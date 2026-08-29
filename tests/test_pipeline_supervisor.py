from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.booksync_batch_pipeline import discover
from tools.booksync_pipeline_supervisor import ControllerAudit, Store, Supervisor, atomic_text, discover_ready


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "minimal.booksync"


class PipelineSupervisorTests(unittest.TestCase):
    def args(self, root: Path) -> argparse.Namespace:
        return argparse.Namespace(
            source=root / "ready", processed=root / "processed", in_hugging_face=root / "in_hf",
            output=root / "raw", upload_ready=root / "upload_ready", destination=root / "downloads",
            state_dir=root / "state", model="tiny", device="cpu", minutes=10.0, mode="smart",
            repo="owner/library", auto_upload=True, max_cpu=2, max_processors=3,
        )

    def seed(self, supervisor: Supervisor) -> None:
        source = supervisor.paths["source"] / "Synthetic Source"
        source.mkdir(parents=True)
        book = source / "Synthetic.epub"
        audio = source / "Synthetic.mp3"
        book.write_bytes(b"epub")
        audio.write_bytes(b"audio")
        supervisor.store.upsert(
            {"id": "Synthetic", "title": "Synthetic", "book": str(book),
             "audio_parts": [str(audio)], "cover": None}, supervisor.paths["output"],
        )

    def test_packaged_and_uploaded_boundaries_move_the_correct_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            supervisor = Supervisor(self.args(Path(directory)))
            self.seed(supervisor)
            raw_package = supervisor.paths["output"] / "Synthetic" / "Synthetic.booksync"
            raw_package.parent.mkdir(parents=True)
            shutil.copytree(EXAMPLE, raw_package)

            supervisor.finish_package("Synthetic", raw_package)
            self.assertFalse((supervisor.paths["source"] / "Synthetic Source").exists())
            self.assertTrue((supervisor.paths["processed"] / "Synthetic Source").is_dir())
            staged = supervisor.paths["upload_ready"] / "Synthetic" / "Synthetic.booksync"
            self.assertTrue(staged.is_dir())

            final = supervisor.paths["destination"] / "Synthetic" / "Synthetic.booksync"
            final.parent.mkdir(parents=True)
            shutil.move(str(staged), str(final))
            database = supervisor.paths["upload_ready"] / ".upload-state" / "upload_queue.sqlite3"
            database.parent.mkdir(parents=True)
            connection = sqlite3.connect(database)
            connection.execute("CREATE TABLE books(package_name TEXT,state TEXT,updated_at TEXT,verified_at TEXT,remote_sha TEXT)")
            # Simulate power loss after remote verification and the Downloads
            # move, but before the uploader's final `complete` state update.
            connection.execute("INSERT INTO books VALUES('Synthetic.booksync','moving','now','now','abc')")
            connection.commit(); connection.close()

            supervisor.reconcile()
            row = supervisor.store.row("Synthetic")
            self.assertEqual(row["state"], "complete")
            self.assertEqual(row["source_location"], "in_hugging_face")
            self.assertTrue((supervisor.paths["in_hugging_face"] / "Synthetic Source").is_dir())
            supervisor.store.close()

    def test_interrupted_active_work_returns_to_recoverable_queue(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "pipeline.sqlite3")
            source = Path(directory) / "book"
            source.mkdir()
            book, audio = source / "book.epub", source / "book.mp3"
            book.write_bytes(b"epub"); audio.write_bytes(b"audio")
            store.upsert({"id": "book", "title": "Book", "book": str(book),
                          "audio_parts": [str(audio)], "cover": None}, Path(directory) / "raw")
            store.update("book", state="transcribing", stage="transcribing", workload="gpu")
            store.reset_interrupted()
            row = store.row("book")
            self.assertEqual(row["state"], "queued")
            self.assertEqual(row["stage"], "recovering")
            store.close()

    def test_pause_is_durable_and_stops_upload_lane(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            supervisor = Supervisor(self.args(Path(directory)))
            supervisor.pause()
            self.assertTrue((Path(directory) / "state" / "PAUSE").is_file())
            self.assertTrue((Path(directory) / "upload_ready" / ".upload-state" / "STOP").is_file())
            self.assertEqual(supervisor.store.meta("pause_requested"), "1")
            supervisor.store.close()

    def test_discovery_prefers_epub_when_pdf_copy_is_also_present(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            folder = source / "Book"
            folder.mkdir()
            (folder / "Book.epub").write_bytes(b"epub")
            (folder / "Book.pdf").write_bytes(b"pdf")
            (folder / "Book.mp3").write_bytes(b"audio")
            jobs = discover(source)
            self.assertEqual(len(jobs), 1)
            self.assertTrue(jobs[0]["book"].casefold().endswith(".epub"))

    def test_ready_discovery_trusts_book_folder_boundary_for_nested_audio(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            folder = source / "Book Title"
            audio = folder / "Disc 01 - unrelated release name"
            audio.mkdir(parents=True)
            (folder / "Book Title.epub").write_bytes(b"epub")
            (audio / "track01.mp3").write_bytes(b"audio")
            jobs, blocked = discover_ready(source)
            self.assertEqual(blocked, [])
            self.assertEqual(len(jobs), 1)
            self.assertEqual(len(jobs[0]["audio_parts"]), 1)

    def test_concurrent_snapshot_writers_leave_valid_complete_views(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            supervisor = Supervisor(self.args(Path(directory)))
            self.seed(supervisor)
            failures: list[Exception] = []

            def writer(index: int) -> None:
                try:
                    for iteration in range(20):
                        self.assertTrue(supervisor.snapshot.write(f"writer {index}/{iteration}"))
                except Exception as error:  # pragma: no cover - reported by the assertion below
                    failures.append(error)

            threads = [threading.Thread(target=writer, args=(index,)) for index in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            self.assertEqual(failures, [])
            snapshot = json.loads((Path(directory) / "state" / "pipeline-status.json").read_text(encoding="utf-8"))
            self.assertEqual(snapshot["books"][0]["title"], "Synthetic")
            self.assertIn("BOOKSYNC END-TO-END PIPELINE", (Path(directory) / "state" / "live.txt").read_text(encoding="utf-8"))
            self.assertEqual(list((Path(directory) / "state").glob("*.tmp")), [])
            supervisor.store.close()

    def test_snapshot_failure_is_nonfatal_and_persisted_as_an_event(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            supervisor = Supervisor(self.args(Path(directory)))
            self.seed(supervisor)
            with patch("tools.booksync_pipeline_supervisor.atomic_json", side_effect=PermissionError("locked")):
                self.assertFalse(supervisor.snapshot.write("still processing"))
            events = supervisor.store.recent_events()
            self.assertTrue(any(item["stage"] == "snapshot" and item["level"] == "warning" for item in events))
            supervisor.store.close()

    def test_atomic_text_retries_transient_windows_sharing_violation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "status.txt"
            real_replace = __import__("os").replace
            calls = 0

            def flaky_replace(source: Path, destination: Path) -> None:
                nonlocal calls
                calls += 1
                if calls < 3:
                    error = PermissionError(13, "sharing violation")
                    error.winerror = 32
                    raise error
                real_replace(source, destination)

            with patch("tools.booksync_pipeline_supervisor.os.replace", side_effect=flaky_replace):
                atomic_text(target, "healthy\n")
            self.assertEqual(target.read_text(encoding="utf-8"), "healthy\n")
            self.assertEqual(calls, 3)

    def test_controller_audit_is_durable_json_lines(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "controller-history.jsonl"
            audit = ControllerAudit(path)
            audit.record("controller_start", command="resume")
            audit.record("controller_exit", reason="paused", exit_code=2)
            entries = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([item["event"] for item in entries], ["controller_start", "controller_exit"])
            self.assertEqual(entries[-1]["reason"], "paused")


if __name__ == "__main__":
    unittest.main()
