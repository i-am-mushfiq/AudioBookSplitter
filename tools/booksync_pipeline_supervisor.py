#!/usr/bin/env python3
"""Durable end-to-end BookSync pipeline supervisor.

The supervisor owns one GPU transcription lane, concurrent downstream CPU
work, one verified upload lane, source-folder lifecycle moves, and recovery
after a pause, process crash, or power loss.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import uuid
from contextlib import AbstractContextManager
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.booksync_batch_pipeline import (  # noqa: E402
    AUDIO_EXTENSIONS, COVER_NAMES, EVENT_PREFIX, PROCESSOR_EVENT_PREFIX,
    clean_title, natural_key, prepare_audio, slug,
)
from tools.validate_booksync_package import validate_package  # noqa: E402
from tools.score_booksync_package import score_quality_report  # noqa: E402

TERMINAL = {"complete", "failed", "quarantined"}
ACTIVE = {"preparing_audio", "transcribing", "cpu", "packaging", "staging", "uploading", "verifying"}


def now() -> str:
    return datetime.now().astimezone().isoformat()


def emit(kind: str, **details: Any) -> None:
    print(EVENT_PREFIX + json.dumps({"type": kind, **details}, ensure_ascii=True), flush=True)


def atomic_json(path: Path, value: Any) -> None:
    atomic_text(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def atomic_text(path: Path, value: str, attempts: int = 8) -> None:
    """Replace a status file without sharing a temp path between writer threads.

    Windows readers, antivirus scanners, and indexers can briefly deny an
    otherwise valid replace.  Unique temp names remove the in-process race;
    bounded backoff handles external sharing violations without hiding durable
    filesystem failures.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(
        f".{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex}.tmp"
    )
    temporary.write_text(value, encoding="utf-8")
    try:
        for attempt in range(attempts):
            try:
                os.replace(temporary, path)
                return
            except OSError as error:
                transient = getattr(error, "winerror", None) in {5, 32} or error.errno in {13}
                if not transient or attempt + 1 >= attempts:
                    raise
                time.sleep(min(0.5, 0.02 * (2**attempt)))
    finally:
        temporary.unlink(missing_ok=True)


class ControllerAudit:
    """Small append-only lifecycle journal, separate from replacing live views."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()

    def record(self, event: str, **details: Any) -> None:
        entry = {"created_at": now(), "pid": os.getpid(), "event": event, **details}
        try:
            with self.lock:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with self.path.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(entry, ensure_ascii=False) + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
        except OSError as error:
            emit("warning", source="controller-audit", message=f"Audit write failed: {error}")


def terminate_tree(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/pid", str(process.pid), "/t", "/f"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    else:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


def windows_long_path(path: Path) -> Path:
    value = str(path.resolve())
    if os.name == "nt" and not value.startswith("\\\\?\\"):
        return Path("\\\\?\\" + value)
    return Path(value)


def discover_ready(source: Path) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Discover exactly one EPUB plus its audio within each immediate book folder."""
    jobs: list[dict[str, Any]] = []
    blocked: list[dict[str, str]] = []
    for folder in sorted((item for item in source.iterdir() if item.is_dir()), key=natural_key):
        scan_root = windows_long_path(folder)
        files = [item for item in scan_root.rglob("*") if item.is_file()]
        epubs = sorted((item for item in files if item.suffix.casefold() == ".epub"), key=natural_key)
        audio = sorted((item for item in files if item.suffix.casefold() in AUDIO_EXTENSIONS), key=natural_key)
        if len(epubs) != 1:
            blocked.append({"folder": folder.name, "message": f"Expected exactly one EPUB; found {len(epubs)}"})
            continue
        if not audio:
            blocked.append({"folder": folder.name, "message": "No supported audiobook files found"})
            continue
        mp3_parts = [item for item in audio if item.suffix.casefold() == ".mp3"]
        if len(mp3_parts) > 1 and any(item.suffix.casefold() == ".m4b" for item in audio):
            audio = mp3_parts
        covers = sorted((item for item in files if item.name.casefold() in COVER_NAMES), key=natural_key)
        title = clean_title(folder.name)
        jobs.append({
            "id": slug(title), "title": title, "book": str(epubs[0].resolve()),
            "audio_parts": [str(item.resolve()) for item in audio],
            "cover": str(covers[0].resolve()) if covers else None, "source_path": str(folder.resolve()),
        })
    return jobs, blocked


class PipelineLock(AbstractContextManager["PipelineLock"]):
    def __init__(self, state_dir: Path):
        self.state_dir = state_dir
        self.handle: int | None = None
        self.lock_file = state_dir / "pipeline.lock"

    def __enter__(self) -> "PipelineLock":
        self.state_dir.mkdir(parents=True, exist_ok=True)
        if os.name == "nt":
            self.handle = ctypes.windll.kernel32.CreateMutexW(None, False, "Global\\BookSync.FullPipeline.v1")
            if not self.handle or ctypes.windll.kernel32.GetLastError() == 183:
                if self.handle:
                    ctypes.windll.kernel32.CloseHandle(self.handle)
                raise RuntimeError("The BookSync pipeline is already running")
        elif self.lock_file.exists():
            raise RuntimeError("The BookSync pipeline is already running")
        self.lock_file.write_text(json.dumps({"pid": os.getpid(), "started_at": now()}), encoding="utf-8")
        return self

    def __exit__(self, *_: Any) -> None:
        self.lock_file.unlink(missing_ok=True)
        if self.handle:
            ctypes.windll.kernel32.ReleaseMutex(self.handle)
            ctypes.windll.kernel32.CloseHandle(self.handle)


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS jobs (
              job_id TEXT PRIMARY KEY, source_name TEXT NOT NULL, title TEXT NOT NULL,
              source_path TEXT NOT NULL, book_path TEXT NOT NULL, audio_parts TEXT NOT NULL,
              cover_path TEXT, output_path TEXT NOT NULL, package_name TEXT NOT NULL,
              state TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT 'queued',
              workload TEXT NOT NULL DEFAULT 'waiting', percent REAL NOT NULL DEFAULT 0,
              message TEXT NOT NULL DEFAULT 'Waiting', gpu_done INTEGER NOT NULL DEFAULT 0,
              packaged INTEGER NOT NULL DEFAULT 0, staged INTEGER NOT NULL DEFAULT 0,
              uploaded INTEGER NOT NULL DEFAULT 0, source_location TEXT NOT NULL DEFAULT 'ready',
              last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              started_at TEXT, packaged_at TEXT, uploaded_at TEXT
            );
            CREATE TABLE IF NOT EXISTS events (
              event_id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, created_at TEXT NOT NULL,
              level TEXT NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """
        )
        self.connection.commit()

    def set_meta(self, key: str, value: str) -> None:
        with self.lock:
            self.connection.execute(
                "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )
            self.connection.commit()

    def meta(self, key: str, default: str = "") -> str:
        with self.lock:
            row = self.connection.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return str(row[0]) if row else default

    def upsert(self, job: dict[str, Any], output: Path) -> None:
        stamp = now()
        job_id = str(job["id"])
        source_path = str(Path(job.get("source_path") or Path(job["book"]).parent))
        package_name = f"{job_id}.booksync"
        with self.lock:
            self.connection.execute(
                """INSERT INTO jobs(job_id,source_name,title,source_path,book_path,audio_parts,cover_path,
                   output_path,package_name,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET
                   title=excluded.title,source_path=CASE WHEN jobs.source_location='ready' THEN excluded.source_path ELSE jobs.source_path END,
                   book_path=excluded.book_path,audio_parts=excluded.audio_parts,cover_path=excluded.cover_path,
                   output_path=excluded.output_path,package_name=excluded.package_name,updated_at=excluded.updated_at""",
                (job_id, Path(source_path).name, job["title"], source_path, job["book"],
                 json.dumps(job["audio_parts"]), job.get("cover"), str(output / job_id), package_name, stamp, stamp),
            )
            self.connection.commit()

    def update(self, job_id: str, **values: Any) -> None:
        if not values:
            return
        values["updated_at"] = now()
        with self.lock:
            self.connection.execute(
                f"UPDATE jobs SET {','.join(f'{key}=?' for key in values)} WHERE job_id=?",
                (*values.values(), job_id),
            )
            self.connection.commit()

    def event(self, job_id: str | None, level: str, stage: str, message: str) -> None:
        with self.lock:
            self.connection.execute(
                "INSERT INTO events(job_id,created_at,level,stage,message) VALUES(?,?,?,?,?)",
                (job_id, now(), level, stage, message[:4000]),
            )
            self.connection.commit()

    def rows(self) -> list[sqlite3.Row]:
        with self.lock:
            return list(self.connection.execute("SELECT * FROM jobs ORDER BY created_at, title COLLATE NOCASE"))

    def recent_events(self, limit: int = 120) -> list[dict[str, Any]]:
        with self.lock:
            rows = list(self.connection.execute(
                "SELECT created_at,level,stage,message FROM events ORDER BY event_id DESC LIMIT ?", (limit,)
            ))
        return [dict(row) for row in reversed(rows)]

    def row(self, job_id: str) -> sqlite3.Row:
        with self.lock:
            row = self.connection.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        if row is None:
            raise KeyError(job_id)
        return row

    def reset_interrupted(self) -> None:
        with self.lock:
            self.connection.execute(
                "UPDATE jobs SET state='queued',stage='recovering',workload='waiting',message='Recovered after interruption',updated_at=? WHERE state IN (%s)"
                % ",".join("?" for _ in ACTIVE),
                (now(), *sorted(ACTIVE)),
            )
            self.connection.commit()

    def close(self) -> None:
        with self.lock:
            self.connection.close()


class Snapshot:
    def __init__(self, store: Store, state_dir: Path, paths: dict[str, Path]):
        self.store, self.state_dir, self.paths = store, state_dir, paths
        self.json_path = state_dir / "pipeline-status.json"
        self.text_path = state_dir / "live.txt"
        self.lock = threading.RLock()
        self.last_error: str | None = None
        self.last_error_reported_at = 0.0

    def value(self) -> dict[str, Any]:
        rows = [dict(row) for row in self.store.rows()]
        for row in rows:
            row["audio_parts"] = len(json.loads(row["audio_parts"]))
        return {
            "updated_at": now(), "supervisor": self.store.meta("supervisor", "stopped"),
            "paused": self.store.meta("pause_requested") == "1", "paths": {key: str(value) for key, value in self.paths.items()},
            "gpu_book": next((row["title"] for row in rows if row["workload"] == "gpu" and row["state"] not in TERMINAL), None),
            "cpu_books": [row["title"] for row in rows if row["workload"] == "cpu" and row["state"] not in TERMINAL],
            "upload_book": next((row["title"] for row in rows if row["workload"] == "upload" and row["state"] not in TERMINAL), None),
            "counts": {state: sum(row["state"] == state for row in rows) for state in sorted({row["state"] for row in rows})},
            "books": rows, "events": self.store.recent_events(),
        }

    def write(self, headline: str = "") -> bool:
        try:
            with self.lock:
                value = self.value()
                value["headline"] = headline
                value["snapshot_healthy"] = self.last_error is None
                value["snapshot_last_error"] = self.last_error
                atomic_json(self.json_path, value)
                lines = ["BOOKSYNC END-TO-END PIPELINE", f"Updated: {value['updated_at']}",
                         f"Supervisor: {value['supervisor']}", f"Paused: {value['paused']}",
                         f"Snapshot healthy: {value['snapshot_healthy']}", f"Latest: {headline}", ""]
                for row in value["books"]:
                    lines.append(
                        f"{row['title']} | {row['state']} | {row['stage']} | {row['workload']} | {row['percent']:.1f}% | "
                        f"packaged={bool(row['packaged'])} | staged={bool(row['staged'])} | uploaded={bool(row['uploaded'])} | "
                        f"source={row['source_location']} | {row['message']}"
                    )
                atomic_text(self.text_path, "\n".join(lines) + "\n")
                recovered = self.last_error is not None
                self.last_error = None
            if recovered:
                self.store.event(None, "info", "snapshot", "Live status writer recovered")
            return True
        except Exception as error:
            message = f"{type(error).__name__}: {error}"
            report_now = message != self.last_error or time.monotonic() - self.last_error_reported_at >= 60
            self.last_error = message
            if report_now:
                self.last_error_reported_at = time.monotonic()
                try:
                    self.store.event(None, "warning", "snapshot", message)
                except Exception:
                    pass
                emit("warning", source="snapshot", message=f"Live status update skipped; processing continues: {message}")
            return False


class Supervisor:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.paths = {name: Path(getattr(args, name)).resolve() for name in
                      ("source", "processed", "in_hugging_face", "output", "upload_ready", "destination")}
        self.state_dir = Path(args.state_dir).resolve()
        self.pause_file = self.state_dir / "PAUSE"
        self.store = Store(self.state_dir / "pipeline.sqlite3")
        self.snapshot = Snapshot(self.store, self.state_dir, self.paths)
        self.audit = ControllerAudit(self.state_dir / "controller-history.jsonl")
        self.processes: dict[str, subprocess.Popen[str]] = {}
        self.readers: dict[str, threading.Thread] = {}
        self.gpu_job: str | None = None
        self.upload_process: subprocess.Popen[str] | None = None
        self.upload_job: str | None = None

    def discover(self) -> None:
        self.paths["source"].mkdir(parents=True, exist_ok=True)
        jobs, blocked = discover_ready(self.paths["source"])
        for item in blocked:
            self.store.event(None, "warning", "discovery", f"{item['folder']}: {item['message']}")
            emit("warning", title=item["folder"], message=item["message"])
        claimed: dict[str, str] = {}
        for job in jobs:
            source_identity = str(Path(job.get("source_path") or Path(job["book"]).parent).resolve()).casefold()
            if job["id"] in claimed and claimed[job["id"]] != source_identity:
                suffix = hashlib.sha256(source_identity.encode()).hexdigest()[:7]
                job["id"] = f"{job['id'][:42].rstrip('_')}_{suffix}"
            claimed[job["id"]] = source_identity
            self.store.upsert(job, self.paths["output"])
        self.store.event(None, "info", "discovery", f"Discovered {len(jobs)} source pair(s); blocked {len(blocked)}")

    def upload_db_verified(self, package_name: str) -> bool:
        database = self.paths["upload_ready"] / ".upload-state" / "upload_queue.sqlite3"
        if not database.is_file():
            return False
        connection = sqlite3.connect(database)
        try:
            row = connection.execute(
                "SELECT state,verified_at,remote_sha FROM books WHERE package_name=? ORDER BY updated_at DESC LIMIT 1", (package_name,)
            ).fetchone()
            return bool(row and (row[0] == "complete" or (row[1] and row[2] and row[0] in {"moving", "cataloging"})))
        finally:
            connection.close()

    def sync_upload_progress(self, job_id: str) -> None:
        database = self.paths["upload_ready"] / ".upload-state" / "upload_queue.sqlite3"
        if not database.is_file():
            return
        row = self.store.row(job_id)
        connection = sqlite3.connect(database)
        connection.row_factory = sqlite3.Row
        try:
            upload = connection.execute(
                "SELECT state,total_bytes,transferred_bytes,speed_bps,last_error FROM books "
                "WHERE package_name=? ORDER BY updated_at DESC LIMIT 1", (row["package_name"],)
            ).fetchone()
        finally:
            connection.close()
        if not upload:
            return
        total, transferred = int(upload["total_bytes"] or 0), int(upload["transferred_bytes"] or 0)
        transfer_percent = (transferred / total * 100) if total else 0
        pipeline_percent = 94 + min(5, transfer_percent * 0.05)
        speed = float(upload["speed_bps"] or 0) / 1024 / 1024
        message = f"Upload {transfer_percent:.1f}% at {speed:.2f} MB/s ({upload['state']})"
        if upload["last_error"]:
            message += f" — {str(upload['last_error'])[:180]}"
        self.store.update(job_id, stage=str(upload["state"]), workload="upload", percent=pipeline_percent, message=message)

    def move_source(self, row: sqlite3.Row, destination_key: str) -> Path:
        source = next((candidate for candidate in (
            Path(row["source_path"]), self.paths["source"] / row["source_name"],
            self.paths["processed"] / row["source_name"], self.paths["in_hugging_face"] / row["source_name"],
        ) if candidate.exists()), None)
        target = self.paths[destination_key] / row["source_name"]
        if target.exists():
            if source and source.resolve() != target.resolve():
                raise RuntimeError(f"Source destination conflict: {target}")
            return target
        if source is None:
            raise RuntimeError(f"Source folder is missing for {row['title']}")
        self.paths[destination_key].mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(target))
        return target

    def reconcile(self) -> None:
        self.store.reset_interrupted()
        for original in self.store.rows():
            row = self.store.row(original["job_id"])
            package_name = row["package_name"]
            final_package = self.paths["destination"] / row["job_id"] / package_name
            if final_package.is_dir() and not validate_package(final_package) and self.upload_db_verified(package_name):
                if not (self.paths["in_hugging_face"] / row["source_name"]).exists():
                    self.move_source(row, "in_hugging_face")
                self.store.update(row["job_id"], state="complete", stage="complete", workload="done", percent=100,
                                  packaged=1, staged=1, uploaded=1, source_location="in_hugging_face",
                                  message="Uploaded, verified, and finalized", uploaded_at=row["uploaded_at"] or now())
                continue
            staged_package = self.paths["upload_ready"] / row["job_id"] / package_name
            if staged_package.is_dir() and not validate_package(staged_package):
                self.store.update(row["job_id"], state="staged", stage="upload_queued", workload="waiting",
                                  packaged=1, staged=1, percent=92, source_location="processed",
                                  message="Validated package waiting for upload")
                continue
            raw_package = Path(row["output_path"]) / package_name
            if raw_package.is_dir() and not validate_package(raw_package):
                self.finish_package(row["job_id"], raw_package)

    def finish_package(self, job_id: str, package: Path) -> None:
        issues = validate_package(package)
        if issues:
            raise RuntimeError("; ".join(map(str, issues[:8])))
        row = self.store.row(job_id)
        quality_path = package / "reports" / "quality-report.json"
        if quality_path.is_file():
            scorecard = score_quality_report(json.loads(quality_path.read_text(encoding="utf-8")))
            if scorecard["grade"] == "F":
                message = f"Quality gate rejected score {scorecard['score']}/100 (grade F); source retained for remediation"
                self.store.update(job_id, state="quarantined", stage="quality_failed", workload="waiting",
                                  percent=90, packaged=1, staged=0, last_error=message, message=message)
                self.store.event(job_id, "error", "quality_failed", message)
                self.snapshot.write(f"Quarantined {row['title']}: {message}")
                return
        if not (self.paths["processed"] / row["source_name"]).exists():
            self.move_source(row, "processed")
        target_parent = self.paths["upload_ready"] / row["job_id"]
        target_package = target_parent / row["package_name"]
        target_parent.mkdir(parents=True, exist_ok=True)
        if not target_package.exists():
            shutil.move(str(package), str(target_package))
        self.store.update(job_id, state="staged", stage="upload_queued", workload="waiting", percent=92,
                          packaged=1, staged=1, source_location="processed", packaged_at=now(),
                          message="Package validated and queued for upload")
        self.store.event(job_id, "info", "staging", f"Staged {target_package}")
        self.snapshot.write(f"Staged {row['title']} for upload")

    def processor_reader(self, job_id: str, process: subprocess.Popen[str], log_path: Path) -> None:
        assert process.stdout
        with log_path.open("a", encoding="utf-8") as log:
            for raw in process.stdout:
                line = raw.rstrip()
                log.write(line + "\n"); log.flush()
                if line.startswith(PROCESSOR_EVENT_PREFIX):
                    try:
                        event = json.loads(line[len(PROCESSOR_EVENT_PREFIX):])
                        stage, percent = str(event.get("stage", "processing")), float(event.get("percent", 0))
                        workload = "gpu" if stage == "transcribing" else "cpu"
                        self.store.update(job_id, state="transcribing" if workload == "gpu" else "cpu",
                                          stage=stage, workload=workload, percent=percent,
                                          message=str(event.get("message", stage)))
                        self.store.event(job_id, "info", stage, str(event.get("message", stage)))
                        emit("book", bookId=job_id, title=self.store.row(job_id)["title"], workload=workload, **event)
                        self.snapshot.write(str(event.get("message", stage)))
                        continue
                    except Exception as error:
                        self.store.event(job_id, "warning", "event", str(error))
                if line:
                    self.store.event(job_id, "info", "processor", line)

    def start_processor(self, row: sqlite3.Row) -> None:
        job = {"id": row["job_id"], "title": row["title"], "book": row["book_path"],
               "audio_parts": json.loads(row["audio_parts"]), "cover": row["cover_path"]}
        output = Path(row["output_path"])
        output.mkdir(parents=True, exist_ok=True)
        self.store.update(row["job_id"], state="preparing_audio", stage="preparing_audio", workload="cpu",
                          message="Preparing audiobook", started_at=row["started_at"] or now(), last_error=None)
        audio = prepare_audio(job, output)
        command = [sys.executable, str(ROOT / "pdf_audiobook_splitter.py"), "--book", row["book_path"],
                   "--audio", str(audio), "--output", str(output), "--book-name", row["title"],
                   "--model", self.args.model, "--device", self.args.device, "--minutes", str(self.args.minutes),
                   "--mode", self.args.mode, "--window-seconds", "300", "--resume"]
        if row["cover_path"]:
            command += ["--cover", row["cover_path"]]
        process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, encoding="utf-8", errors="replace",
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.processes[row["job_id"]] = process
        thread = threading.Thread(target=self.processor_reader,
                                  args=(row["job_id"], process, output / "processor.log"), daemon=True)
        self.readers[row["job_id"]] = thread
        thread.start()
        if not (output / "transcript.json").is_file():
            self.gpu_job = row["job_id"]
            self.store.update(row["job_id"], state="transcribing", stage="transcribing", workload="gpu",
                              message="GPU transcription started")
        else:
            self.store.update(row["job_id"], state="cpu", stage="recovering_downstream", workload="cpu", gpu_done=1,
                              message="Reusing transcript; resumed downstream work")
        self.snapshot.write(f"Started {row['title']}")

    def start_upload(self, row: sqlite3.Row) -> None:
        package = self.paths["upload_ready"] / row["job_id"] / row["package_name"]
        command = [sys.executable, str(ROOT / "tools" / "booksync_upload_supervisor.py"), "run",
                   "--queue", str(self.paths["upload_ready"]), "--destination", str(self.paths["destination"]),
                   "--repo", self.args.repo, "--only", package.name]
        self.upload_process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.upload_job = row["job_id"]
        self.store.update(row["job_id"], state="uploading", stage="uploading", workload="upload", percent=94,
                          message="Durable Hugging Face upload running")
        self.snapshot.write(f"Uploading {row['title']}")

    def finish_upload(self, job_id: str, code: int) -> None:
        row = self.store.row(job_id)
        final_package = self.paths["destination"] / row["job_id"] / row["package_name"]
        if code or not final_package.is_dir() or validate_package(final_package) or not self.upload_db_verified(row["package_name"]):
            self.store.update(job_id, state="failed", stage="upload_failed", workload="waiting",
                              last_error=f"Uploader exited {code}; verified destination not found", message="Upload needs retry")
            return
        self.move_source(row, "in_hugging_face")
        self.store.update(job_id, state="complete", stage="complete", workload="done", percent=100,
                          uploaded=1, source_location="in_hugging_face", uploaded_at=now(),
                          message="Uploaded, verified, and source finalized")
        self.store.event(job_id, "info", "complete", "Upload verified; source moved to __in_hugging_face")
        self.snapshot.write(f"Completed {row['title']}")

    def pause(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.pause_file.write_text(now(), encoding="utf-8")
        self.store.set_meta("pause_requested", "1")
        upload_stop = self.paths["upload_ready"] / ".upload-state" / "STOP"
        upload_stop.parent.mkdir(parents=True, exist_ok=True)
        upload_stop.write_text(now(), encoding="utf-8")
        self.snapshot.write("Pause requested")

    def run(self) -> int:
        self.audit.record("controller_start", command="resume", source=str(self.paths["source"]))
        self.pause_file.unlink(missing_ok=True)
        self.store.set_meta("pause_requested", "0")
        self.store.set_meta("supervisor", "recovering")
        self.discover()
        self.reconcile()
        self.store.set_meta("supervisor", "running")
        self.snapshot.write("Pipeline running")
        try:
            while True:
                if self.pause_file.exists():
                    for process in self.processes.values():
                        terminate_tree(process)
                    if self.upload_process:
                        terminate_tree(self.upload_process)
                    self.store.reset_interrupted()
                    self.store.set_meta("pause_requested", "1")
                    self.store.set_meta("supervisor", "paused")
                    self.snapshot.write("Pipeline paused; checkpoints preserved")
                    self.audit.record("controller_exit", reason="paused", exit_code=2)
                    return 2

                for job_id, process in list(self.processes.items()):
                    row = self.store.row(job_id)
                    transcript = Path(row["output_path"]) / "transcript.json"
                    if self.gpu_job == job_id and transcript.is_file():
                        self.gpu_job = None
                        self.store.update(job_id, gpu_done=1, state="cpu", workload="cpu",
                                          message="GPU complete; downstream work continues")
                        self.snapshot.write(f"GPU released by {row['title']}")
                    code = process.poll()
                    if code is None:
                        continue
                    self.readers[job_id].join(timeout=3)
                    del self.processes[job_id]
                    self.readers.pop(job_id, None)
                    if self.gpu_job == job_id:
                        self.gpu_job = None
                    package = Path(row["output_path"]) / row["package_name"]
                    if code == 0 and package.is_dir() and not validate_package(package):
                        try:
                            self.finish_package(job_id, package)
                        except Exception as error:
                            self.store.update(job_id, state="failed", stage="staging_failed", workload="waiting",
                                              last_error=str(error), message=str(error))
                    else:
                        self.store.update(job_id, state="failed", stage="processing_failed", workload="waiting",
                                          last_error=f"Processor exit {code}", message="Processing needs attention")

                if self.upload_process and self.upload_process.poll() is not None:
                    code, job_id = self.upload_process.returncode, self.upload_job
                    self.upload_process, self.upload_job = None, None
                    if job_id:
                        try:
                            self.finish_upload(job_id, int(code or 0))
                        except Exception as error:
                            self.store.update(job_id, state="failed", stage="finalize_failed", workload="waiting",
                                              last_error=str(error), message=str(error))
                elif self.upload_process and self.upload_job:
                    self.sync_upload_progress(self.upload_job)

                rows = self.store.rows()
                active_cpu = sum(row["workload"] == "cpu" and row["job_id"] in self.processes for row in rows)
                if len(self.processes) < self.args.max_processors:
                    candidates = [row for row in rows if row["state"] == "queued"
                                  and (self.paths["source"] / row["source_name"]).exists()]
                    candidates.sort(key=lambda row: (not (Path(row["output_path"]) / "transcript.json").is_file(), row["created_at"]))
                    for row in candidates:
                        has_transcript = (Path(row["output_path"]) / "transcript.json").is_file()
                        if has_transcript and active_cpu < self.args.max_cpu:
                            self.start_processor(row); active_cpu += 1; break
                        if not has_transcript and self.gpu_job is None:
                            self.start_processor(row); break

                if self.upload_process is None and self.args.auto_upload:
                    staged = next((row for row in self.store.rows() if row["state"] == "staged"), None)
                    if staged:
                        self.start_upload(staged)

                rows = self.store.rows()
                unfinished = [row for row in rows if row["state"] not in TERMINAL]
                recoverable_failures = [row for row in rows if row["state"] == "failed"]
                self.snapshot.write("Pipeline running")
                if not self.args.auto_upload and unfinished and all(row["state"] == "staged" for row in unfinished):
                    self.store.set_meta("supervisor", "waiting_upload")
                    self.snapshot.write("All packages staged; automatic upload is off")
                    self.audit.record("controller_exit", reason="waiting_upload", exit_code=0)
                    return 0
                if not unfinished and not self.processes and self.upload_process is None:
                    self.store.set_meta("supervisor", "complete" if not recoverable_failures else "attention")
                    self.snapshot.write("Pipeline complete" if not recoverable_failures else "Pipeline needs attention")
                    exit_code = 0 if not recoverable_failures else 1
                    self.audit.record("controller_exit", reason="complete" if exit_code == 0 else "attention",
                                      exit_code=exit_code)
                    return exit_code
                time.sleep(2)
        finally:
            for process in self.processes.values():
                if process.poll() is None:
                    terminate_tree(process)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("command", nargs="?", choices=["run", "resume", "pause", "status", "scan"], default="run")
    value.add_argument("--source", type=Path, default=Path(r"D:\Audiobooks\__Ready"))
    value.add_argument("--processed", type=Path, default=Path(r"D:\Audiobooks\__Processed"))
    value.add_argument("--in-hugging-face", dest="in_hugging_face", type=Path, default=Path(r"D:\Audiobooks\__in_hugging_face"))
    value.add_argument("--output", type=Path, default=ROOT / "local-data" / "books" / "raw_processing")
    value.add_argument("--upload-ready", dest="upload_ready", type=Path, default=ROOT / "local-data" / "books" / "upload_ready")
    value.add_argument("--destination", type=Path, default=Path(r"C:\Users\Mushfiq\Downloads\BookSync"))
    value.add_argument("--state-dir", type=Path, default=ROOT / "local-data" / "books" / ".pipeline-state")
    value.add_argument("--model", default="small")
    value.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    value.add_argument("--minutes", type=float, default=10)
    value.add_argument("--mode", choices=["smart", "chapter", "fixed"], default="smart")
    value.add_argument("--repo", default="mdrahman/booksync-library")
    value.add_argument("--auto-upload", action=argparse.BooleanOptionalAction, default=True)
    value.add_argument("--max-cpu", type=int, default=2)
    value.add_argument("--max-processors", type=int, default=3)
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    supervisor = Supervisor(args)
    try:
        if args.command == "pause":
            supervisor.pause(); supervisor.audit.record("pause_requested"); return 0
        if args.command == "status":
            print(json.dumps(supervisor.snapshot.value(), indent=2)); return 0
        if args.command == "scan":
            supervisor.discover(); supervisor.reconcile(); supervisor.snapshot.write("Scan complete"); return 0
        with PipelineLock(Path(args.state_dir).resolve()):
            return supervisor.run()
    except Exception as error:
        supervisor.audit.record("controller_fatal", error=f"{type(error).__name__}: {error}",
                                traceback=traceback.format_exc())
        try:
            supervisor.store.set_meta("supervisor", "interrupted")
            supervisor.snapshot.write("Controller stopped unexpectedly; watchdog recovery pending")
        except Exception:
            pass
        raise
    finally:
        supervisor.store.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        emit("finished", success=False, failures=[str(error)], message=str(error))
        raise
