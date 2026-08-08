from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

from processor.models import Cut, ExtractedBook, ProcessingPlan
from processor.text import roman_to_int


DEFAULT_NAMING_TEMPLATE = "[{I2}|{T}]_{B}__C[{C2}|{CT}]__P[{P}|{PT}].mp3"


def render_filename(
    template: str,
    item: Cut,
    book_name: str,
    total_parts: int,
    total_chapters: int,
    chapter_part_count: int,
) -> str:
    chapter = roman_to_int(item.chapter_number)
    values = {
        "B": book_name,
        "T": str(total_parts),
        "CT": str(total_chapters),
        "PT": str(chapter_part_count),
        "I": str(item.index),
        "I2": f"{item.index:02d}",
        "C": str(chapter),
        "C2": f"{chapter:02d}",
        "P": str(item.part),
        "P2": f"{item.part:02d}",
    }
    for key, value in values.items():
        template = template.replace("{" + key + "}", value)
    replacements = [
        ("Chapter_01", f"Chapter_{values['C2']}"),
        ("Chapter01", f"Chapter{values['C2']}"),
        ("Chapter[01", f"Chapter[{values['C2']}"),
        ("Ch_01", f"Ch_{values['C2']}"),
        ("Ch01", f"Ch{values['C2']}"),
        ("C[01", f"C[{values['C2']}"),
        ("C01", f"C{values['C2']}"),
        ("Part_01", f"Part_{values['P2']}"),
        ("Part_1", f"Part_{values['P']}"),
        ("Part1", f"Part{values['P']}"),
        ("P[1", f"P[{values['P']}"),
        ("P1", f"P{values['P']}"),
        ("BookPart_01", f"BookPart_{values['I2']}"),
        ("WholeBook_01", f"WholeBook_{values['I2']}"),
        ("Book_01", f"Book_{values['I2']}"),
        ("B01", f"B{values['I2']}"),
        ("Fraction_01", f"Fraction_{values['I2']}"),
        ("001-", f"{item.index:03d}-"),
        ("01-", f"{values['I2']}-"),
        ("01of", f"{values['I2']}of"),
        ("[01|", f"[{values['I2']}|"),
        ("[01-", f"[{values['I2']}-"),
        ("01•", f"{values['I2']}•"),
        ("01·", f"{values['I2']}·"),
        ("01|", f"{values['I2']}|"),
        ("01:", f"{values['I2']}:")
    ]
    for old, new in replacements:
        template = template.replace(old, new)
    template = template.replace("|", "+").replace(":", "-").replace("/", "-").replace("\\", "-")
    return re.sub(r"[^A-Za-z0-9_\[\]().+•· -]", "", template)


def assign_output_names(plan: ProcessingPlan, template: str, book_name: str) -> None:
    total_chapters = len(plan.chapter_ranges)
    total_parts = len(plan.cuts)
    chapter_part_counts = Counter(item.chapter_number for item in plan.cuts)
    for item in plan.cuts:
        item.output = render_filename(
            template,
            item,
            book_name,
            total_parts,
            total_chapters,
            chapter_part_counts[item.chapter_number],
        )


def write_legacy_manifest(
    output: Path,
    book_path: Path,
    audio_path: Path,
    book_name: str,
    book: ExtractedBook,
    duration: float,
    plan: ProcessingPlan,
    naming_template: str,
) -> None:
    report = {
        "book_name": book_name,
        "source_type": book.source_type,
        "total_chapters": len(plan.chapter_ranges),
        "total_parts": len(plan.cuts),
        "filename_pattern": naming_template,
        "source_pdf": str(book_path),
        "source_audio": str(audio_path),
        "audio_duration_seconds": duration,
        "pdf_pages": len(book.sections),
        "chapters": [
            {
                "number": chapter.number,
                "title": chapter.title,
                "pdf_page": chapter.pdf_page,
                "text": chapter.text,
            }
            for chapter, _ in plan.chapter_starts
        ],
        "chapter_audio_starts": [
            {
                "number": chapter.number,
                "title": chapter.title,
                "pdf_page": chapter.pdf_page,
                "audio_start": start,
            }
            for chapter, start in plan.chapter_starts
        ],
        "chunks": [vars(cut) for cut in plan.cuts],
    }
    (output / "manifest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
