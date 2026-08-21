#!/usr/bin/env python3
"""Small JSON bridge used by the Windows BookSync Studio shell."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path
from typing import Any

from huggingface_hub import get_token, hf_hub_download


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

RESULT_PREFIX = "BOOKSYNC_RESULT "
MAX_MANIFEST_BYTES = 8 * 1024 * 1024
REPO_PATTERN = re.compile(r"^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*$")


def output(value: dict[str, Any]) -> None:
    print(RESULT_PREFIX + json.dumps(value, ensure_ascii=False), flush=True)


def load_manifest_bytes(data: bytes, label: str) -> dict[str, Any]:
    if len(data) > MAX_MANIFEST_BYTES:
        raise ValueError(f"{label} manifest exceeds 8 MB")
    value = json.loads(data.decode("utf-8"))
    if not isinstance(value, dict) or value.get("format") != "booksync" or value.get("schema_version") != 1:
        raise ValueError(f"{label} is not a BookSync v1 manifest")
    if not isinstance(value.get("book_id"), str) or not isinstance(value.get("title"), str):
        raise ValueError(f"{label} is missing its book identity")
    return value


def record_from_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    cover = manifest.get("cover") if isinstance(manifest.get("cover"), dict) else None
    stable_manifest = {key: value for key, value in manifest.items() if key != "created_at"}
    fingerprint = hashlib.sha256(
        json.dumps(stable_manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    return {
        "book_id": manifest["book_id"],
        "title": manifest["title"],
        "author": manifest.get("author"),
        "chapters": len(manifest.get("chapters", [])),
        "duration_ms": int(manifest.get("total_duration_ms", 0)),
        "created_at": manifest.get("created_at"),
        "cover_relative_path": cover.get("path") if cover else None,
        "content_fingerprint": fingerprint,
    }


def inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def quick_package_valid(package: Path) -> bool:
    """Verify the local package index without re-hashing gigabytes of audio."""
    try:
        checksums = json.loads((package / "checksums.json").read_text(encoding="utf-8"))
        files = checksums.get("files")
        if checksums.get("format") != "booksync-checksums" or not isinstance(files, list):
            return False
        for record in files:
            if not isinstance(record, dict) or not isinstance(record.get("path"), str):
                return False
            if "\\" in record["path"] or ":" in record["path"]:
                return False
            relative = Path(record["path"])
            candidate = package.joinpath(*relative.parts)
            if relative.is_absolute() or ".." in relative.parts or not inside(package, candidate):
                return False
            if candidate.is_symlink() or not candidate.is_file() or candidate.stat().st_size != record.get("byte_length"):
                return False
        return True
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False


def scan_local(root: Path) -> tuple[dict[str, dict[str, Any]], list[str]]:
    root = root.resolve()
    if not root.is_dir():
        raise ValueError(f"Library folder does not exist: {root}")
    records: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []

    for manifest_path in sorted(root.rglob("manifest.json"), key=lambda item: str(item).casefold()):
        package = manifest_path.parent
        if package.suffix.casefold() != ".booksync" or not inside(root, package):
            continue
        try:
            manifest = load_manifest_bytes(manifest_path.read_bytes(), str(package))
            record = record_from_manifest(manifest)
            cover_path = package / str(record["cover_relative_path"] or "")
            record.update(
                {
                    "local": True,
                    "package_path": str(package),
                    "zip_path": str(package.with_suffix(".booksync.zip")) if package.with_suffix(".booksync.zip").is_file() else None,
                    "cover_path": str(cover_path) if record["cover_relative_path"] and cover_path.is_file() and inside(package, cover_path) else None,
                    "package_valid": quick_package_valid(package),
                }
            )
            records[record["book_id"]] = record
        except Exception as error:
            warnings.append(f"Skipped {package.name}: {error}")

    for archive_path in sorted(root.rglob("*.booksync.zip"), key=lambda item: str(item).casefold()):
        if not inside(root, archive_path):
            continue
        try:
            with zipfile.ZipFile(archive_path) as archive:
                info = archive.getinfo("manifest.json")
                if info.file_size > MAX_MANIFEST_BYTES:
                    raise ValueError("manifest exceeds 8 MB")
                manifest = load_manifest_bytes(archive.read(info), str(archive_path))
            record = records.get(manifest["book_id"])
            if record:
                record["zip_path"] = str(archive_path)
                continue
            record = record_from_manifest(manifest)
            record.update(
                {
                    "local": True,
                    "package_path": None,
                    "zip_path": str(archive_path),
                    "cover_path": None,
                    "package_valid": None,
                }
            )
            records[record["book_id"]] = record
        except Exception as error:
            warnings.append(f"Skipped {archive_path.name}: {error}")
    return records, warnings


def validate_repo(repo_id: str) -> str:
    repo_id = repo_id.strip()
    if not REPO_PATTERN.fullmatch(repo_id):
        raise ValueError("Hugging Face repository must use owner/dataset format")
    return repo_id


def scan_remote(repo_id: str, revision: str) -> dict[str, dict[str, Any]]:
    repo_id = validate_repo(repo_id)
    token = get_token()
    if not token:
        raise RuntimeError("Hugging Face is not authenticated. Paste a token in Studio or run: hf auth login")
    catalog_path = hf_hub_download(
        repo_id=repo_id,
        filename="library.json",
        repo_type="dataset",
        revision=revision,
        token=token,
    )
    catalog = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    if catalog.get("format") not in {"booksync-library", "booksync-oracle-library"} or catalog.get("schema_version") != 1:
        raise ValueError("Remote library.json is not a supported BookSync catalog")
    books = catalog.get("books")
    if not isinstance(books, list) or len(books) > 2000:
        raise ValueError("Remote catalog has an invalid book list")

    records: dict[str, dict[str, Any]] = {}
    for item in books:
        manifest_path = item.get("manifest_path") if isinstance(item, dict) else None
        if not isinstance(manifest_path, str) or not manifest_path.endswith("/manifest.json"):
            raise ValueError("Remote catalog contains an unsafe manifest path")
        if "\\" in manifest_path or ".." in Path(manifest_path).parts or manifest_path.startswith("/"):
            raise ValueError(f"Remote catalog contains an unsafe path: {manifest_path}")
        local_path = hf_hub_download(
            repo_id=repo_id,
            filename=manifest_path,
            repo_type="dataset",
            revision=revision,
            token=token,
        )
        manifest = load_manifest_bytes(Path(local_path).read_bytes(), manifest_path)
        record = record_from_manifest(manifest)
        record.update({"remote": True, "manifest_path": manifest_path})
        records[record["book_id"]] = record
    return records


def inventory(folder: Path, repo_id: str, revision: str, local_only: bool) -> dict[str, Any]:
    local, warnings = scan_local(folder)
    remote: dict[str, dict[str, Any]] = {}
    remote_error: str | None = None
    if not local_only:
        try:
            remote = scan_remote(repo_id, revision)
        except Exception as error:
            remote_error = str(error)

    rows: list[dict[str, Any]] = []
    for book_id in sorted(set(local) | set(remote), key=lambda value: (local.get(value) or remote[value])["title"].casefold()):
        local_record = local.get(book_id)
        remote_record = remote.get(book_id)
        merged = {**(remote_record or {}), **(local_record or {})}
        if local_record and remote_record:
            state = "synced" if local_record["content_fingerprint"] == remote_record["content_fingerprint"] else "update_available"
        else:
            state = "local_only" if local_record else "remote_only"
        merged.update(
            {
                "local": local_record is not None,
                "remote": remote_record is not None,
                "state": state,
            }
        )
        rows.append(merged)
    return {
        "folder": str(folder.resolve()),
        "repo_id": repo_id,
        "revision": revision,
        "books": rows,
        "counts": {
            "local": len(local),
            "remote": len(remote),
            "synced": sum(item["state"] == "synced" for item in rows),
            "update_available": sum(item["state"] == "update_available" for item in rows),
            "local_only": sum(item["state"] == "local_only" for item in rows),
            "remote_only": sum(item["state"] == "remote_only" for item in rows),
        },
        "warnings": warnings,
        "remote_error": remote_error,
    }


def health() -> dict[str, Any]:
    required_modules: dict[str, bool] = {}
    for name in ("faster_whisper", "numpy", "pdfplumber", "huggingface_hub", "jsonschema"):
        try:
            __import__(name)
            required_modules[name] = True
        except Exception:
            required_modules[name] = False
    return {
        "python": sys.executable,
        "python_version": sys.version.split()[0],
        "ffmpeg": shutil.which("ffmpeg"),
        "ffprobe": shutil.which("ffprobe"),
        "modules": required_modules,
        "huggingface_authenticated": bool(get_token()),
        "ready": bool(shutil.which("ffmpeg") and shutil.which("ffprobe") and all(required_modules.values())),
        "environment": os.environ.get("CONDA_DEFAULT_ENV"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("health")
    inventory_parser = subparsers.add_parser("inventory")
    inventory_parser.add_argument("--folder", type=Path, required=True)
    inventory_parser.add_argument("--repo", default="mdrahman/booksync-library")
    inventory_parser.add_argument("--revision", default="main")
    inventory_parser.add_argument("--local-only", action="store_true")
    args = parser.parse_args()
    if args.command == "health":
        output(health())
    else:
        output(inventory(args.folder, args.repo, args.revision, args.local_only))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
