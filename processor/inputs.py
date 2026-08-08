from __future__ import annotations

from pathlib import Path


def discover_input(directory: Path, suffix: str) -> Path:
    matches = sorted(directory.glob(f"*{suffix}"))
    if len(matches) != 1:
        names = ", ".join(path.name for path in matches) or "none"
        raise SystemExit(
            f"Expected exactly one {suffix} file in {directory}; found: {names}. "
            f"Pass --{suffix[1:]} explicitly."
        )
    return matches[0]


def discover_book(directory: Path) -> Path:
    matches = sorted([*directory.glob("*.pdf"), *directory.glob("*.epub")])
    if len(matches) != 1:
        names = ", ".join(path.name for path in matches) or "none"
        raise SystemExit(
            f"Expected exactly one PDF or EPUB in {directory}; found: {names}. "
            "Pass --pdf explicitly."
        )
    return matches[0]
