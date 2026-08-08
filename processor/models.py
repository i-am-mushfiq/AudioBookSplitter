from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Word:
    text: str
    start: float
    end: float


@dataclass
class Chapter:
    number: str
    title: str
    pdf_page: int
    text: str
    paragraphs: list[str] = field(default_factory=list)
    source_href: str | None = None


@dataclass
class ExtractedBook:
    source_type: str
    sections: list[str]
    chapters: list[Chapter]
    title: str | None = None
    author: str | None = None


@dataclass
class ChapterRange:
    chapter: Chapter
    start: float
    end: float


@dataclass
class Cut:
    index: int
    start: float
    end: float
    pdf_page_start: int
    pdf_page_end: int
    reason: str
    output: str
    chapter_number: str
    chapter_title: str
    part: int


@dataclass
class ProcessingPlan:
    page_times: list[tuple[int, float]]
    chapter_starts: list[tuple[Chapter, float]]
    chapter_ranges: list[ChapterRange]
    cuts: list[Cut]


@dataclass(frozen=True)
class RenderedAsset:
    cut: Cut
    stable_id: str
    package_path: str
    file_path: Path
    duration_ms: int
