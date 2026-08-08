from __future__ import annotations

import difflib
import re

from processor.models import ChapterRange, Cut, ExtractedBook, ProcessingPlan, Word
from processor.text import norm


EXPLICIT_CHAPTER_RE = re.compile(r"^(?:chapter\b.+|prologue\b.*|epilogue\b.*)$", re.I)


def select_narrated_chapters(book: ExtractedBook):
    """Drop obvious EPUB front matter when a repeated chapter pattern exists."""
    if book.source_type != "epub":
        return book.chapters
    explicit = [chapter for chapter in book.chapters if EXPLICIT_CHAPTER_RE.match(chapter.title.strip())]
    return explicit if len(explicit) >= 2 else book.chapters


def find_phrase(words: list[Word], phrase: str, start_at: float = 0.0) -> float | None:
    """Find a phrase using tolerant, ordered token matching."""
    target = norm(phrase)[:45]
    if len(target) < 5:
        return None
    best: tuple[float, float] | None = None
    for index, word in enumerate(words):
        if word.start < start_at:
            continue
        candidate = [tokens[0] for item in words[index : index + len(target)] if (tokens := norm(item.text))]
        score = difflib.SequenceMatcher(None, target, candidate, autojunk=False).ratio()
        if best is None or score > best[0]:
            best = (score, word.start)
    return best[1] if best and best[0] >= 0.58 else None


def nearest_sentence_cut(words: list[Word], target: float, window: float = 75.0) -> tuple[float, str]:
    candidates: list[tuple[float, float]] = []
    for word in words[:-1]:
        if abs(word.end - target) > window:
            continue
        if word.text.endswith((".", "!", "?", ".”", "!”", "?”")):
            candidates.append((abs(word.end - target), word.end))
    if candidates:
        return min(candidates)[1], "nearest sentence end"
    return target, "time target (no sentence match)"


def build_processing_plan(
    book: ExtractedBook,
    words: list[Word],
    book_name: str,
    duration: float,
    minutes: float,
    mode: str,
) -> ProcessingPlan:
    page_times: list[tuple[int, float]] = []
    cursor = 0.0
    page_sections = book.sections if book.source_type == "pdf" else []
    for page_number, page_text in enumerate(page_sections, 1):
        page_lines = [line.strip() for line in page_text.splitlines() if line.strip()]
        if (
            book.source_type == "pdf"
            and page_lines
            and page_lines[0].lower().startswith(book_name.replace("_", " ").lower())
        ):
            page_lines = page_lines[1:]
        page_start = find_phrase(words, " ".join(page_lines), cursor)
        if page_start is not None:
            cursor = page_start
            page_times.append((page_number, page_start))

    chapter_starts: list[tuple] = []
    cursor = 0.0
    for chapter in select_narrated_chapters(book):
        found = find_phrase(words, chapter.title, cursor)
        if found is None:
            found = find_phrase(words, chapter.text.replace("\n", " "), cursor)
        if found is not None:
            cursor = found
        chapter_starts.append((chapter, cursor))

    chapter_ranges: list[ChapterRange] = []
    for index, (chapter, chapter_time) in enumerate(chapter_starts):
        start = 0.0 if index == 0 else chapter_time
        end = chapter_starts[index + 1][1] if index + 1 < len(chapter_starts) else duration
        if end > start:
            chapter_ranges.append(ChapterRange(chapter, start, end))

    cuts: list[Cut] = []
    target = minutes * 60
    chunk_number = 1
    for chapter_range in chapter_ranges:
        current = chapter_range.start
        part = 1
        while mode != "chapter" and chapter_range.end - current > target + 45:
            cut, reason = nearest_sentence_cut(words, current + target)
            cut = max(current + 60, min(chapter_range.end - 30, cut))
            cuts.append(
                Cut(
                    chunk_number,
                    current,
                    cut,
                    1,
                    1,
                    reason,
                    "",
                    chapter_range.chapter.number,
                    chapter_range.chapter.title,
                    part,
                )
            )
            current = cut
            chunk_number += 1
            part += 1
        cuts.append(
            Cut(
                chunk_number,
                current,
                chapter_range.end,
                1,
                1,
                "chapter boundary" if chapter_range.end < duration else "final chunk",
                "",
                chapter_range.chapter.number,
                chapter_range.chapter.title,
                part,
            )
        )
        chunk_number += 1

    def page_at(time: float) -> int:
        current_page = 1
        for page_number, page_time in page_times:
            if page_time <= time:
                current_page = page_number
        return current_page

    for cut in cuts:
        cut.pdf_page_start = page_at(cut.start)
        cut.pdf_page_end = page_at(max(cut.start, cut.end - 0.1))

    return ProcessingPlan(page_times, chapter_starts, chapter_ranges, cuts)
