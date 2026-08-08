from __future__ import annotations

from pathlib import Path

from processor.extractors.epub import extract_epub
from processor.extractors.pdf import extract_pdf
from processor.models import ExtractedBook


def extract_book(book_path: Path) -> ExtractedBook:
    if book_path.suffix.lower() == ".epub":
        return extract_epub(book_path)
    if book_path.suffix.lower() == ".pdf":
        return extract_pdf(book_path)
    raise SystemExit(f"Unsupported book format: {book_path.suffix or '(none)'}")


__all__ = ["extract_book", "extract_epub", "extract_pdf"]
