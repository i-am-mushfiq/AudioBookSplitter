from __future__ import annotations

import re
from pathlib import Path

from processor.models import Chapter, ExtractedBook


CHAPTER_RE = re.compile(r"^([IVXLCDM]+)\s*$", re.I)


def extract_pdf(pdf_path: Path) -> ExtractedBook:
    try:
        import pdfplumber
    except ImportError as exc:
        raise SystemExit("Missing pdfplumber. Install requirements.txt first.") from exc

    pages: list[str] = []
    metadata: dict = {}
    with pdfplumber.open(pdf_path) as pdf:
        metadata = pdf.metadata or {}
        for page in pdf.pages:
            pages.append(page.extract_text() or "")

    chapters: list[Chapter] = []
    for page_index, page in enumerate(pages):
        lines = [line.strip() for line in page.splitlines() if line.strip()]
        for line_index, line in enumerate(lines):
            match = CHAPTER_RE.match(line)
            if not match or line_index + 1 >= len(lines):
                continue
            title = lines[line_index + 1]
            if len(title) <= 3 or sum(character.isupper() for character in title) < 3:
                continue
            chapter_lines = lines[line_index + 1 :]
            text = " ".join(chapter_lines)
            chapters.append(
                Chapter(
                    number=match.group(1).upper(),
                    title=title,
                    pdf_page=page_index + 1,
                    text=text,
                    paragraphs=[text],
                )
            )
            break

    if not chapters:
        nonempty = [page for page in pages if page.strip()]
        if nonempty:
            chapters = [
                Chapter(
                    number="1",
                    title=str(metadata.get("Title") or pdf_path.stem),
                    pdf_page=1,
                    text=" ".join(nonempty),
                    paragraphs=nonempty,
                )
            ]

    return ExtractedBook(
        source_type="pdf",
        sections=pages,
        chapters=chapters,
        title=str(metadata.get("Title") or "").strip() or None,
        author=str(metadata.get("Author") or "").strip() or None,
    )
