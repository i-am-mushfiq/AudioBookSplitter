#!/usr/bin/env python3
"""Run a recoverable multi-book BookSync pipeline with one sequential GPU lane.

Each EPUB/PDF is paired with a neighbouring audiobook folder. Once one book's
transcript checkpoint exists, its CPU alignment/render/package work continues
while the next book takes the GPU. Completed packages enter one upload lane.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
EVENT_PREFIX = "BOOKSYNC_BATCH_EVENT "
PROCESSOR_EVENT_PREFIX = "BOOKSYNC_EVENT "
BOOK_EXTENSIONS = {".epub", ".pdf"}
AUDIO_EXTENSIONS = {".mp3", ".m4a", ".m4b", ".aac", ".wav", ".flac", ".ogg", ".opus", ".wma", ".mp4"}
COVER_NAMES = {"cover.jpg", "cover.jpeg", "cover.png", "cover.webp", "folder.jpg", "folder.png"}


def emit(kind: str, **details: Any) -> None:
    # ASCII JSON keeps event streaming reliable in Windows processes whose
    # inherited console code page cannot encode every filename character.
    print(EVENT_PREFIX + json.dumps({"type": kind, **details}, ensure_ascii=True), flush=True)


def natural_key(path: Path) -> list[Any]:
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", str(path))]


def clean_title(stem: str) -> str:
    value = re.sub(r"\s*[\[(].*?[\])]", "", stem).replace("_", " ").strip(" ._-")
    return re.sub(r"\s+", " ", value) or stem


def slug(title: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "_", title).strip("_") or "book"
    return s[:50].strip("_")


def words(value: str) -> set[str]:
    ignored = {"the", "a", "an", "and", "of", "to", "book", "audiobook"}
    return {item for item in re.findall(r"[a-z0-9]+", value.casefold()) if len(item) > 1 and item not in ignored}


def folder_score(book: Path, folder: Path) -> tuple[int, int]:
    book_words = words(clean_title(book.stem))
    folder_words = words(folder.name)
    overlap = len(book_words & folder_words)
    return overlap * 100 - abs(len(book_words) - len(folder_words)), -len(str(folder))


def discover(source: Path, only: list[str] | None = None) -> list[dict[str, Any]]:
    excluded = {"processed", "processing", "generated", "prepared-audio", "alternate-copy", "_operations", ".combined", "output", "node_modules"}
    direct_books = [path for path in source.iterdir() if path.is_file() and path.suffix.casefold() in BOOK_EXTENSIONS]
    recursive_books = [path for path in source.rglob("*") if path.is_file() and path.suffix.casefold() in BOOK_EXTENSIONS and not any(part.casefold() in excluded for part in path.relative_to(source).parts)]
    if only:
        wanted = {item.casefold() for item in only}
        candidates = [path for path in recursive_books if path.parent.name.casefold() in wanted]
    elif direct_books:
        candidates = direct_books
    elif recursive_books:
        # Status folders contain one directory per book. Prefer the shallowest
        # source documents so EPUB/PDF copies bundled inside audiobook folders
        # do not create duplicate jobs.
        minimum_depth = min(len(path.relative_to(source).parts) for path in recursive_books)
        candidates = [path for path in recursive_books if len(path.relative_to(source).parts) == minimum_depth]
    else:
        candidates = []
    # EPUB is the canonical batch source. If a folder contains an EPUB plus a
    # convenience PDF copy, never let the PDF claim that folder's audiobook
    # first and make the EPUB appear unmatched.
    epub_parents = {path.parent.resolve() for path in candidates if path.suffix.casefold() == ".epub"}
    candidates = [
        path for path in candidates
        if path.suffix.casefold() == ".epub" or path.parent.resolve() not in epub_parents
    ]
    books = sorted(candidates, key=natural_key)
    jobs: list[dict[str, Any]] = []
    used_audio: set[Path] = set()
    for book in books:
        folders = [item for item in book.parent.iterdir() if item.is_dir() and item.name.casefold() not in excluded]
        ranked = sorted(folders, key=lambda item: folder_score(book, item), reverse=True)
        chosen: Path | None = None
        audio: list[Path] = []
        for folder in ranked:
            if folder_score(book, folder)[0] <= 0:
                continue
            candidates = sorted((item for item in folder.rglob("*") if item.is_file() and item.suffix.casefold() in AUDIO_EXTENSIONS and item.resolve() not in used_audio), key=natural_key)
            if candidates:
                chosen, audio = folder, candidates
                break
        if not audio:
            # Some ready folders keep the book document and a multi-part or
            # split audiobook side by side instead of inside a neighbouring
            # audio subfolder. Treat all direct audio files as one audiobook;
            # prepare_audio() will concatenate them in natural order.
            candidates = sorted((item for item in book.parent.iterdir() if item.is_file() and item.suffix.casefold() in AUDIO_EXTENSIONS and item.resolve() not in used_audio), key=natural_key)
            # Prefer split MP3 parts when a folder also contains a single
            # full-length M4B; the latter is commonly a duplicate rip.
            mp3_parts = [item for item in candidates if item.suffix.casefold() == ".mp3"]
            if len(mp3_parts) > 1 and any(item.suffix.casefold() == ".m4b" for item in candidates):
                candidates = mp3_parts
            if candidates:
                audio = candidates
        if not audio:
            emit("warning", title=clean_title(book.stem), message="No matching neighbouring audiobook folder was found", book=str(book))
            continue
        used_audio.update(item.resolve() for item in audio)
        covers = sorted((item for item in (chosen or book.parent).rglob("*") if item.is_file() and item.name.casefold() in COVER_NAMES), key=natural_key)
        title = clean_title(book.stem)
        jobs.append({"id": slug(title), "title": title, "book": str(book.resolve()), "audio_parts": [str(item.resolve()) for item in audio], "cover": str(covers[0].resolve()) if covers else None})
    return jobs


def ffconcat_escape(path: Path) -> str:
    return str(path).replace("'", "'\\''")


def prepare_audio(job: dict[str, Any], job_output: Path) -> Path:
    parts = [Path(item) for item in job["audio_parts"]]
    if len(parts) == 1:
        return parts[0]
    combined_dir = job_output / ".prepared"
    combined_dir.mkdir(parents=True, exist_ok=True)
    concat_file = combined_dir / "audiobook.ffconcat"
    concat_file.write_text("ffconcat version 1.0\n" + "\n".join(f"file '{ffconcat_escape(item)}'" for item in parts) + "\n", encoding="utf-8")
    copied = combined_dir / f"{job['id']}{parts[0].suffix.casefold()}"
    emit("book", bookId=job["id"], title=job["title"], stage="preparing_audio", workload="cpu", percent=4, message=f"Joining {len(parts)} audiobook files")
    result = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(copied)], capture_output=True, text=True)
    if result.returncode == 0:
        return copied
    encoded = combined_dir / f"{job['id']}.mp3"
    result = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c:a", "libmp3lame", "-q:a", "2", str(encoded)], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "FFmpeg could not join the audiobook files")
    return encoded


def pipe_output(process: subprocess.Popen[str], job: dict[str, Any], log_path: Path) -> None:
    assert process.stdout
    with log_path.open("a", encoding="utf-8") as log:
        for line in process.stdout:
            line = line.rstrip()
            log.write(line + "\n"); log.flush()
            if line.startswith(PROCESSOR_EVENT_PREFIX):
                try:
                    event = json.loads(line[len(PROCESSOR_EVENT_PREFIX):])
                    stage = str(event.get("stage", "processing"))
                    emit("book", bookId=job["id"], title=job["title"], workload="gpu" if stage == "transcribing" else "cpu", **event)
                    continue
                except (ValueError, TypeError):
                    pass
            if line:
                emit("log", source=job["title"], message=line)


def start_book(job: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    output = args.output / job["id"]
    output.mkdir(parents=True, exist_ok=True)
    audio = prepare_audio(job, output)
    command = [sys.executable, str(ROOT / "pdf_audiobook_splitter.py"), "--book", job["book"], "--audio", str(audio), "--output", str(output), "--book-name", job["title"], "--model", args.model, "--device", args.device, "--minutes", str(args.minutes), "--mode", args.mode, "--window-seconds", "300", "--resume"]
    if job.get("cover"):
        command.extend(["--cover", job["cover"]])
    process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    thread = threading.Thread(target=pipe_output, args=(process, job, output / "processor.log"), daemon=True)
    thread.start()
    return {"job": job, "process": process, "thread": thread, "output": output, "transcript": output / "transcript.json", "package": output / f"{job['id']}.booksync"}


def upload_worker(items: "queue.Queue[dict[str, Any] | None]", args: argparse.Namespace, failures: list[str]) -> None:
    while True:
        entry = items.get()
        if entry is None:
            return
        job, package = entry["job"], entry["package"]
        emit("upload", bookId=job["id"], title=job["title"], stage="uploading", percent=10, message="Validating and uploading package")
        command = [sys.executable, str(ROOT / "tools" / "publish_huggingface_package.py"), str(package), "--repo", args.repo, "--revision", "main"]
        process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        assert process.stdout
        for line in process.stdout:
            line = line.rstrip()
            if line.startswith(PROCESSOR_EVENT_PREFIX):
                try:
                    event = json.loads(line[len(PROCESSOR_EVENT_PREFIX):])
                    emit("upload", bookId=job["id"], title=job["title"], **event)
                    continue
                except (ValueError, TypeError):
                    pass
            if line:
                emit("log", source=f"Upload · {job['title']}", message=line)
        code = process.wait()
        if code:
            failures.append(f"Upload failed for {job['title']} (exit {code})")
            emit("upload", bookId=job["id"], title=job["title"], stage="failed", percent=0, message="Upload failed")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    parser.add_argument("--minutes", type=float, default=10)
    parser.add_argument("--mode", choices=["smart", "chapter", "fixed"], default="smart")
    parser.add_argument("--repo", default="mdrahman/booksync-library")
    parser.add_argument("--auto-upload", action="store_true")
    parser.add_argument("--only", action="append", help="Process only the named immediate source folders (repeatable)")
    args = parser.parse_args()
    args.source, args.output = args.source.resolve(), args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    jobs = discover(args.source, args.only)
    if not jobs:
        raise RuntimeError("No EPUB/PDF and neighbouring audiobook-folder pairs were found")
    emit("started", books=[{"bookId": item["id"], "title": item["title"], "audioFiles": len(item["audio_parts"])} for item in jobs], source=str(args.source), output=str(args.output), autoUpload=args.auto_upload)

    uploads: "queue.Queue[dict[str, Any] | None]" = queue.Queue()
    failures: list[str] = []
    upload_thread = threading.Thread(target=upload_worker, args=(uploads, args, failures), daemon=True)
    if args.auto_upload:
        upload_thread.start()
    pending_jobs = list(jobs)
    running_jobs = []
    queued_for_upload = set()
    gpu_job = None

    while pending_jobs or running_jobs:
        # 1. Start next job on GPU if GPU is idle and there are pending jobs
        if gpu_job is None and pending_jobs:
            job = pending_jobs.pop(0)
            package = args.output / job["id"] / f"{job['id']}.booksync"
            progress = args.output / job["id"] / "processing-progress.json"
            if package.joinpath("manifest.json").is_file() and progress.is_file():
                emit("book", bookId=job["id"], title=job["title"], stage="complete", workload="done", percent=100, message="Recovered completed package")
                if args.auto_upload:
                    uploads.put({"job": job, "package": package})
                    queued_for_upload.add(job["id"])
            else:
                try:
                    entry = start_book(job, args)
                    running_jobs.append(entry)
                    gpu_job = entry
                    emit("scheduler", gpuBook=job["title"], queued=len(pending_jobs), message="GPU transcription lane started; completed transcripts move to CPU work")
                except Exception as error:
                    failures.append(f"{job['title']}: {error}")
                    emit("book", bookId=job["id"], title=job["title"], stage="failed", workload="cpu", percent=0, message=str(error))

        # 2. Check if the GPU job has finished its transcription phase
        if gpu_job is not None:
            if gpu_job["transcript"].is_file():
                emit("scheduler", gpuBook=None, cpuBook=gpu_job["job"]["title"], message="Transcript complete; next book may take the GPU while this book continues on CPU")
                gpu_job = None
            elif gpu_job["process"].poll() is not None:
                emit("scheduler", gpuBook=None, message="GPU job process exited unexpectedly")
                gpu_job = None

        # 3. Check for any running jobs that have completed entirely
        still_running = []
        for entry in running_jobs:
            job = entry["job"]
            poll_code = entry["process"].poll()
            if poll_code is not None:
                entry["thread"].join(timeout=2)
                if poll_code or not entry["package"].joinpath("manifest.json").is_file():
                    failures.append(f"Processing failed for {job['title']} (exit {poll_code})")
                    emit("book", bookId=job["id"], title=job["title"], stage="failed", workload="done", percent=0, message="Processing did not produce a package")
                else:
                    emit("book", bookId=job["id"], title=job["title"], stage="complete", workload="done", percent=100, message="Package ready")
                    if args.auto_upload and job["id"] not in queued_for_upload:
                        uploads.put(entry)
                        queued_for_upload.add(job["id"])
            else:
                still_running.append(entry)
        running_jobs = still_running

        time.sleep(2)

    if args.auto_upload:
        uploads.put(None); upload_thread.join()
    emit("finished", success=not failures, failures=failures, message="Pipeline complete" if not failures else "Pipeline completed with errors")
    return 0 if not failures else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        emit("finished", success=False, failures=[str(error)], message=str(error))
        raise
