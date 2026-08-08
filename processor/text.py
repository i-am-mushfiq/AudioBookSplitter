from __future__ import annotations

import re
from pathlib import Path


WORD_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")
BOUNDARY_RE = re.compile(r"[.!?][\"'”’)]*(?P<space>\s+)(?=[\"'“‘(]*[A-Z0-9])")
ABBREVIATION_RE = re.compile(
    r"\b(Mr|Mrs|Ms|Dr|Prof|Rev|St|Sr|Jr|Gen|Col|Capt|Sgt|Lt|No|vs|etc|e\.g|i\.e)\.",
    re.I,
)
PERIOD_MARKER = "\uE000"
NUMBER_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    "ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13",
    "fourteen": "14", "fifteen": "15", "sixteen": "16", "seventeen": "17",
    "eighteen": "18", "nineteen": "19", "twenty": "20",
    "first": "1", "second": "2", "third": "3", "fourth": "4", "fifth": "5",
    "sixth": "6", "seventh": "7", "eighth": "8", "ninth": "9", "tenth": "10",
}


def norm(text: str) -> list[str]:
    tokens = WORD_RE.findall(text.lower().replace("—", " ").replace("-", " "))
    return [NUMBER_WORDS.get(token, token) for token in tokens]


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
    protected = ABBREVIATION_RE.sub(lambda match: match.group(0).replace(".", PERIOD_MARKER), cleaned)
    protected = re.sub(r"\b([A-Z])\.(?=\s+[A-Z])", lambda match: match.group(0).replace(".", PERIOD_MARKER), protected)
    protected = re.sub(r"(?<=\d)\.(?=\d)", PERIOD_MARKER, protected)

    sentences: list[str] = []
    start = 0
    for boundary in BOUNDARY_RE.finditer(protected):
        split_at = boundary.start("space")
        sentence = protected[start:split_at].strip().replace(PERIOD_MARKER, ".")
        if sentence:
            sentences.append(sentence)
        start = boundary.end("space")
    tail = protected[start:].strip().replace(PERIOD_MARKER, ".")
    if tail:
        sentences.append(tail)

    merged: list[str] = []
    for sentence in sentences:
        if merged and not norm(sentence):
            merged[-1] = f"{merged[-1]} {sentence}".strip()
        else:
            merged.append(sentence)
    return merged or [cleaned]
