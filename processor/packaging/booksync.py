from __future__ import annotations

import hashlib
import html
import json
import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from processor import __version__
from processor.alignment.backends import AlignmentBackend, SentenceAlignment
from processor.models import Chapter, ChapterRange, Cut, ExtractedBook, ProcessingPlan, Word
from processor.packaging.quality import build_quality_report, write_alignment_review
from processor.text import split_sentences


EXACT_MIN = 0.85
APPROXIMATE_MIN = 0.60


@dataclass(frozen=True)
class CanonicalSentence:
    sentence_id: str
    ordinal: int
    text: str
    paragraph_index: int
    character_start: int
    character_end: int


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def file_record(package_root: Path, path: Path) -> dict[str, Any]:
    return {
        "path": path.relative_to(package_root).as_posix(),
        "sha256": sha256_file(path),
        "byte_length": path.stat().st_size,
    }


def derive_book_id(source_hash: str, audiobook_hash: str) -> str:
    identity = f"booksync-book-v1\n{source_hash}\n{audiobook_hash}".encode("utf-8")
    return f"book_{hashlib.sha256(identity).hexdigest()}"


def canonicalize_chapter(chapter: Chapter, chapter_index: int) -> tuple[list[list[CanonicalSentence]], int]:
    paragraphs = chapter.paragraphs or [chapter.text]
    canonical: list[list[CanonicalSentence]] = []
    ordinal = 1
    character_offset = 0
    for paragraph_index, paragraph in enumerate(paragraphs, 1):
        sentence_group: list[CanonicalSentence] = []
        for sentence in split_sentences(paragraph):
            start = character_offset
            end = start + len(sentence)
            sentence_group.append(
                CanonicalSentence(
                    sentence_id=f"sent_{chapter_index:04d}_{ordinal:06d}",
                    ordinal=ordinal,
                    text=sentence,
                    paragraph_index=paragraph_index,
                    character_start=start,
                    character_end=end,
                )
            )
            ordinal += 1
            character_offset = end + 1
        if sentence_group:
            canonical.append(sentence_group)
    return canonical, ordinal - 1


def write_chapter_html(
    path: Path,
    chapter: Chapter,
    canonical: list[list[CanonicalSentence]],
    language: str,
) -> None:
    body: list[str] = [
        "<!doctype html>",
        f'<html lang="{html.escape(language, quote=True)}">',
        "  <head>",
        '    <meta charset="utf-8" />',
        f"    <title>{html.escape(chapter.title)}</title>",
        "  </head>",
        "  <body>",
        "    <main>",
        f"      <h1>{html.escape(chapter.title)}</h1>",
    ]
    for paragraph in canonical:
        spans = " ".join(
            f'<span id="{sentence.sentence_id}">{html.escape(sentence.text)}</span>'
            for sentence in paragraph
        )
        body.append(f"      <p>{spans}</p>")
    body.extend(["    </main>", "  </body>", "</html>", ""])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(body), encoding="utf-8")


def link_or_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def prepare_package_root(output_root: Path, book_name: str) -> Path:
    output_root.mkdir(parents=True, exist_ok=True)
    package_root = output_root / f"{book_name}.booksync"
    resolved_output = output_root.resolve()
    resolved_package = package_root.resolve()
    if resolved_package.parent != resolved_output or resolved_package.suffix != ".booksync":
        raise ValueError("Refusing to prepare a package outside the selected output directory")
    if package_root.exists():
        shutil.rmtree(package_root)
    package_root.mkdir()
    return package_root


def archive_booksync_package(package_root: Path) -> Path:
    """Create the portable ZIP consumed by the desktop, Android, and iOS readers."""
    if package_root.suffix != ".booksync":
        raise ValueError("BookSync packages must be archived from a .booksync directory")
    archive_path = package_root.with_suffix(".booksync.zip")
    temporary_base = package_root.parent / f".{package_root.name}.archive"
    temporary_path = Path(f"{temporary_base}.zip")
    if temporary_path.exists():
        temporary_path.unlink()
    if archive_path.exists():
        archive_path.unlink()
    created = Path(shutil.make_archive(str(temporary_base), "zip", root_dir=package_root))
    created.replace(archive_path)
    return archive_path


def cut_for_time(cuts: list[Cut], seconds: float) -> Cut | None:
    for cut in cuts:
        if cut.start <= seconds < cut.end or (cut is cuts[-1] and seconds == cut.end):
            return cut
    return None


def audio_locator(match: SentenceAlignment, cuts: list[Cut]) -> dict[str, Any] | None:
    if match.start is None or match.end is None:
        return None
    cut = cut_for_time(cuts, match.start)
    if cut is None:
        return None
    local_start = max(0, round((match.start - cut.start) * 1000))
    cut_global_start = round(cut.start * 1000)
    duration_ms = max(1, round(cut.end * 1000) - cut_global_start)
    local_end = min(duration_ms, max(local_start + 1, round((match.end - cut.start) * 1000)))
    global_start = cut_global_start + local_start
    return {
        "asset_id": f"aud_{cut.index:04d}",
        "start_ms": local_start,
        "end_ms": local_end,
        "global_start_ms": global_start,
    }


def word_timings(sentence: CanonicalSentence, match: SentenceAlignment, words: list[Word]) -> list[dict[str, Any]]:
    """Return source-text words with sentence-relative audiobook timings."""
    if match.start is None or match.end is None:
        return []
    source_words = re.findall(r"\S+", sentence.text)
    spoken = [word for word in words if word.end > match.start and word.start < match.end]
    if not source_words or not spoken:
        return []

    source_norm = [" ".join(re.findall(r"\w+", item.casefold())) for item in source_words]
    spoken_norm = [" ".join(re.findall(r"\w+", item.text.casefold())) for item in spoken]
    used: set[int] = set()
    mapped: list[Word | None] = []
    cursor = 0
    for index, token in enumerate(source_norm):
        candidates = [candidate for candidate in range(cursor, min(len(spoken), cursor + 5)) if spoken_norm[candidate] == token]
        if candidates:
            selected = candidates[0]
            cursor = selected + 1
            used.add(selected)
            mapped.append(spoken[selected])
            continue
        proportional = min(len(spoken) - 1, round(index * (len(spoken) - 1) / max(1, len(source_words) - 1)))
        mapped.append(spoken[proportional] if proportional not in used else None)
        used.add(proportional)

    duration_ms = max(1, round((match.end - match.start) * 1000))
    if duration_ms < len(source_words):
        return []
    result: list[dict[str, Any]] = []
    previous_end = 0
    for index, (text, timing) in enumerate(zip(source_words, mapped)):
        fallback_start = round(duration_ms * index / len(source_words))
        fallback_end = round(duration_ms * (index + 1) / len(source_words))
        remaining_words = len(source_words) - index - 1
        latest_end = duration_ms - remaining_words
        start_ms = min(latest_end - 1, max(previous_end, round((timing.start - match.start) * 1000) if timing else fallback_start))
        end_ms = min(latest_end, max(start_ms + 1, round((timing.end - match.start) * 1000) if timing else fallback_end))
        result.append({"text": text, "start_ms": start_ms, "end_ms": end_ms})
        previous_end = end_ms
    return result


def build_overlay_entries(
    source_type: str,
    chapter_range: ChapterRange,
    chapter_index: int,
    content_path: str,
    canonical: list[list[CanonicalSentence]],
    words: list[Word],
    alignment_backend: AlignmentBackend,
    cuts: list[Cut],
) -> list[dict[str, Any]]:
    flat_sentences = [sentence for paragraph in canonical for sentence in paragraph]
    alignments = alignment_backend.align(
        flat_sentences,
        words,
        chapter_range.start,
        chapter_range.end,
    )
    alignment_by_id = {alignment.sentence_id: alignment for alignment in alignments}
    entries: list[dict[str, Any]] = []
    for paragraph in canonical:
        for sentence in paragraph:
            match = alignment_by_id[sentence.sentence_id]
            locator: dict[str, Any]
            if source_type == "epub":
                locator = {
                    "type": "epub",
                    "document": content_path,
                    "element_id": sentence.sentence_id,
                }
            else:
                locator = {
                    "type": "pdf",
                    "page": chapter_range.chapter.pdf_page,
                    "spans": [
                        {
                            "text_item": 0,
                            "start_character": sentence.character_start,
                            "end_character": sentence.character_end,
                        }
                    ],
                }
            reasons = list(match.reasons)
            if source_type == "pdf":
                reasons.append("provisional-pdf-text-locator")
            entries.append(
                {
                    "sentence_id": sentence.sentence_id,
                    "ordinal": sentence.ordinal,
                    "text": sentence.text,
                    "text_locator": locator,
                    "audio_locator": audio_locator(match, cuts),
                    "confidence": match.confidence,
                    "alignment": match.state,
                    "reasons": reasons,
                    "words": word_timings(sentence, match, words),
                }
            )
    return entries


def build_booksync_package(
    *,
    output_root: Path,
    book_path: Path,
    audio_path: Path,
    transcript_path: Path,
    book: ExtractedBook,
    plan: ProcessingPlan,
    words: list[Word],
    book_name: str,
    language: str,
    mode: str,
    minutes: float,
    naming_template: str,
    alignment_backend: AlignmentBackend,
) -> Path:
    source_hash = sha256_file(book_path)
    audiobook_hash = sha256_file(audio_path)
    book_id = derive_book_id(source_hash, audiobook_hash)
    package_root = prepare_package_root(output_root, book_name)

    source_destination = package_root / "source" / f"book{book_path.suffix.lower()}"
    source_destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(book_path, source_destination)

    transcript_destination = package_root / "transcript" / "transcript.json"
    transcript_destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(transcript_path, transcript_destination)

    checksum_paths: list[Path] = [source_destination, transcript_destination]
    audio_assets: list[dict[str, Any]] = []
    for cut in plan.cuts:
        legacy_path = output_root / cut.output
        package_audio = package_root / "audio" / f"audio-{cut.index:04d}.mp3"
        link_or_copy(legacy_path, package_audio)
        checksum_paths.append(package_audio)
        global_start_ms = round(cut.start * 1000)
        audio_assets.append(
            {
                "id": f"aud_{cut.index:04d}",
                "path": package_audio.relative_to(package_root).as_posix(),
                "media_type": "audio/mpeg",
                "sha256": sha256_file(package_audio),
                "byte_length": package_audio.stat().st_size,
                "duration_ms": max(1, round(cut.end * 1000) - global_start_ms),
                "global_start_ms": global_start_ms,
                "display_filename": cut.output,
            }
        )

    chapters: list[dict[str, Any]] = []
    overlay_assets: list[dict[str, Any]] = []
    all_entries: list[dict[str, Any]] = []
    chapter_entry_groups: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    for chapter_index, chapter_range in enumerate(plan.chapter_ranges, 1):
        chapter_id = f"ch_{chapter_index:04d}"
        overlay_id = f"ov_{chapter_index:04d}"
        canonical, _ = canonicalize_chapter(chapter_range.chapter, chapter_index)
        content_file = package_root / "content" / f"chapter-{chapter_index:04d}.html"
        content_path = content_file.relative_to(package_root).as_posix()
        write_chapter_html(content_file, chapter_range.chapter, canonical, language)
        checksum_paths.append(content_file)

        entries = build_overlay_entries(
            book.source_type,
            chapter_range,
            chapter_index,
            content_path,
            canonical,
            words,
            alignment_backend,
            plan.cuts,
        )
        all_entries.extend(entries)
        overlay_file = package_root / "overlays" / f"chapter-{chapter_index:04d}.json"
        write_json(
            overlay_file,
            {
                "format": "booksync-overlay",
                "schema_version": 1,
                "overlay_id": overlay_id,
                "book_id": book_id,
                "chapter_id": chapter_id,
                "entries": entries,
            },
        )
        checksum_paths.append(overlay_file)
        chapter_record = {
            "id": chapter_id,
            "index": chapter_index,
            "label": chapter_range.chapter.number,
            "title": chapter_range.chapter.title or None,
            "content_path": content_path,
            "content_sha256": sha256_file(content_file),
            "content_byte_length": content_file.stat().st_size,
            "overlay_id": overlay_id,
            "audio_start_ms": round(chapter_range.start * 1000),
            "audio_end_ms": round(chapter_range.end * 1000),
        }
        chapters.append(chapter_record)
        chapter_entry_groups.append((chapter_record, entries))
        overlay_assets.append(
            {
                "id": overlay_id,
                "chapter_id": chapter_id,
                "path": overlay_file.relative_to(package_root).as_posix(),
                "sha256": sha256_file(overlay_file),
                "byte_length": overlay_file.stat().st_size,
                "entry_count": len(entries),
            }
        )

    exact_count = sum(entry["alignment"] == "exact" for entry in all_entries)
    approximate_count = sum(entry["alignment"] == "approximate" for entry in all_entries)
    unmatched_count = sum(entry["alignment"] == "unmatched" for entry in all_entries)
    aligned_count = exact_count + approximate_count
    sentence_count = len(all_entries)

    display_title = book.title or book_name.replace("_", " ")
    quality_file = package_root / "reports" / "quality-report.json"
    write_json(
        quality_file,
        build_quality_report(
            title=display_title,
            backend_name=alignment_backend.name,
            chapter_entries=chapter_entry_groups,
            plan=plan,
        ),
    )
    review_file = package_root / "reports" / "alignment-review.html"
    write_alignment_review(review_file, display_title, chapter_entry_groups)
    checksum_paths.extend([quality_file, review_file])

    source_record = file_record(package_root, source_destination)
    transcript_record = file_record(package_root, transcript_destination)
    manifest = {
        "format": "booksync",
        "schema_version": 1,
        "book_id": book_id,
        "title": display_title,
        "author": book.author,
        "language": language,
        "source": {
            "type": book.source_type,
            "sha256": source_hash,
            "byte_length": book_path.stat().st_size,
            "original_filename": book_path.name,
            "included_path": source_record["path"],
        },
        "audiobook_sha256": audiobook_hash,
        "total_duration_ms": max(1, round(plan.cuts[-1].end * 1000)),
        "chapters": chapters,
        "audio_assets": audio_assets,
        "overlay_assets": overlay_assets,
        "transcript": {
            **transcript_record,
            "media_type": "application/json",
        },
        "quality_report": {
            **file_record(package_root, quality_file),
            "media_type": "application/json",
        },
        "alignment_review": {
            **file_record(package_root, review_file),
            "media_type": "text/html",
        },
        "alignment": {
            "sentence_count": sentence_count,
            "aligned_sentence_count": aligned_count,
            "exact_sentence_count": exact_count,
            "approximate_sentence_count": approximate_count,
            "unmatched_sentence_count": unmatched_count,
            "sentence_coverage": aligned_count / sentence_count if sentence_count else 0.0,
            "thresholds": {
                "exact_min": EXACT_MIN,
                "approximate_min": APPROXIMATE_MIN,
            },
        },
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "generator": {
            "name": "pdf-audiobook-splitter",
            "version": __version__,
            "settings": {
                "mode": mode,
                "minutes": minutes,
                "naming_template": naming_template,
                "alignment_stage": alignment_backend.name,
            },
        },
    }
    write_json(package_root / "manifest.json", manifest)

    checksum_records = [file_record(package_root, path) for path in checksum_paths]
    checksum_records.sort(key=lambda item: item["path"])
    write_json(
        package_root / "checksums.json",
        {
            "format": "booksync-checksums",
            "schema_version": 1,
            "algorithm": "sha256",
            "files": checksum_records,
        },
    )

    from tools.validate_booksync_package import validate_package

    issues = validate_package(package_root)
    if issues:
        formatted = "\n".join(f"- {issue}" for issue in issues)
        raise RuntimeError(f"Generated BookSync package failed validation:\n{formatted}")
    archive_booksync_package(package_root)
    return package_root
