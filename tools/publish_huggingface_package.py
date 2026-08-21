#!/usr/bin/env python3
"""Validate, score, upload, catalog, and verify one expanded BookSync package."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from huggingface_hub import HfApi, get_token, hf_hub_download

# Direct execution (``python tools/publish_huggingface_package.py``) places the
# tools directory on sys.path. Add the project root so the same imports work
# both from the CLI and when this module is imported by tests.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from tools.score_booksync_package import score_package
from tools.validate_booksync_package import validate_package


EVENT_PREFIX = "BOOKSYNC_EVENT "


def emit_event(stage: str, percent: float, message: str, **details: Any) -> None:
    print(
        EVENT_PREFIX + json.dumps(
            {"stage": stage, "percent": percent, "message": message, **details},
            ensure_ascii=False,
        ),
        flush=True,
    )


def merged_catalog(current: dict[str, Any] | None, manifest_path: str) -> dict[str, Any]:
    paths = {
        str(item["manifest_path"])
        for item in (current or {}).get("books", [])
        if isinstance(item, dict) and isinstance(item.get("manifest_path"), str)
    }
    paths.add(manifest_path)
    return {
        "format": "booksync-library",
        "schema_version": 1,
        "name": (current or {}).get("name", "BookSync Library"),
        "books": [{"manifest_path": path} for path in sorted(paths, key=str.casefold)],
    }


def remote_catalog(repo_id: str, revision: str) -> dict[str, Any] | None:
    try:
        path = hf_hub_download(repo_id=repo_id, filename="library.json", repo_type="dataset", revision=revision)
    except Exception as error:
        if "404" in str(error) or "Entry Not Found" in str(error):
            return None
        raise
    return json.loads(Path(path).read_text(encoding="utf-8"))


def publish(package: Path, repo_id: str, revision: str = "main") -> dict[str, Any]:
    package = package.resolve()
    emit_event("validating", 5, "Validating the server-ready package")
    issues = validate_package(package)
    if issues:
        details = "\n".join(f"- {issue}" for issue in issues[:20])
        raise RuntimeError(f"BookSync validation failed ({len(issues)} issues):\n{details}")
    emit_event("scoring", 12, "Creating the package quality scorecard")
    score_path, scorecard = score_package(package)
    token = get_token()
    if not token:
        raise RuntimeError("Hugging Face is not authenticated. Run: hf auth login")

    emit_event("uploading", 20, f"Uploading {package.name} to {repo_id}")
    subprocess.run(
        [
            "hf", "upload", repo_id, str(package), package.name,
            "--repo-type", "dataset", "--revision", revision,
            "--exclude", "*.zip", ".cache/**",
            "--commit-message", f"Publish {package.stem} BookSync package",
        ],
        check=True,
    )

    emit_event("cataloging", 88, "Updating the remote library catalog")
    api = HfApi(token=token)
    manifest_path = f"{package.name}/manifest.json"
    catalog = merged_catalog(remote_catalog(repo_id, revision), manifest_path)
    catalog_bytes = (json.dumps(catalog, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    commit = api.upload_file(
        path_or_fileobj=catalog_bytes,
        path_in_repo="library.json",
        repo_id=repo_id,
        repo_type="dataset",
        revision=revision,
        commit_message=f"Add {package.stem} to BookSync catalog",
    )
    info = api.repo_info(repo_id=repo_id, repo_type="dataset", revision=revision, files_metadata=True)
    files = {item.rfilename: item for item in info.siblings or []}
    if manifest_path not in files or "library.json" not in files:
        raise RuntimeError("Remote verification failed after upload.")
    result = {
        "package": package.name,
        "score": scorecard["score"],
        "grade": scorecard["grade"],
        "scorecard": str(score_path),
        "manifest_path": manifest_path,
        "catalog_books": len(catalog["books"]),
        "remote_sha": info.sha,
        "commit_url": str(commit),
        "private": bool(info.private),
    }
    emit_event("complete", 100, f"{package.stem} is synced to Hugging Face", **result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--repo", default="mdrahman/booksync-library")
    parser.add_argument("--revision", default="main")
    args = parser.parse_args()
    print(json.dumps(publish(args.package, args.repo, args.revision), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
