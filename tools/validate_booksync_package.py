#!/usr/bin/env python3
"""Validate a BookSync v1 package against schemas and cross-file invariants."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

from jsonschema import Draft202012Validator, FormatChecker


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_ROOT = PROJECT_ROOT / "schemas"


@dataclass(frozen=True)
class ValidationIssue:
    location: str
    message: str

    def __str__(self) -> str:
        return f"{self.location}: {self.message}"


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_schema(name: str) -> dict[str, Any]:
    return load_json(SCHEMA_ROOT / name)


def schema_issues(data: Any, schema_name: str, location: str) -> list[ValidationIssue]:
    validator = Draft202012Validator(load_schema(schema_name), format_checker=FormatChecker())
    issues: list[ValidationIssue] = []
    for error in sorted(validator.iter_errors(data), key=lambda item: list(item.absolute_path)):
        suffix = "".join(f"[{part}]" if isinstance(part, int) else f".{part}" for part in error.absolute_path)
        issues.append(ValidationIssue(f"{location}{suffix}", error.message))
    return issues


def safe_package_path(root: Path, value: str) -> Path:
    pure = PurePosixPath(value)
    if pure.is_absolute() or not pure.parts or ".." in pure.parts or "." in pure.parts:
        raise ValueError("must be a normalized relative package path")
    if "\\" in value or ":" in pure.parts[0] or "?" in value or "#" in value:
        raise ValueError("must not contain backslashes, drive prefixes, queries, or fragments")
    candidate = root.joinpath(*pure.parts)
    resolved_root = root.resolve()
    resolved_candidate = candidate.resolve()
    if resolved_candidate != resolved_root and resolved_root not in resolved_candidate.parents:
        raise ValueError("escapes the package root")
    if candidate.is_symlink():
        raise ValueError("symlinks are not allowed in BookSync packages")
    return candidate


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def duplicate_values(items: Iterable[dict[str, Any]], key: str) -> set[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for item in items:
        value = str(item[key])
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    return duplicates


def validate_file(
    root: Path,
    logical_path: str,
    expected_hash: str,
    expected_size: int,
    location: str,
) -> list[ValidationIssue]:
    try:
        path = safe_package_path(root, logical_path)
    except ValueError as error:
        return [ValidationIssue(location, str(error))]
    if not path.is_file():
        return [ValidationIssue(location, f"referenced file does not exist: {logical_path}")]

    issues: list[ValidationIssue] = []
    actual_size = path.stat().st_size
    if actual_size != expected_size:
        issues.append(ValidationIssue(location, f"byte length is {actual_size}, expected {expected_size}"))
    actual_hash = digest(path)
    if actual_hash != expected_hash:
        issues.append(ValidationIssue(location, f"SHA-256 is {actual_hash}, expected {expected_hash}"))
    return issues


def referenced_assets(manifest: dict[str, Any]) -> dict[str, tuple[str, int, str]]:
    assets: dict[str, tuple[str, int, str]] = {}
    source = manifest["source"]
    if "included_path" in source:
        assets[source["included_path"]] = (source["sha256"], source["byte_length"], "manifest.source")
    cover = manifest.get("cover")
    if cover:
        assets[cover["path"]] = (cover["sha256"], cover["byte_length"], "manifest.cover")
    transcript = manifest.get("transcript")
    if transcript:
        assets[transcript["path"]] = (
            transcript["sha256"],
            transcript["byte_length"],
            "manifest.transcript",
        )
    for index, chapter in enumerate(manifest["chapters"]):
        assets[chapter["content_path"]] = (
            chapter["content_sha256"],
            chapter["content_byte_length"],
            f"manifest.chapters[{index}].content_path",
        )
    for index, asset in enumerate(manifest["audio_assets"]):
        assets[asset["path"]] = (
            asset["sha256"],
            asset["byte_length"],
            f"manifest.audio_assets[{index}].path",
        )
    for index, asset in enumerate(manifest["overlay_assets"]):
        assets[asset["path"]] = (
            asset["sha256"],
            asset["byte_length"],
            f"manifest.overlay_assets[{index}].path",
        )
    return assets


def validate_package(package_root: Path) -> list[ValidationIssue]:
    root = package_root.resolve()
    issues: list[ValidationIssue] = []
    if not root.is_dir():
        return [ValidationIssue(str(package_root), "package root is not a directory")]

    manifest_path = root / "manifest.json"
    checksums_path = root / "checksums.json"
    if not manifest_path.is_file():
        issues.append(ValidationIssue("manifest.json", "required file is missing"))
    if not checksums_path.is_file():
        issues.append(ValidationIssue("checksums.json", "required file is missing"))
    if issues:
        return issues

    try:
        manifest = load_json(manifest_path)
    except (OSError, json.JSONDecodeError) as error:
        return [ValidationIssue("manifest.json", f"cannot read JSON: {error}")]
    try:
        checksums = load_json(checksums_path)
    except (OSError, json.JSONDecodeError) as error:
        return [ValidationIssue("checksums.json", f"cannot read JSON: {error}")]

    issues.extend(schema_issues(manifest, "manifest.schema.json", "manifest.json"))
    issues.extend(schema_issues(checksums, "checksums.schema.json", "checksums.json"))
    if issues:
        return issues

    for collection, key in (
        (manifest["chapters"], "id"),
        (manifest["audio_assets"], "id"),
        (manifest["overlay_assets"], "id"),
    ):
        for duplicate in duplicate_values(collection, key):
            issues.append(ValidationIssue("manifest.json", f"duplicate internal ID: {duplicate}"))

    chapter_ids = {item["id"] for item in manifest["chapters"]}
    chapters_by_id = {item["id"]: item for item in manifest["chapters"]}
    overlay_assets = {item["id"]: item for item in manifest["overlay_assets"]}
    audio_assets = {item["id"]: item for item in manifest["audio_assets"]}

    identity = (
        "booksync-book-v1\n"
        f"{manifest['source']['sha256']}\n"
        f"{manifest['audiobook_sha256']}"
    ).encode("utf-8")
    expected_book_id = f"book_{hashlib.sha256(identity).hexdigest()}"
    if manifest["book_id"] != expected_book_id:
        issues.append(
            ValidationIssue(
                "manifest.book_id",
                f"does not match the canonical source/audiobook identity; expected {expected_book_id}",
            )
        )

    expected_indexes = list(range(1, len(manifest["chapters"]) + 1))
    actual_indexes = [item["index"] for item in manifest["chapters"]]
    if actual_indexes != expected_indexes:
        issues.append(ValidationIssue("manifest.chapters", "chapter indexes must be consecutive and ordered from 1"))

    previous_end = 0
    for index, chapter in enumerate(manifest["chapters"]):
        location = f"manifest.chapters[{index}]"
        if chapter["audio_end_ms"] <= chapter["audio_start_ms"]:
            issues.append(ValidationIssue(location, "audio_end_ms must be greater than audio_start_ms"))
        if chapter["audio_start_ms"] < previous_end:
            issues.append(ValidationIssue(location, "chapter audio ranges must be monotonic and non-overlapping"))
        if chapter["audio_end_ms"] > manifest["total_duration_ms"]:
            issues.append(ValidationIssue(location, "chapter audio range exceeds total_duration_ms"))
        previous_end = chapter["audio_end_ms"]
        overlay = overlay_assets.get(chapter["overlay_id"])
        if overlay is None:
            issues.append(ValidationIssue(location, f"unknown overlay_id: {chapter['overlay_id']}"))
        elif overlay["chapter_id"] != chapter["id"]:
            issues.append(ValidationIssue(location, "overlay asset points to a different chapter"))

    previous_audio_end = 0
    for index, asset in enumerate(manifest["audio_assets"]):
        location = f"manifest.audio_assets[{index}]"
        if asset["global_start_ms"] < previous_audio_end:
            issues.append(ValidationIssue(location, "audio assets must be ordered and non-overlapping"))
        previous_audio_end = asset["global_start_ms"] + asset["duration_ms"]
    if previous_audio_end != manifest["total_duration_ms"]:
        issues.append(ValidationIssue("manifest.total_duration_ms", "must equal the end of the final audio asset"))

    checksum_items = checksums["files"]
    for duplicate in duplicate_values(checksum_items, "path"):
        issues.append(ValidationIssue("checksums.files", f"duplicate checksum path: {duplicate}"))
    checksum_index = {item["path"]: item for item in checksum_items}
    for index, checksum in enumerate(checksum_items):
        issues.extend(
            validate_file(
                root,
                checksum["path"],
                checksum["sha256"],
                checksum["byte_length"],
                f"checksums.files[{index}]",
            )
        )

    assets = referenced_assets(manifest)
    for logical_path, (expected_hash, manifest_size, location) in assets.items():
        checksum = checksum_index.get(logical_path)
        if checksum is None:
            issues.append(ValidationIssue(location, f"missing checksum entry for {logical_path}"))
            continue
        if checksum["sha256"] != expected_hash:
            issues.append(ValidationIssue(location, "manifest and checksum index disagree on SHA-256"))
        if manifest_size >= 0 and checksum["byte_length"] != manifest_size:
            issues.append(ValidationIssue(location, "manifest and checksum index disagree on byte length"))

    total_entries = 0
    exact_entries = 0
    approximate_entries = 0
    unmatched_entries = 0
    sentence_ids: set[str] = set()
    thresholds = manifest["alignment"]["thresholds"]

    if thresholds["approximate_min"] >= thresholds["exact_min"]:
        issues.append(ValidationIssue("manifest.alignment.thresholds", "approximate_min must be below exact_min"))

    for asset_index, asset in enumerate(manifest["overlay_assets"]):
        overlay_path = root.joinpath(*PurePosixPath(asset["path"]).parts)
        try:
            overlay = load_json(overlay_path)
        except (OSError, json.JSONDecodeError) as error:
            issues.append(ValidationIssue(asset["path"], f"cannot read JSON: {error}"))
            continue
        overlay_issues = schema_issues(overlay, "overlay.schema.json", asset["path"])
        issues.extend(overlay_issues)
        if overlay_issues:
            continue
        if overlay["overlay_id"] != asset["id"]:
            issues.append(ValidationIssue(asset["path"], "overlay_id does not match manifest asset ID"))
        if overlay["book_id"] != manifest["book_id"]:
            issues.append(ValidationIssue(asset["path"], "book_id does not match manifest"))
        if overlay["chapter_id"] != asset["chapter_id"] or overlay["chapter_id"] not in chapter_ids:
            issues.append(ValidationIssue(asset["path"], "chapter_id does not match a manifest chapter"))
        if len(overlay["entries"]) != asset["entry_count"]:
            issues.append(ValidationIssue(asset["path"], "entry count does not match manifest"))

        previous_global_start = -1
        for entry_index, entry in enumerate(overlay["entries"]):
            location = f"{asset['path']}.entries[{entry_index}]"
            total_entries += 1
            if entry["ordinal"] != entry_index + 1:
                issues.append(ValidationIssue(location, "ordinals must be consecutive and ordered from 1"))
            if entry["sentence_id"] in sentence_ids:
                issues.append(ValidationIssue(location, f"duplicate sentence ID: {entry['sentence_id']}"))
            sentence_ids.add(entry["sentence_id"])

            locator = entry["audio_locator"]
            state = entry["alignment"]
            confidence = entry["confidence"]
            if state == "exact":
                exact_entries += 1
                if locator is None or confidence < thresholds["exact_min"]:
                    issues.append(ValidationIssue(location, "exact alignment requires an audio locator and exact confidence"))
            elif state == "approximate":
                approximate_entries += 1
                if locator is None or not (thresholds["approximate_min"] <= confidence < thresholds["exact_min"]):
                    issues.append(ValidationIssue(location, "approximate alignment confidence is outside its threshold band"))
            else:
                unmatched_entries += 1
                if confidence >= thresholds["approximate_min"]:
                    issues.append(ValidationIssue(location, "unmatched alignment confidence must be below approximate_min"))

            if locator is not None:
                referenced_audio = audio_assets.get(locator["asset_id"])
                if referenced_audio is None:
                    issues.append(ValidationIssue(location, f"unknown audio asset: {locator['asset_id']}"))
                    continue
                if locator["end_ms"] <= locator["start_ms"]:
                    issues.append(ValidationIssue(location, "audio end_ms must be greater than start_ms"))
                if locator["end_ms"] > referenced_audio["duration_ms"]:
                    issues.append(ValidationIssue(location, "audio locator exceeds its asset duration"))
                expected_global = referenced_audio["global_start_ms"] + locator["start_ms"]
                if locator["global_start_ms"] != expected_global:
                    issues.append(ValidationIssue(location, "global_start_ms does not match asset-local time"))
                if locator["global_start_ms"] < previous_global_start:
                    issues.append(ValidationIssue(location, "overlay audio times must be monotonic"))
                previous_global_start = locator["global_start_ms"]

            text_locator = entry["text_locator"]
            if text_locator["type"] == "epub":
                chapter = chapters_by_id.get(asset["chapter_id"])
                if chapter is not None and text_locator["document"] != chapter["content_path"]:
                    issues.append(ValidationIssue(location, "EPUB locator document does not match chapter content"))

    summary = manifest["alignment"]
    aligned_entries = exact_entries + approximate_entries
    expected_summary = {
        "sentence_count": total_entries,
        "aligned_sentence_count": aligned_entries,
        "exact_sentence_count": exact_entries,
        "approximate_sentence_count": approximate_entries,
        "unmatched_sentence_count": unmatched_entries,
    }
    for key, expected in expected_summary.items():
        if summary[key] != expected:
            issues.append(ValidationIssue(f"manifest.alignment.{key}", f"is {summary[key]}, expected {expected}"))
    expected_coverage = aligned_entries / total_entries if total_entries else 0.0
    if not math.isclose(summary["sentence_coverage"], expected_coverage, abs_tol=1e-6):
        issues.append(
            ValidationIssue(
                "manifest.alignment.sentence_coverage",
                f"is {summary['sentence_coverage']}, expected {expected_coverage:.6f}",
            )
        )

    return issues


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path, help="Path to an expanded .booksync package")
    args = parser.parse_args()

    issues = validate_package(args.package)
    if issues:
        print(f"BookSync package is invalid ({len(issues)} issue(s)):", file=sys.stderr)
        for issue in issues:
            print(f"- {issue}", file=sys.stderr)
        return 1
    print(f"BookSync package is valid: {args.package.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
