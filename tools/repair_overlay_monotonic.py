#!/usr/bin/env python3
"""Repair tiny backward overlay timestamp steps in completed packages."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def repair(package: Path) -> int:
    manifest_path = package / "manifest.json"
    checksums_path = package / "checksums.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assets = {item["id"]: item for item in manifest["audio_assets"]}
    repairs = 0
    changed_files: set[str] = set()
    for overlay_path in sorted((package / "overlays").glob("chapter-*.json")):
        payload = json.loads(overlay_path.read_text(encoding="utf-8"))
        previous = -1
        changed = False
        for entry in payload.get("entries", []):
            locator = entry.get("audio_locator")
            if not locator:
                continue
            current = int(locator["global_start_ms"])
            if current < previous:
                asset = assets[locator["asset_id"]]
                # These defects are sub-millisecond-rounding-sized reversals.
                # Preserve the asset and duration, advancing only the start.
                target = previous
                local_start = max(0, target - int(asset["global_start_ms"]))
                duration = int(asset["duration_ms"])
                local_start = min(local_start, max(0, duration - 1))
                locator["start_ms"] = local_start
                locator["global_start_ms"] = int(asset["global_start_ms"]) + local_start
                locator["end_ms"] = min(duration, max(local_start + 1, int(locator["end_ms"])))
                entry.setdefault("reasons", []).append("monotonic-timing-repair")
                repairs += 1
                changed = True
            previous = int(locator["global_start_ms"])
        if changed:
            overlay_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            changed_files.add(overlay_path.relative_to(package).as_posix())

    # Also repair indexes when a previous run changed overlays but did not
    # update manifest metadata.
    manifest_records = {r.get("path"): r for r in manifest.get("overlay_assets", [])}
    checksum_records = {r.get("path"): r for r in json.loads(checksums_path.read_text(encoding="utf-8")).get("files", [])}
    for overlay_path in sorted((package / "overlays").glob("chapter-*.json")):
        rel = overlay_path.relative_to(package).as_posix()
        digest = sha256(overlay_path)
        size = overlay_path.stat().st_size
        if (manifest_records.get(rel, {}).get("sha256"), manifest_records.get(rel, {}).get("byte_length")) != (digest, size) or (checksum_records.get(rel, {}).get("sha256"), checksum_records.get(rel, {}).get("byte_length")) != (digest, size):
            changed_files.add(rel)

    if changed_files:
        checksums = json.loads(checksums_path.read_text(encoding="utf-8"))
        for record in checksums.get("files", []):
            rel = record.get("path")
            if rel in changed_files:
                path = package / rel
                record["sha256"] = sha256(path)
                record["byte_length"] = path.stat().st_size
        checksums_path.write_text(json.dumps(checksums, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        for record in manifest.get("overlay_assets", []):
            rel = record.get("path")
            if rel in changed_files:
                path = package / rel
                record["sha256"] = sha256(path)
                record["byte_length"] = path.stat().st_size
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        zip_path = package.with_suffix(".booksync.zip")
        if zip_path.exists():
            zip_path.unlink()
        temp_base = package.parent / f".{package.name}.archive"
        temp_zip = Path(shutil.make_archive(str(temp_base), "zip", root_dir=package))
        temp_zip.replace(zip_path)
    print(f"{package}: repaired {repairs} timestamp reversal(s)")
    return repairs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("packages", nargs="+", type=Path)
    args = parser.parse_args()
    return 0 if all(repair(path.resolve()) >= 0 for path in args.packages) else 1


if __name__ == "__main__":
    raise SystemExit(main())
