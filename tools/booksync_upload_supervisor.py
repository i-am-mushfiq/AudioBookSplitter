#!/usr/bin/env python3
"""Durable and observable Hugging Face upload supervisor for BookSync."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import queue
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from huggingface_hub import HfApi, get_token, hf_hub_download

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.publish_huggingface_package import merged_catalog, remote_catalog
from tools.score_booksync_package import score_package
from tools.validate_booksync_package import validate_package

ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
LEGACY_PROGRESS_RE = re.compile(
    r"Uploading\.\.\.\s*(\d+)/(\d+) files checked,\s*(\d+)/(\d+) uploaded "
    r"\(([^)]+) transferred\),\s*(\d+) committed"
)
PROCESSING_RE = re.compile(
    r"Processing Files.*?:\s*(\d+)%.*?([\d.]+\s*[KMGT]?B)\s*/\s*"
    r"([\d.]+\s*[KMGT]?B)(?:,\s*([\d.]+\s*[KMGT]?B/s))?",
    re.IGNORECASE,
)
MODERN_PROGRESS_RE = re.compile(
    r"Uploading.*?(\d+)\s*/\s*(\d+)\s+files.*?"
    r"([\d.]+\s*[KMGT]?B).*?(?:·|,)\s*([\d.]+\s*[KMGT]?B/s)",
    re.IGNORECASE,
)
SIZE_RE = re.compile(r"([\d.]+)\s*([KMGT]?B)(?:/s)?", re.IGNORECASE)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def human_bytes(value: float | int | None) -> str:
    amount = float(value or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(amount) < 1024 or unit == "TB":
            return f"{amount:.2f} {unit}" if unit != "B" else f"{amount:.0f} B"
        amount /= 1024
    return f"{amount:.2f} TB"


def parse_size(value: str | None) -> int:
    if not value:
        return 0
    match = SIZE_RE.search(value.replace("iB", "B"))
    if not match:
        return 0
    scale = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}
    return int(float(match.group(1)) * scale[match.group(2).upper()])


def physical_memory_gb() -> float:
    if os.name != "nt":
        try:
            return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3
        except (AttributeError, ValueError, OSError):
            return 0

    class MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("length", ctypes.c_ulong), ("memory_load", ctypes.c_ulong),
            ("total_physical", ctypes.c_ulonglong), ("available_physical", ctypes.c_ulonglong),
            ("total_page_file", ctypes.c_ulonglong), ("available_page_file", ctypes.c_ulonglong),
            ("total_virtual", ctypes.c_ulonglong), ("available_virtual", ctypes.c_ulonglong),
            ("available_extended_virtual", ctypes.c_ulonglong),
        ]

    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        return 0
    return status.total_physical / 1024**3


def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def human_duration(seconds: float | None) -> str:
    if seconds is None:
        return "-"
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {secs:02d}s"
    return f"{minutes}m {secs:02d}s"


def sample_network_send_bps() -> float:
    """Return system-wide outgoing bytes/sec, or zero when unavailable."""
    if os.name != "nt":
        return 0
    try:
        result = subprocess.run(
            ["typeperf", r"\Network Interface(*)\Bytes Sent/sec", "-sc", "2"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=8,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        rows = [line for line in result.stdout.splitlines() if line.startswith('"')]
        if len(rows) < 3:
            return 0
        values = next(__import__("csv").reader([rows[-1]]))[1:]
        return sum(max(0.0, float(value)) for value in values)
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


@dataclass
class TransferProgress:
    transferred: int = 0
    total: int = 0
    speed_bps: float = 0
    files_done: int = 0
    files_total: int = 0
    committed: int = 0
    message: str = ""


def parse_progress(text: str, previous: TransferProgress | None = None) -> TransferProgress:
    clean = ANSI_RE.sub("", text).replace("\r", "\n")
    progress = TransferProgress(**vars(previous)) if previous else TransferProgress()
    for line in (part.strip() for part in clean.splitlines() if part.strip()):
        legacy = LEGACY_PROGRESS_RE.search(line)
        if legacy:
            progress.files_done = int(legacy.group(3))
            progress.files_total = int(legacy.group(4))
            progress.transferred = max(progress.transferred, parse_size(legacy.group(5)))
            progress.committed = int(legacy.group(6))
            progress.message = line
            continue
        processing = PROCESSING_RE.search(line)
        if processing:
            progress.transferred = max(progress.transferred, parse_size(processing.group(2)))
            progress.total = max(progress.total, parse_size(processing.group(3)))
            if processing.group(4):
                progress.speed_bps = parse_size(processing.group(4))
            progress.message = line
            continue
        modern = MODERN_PROGRESS_RE.search(line)
        if modern:
            progress.files_done = int(modern.group(1))
            progress.files_total = int(modern.group(2))
            progress.transferred = max(progress.transferred, parse_size(modern.group(3)))
            progress.speed_bps = parse_size(modern.group(4))
            progress.message = line
    return progress


class StateStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS books (
                id TEXT PRIMARY KEY, parent_path TEXT NOT NULL, package_path TEXT NOT NULL,
                package_name TEXT NOT NULL, total_bytes INTEGER NOT NULL DEFAULT 0,
                file_count INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'queued',
                transport TEXT, attempt INTEGER NOT NULL DEFAULT 0,
                transferred_bytes INTEGER NOT NULL DEFAULT 0, speed_bps REAL NOT NULL DEFAULT 0,
                average_bps REAL NOT NULL DEFAULT 0, files_done INTEGER NOT NULL DEFAULT 0,
                files_total INTEGER NOT NULL DEFAULT 0, committed INTEGER NOT NULL DEFAULT 0,
                last_movement_at TEXT, last_error TEXT, remote_sha TEXT, commit_url TEXT,
                updated_at TEXT NOT NULL, completed_at TEXT, started_at TEXT, verified_at TEXT,
                destination_path TEXT, package_sha256 TEXT, speed_source TEXT,
                batch_id TEXT, bytes_read INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT, created_at TEXT NOT NULL,
                level TEXT NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """
        )
        existing = {row[1] for row in self.connection.execute("PRAGMA table_info(books)")}
        migrations = {
            "started_at": "TEXT", "verified_at": "TEXT", "destination_path": "TEXT",
            "package_sha256": "TEXT", "speed_source": "TEXT", "batch_id": "TEXT",
            "bytes_read": "INTEGER NOT NULL DEFAULT 0",
        }
        for name, definition in migrations.items():
            if name not in existing:
                self.connection.execute(f"ALTER TABLE books ADD COLUMN {name} {definition}")
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def set_meta(self, key: str, value: str) -> None:
        self.connection.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        self.connection.commit()

    def get_meta(self, key: str, default: str = "") -> str:
        row = self.connection.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return str(row[0]) if row else default

    def event(self, book_id: str | None, level: str, stage: str, message: str) -> None:
        self.connection.execute(
            "INSERT INTO events(book_id,created_at,level,stage,message) VALUES(?,?,?,?,?)",
            (book_id, utc_now(), level, stage, message[:4000]),
        )
        self.connection.commit()

    def upsert_package(self, parent: Path, package: Path) -> str:
        files = [item for item in package.rglob("*") if item.is_file()]
        total = sum(item.stat().st_size for item in files)
        fingerprint = hashlib.sha256()
        for control in (package / "manifest.json", package / "checksums.json"):
            if control.is_file():
                fingerprint.update(control.read_bytes())
        book_id = hashlib.sha256(str(package.resolve()).casefold().encode()).hexdigest()[:24]
        self.connection.execute(
            """INSERT INTO books(id,parent_path,package_path,package_name,total_bytes,file_count,updated_at,package_sha256)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_path=excluded.parent_path,
            package_path=excluded.package_path,package_name=excluded.package_name,
            total_bytes=excluded.total_bytes,file_count=excluded.file_count,updated_at=excluded.updated_at,
            state=CASE WHEN books.package_sha256<>excluded.package_sha256 THEN 'queued' ELSE books.state END,
            transferred_bytes=CASE WHEN books.package_sha256<>excluded.package_sha256 THEN 0 ELSE books.transferred_bytes END,
            verified_at=CASE WHEN books.package_sha256<>excluded.package_sha256 THEN NULL ELSE books.verified_at END,
            remote_sha=CASE WHEN books.package_sha256<>excluded.package_sha256 THEN NULL ELSE books.remote_sha END,
            completed_at=CASE WHEN books.package_sha256<>excluded.package_sha256 THEN NULL ELSE books.completed_at END,
            last_error=CASE WHEN books.package_sha256<>excluded.package_sha256 THEN 'Package content changed; queued replacement' ELSE books.last_error END,
            package_sha256=excluded.package_sha256""",
            (book_id, str(parent), str(package), package.name, total, len(files), utc_now(), fingerprint.hexdigest()),
        )
        self.connection.commit()
        return book_id

    def update(self, book_id: str, **values: Any) -> None:
        if not values:
            return
        values["updated_at"] = utc_now()
        assignments = ",".join(f"{key}=?" for key in values)
        self.connection.execute(f"UPDATE books SET {assignments} WHERE id=?", (*values.values(), book_id))
        self.connection.commit()

    def reset_interrupted(self) -> None:
        self.connection.execute(
            """UPDATE books SET state='queued',last_error='Recovered after interrupted supervisor',updated_at=?
            WHERE state IN ('validating','authenticating','scanning','uploading','committing','verifying','cataloging','moving','retrying')""",
            (utc_now(),),
        )
        self.connection.commit()

    def rows(self) -> list[sqlite3.Row]:
        return list(self.connection.execute("SELECT * FROM books ORDER BY package_name COLLATE NOCASE"))

    def pending(self) -> list[sqlite3.Row]:
        return list(self.connection.execute(
            "SELECT * FROM books WHERE state NOT IN ('complete','quarantined') ORDER BY package_name COLLATE NOCASE"
        ))


class SingleInstance(AbstractContextManager["SingleInstance"]):
    def __init__(self, repo: str, state_dir: Path):
        self.repo, self.state_dir = repo, state_dir
        self.handle: int | None = None
        self.lock_file = state_dir / "supervisor.lock"

    def __enter__(self) -> "SingleInstance":
        self.state_dir.mkdir(parents=True, exist_ok=True)
        if os.name == "nt":
            name = "Global\\BookSync.HFUploader." + hashlib.sha256(self.repo.encode()).hexdigest()[:20]
            kernel = ctypes.windll.kernel32
            self.handle = kernel.CreateMutexW(None, False, name)
            if not self.handle or kernel.GetLastError() == 183:
                if self.handle:
                    kernel.CloseHandle(self.handle)
                raise RuntimeError(f"An uploader is already active for {self.repo}")
        else:
            try:
                descriptor = os.open(self.lock_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(descriptor)
            except FileExistsError as error:
                raise RuntimeError(f"An uploader is already active for {self.repo}") from error
        self.lock_file.write_text(json.dumps({"pid": os.getpid(), "repo": self.repo, "started_at": utc_now()}), encoding="utf-8")
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.lock_file.unlink(missing_ok=True)
        if self.handle:
            ctypes.windll.kernel32.ReleaseMutex(self.handle)
            ctypes.windll.kernel32.CloseHandle(self.handle)


class SnapshotWriter:
    def __init__(self, store: StateStore, path: Path, repo: str, queue_root: Path):
        self.store, self.path, self.repo, self.queue_root = store, path, repo, queue_root

    def write(self, headline: str = "") -> None:
        lines = [
            "BOOKSYNC HUGGING FACE UPLOAD", f"Updated: {datetime.now().astimezone().isoformat()}",
            f"Supervisor: {self.store.get_meta('supervisor_state', 'stopped')}",
            f"Repository: {self.repo}", f"Queue: {self.queue_root}", "",
        ]
        if headline:
            lines.extend([f"Latest: {headline}", ""])
        for row in self.store.rows():
            transferred, total = int(row["transferred_bytes"] or 0), int(row["total_bytes"] or 0)
            speed = float(row["speed_bps"] or 0)
            percent = min(100, transferred / total * 100) if total else 0
            started = parse_timestamp(row["started_at"])
            finished = parse_timestamp(row["completed_at"])
            elapsed = ((finished or datetime.now(timezone.utc)) - started).total_seconds() if started else None
            eta = ((total - transferred) / speed) if speed > 0 and transferred < total else 0 if transferred >= total else None
            detail = (f"{row['package_name']} | {row['state']} | {percent:.1f}% | "
                      f"{human_bytes(transferred)}/{human_bytes(total)} | {human_bytes(speed)}/s")
            if row["transport"]:
                detail += f" | {row['transport']}"
            detail += (
                f" | start={started.astimezone().isoformat() if started else '-'}"
                f" | finish={finished.astimezone().isoformat() if finished else '-'}"
                f" | elapsed={human_duration(elapsed)} | ETA={human_duration(eta)}"
                f" | files={row['files_done']}/{row['files_total']} | commits={row['committed']}"
                f" | attempt={row['attempt']} | speed_source={row['speed_source'] or '-'}"
            )
            if row["last_error"]:
                detail += f" | error={str(row['last_error']).replace(chr(10), ' ')[:220]}"
            lines.append(detail)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
        os.replace(temporary, self.path)


class UploadStopped(RuntimeError):
    pass


class ChildProcessJob(AbstractContextManager["ChildProcessJob"]):
    """Put a child in a Windows kill-on-close Job Object."""

    def __init__(self, process: subprocess.Popen[bytes]):
        self.process = process
        self.handle: int | None = None

    def __enter__(self) -> "ChildProcessJob":
        if os.name != "nt":
            return self

        class BasicLimit(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", ctypes.c_ulong),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.c_ulong),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", ctypes.c_ulong),
                ("SchedulingClass", ctypes.c_ulong),
            ]

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
            )]

        class ExtendedLimit(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BasicLimit), ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel = ctypes.windll.kernel32
        self.handle = kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError()
        limits = ExtendedLimit()
        limits.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            kernel.CloseHandle(self.handle)
            self.handle = None
            raise ctypes.WinError()
        process_handle = kernel.OpenProcess(0x0100 | 0x0001, False, self.process.pid)
        if not process_handle:
            kernel.CloseHandle(self.handle)
            self.handle = None
            raise ctypes.WinError()
        try:
            if not kernel.AssignProcessToJobObject(self.handle, process_handle):
                raise ctypes.WinError()
        finally:
            kernel.CloseHandle(process_handle)
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self.handle:
            ctypes.windll.kernel32.CloseHandle(self.handle)
            self.handle = None


class UploadSupervisor:
    def __init__(self, queue_root: Path, destination: Path, repo: str, revision: str,
                 state_dir: Path, log_path: Path, dry_run: bool = False, only: str | None = None):
        self.queue_root, self.destination = queue_root.resolve(), destination.resolve()
        self.repo, self.revision, self.state_dir = repo, revision, state_dir.resolve()
        self.stop_file = self.state_dir / "STOP"
        self.store = StateStore(self.state_dir / "upload_queue.sqlite3")
        self.snapshot = SnapshotWriter(self.store, log_path.resolve(), repo, self.queue_root)
        self.dry_run, self.api, self.only = dry_run, None, only

    def close(self) -> None:
        self.store.close()

    def scan(self) -> None:
        self.queue_root.mkdir(parents=True, exist_ok=True)
        parents = (item for item in self.queue_root.iterdir() if item.is_dir() and not item.name.startswith("."))
        for parent in sorted(parents, key=lambda item: item.name.casefold()):
            packages = sorted(parent.glob("*.booksync"), key=lambda item: item.name.casefold())
            if len(packages) != 1:
                self.store.event(None, "warning", "scan", f"{parent.name}: expected one package, found {len(packages)}")
                continue
            self.store.upsert_package(parent, packages[0])
        self.snapshot.write("Queue scanned")

    def check_stop(self) -> None:
        if self.stop_file.exists():
            raise UploadStopped("Stop requested")

    def preflight(self) -> None:
        token = os.environ.get("HF_TOKEN") or get_token()
        if not token:
            raise RuntimeError("HF_TOKEN is unavailable")
        self.api = HfApi(token=token)
        identity = self.api.whoami()
        info = self.api.repo_info(self.repo, repo_type="dataset", revision=self.revision)
        self.store.set_meta("authenticated_as", str(identity.get("name", "unknown")))
        self.store.set_meta("remote_sha", str(info.sha or ""))

    def modes(self) -> list[str]:
        modes = ["xet", "xet-retry"]
        if physical_memory_gb() >= 64:
            modes.append("xet-high-performance")
        modes.append("http-fallback")
        preferred = self.store.get_meta("preferred_transport")
        if not preferred:
            result_path = self.state_dir / "canary-result.json"
            if result_path.is_file():
                try:
                    preferred = str(json.loads(result_path.read_text(encoding="utf-8")).get("best", {}).get("mode", ""))
                except (OSError, ValueError, AttributeError):
                    preferred = ""
        if preferred in modes:
            modes.remove(preferred)
            modes.insert(0, preferred)
        return modes

    @staticmethod
    def classify(error: Exception) -> str:
        message = str(error).casefold()
        if "token refresh" in message or "xet-write-token" in message:
            return "xet-auth-refresh"
        if "401" in message or "403" in message or "unauthorized" in message or "forbidden" in message:
            return "authentication"
        if "cas-server" in message or "xethub" in message or "xet" in message:
            return "xet-network"
        if "connection" in message or "timeout" in message or "network" in message:
            return "network"
        return "upload"

    def transfer_environment(self, mode: str) -> dict[str, str]:
        environment = dict(os.environ)
        environment.pop("HF_XET_HIGH_PERFORMANCE", None)
        environment.pop("HF_HUB_DISABLE_XET", None)
        environment.update({"NO_COLOR": "1", "PYTHONUNBUFFERED": "1"})
        if mode == "xet-high-performance":
            environment["HF_XET_HIGH_PERFORMANCE"] = "1"
        elif mode == "http-fallback":
            environment["HF_HUB_DISABLE_XET"] = "1"
        return environment

    def upload_command(self, source: Path, path_in_repo: str, message: str) -> list[str]:
        executable = shutil.which("hf")
        if not executable:
            raise RuntimeError("The Hugging Face 'hf' CLI is unavailable")
        return [executable, "upload", self.repo, str(source), path_in_repo, "--repo-type", "dataset",
                "--revision", self.revision, "--exclude", "*.zip", "--exclude", ".cache/**",
                "--commit-message", message]

    def run_transfer(self, source: Path, path_in_repo: str, mode: str, book_id: str | None,
                     total_bytes: int, message: str) -> tuple[str, TransferProgress, float]:
        if self.dry_run:
            return "dry-run", TransferProgress(transferred=total_bytes, total=total_bytes, speed_bps=total_bytes), 0.01
        output_queue: queue.Queue[bytes | None] = queue.Queue()
        process = subprocess.Popen(
            self.upload_command(source, path_in_repo, message), cwd=ROOT, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, env=self.transfer_environment(mode), bufsize=0,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        child_job = ChildProcessJob(process)
        child_job.__enter__()

        def reader() -> None:
            assert process.stdout
            while True:
                chunk = process.stdout.read(4096)
                if not chunk:
                    break
                output_queue.put(chunk)
            output_queue.put(None)

        threading.Thread(target=reader, daemon=True).start()
        started, progress, output, ended = time.monotonic(), TransferProgress(total=total_bytes), bytearray(), False
        samples: list[tuple[float, int]] = [(started, 0)]
        next_network_sample = started
        last_movement = started
        previous_transferred = 0
        speed_source = "hf-progress"
        while process.poll() is None or not ended:
            if self.stop_file.exists():
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                child_job.__exit__(None, None, None)
                raise UploadStopped("Stop requested during transfer")
            try:
                chunk = output_queue.get(timeout=0.75)
                if chunk is None:
                    ended = True
                else:
                    output.extend(chunk)
                    progress = parse_progress(output[-65536:].decode("utf-8", errors="replace"), progress)
            except queue.Empty:
                pass
            now = time.monotonic()
            if now >= next_network_sample:
                network_speed = sample_network_send_bps()
                next_network_sample = now + 5
                if network_speed > 32 * 1024:
                    # The interface counter is system-wide: browsers, sync tools, and
                    # other uploads contribute to it.  It is therefore safe only as a
                    # speed fallback and must never advance this upload's byte count.
                    # HF CLI output is the authoritative transfer-progress source.
                    if progress.speed_bps <= 0:
                        progress.speed_bps = network_speed
                        speed_source = "system-network"
            if progress.transferred > samples[-1][1]:
                samples.append((now, progress.transferred))
            if progress.transferred > previous_transferred:
                last_movement = now
                previous_transferred = progress.transferred
            samples = [sample for sample in samples if now - sample[0] <= 60] or [samples[-1]]
            if len(samples) > 1 and samples[-1][0] > samples[0][0]:
                rolling = (samples[-1][1] - samples[0][1]) / (samples[-1][0] - samples[0][0])
                if rolling > 0:
                    progress.speed_bps = rolling
                    speed_source = "rolling-60s"
            idle_seconds = now - last_movement
            if idle_seconds >= 900:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                child_job.__exit__(None, None, None)
                raise RuntimeError("Transfer stalled for 15 minutes with no byte movement")
            stall_note = ""
            if idle_seconds >= 300:
                stall_note = " WARNING: no byte movement for 5 minutes"
            elif idle_seconds >= 90:
                stall_note = " warning: no byte movement for 90 seconds"
            if book_id:
                elapsed = max(0.01, now - started)
                self.store.update(book_id, state="uploading", transport=mode,
                                  transferred_bytes=progress.transferred, speed_bps=progress.speed_bps,
                                  average_bps=progress.transferred / elapsed, files_done=progress.files_done,
                                  files_total=progress.files_total, committed=progress.committed,
                                  last_movement_at=utc_now() if progress.transferred > 0 else None,
                                  speed_source=speed_source)
                self.snapshot.write((progress.message or f"Uploading with {mode}") + stall_note)
            else:
                elapsed = max(0.01, now - started)
                observed = progress.speed_bps or (progress.transferred / elapsed)
                self.snapshot.write(
                    f"Canary {mode}: {human_bytes(progress.transferred)}/{human_bytes(total_bytes)} "
                    f"at {human_bytes(observed)}/s"
                )
        elapsed = max(0.01, time.monotonic() - started)
        child_job.__exit__(None, None, None)
        rendered = ANSI_RE.sub("", output.decode("utf-8", errors="replace")).replace("\r", "\n")
        if process.returncode:
            raise RuntimeError(rendered[-8000:] or f"hf upload failed with exit {process.returncode}")
        return rendered, progress, elapsed

    def verify_remote_package(self, package: Path) -> str:
        assert self.api
        info = self.api.repo_info(self.repo, repo_type="dataset", revision=self.revision, files_metadata=True)
        siblings = {item.rfilename: item for item in info.siblings or []}
        paths = set(siblings)
        expected = {f"{package.name}/{item.relative_to(package).as_posix()}" for item in package.rglob("*")
                    if item.is_file() and item.suffix.casefold() != ".zip" and ".cache" not in item.parts}
        missing = sorted(expected - paths)
        if missing:
            raise RuntimeError(f"Remote verification found {len(missing)} missing files: {missing[:8]}")
        token = os.environ.get("HF_TOKEN") or get_token()
        for control_name in ("manifest.json", "checksums.json"):
            remote_file = Path(hf_hub_download(
                repo_id=self.repo, filename=f"{package.name}/{control_name}", repo_type="dataset",
                revision=self.revision, token=token, force_download=True,
            ))
            local_file = package / control_name
            if hashlib.sha256(remote_file.read_bytes()).digest() != hashlib.sha256(local_file.read_bytes()).digest():
                raise RuntimeError(f"Remote {control_name} hash does not match the local package")
        checksum_data = json.loads((package / "checksums.json").read_text(encoding="utf-8"))
        checksum_files = checksum_data.get("files", [])
        sample_indexes = sorted({0, len(checksum_files) // 2, max(0, len(checksum_files) - 1)})
        for index in sample_indexes:
            if not checksum_files:
                break
            record = checksum_files[index]
            remote_item = siblings.get(f"{package.name}/{record['path']}")
            lfs = getattr(remote_item, "lfs", None) if remote_item else None
            remote_hash = getattr(lfs, "sha256", None) if lfs else None
            if remote_hash and remote_hash != record["sha256"]:
                raise RuntimeError(f"Remote asset hash mismatch: {record['path']}")
        return str(info.sha or "")

    def publish_catalog(self, package: Path) -> str:
        assert self.api
        manifest_path = f"{package.name}/manifest.json"
        catalog = merged_catalog(remote_catalog(self.repo, self.revision), manifest_path)
        commit = self.api.upload_file(
            path_or_fileobj=(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n").encode(),
            path_in_repo="library.json", repo_id=self.repo, repo_type="dataset",
            revision=self.revision, commit_message=f"Catalog {package.stem}",
        )
        refreshed = remote_catalog(self.repo, self.revision)
        paths = {item.get("manifest_path") for item in (refreshed or {}).get("books", []) if isinstance(item, dict)}
        if manifest_path not in paths:
            raise RuntimeError("Catalog verification failed")
        return str(commit)

    def reconcile_catalog(self) -> dict[str, Any]:
        self.preflight()
        assert self.api
        info = self.api.repo_info(self.repo, repo_type="dataset", revision=self.revision, files_metadata=True)
        manifest_paths = sorted(
            (item.rfilename for item in info.siblings or []
             if item.rfilename.endswith(".booksync/manifest.json")),
            key=str.casefold,
        )
        current = remote_catalog(self.repo, self.revision)
        catalog: dict[str, Any] | None = {
            "format": "booksync-library", "schema_version": 1,
            "name": (current or {}).get("name", "BookSync Library"), "books": [],
        }
        for manifest_path in manifest_paths:
            catalog = merged_catalog(catalog, manifest_path)
        commit = self.api.upload_file(
            path_or_fileobj=(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n").encode("utf-8"),
            path_in_repo="library.json", repo_id=self.repo, repo_type="dataset", revision=self.revision,
            commit_message="Reconcile BookSync library catalog from remote manifests",
        )
        verified = remote_catalog(self.repo, self.revision)
        actual = {item.get("manifest_path") for item in (verified or {}).get("books", []) if isinstance(item, dict)}
        if actual != set(manifest_paths):
            raise RuntimeError("Reconciled catalog verification failed")
        result = {"books": len(manifest_paths), "commit_url": str(commit), "remote_sha": str(info.sha or "")}
        self.store.event(None, "info", "reconcile", json.dumps(result))
        return result

    def process_book(self, row: sqlite3.Row) -> None:
        book_id, package, parent = str(row["id"]), Path(row["package_path"]), Path(row["parent_path"])
        total_bytes = int(row["total_bytes"])
        started_at = utc_now()
        self.store.update(book_id, state="validating", last_error=None, transferred_bytes=0, speed_bps=0,
                          started_at=started_at, completed_at=None, verified_at=None,
                          destination_path=str(self.destination / parent.name), files_total=int(row["file_count"]))
        self.store.event(book_id, "info", "start", f"Started {package.name} at {started_at}")
        self.snapshot.write(f"Validating {package.name}")
        issues = validate_package(package)
        if issues:
            message = "; ".join(str(issue) for issue in issues[:12])
            self.store.update(book_id, state="quarantined", last_error=message)
            self.store.event(book_id, "error", "validation", message)
            return
        _, scorecard = score_package(package)
        if scorecard["grade"] == "F":
            message = f"Quality gate rejected score {scorecard['score']}/100 (grade F)"
            self.store.update(book_id, state="quarantined", last_error=message)
            self.store.event(book_id, "error", "quality", message)
            self.snapshot.write(f"Quarantined {package.name}: {message}")
            return

        # A previous upload can finish transferring every file but be interrupted
        # before cataloging/moving the local package.  Reuse that verified remote
        # copy instead of retransmitting the whole book.
        remote_sha: str | None = None
        try:
            assert self.api
            remote_info = self.api.repo_info(
                self.repo, repo_type="dataset", revision=self.revision, files_metadata=False
            )
            remote_manifest = f"{package.name}/manifest.json"
            remote_paths = {item.rfilename for item in remote_info.siblings or []}
            if remote_manifest in remote_paths:
                self.store.update(book_id, state="verifying", transport="remote-existing")
                self.snapshot.write(f"Verifying existing remote copy of {package.name}")
                remote_sha = self.verify_remote_package(package)
        except Exception as error:
            self.store.event(
                book_id, "warning", "remote-reuse",
                f"Existing remote copy could not be reused; upload required: {error}",
            )
            remote_sha = None

        if remote_sha is not None:
            self.store.update(book_id, state="cataloging", remote_sha=remote_sha, verified_at=utc_now())
            commit_url = self.publish_catalog(package)
            self.store.update(book_id, state="moving", commit_url=commit_url)
            self.destination.mkdir(parents=True, exist_ok=True)
            destination = self.destination / parent.name
            if destination.exists():
                raise RuntimeError(f"Destination already exists: {destination}")
            shutil.move(str(parent), str(destination))
            completed_at = utc_now()
            self.store.update(
                book_id, state="complete", completed_at=completed_at, last_error=None,
                transferred_bytes=total_bytes, speed_bps=0, average_bps=0,
                files_done=int(row["file_count"]), files_total=int(row["file_count"]),
                committed=1,
            )
            self.store.event(
                book_id, "info", "finish",
                f"Finished {package.name} at {completed_at}; reused verified remote files; no retransmission",
            )
            self.snapshot.write(f"Completed {package.name} from verified remote copy")
            return

        last_error: Exception | None = None
        for attempt, mode in enumerate(self.modes(), 1):
            self.check_stop()
            self.store.update(book_id, state="uploading", transport=mode, attempt=attempt, last_error=None)
            try:
                _, progress, elapsed = self.run_transfer(package, package.name, mode, book_id, total_bytes,
                                                          f"Publish {package.stem} BookSync package")
                effective_speed = total_bytes / elapsed
                self.store.update(book_id, state="committing", transferred_bytes=max(progress.transferred, total_bytes),
                                  speed_bps=progress.speed_bps or effective_speed, average_bps=effective_speed)
                self.store.update(book_id, state="verifying")
                remote_sha = self.verify_remote_package(package)
                self.store.update(book_id, state="cataloging", remote_sha=remote_sha, verified_at=utc_now())
                commit_url = self.publish_catalog(package)
                self.store.update(book_id, state="moving", commit_url=commit_url)
                self.destination.mkdir(parents=True, exist_ok=True)
                destination = self.destination / parent.name
                if destination.exists():
                    raise RuntimeError(f"Destination already exists: {destination}")
                shutil.move(str(parent), str(destination))
                completed_at = utc_now()
                self.store.update(book_id, state="complete", completed_at=completed_at, last_error=None,
                                  files_done=int(row["file_count"]), files_total=int(row["file_count"]),
                                  committed=max(1, int(progress.committed or 0)))
                self.store.event(book_id, "info", "finish",
                                 f"Finished {package.name} at {completed_at}; transfer={elapsed:.1f}s; speed={human_bytes(effective_speed)}/s")
                self.snapshot.write(f"Completed {package.name} at {human_bytes(effective_speed)}/s effective")
                return
            except UploadStopped:
                raise
            except Exception as error:
                last_error = error
                classification = self.classify(error)
                self.store.update(book_id, state="retrying", last_error=f"{classification}: {error}")
                self.store.event(book_id, "warning", "retry", f"{classification}: {error}")
                self.snapshot.write(f"{package.name} failed with {classification}; trying fallback")
                time.sleep(min(20, 2**attempt))
        assert last_error
        self.store.update(book_id, state="failed", last_error=str(last_error))

    @staticmethod
    def micro_batches(rows: list[sqlite3.Row], max_books: int = 3, max_bytes: int = 2 * 1024**3) -> list[list[sqlite3.Row]]:
        batches: list[list[sqlite3.Row]] = []
        current: list[sqlite3.Row] = []
        current_bytes = 0
        for row in rows:
            size = int(row["total_bytes"] or 0)
            if current and (len(current) >= max_books or current_bytes + size > max_bytes):
                batches.append(current)
                current, current_bytes = [], 0
            current.append(row)
            current_bytes += size
        if current:
            batches.append(current)
        return batches

    def run(self) -> int:
        self.stop_file.unlink(missing_ok=True)
        self.store.reset_interrupted()
        self.store.set_meta("supervisor_state", "starting")
        self.scan()
        self.store.set_meta("supervisor_state", "authenticating")
        self.snapshot.write("Authenticating")
        self.preflight()
        self.store.set_meta("supervisor_state", "running")
        try:
            pending = self.store.pending()
            if self.only:
                pending = [row for row in pending if row["package_name"].casefold() == self.only.casefold()]
                if not pending:
                    raise RuntimeError(f"Requested package is not queued: {self.only}")
            for batch_number, batch in enumerate(self.micro_batches(pending), 1):
                batch_id = f"batch-{batch_number:03d}-{uuid.uuid4().hex[:6]}"
                for row in batch:
                    self.store.update(str(row["id"]), batch_id=batch_id)
                self.store.event(None, "info", "batch",
                                 f"Starting {batch_id}: {len(batch)} book(s), {human_bytes(sum(int(row['total_bytes']) for row in batch))}")
                for row in batch:
                    self.check_stop()
                    self.process_book(row)
        except UploadStopped as stopped:
            self.store.set_meta("supervisor_state", "paused")
            self.snapshot.write(str(stopped))
            return 2
        self.store.set_meta("supervisor_state", "complete")
        self.snapshot.write("Queue finished")
        return 0

    def canary(self, size_mb: int, keep_remote: bool = False, benchmark_all: bool = False) -> dict[str, Any]:
        self.stop_file.unlink(missing_ok=True)
        self.store.set_meta("supervisor_state", "canary")
        self.snapshot.write("Running remote canary")
        self.preflight()
        assert self.api
        canary_id = f"booksync-upload-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        with tempfile.TemporaryDirectory(prefix="booksync-canary-") as temporary:
            folder = Path(temporary) / canary_id
            folder.mkdir()
            bytes_per_file = max(1024 * 1024, size_mb * 1024 * 1024 // 4)
            for index in range(4):
                (folder / f"random-{index + 1:02d}.bin").write_bytes(os.urandom(bytes_per_file))
            (folder / "canary.json").write_text(json.dumps({"format": "booksync-upload-canary",
                "created_at": utc_now(), "files": 4, "requested_mb": size_mb}, indent=2) + "\n", encoding="utf-8")
            total = sum(item.stat().st_size for item in folder.iterdir() if item.is_file())
            attempts: list[dict[str, Any]] = []
            successful: list[dict[str, Any]] = []
            modes = ["xet", "http-fallback"] if benchmark_all else self.modes()
            for mode_index, mode in enumerate(modes):
                if benchmark_all and mode_index:
                    for index in range(4):
                        (folder / f"random-{index + 1:02d}.bin").write_bytes(os.urandom(bytes_per_file))
                remote_path = f"_canary/{canary_id}-{mode}"
                started = time.monotonic()
                try:
                    _, progress, elapsed = self.run_transfer(folder, remote_path, mode, None, total,
                                                              f"BookSync upload canary {canary_id}")
                    info = self.api.repo_info(self.repo, repo_type="dataset", revision=self.revision, files_metadata=True)
                    paths = {item.rfilename for item in info.siblings or []}
                    expected = {f"{remote_path}/{item.name}" for item in folder.iterdir() if item.is_file()}
                    if expected - paths:
                        raise RuntimeError(f"Canary verification missing: {sorted(expected - paths)}")
                    effective = total / elapsed
                    success = {"mode": mode, "bytes": total, "seconds": elapsed,
                               "effective_bps": effective, "reported_bps": progress.speed_bps,
                               "remote_path": remote_path}
                    attempts.append({"success": True, **success})
                    successful.append(success)
                    if not keep_remote:
                        self.api.delete_folder(repo_id=self.repo, path_in_repo=remote_path, repo_type="dataset",
                                               revision=self.revision,
                                               commit_message=f"Remove upload canary {canary_id}-{mode}")
                    if not benchmark_all:
                        break
                except Exception as error:
                    attempts.append({"mode": mode, "success": False, "seconds": time.monotonic() - started,
                                     "classification": self.classify(error), "error": str(error)[-2000:]})
            best = max(successful, key=lambda item: item["effective_bps"]) if successful else None
            if best:
                self.store.set_meta("preferred_transport", str(best["mode"]))
            result = {"success": bool(successful), "repo": self.repo, "ram_gb": round(physical_memory_gb(), 1),
                      "attempts": attempts, "best": best,
                      "cleaned_up": bool(successful and not keep_remote)}
            (self.state_dir / "canary-result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            self.store.set_meta("supervisor_state", "stopped")
            if best:
                self.snapshot.write(f"Canary passed: {human_bytes(best['effective_bps'])}/s using {best['mode']}")
            else:
                self.snapshot.write("Canary failed; real queue was not started")
            return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["scan", "run", "stop", "status", "canary", "reconcile"])
    parser.add_argument("--queue", type=Path, default=ROOT / "local-data" / "books" / "upload_ready")
    parser.add_argument("--destination", type=Path, default=Path(r"C:\Users\Mushfiq\Downloads\BookSync"))
    parser.add_argument("--repo", default="mdrahman/booksync-library")
    parser.add_argument("--revision", default="main")
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--log", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--canary-mb", type=int, default=16)
    parser.add_argument("--keep-canary", action="store_true")
    parser.add_argument("--benchmark-all", action="store_true")
    parser.add_argument("--only", help="Run exactly one queued package name")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    state_dir = (args.state_dir or args.queue / ".upload-state").resolve()
    log_path = (args.log or args.queue / "live.txt").resolve()
    if args.command == "stop":
        state_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / "STOP").write_text(utc_now() + "\n", encoding="utf-8")
        state = StateStore(state_dir / "upload_queue.sqlite3")
        try:
            state.set_meta("supervisor_state", "pause_requested")
        finally:
            state.close()
        deadline = time.monotonic() + 20
        lock_file = state_dir / "supervisor.lock"
        while lock_file.exists() and time.monotonic() < deadline:
            time.sleep(0.5)
        if lock_file.exists():
            print(f"Pause requested; supervisor has not confirmed shutdown yet: {lock_file}")
            return 2
        print("Upload supervisor paused; no upload child remains")
        return 0
    supervisor = UploadSupervisor(args.queue, args.destination, args.repo, args.revision,
                                  state_dir, log_path, args.dry_run, args.only)
    try:
        if args.command in {"scan", "status"}:
            supervisor.scan()
            if args.command == "status":
                print(log_path.read_text(encoding="utf-8"))
            return 0
        with SingleInstance(args.repo, state_dir):
            if args.command == "reconcile":
                print(json.dumps(supervisor.reconcile_catalog(), indent=2))
                return 0
            if args.command == "canary":
                result = supervisor.canary(args.canary_mb, args.keep_canary, args.benchmark_all)
                print(json.dumps(result, indent=2))
                return 0 if result["success"] else 1
            return supervisor.run()
    finally:
        supervisor.close()


if __name__ == "__main__":
    raise SystemExit(main())
