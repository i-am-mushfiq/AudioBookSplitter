#!/usr/bin/env python3
"""Fast, resumable BookSync package upload using Hugging Face upload_folder."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from huggingface_hub import HfApi, get_token

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from tools.publish_huggingface_package import merged_catalog, remote_catalog
from tools.score_booksync_package import score_package
from tools.validate_booksync_package import validate_package


def emit(stage: str, percent: float, message: str, **extra: object) -> None:
    print("BOOKSYNC_FAST_UPLOAD " + json.dumps({"stage": stage, "percent": percent, "message": message, **extra}, ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("package", type=Path)
    parser.add_argument("--repo", default="mdrahman/booksync-library")
    parser.add_argument("--revision", default="main")
    parser.add_argument("--max-retries", type=int, default=3)
    args = parser.parse_args()
    package = args.package.resolve()
    emit("validating", 2, "Validating package")
    issues = validate_package(package)
    if issues:
        raise RuntimeError("Package validation failed: " + "; ".join(str(item) for item in issues[:10]))
    score_package(package)
    token = get_token()
    if not token:
        raise RuntimeError("Hugging Face token is unavailable")
    api = HfApi(token=token)
    emit("uploading", 5, f"Streaming {package.name} with upload_folder/hf_xet")
    commit = None
    for attempt in range(1, max(1, args.max_retries) + 1):
        try:
            commit = api.upload_folder(
                repo_id=args.repo,
                repo_type="dataset",
                folder_path=package,
                path_in_repo=package.name,
                revision=args.revision,
                ignore_patterns=["*.zip", ".cache/**"],
                commit_message=f"Publish {package.stem} BookSync package",
            )
            break
        except Exception as exc:
            if attempt >= max(1, args.max_retries):
                raise
            delay = min(60, 5 * (2 ** (attempt - 1)))
            emit("retrying", 5, f"Upload attempt {attempt} failed; retrying in {delay}s", error=str(exc))
            time.sleep(delay)
    assert commit is not None
    emit("cataloging", 92, "Updating remote library catalog", commit_url=str(commit))
    catalog = merged_catalog(remote_catalog(args.repo, args.revision), f"{package.name}/manifest.json")
    catalog_commit = api.upload_file(
        path_or_fileobj=(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n").encode("utf-8"),
        path_in_repo="library.json",
        repo_id=args.repo,
        repo_type="dataset",
        revision=args.revision,
        commit_message=f"Catalog {package.stem}",
    )
    info = api.repo_info(repo_id=args.repo, repo_type="dataset", revision=args.revision, files_metadata=True)
    paths = {item.rfilename for item in (info.siblings or [])}
    manifest_path = f"{package.name}/manifest.json"
    if manifest_path not in paths or "library.json" not in paths:
        raise RuntimeError("Remote verification failed")
    emit("complete", 100, f"{package.name} uploaded and verified", manifest_path=manifest_path, remote_sha=info.sha, commit_url=str(catalog_commit), private=bool(info.private))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
