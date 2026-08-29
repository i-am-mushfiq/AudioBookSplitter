from __future__ import annotations

import difflib
import math
import re
from collections import Counter
from collections import defaultdict

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


def build_phrase_index(words: list[Word]) -> tuple[list[str], list[float], dict[tuple[str, ...], list[int]]]:
    tokens: list[str] = []
    starts: list[float] = []
    for word in words:
        for token in norm(word.text):
            tokens.append(token)
            starts.append(word.start)
    index: dict[tuple[str, ...], list[int]] = defaultdict(list)
    for position in range(max(0, len(tokens) - 4)):
        index[tuple(tokens[position : position + 5])].append(position)
    return tokens, starts, dict(index)


def find_indexed_phrase(
    tokens: list[str],
    starts: list[float],
    index: dict[tuple[str, ...], list[int]],
    phrase: str,
    start_at: float = 0.0,
) -> float | None:
    """Find a phrase from exact five-token seeds, then score its full opening."""
    target = norm(phrase)[:45]
    if len(target) < 5:
        return None
    candidates: set[int] = set()
    for offset in range(min(21, len(target) - 4)):
        seed = tuple(target[offset : offset + 5])
        for position in index.get(seed, []):
            candidate_start = position - offset
            if candidate_start >= 0 and starts[candidate_start] >= start_at:
                candidates.add(candidate_start)
    best: tuple[float, float] | None = None
    for candidate_start in candidates:
        candidate = tokens[candidate_start : candidate_start + len(target)]
        score = difflib.SequenceMatcher(None, target, candidate, autojunk=False).ratio()
        if best is None or score > best[0]:
            best = (score, starts[candidate_start])
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
    pauses: list[tuple[float, float]] = []
    for current, following in zip(words, words[1:]):
        if abs(current.end - target) <= window and following.start - current.end >= 0.35:
            pauses.append((abs(current.end - target), current.end))
    if pauses:
        return min(pauses)[1], "nearest speech pause"
    boundaries = [(abs(word.end - target), word.end) for word in words if abs(word.end - target) <= window]
    if boundaries:
        return min(boundaries)[1], "nearest word boundary"
    return target, "time target (no speech metadata)"


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

    anchor_candidates: list[tuple] = []
    transcript_tokens, transcript_starts, phrase_index = build_phrase_index(words)
    selected_chapters = list(select_narrated_chapters(book))
    title_counts = Counter(" ".join(norm(chapter.title)) for chapter in selected_chapters)
    normalized_book_title = " ".join(norm(book.title or ""))
    for chapter in selected_chapters:
        # EPUB producers frequently stamp the book title onto every spine item.
        # Searching that generic title first repeatedly anchors every chapter to
        # the audiobook introduction and collapses the intervening content. A
        # chapter's opening prose is much more distinctive, so prefer it and use
        # the title only when the body cannot be located.
        found = find_indexed_phrase(
            transcript_tokens, transcript_starts, phrase_index,
            chapter.text.replace("\n", " "), 0.0,
        )
        normalized_title = " ".join(norm(chapter.title))
        title_is_distinctive = (
            bool(normalized_title)
            and normalized_title != normalized_book_title
            and title_counts[normalized_title] == 1
        )
        if found is None and title_is_distinctive:
            found = find_indexed_phrase(
                transcript_tokens, transcript_starts, phrase_index, chapter.title, 0.0,
            )
        if found is None:
            continue
        anchor_candidates.append((chapter, found))

    # Front matter is commonly stored before Chapter 1 in the EPUB but spoken
    # as credits at the end of the recording. A greedy cursor follows that late
    # match and makes every real chapter unreachable. Retain the longest strict
    # sequence whose audio times increase with EPUB spine order instead.
    chapter_starts: list[tuple] = []
    if anchor_candidates:
        lengths = [1] * len(anchor_candidates)
        previous = [-1] * len(anchor_candidates)
        for right in range(len(anchor_candidates)):
            for left in range(right):
                if anchor_candidates[left][1] < anchor_candidates[right][1] and lengths[left] + 1 > lengths[right]:
                    lengths[right] = lengths[left] + 1
                    previous[right] = left
        cursor_index = max(range(len(anchor_candidates)), key=lambda index: lengths[index])
        selected_indexes: list[int] = []
        while cursor_index >= 0:
            selected_indexes.append(cursor_index)
            cursor_index = previous[cursor_index]
        chapter_starts = [anchor_candidates[index] for index in reversed(selected_indexes)]

    # A true single-chapter source has no boundary to discover; its only valid
    # range is the full recording. Multi-chapter books must provide real anchors
    # rather than silently manufacturing zero-confidence boundaries.
    if not chapter_starts and len(selected_chapters) == 1:
        chapter_starts.append((selected_chapters[0], 0.0))

    chapter_ranges: list[ChapterRange] = []
    for index, (chapter, chapter_time) in enumerate(chapter_starts):
        start = 0.0 if index == 0 else chapter_time
        end = chapter_starts[index + 1][1] if index + 1 < len(chapter_starts) else duration
        if end > start:
            chapter_ranges.append(ChapterRange(chapter, start, end))

    cuts: list[Cut] = []
    target = minutes * 60
    chunk_number = 1
    for chapter_ordinal, chapter_range in enumerate(chapter_ranges, 1):
        chapter_duration = chapter_range.end - chapter_range.start
        desired_boundaries: list[float] = []
        if mode == "smart" and chapter_duration > target + 45:
            part_count = math.ceil(chapter_duration / target)
            desired_boundaries = [
                chapter_range.start + chapter_duration * part / part_count
                for part in range(1, part_count)
            ]
        elif mode == "fixed":
            next_target = chapter_range.start + target
            while chapter_range.end - next_target > 45:
                desired_boundaries.append(next_target)
                next_target += target

        current = chapter_range.start
        part = 1
        for boundary_index, desired in enumerate(desired_boundaries, 1):
            cut, reason = nearest_sentence_cut(words, desired)
            remaining_parts = len(desired_boundaries) - boundary_index + 1
            minimum = current + 60
            maximum = chapter_range.end - remaining_parts * 60
            cut = max(minimum, min(maximum, cut))
            cuts.append(
                Cut(
                    chunk_number,
                    current,
                    cut,
                    1,
                    1,
                    reason,
                    "",
                    str(chapter_ordinal),
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
                str(chapter_ordinal),
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
