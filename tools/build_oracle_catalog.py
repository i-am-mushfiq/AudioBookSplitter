"""Build the small library.json index consumed by the BookSync Oracle reader.

The selected directory is uploaded as-is to OCI Object Storage. Each expanded
*.booksync directory remains independently portable and manifest-driven.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


CATALOG_FORMAT = "booksync-oracle-library"


def discover_manifests(root: Path) -> list[Path]:
    manifests = sorted(
        path
        for path in root.rglob("manifest.json")
        if path.is_file() and path.parent.name.lower().endswith(".booksync")
    )
    if not manifests:
        raise ValueError(f"No expanded BookSync manifest.json files were found under {root}")
    return manifests


def build_catalog(root: Path) -> dict[str, object]:
    root = root.resolve()
    books: list[dict[str, str]] = []
    book_ids: set[str] = set()
    for manifest_path in discover_manifests(root):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("format") != "booksync" or manifest.get("schema_version") != 1:
            raise ValueError(f"Unsupported BookSync manifest: {manifest_path}")
        book_id = manifest.get("book_id")
        if not isinstance(book_id, str) or not book_id.startswith("book_"):
            raise ValueError(f"Invalid book_id in {manifest_path}")
        if book_id in book_ids:
            raise ValueError(f"Duplicate book_id in Oracle library: {book_id}")
        book_ids.add(book_id)
        relative = manifest_path.relative_to(root).as_posix()
        books.append({"manifest_path": relative})
    return {"format": CATALOG_FORMAT, "schema_version": 1, "books": books}


def write_catalog(root: Path, output: Path) -> Path:
    catalog = build_catalog(root)
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(output)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Create library.json for an expanded BookSync Oracle library")
    parser.add_argument("root", type=Path, help="Directory containing one or more expanded .booksync folders")
    parser.add_argument("--output", type=Path, help="Output path (default: ROOT/library.json)")
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        parser.error(f"Root directory does not exist: {root}")
    output = args.output.resolve() if args.output else root / "library.json"
    result = write_catalog(root, output)
    print(f"Created {result} with {len(build_catalog(root)['books'])} book(s).")


if __name__ == "__main__":
    main()
