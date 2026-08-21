import json
import tempfile
import unittest
from pathlib import Path

from tools.build_oracle_catalog import build_catalog, write_catalog


class OracleCatalogTests(unittest.TestCase):
    def manifest(self, root: Path, folder: str, book_id: str) -> None:
        target = root / folder
        target.mkdir(parents=True)
        (target / "manifest.json").write_text(
            json.dumps({"format": "booksync", "schema_version": 1, "book_id": book_id}),
            encoding="utf-8",
        )

    def test_builds_sorted_relative_manifest_index(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.manifest(root, "B.booksync", "book_b")
            self.manifest(root, "A.booksync", "book_a")
            catalog = build_catalog(root)
            self.assertEqual(catalog["format"], "booksync-oracle-library")
            self.assertEqual(catalog["books"], [
                {"manifest_path": "A.booksync/manifest.json"},
                {"manifest_path": "B.booksync/manifest.json"},
            ])
            output = write_catalog(root, root / "library.json")
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), catalog)

    def test_rejects_duplicate_book_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.manifest(root, "A.booksync", "book_same")
            self.manifest(root, "B.booksync", "book_same")
            with self.assertRaisesRegex(ValueError, "Duplicate book_id"):
                build_catalog(root)

    def test_ignores_unrelated_manifests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.manifest(root, "Real.booksync", "book_real")
            self.manifest(root, "unrelated", "book_unrelated")
            self.assertEqual(build_catalog(root)["books"], [
                {"manifest_path": "Real.booksync/manifest.json"},
            ])


if __name__ == "__main__":
    unittest.main()
