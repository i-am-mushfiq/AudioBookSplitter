from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from processor.inputs import discover_audio
from processor.packaging.booksync import archive_booksync_package
from tools.booksync_desktop_bridge import PROJECT_ROOT, inventory, scan_local


EXAMPLE_PACKAGE = PROJECT_ROOT / "examples" / "minimal.booksync"


class DesktopBridgeTests(unittest.TestCase):
    def test_audio_discovery_accepts_common_audiobook_formats(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "book.m4b"
            audio.write_bytes(b"fixture")
            self.assertEqual(discover_audio(Path(directory)), audio)

    def test_local_scan_deduplicates_expanded_package_and_reader_zip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "Synthetic.booksync"
            shutil.copytree(EXAMPLE_PACKAGE, package)
            archive_booksync_package(package)
            records, warnings = scan_local(root)
            self.assertEqual(warnings, [])
            self.assertEqual(len(records), 1)
            record = next(iter(records.values()))
            self.assertEqual(record["package_path"], str(package))
            self.assertEqual(record["zip_path"], str(package.with_suffix(".booksync.zip")))
            self.assertTrue(record["package_valid"])

    def test_local_inventory_classifies_books_without_cloud_access(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(EXAMPLE_PACKAGE, root / "Synthetic.booksync")
            result = inventory(root, "owner/booksync-library", "main", local_only=True)
            self.assertEqual(result["counts"]["local"], 1)
            self.assertEqual(result["counts"]["local_only"], 1)
            self.assertEqual(result["books"][0]["state"], "local_only")
            self.assertIsNone(result["remote_error"])


if __name__ == "__main__":
    unittest.main()
