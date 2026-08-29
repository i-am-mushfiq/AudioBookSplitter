#!/usr/bin/env python3
"""Verify that raw-processing folders have valid local and remote replacements."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from huggingface_hub import HfApi, get_token, hf_hub_download

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.validate_booksync_package import validate_package


RAW = Path(r"C:\Personal_Endeavours\BookSync2\local-data\books\raw_processing")
DESTINATION = Path(r"C:\Users\Mushfiq\Downloads\BookSync")
REPO = "mdrahman/booksync-library"


def main() -> int:
    folders = sorted(
        (item for item in RAW.iterdir() if item.is_dir() and not item.name.startswith("_")),
        key=lambda item: item.name.casefold(),
    )
    token = get_token()
    api = HfApi(token=token)
    info = api.repo_info(REPO, repo_type="dataset")
    remote_paths = {item.rfilename for item in info.siblings or []}
    library_file = Path(
        hf_hub_download(
            repo_id=REPO,
            filename="library.json",
            repo_type="dataset",
            token=token,
            force_download=True,
        )
    )
    catalog_paths = {
        item.get("manifest_path")
        for item in json.loads(library_file.read_text(encoding="utf-8")).get("books", [])
    }

    all_safe = True
    for folder in folders:
        package = DESTINATION / folder.name / f"{folder.name}.booksync"
        issues = validate_package(package) if package.is_dir() else ["missing package"]
        controls_match = True
        for name in ("manifest.json", "checksums.json"):
            local_control = package / name
            if not local_control.is_file():
                controls_match = False
                continue
            remote_control = Path(
                hf_hub_download(
                    repo_id=REPO,
                    filename=f"{package.name}/{name}",
                    repo_type="dataset",
                    token=token,
                    force_download=True,
                )
            )
            controls_match &= hashlib.sha256(local_control.read_bytes()).digest() == hashlib.sha256(
                remote_control.read_bytes()
            ).digest()
        manifest_path = f"{folder.name}.booksync/manifest.json"
        safe = (
            not issues
            and controls_match
            and manifest_path in remote_paths
            and manifest_path in catalog_paths
        )
        all_safe &= safe
        print(
            f"{folder.name}|safe={safe}|valid={not issues}|controls_match={controls_match}"
            f"|manifest={manifest_path in remote_paths}|catalog={manifest_path in catalog_paths}"
        )
    print(f"ALL_SAFE|{all_safe}|COUNT|{len(folders)}")
    return 0 if all_safe else 1


if __name__ == "__main__":
    raise SystemExit(main())
