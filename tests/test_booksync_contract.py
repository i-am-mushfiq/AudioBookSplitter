from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

from tools.validate_booksync_package import PROJECT_ROOT, load_schema, validate_package


EXAMPLE_PACKAGE = PROJECT_ROOT / "examples" / "minimal.booksync"


class BookSyncContractTests(unittest.TestCase):
    def test_schemas_are_valid_draft_2020_12(self) -> None:
        for name in ("manifest.schema.json", "overlay.schema.json", "checksums.schema.json"):
            Draft202012Validator.check_schema(load_schema(name))

    def test_minimal_example_package_is_valid(self) -> None:
        self.assertEqual(validate_package(EXAMPLE_PACKAGE), [])

    def test_manifest_rejects_noncanonical_book_id(self) -> None:
        manifest = json.loads((EXAMPLE_PACKAGE / "manifest.json").read_text(encoding="utf-8"))
        manifest["book_id"] = "book-readable-name"
        errors = list(Draft202012Validator(load_schema("manifest.schema.json")).iter_errors(manifest))
        self.assertTrue(any(list(error.path) == ["book_id"] for error in errors))

    def test_overlay_rejects_path_traversal(self) -> None:
        overlay = json.loads((EXAMPLE_PACKAGE / "overlays" / "chapter-001.json").read_text(encoding="utf-8"))
        overlay["entries"][0]["text_locator"]["document"] = "../outside.html"
        errors = list(Draft202012Validator(load_schema("overlay.schema.json")).iter_errors(overlay))
        self.assertTrue(errors)

    def test_validator_detects_checksum_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copied = Path(directory) / "fixture"
            self._copy_package(EXAMPLE_PACKAGE, copied)
            content = copied / "content" / "chapter-001.html"
            content.write_text(content.read_text(encoding="utf-8") + "\nchanged", encoding="utf-8")
            issues = validate_package(copied)
            self.assertTrue(any("SHA-256" in issue.message or "byte length" in issue.message for issue in issues))

    def test_validator_enforces_derived_book_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copied = Path(directory) / "fixture"
            self._copy_package(EXAMPLE_PACKAGE, copied)
            manifest_path = copied / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["source"]["sha256"] = "1" * 64
            manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            issues = validate_package(copied)
            self.assertTrue(any(issue.location == "manifest.book_id" for issue in issues))

    @staticmethod
    def _copy_package(source: Path, destination: Path) -> None:
        destination.mkdir(parents=True)
        for path in source.rglob("*"):
            relative = path.relative_to(source)
            target = destination / relative
            if path.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(path.read_bytes())


if __name__ == "__main__":
    unittest.main()
