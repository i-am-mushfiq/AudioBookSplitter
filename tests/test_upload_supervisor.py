from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.booksync_upload_supervisor import (
    SingleInstance,
    StateStore,
    TransferProgress,
    UploadSupervisor,
    parse_progress,
    parse_size,
)


class UploadSupervisorTests(unittest.TestCase):
    def test_upload_command_only_uses_supported_hf_upload_arguments(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            supervisor = UploadSupervisor(
                root / "queue", root / "destination", "test/booksync", "main",
                root / "state", root / "live.txt", dry_run=True,
            )
            try:
                with patch("tools.booksync_upload_supervisor.shutil.which", return_value="hf"):
                    command = supervisor.upload_command(root / "package.booksync", "package.booksync", "Test upload")
                self.assertNotIn("--format", command)
                self.assertEqual(command[:4], ["hf", "upload", "test/booksync", str(root / "package.booksync")])
                self.assertIn("--repo-type", command)
                self.assertIn("--commit-message", command)
            finally:
                supervisor.close()

    def test_parse_sizes(self) -> None:
        self.assertEqual(parse_size("147MB"), 147 * 1024 * 1024)
        self.assertEqual(parse_size("1.5 GB/s"), int(1.5 * 1024**3))

    def test_parse_legacy_progress(self) -> None:
        progress = parse_progress(
            "Uploading... 151/151 files checked, 23/129 uploaded "
            "(147MB transferred), 1 committed in 1 commit(s)"
        )
        self.assertEqual(progress.transferred, 147 * 1024 * 1024)
        self.assertEqual(progress.files_done, 23)
        self.assertEqual(progress.files_total, 129)
        self.assertEqual(progress.committed, 1)

    def test_parse_processing_speed(self) -> None:
        progress = parse_progress(
            "Processing Files (1 / 2): 42%| 130MB / 310MB, 2.7MB/s",
            TransferProgress(),
        )
        self.assertEqual(progress.transferred, 130 * 1024 * 1024)
        self.assertEqual(progress.total, 310 * 1024 * 1024)
        self.assertEqual(progress.speed_bps, int(2.7 * 1024 * 1024))

    def test_system_network_estimate_cannot_replace_hf_progress(self) -> None:
        progress = parse_progress(
            "Processing Files (10 / 36): 58%| 122MB / 209MB, 130kB/s",
            TransferProgress(),
        )
        # A system-wide network counter may observe more traffic, but the CLI's
        # byte counter remains the authoritative numerator.
        observed_system_network_bytes = 209 * 1024 * 1024
        self.assertGreater(observed_system_network_bytes, progress.transferred)
        self.assertEqual(progress.transferred, 122 * 1024 * 1024)
        self.assertLess(progress.transferred / progress.total, 0.59)

    def test_state_store_recovers_interrupted_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            parent = root / "book"
            package = parent / "book.booksync"
            package.mkdir(parents=True)
            (package / "test.bin").write_bytes(b"abc")
            store = StateStore(root / "state.sqlite3")
            try:
                book_id = store.upsert_package(parent, package)
                store.update(book_id, state="uploading")
                store.reset_interrupted()
                row = store.rows()[0]
                self.assertEqual(row["state"], "queued")
                self.assertIn("Recovered", row["last_error"])
            finally:
                store.close()

    def test_changed_package_fingerprint_requeues_a_completed_upload(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            parent = root / "book"
            package = parent / "book.booksync"
            package.mkdir(parents=True)
            (package / "manifest.json").write_text('{"version": 1}', encoding="utf-8")
            (package / "checksums.json").write_text('{"version": 1}', encoding="utf-8")
            store = StateStore(root / "state.sqlite3")
            try:
                book_id = store.upsert_package(parent, package)
                store.update(book_id, state="complete", verified_at="then", remote_sha="old")
                (package / "manifest.json").write_text('{"version": 2}', encoding="utf-8")

                store.upsert_package(parent, package)
                row = store.rows()[0]

                self.assertEqual(row["state"], "queued")
                self.assertIsNone(row["verified_at"])
                self.assertIsNone(row["remote_sha"])
                self.assertIn("changed", row["last_error"].casefold())
            finally:
                store.close()

    def test_single_instance_rejects_second_writer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            with SingleInstance("test/booksync", state):
                with self.assertRaises(RuntimeError):
                    with SingleInstance("test/booksync", state):
                        pass

    def test_synthetic_folder_dry_run_transfer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "synthetic-folder"
            source.mkdir()
            (source / "one.bin").write_bytes(b"a" * 1024)
            (source / "two.bin").write_bytes(b"b" * 2048)
            supervisor = UploadSupervisor(
                root / "queue",
                root / "destination",
                "test/booksync",
                "main",
                root / "state",
                root / "live.txt",
                dry_run=True,
            )
            try:
                _, progress, elapsed = supervisor.run_transfer(
                    source,
                    "_test/synthetic-folder",
                    "xet",
                    None,
                    3072,
                    "Synthetic upload test",
                )
                self.assertEqual(progress.transferred, 3072)
                self.assertGreater(elapsed, 0)
            finally:
                supervisor.close()

    def test_canary_winner_becomes_first_transport(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            supervisor = UploadSupervisor(
                root / "queue", root / "destination", "test/booksync", "main",
                root / "state", root / "live.txt", dry_run=True,
            )
            try:
                supervisor.store.set_meta("preferred_transport", "http-fallback")
                self.assertEqual(supervisor.modes()[0], "http-fallback")
            finally:
                supervisor.close()


if __name__ == "__main__":
    unittest.main()
