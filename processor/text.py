from __future__ import annotations

import re
from pathlib import Path


WORD_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")
SENTENCE_RE = re.compile(r"(?<=[.!?])(?:[\"'”’)]*)\s+(?=[A-Z0-9\"'“‘(])")


def norm(text: str) -> list[str]:
    return WORD_RE.findall(text.lower().replace("—", " ").replace("-", " "))


def roman_to_int(value: str) -> int:
    if value.isdigit():
        return int(value)
    values = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
    total = 0
    previous = 0
    for char in reversed(value.upper()):
        current = values[char]
        total += -current if current < previous else current
        previous = current
    return total


def safe_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_")
    return value or "Book"


def derive_book_name(book_path: Path, sections: list[str], metadata_title: str | None = None) -> str:
    if metadata_title and metadata_title.strip():
        return safe_name(metadata_title)
    first_section = sections[0] if sections else ""
    for line in (line.strip() for line in first_section.splitlines() if line.strip()):
        match = re.match(r"(.+?)\s+by\s+.+$", line, re.I)
        if match:
            return safe_name(match.group(1))
    return safe_name(book_path.stem)


def split_sentences(paragraph: str) -> list[str]:
    cleaned = " ".join(paragraph.split())
    if not cleaned:
        return []
    sentences = [item.strip() for item in SENTENCE_RE.split(cleaned) if item.strip()]
    return sentences or [cleaned]
