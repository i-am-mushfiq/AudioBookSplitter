from __future__ import annotations

import posixpath
import re
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote
from xml.etree import ElementTree

from processor.models import Chapter, ExtractedBook


BLOCK_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote"}
SKIP_TAGS = {"script", "style", "nav", "svg"}
END_MARKERS = {"the end", "end of the project gutenberg ebook"}


class EpubTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.heading = ""
        self.paragraphs: list[str] = []
        self._document_text: list[str] = []
        self._block_parts: list[str] = []
        self._block_tag: str | None = None
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag in SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == "title":
            self._in_title = True
        if tag in BLOCK_TAGS:
            self._finish_block()
            self._block_tag = tag

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in SKIP_TAGS and self._skip_depth:
            self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if tag == "title":
            self._in_title = False
        if self._block_tag == tag:
            self._finish_block()

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        text = " ".join(data.split())
        if not text:
            return
        if self._in_title:
            self.title = f"{self.title} {text}".strip()
        self._document_text.append(text)
        if self._block_tag:
            self._block_parts.append(text)

    def close(self) -> None:
        super().close()
        self._finish_block()

    @property
    def text(self) -> str:
        return " ".join(self._document_text).strip()

    def _finish_block(self) -> None:
        if not self._block_tag:
            return
        text = " ".join(self._block_parts).strip()
        if text:
            self.paragraphs.append(text)
            if self._block_tag.startswith("h") and not self.heading:
                self.heading = text
        self._block_tag = None
        self._block_parts = []


def _metadata_text(opf: ElementTree.Element, name: str) -> str | None:
    element = opf.find(f".//{{*}}metadata/{{*}}{name}")
    if element is None or not element.text:
        return None
    value = " ".join(element.text.split())
    return value or None


def clean_paragraphs(paragraphs: list[str]) -> list[str]:
    cleaned: list[str] = []
    for paragraph in paragraphs:
        marker = " ".join(paragraph.lower().split()).strip(" .—-*_")
        if marker in END_MARKERS or marker.startswith("*** end of"):
            break
        cleaned.append(paragraph)
    return cleaned


def clean_document_text(text: str) -> str:
    marker = re.search(r"(?i)(?:^|\s)(?:\*{3}\s*)?(?:the end|end of the project gutenberg ebook)(?=\s|$)", text)
    return text[: marker.start()].strip() if marker else text.strip()


def extract_epub(epub_path: Path) -> ExtractedBook:
    """Read EPUB spine documents in publication order."""
    with zipfile.ZipFile(epub_path) as archive:
        container = ElementTree.fromstring(archive.read("META-INF/container.xml"))
        rootfile = container.find(".//{*}rootfile")
        if rootfile is None or not rootfile.attrib.get("full-path"):
            raise SystemExit("EPUB has no readable OPF package.")

        opf_path = unquote(rootfile.attrib["full-path"])
        opf_dir = posixpath.dirname(opf_path)
        opf = ElementTree.fromstring(archive.read(opf_path))
        title = _metadata_text(opf, "title")
        author = _metadata_text(opf, "creator")
        manifest = {
            item.attrib["id"]: item.attrib.get("href", "")
            for item in opf.findall(".//{*}manifest/{*}item")
            if item.attrib.get("id")
        }
        spine_ids = [item.attrib.get("idref") for item in opf.findall(".//{*}spine/{*}itemref")]

        sections: list[str] = []
        chapters: list[Chapter] = []
        for spine_index, item_id in enumerate(spine_ids, 1):
            href = manifest.get(item_id or "")
            if not href:
                continue
            document_path = posixpath.normpath(posixpath.join(opf_dir, unquote(href.split("#", 1)[0])))
            try:
                source = archive.read(document_path).decode("utf-8", errors="replace")
            except KeyError:
                continue
            parser = EpubTextParser()
            parser.feed(source)
            parser.close()
            paragraphs = clean_paragraphs(parser.paragraphs)
            paragraph_text = " ".join(paragraphs).strip()
            document_text = clean_document_text(parser.text)
            # Some valid EPUBs (notably Calibre conversions) place most prose in
            # styled div elements while retaining a few h1/p elements. Using the
            # partial block list in that case silently drops nearly the whole book.
            # Fall back to the complete visible document text when block coverage
            # is clearly incomplete; a single canonical paragraph is preferable to
            # losing narration text and sentence alignment.
            if document_text and len(paragraph_text) < len(document_text) * 0.6:
                text = document_text
                paragraphs = [text]
            else:
                text = paragraph_text or document_text
            if not text:
                continue
            chapter_title = (parser.heading or parser.title or f"Section {spine_index}").strip()
            paragraphs = paragraphs or [text]
            sections.append(text)
            chapters.append(
                Chapter(
                    number=str(spine_index),
                    title=chapter_title,
                    pdf_page=len(sections),
                    text=text,
                    paragraphs=paragraphs,
                    source_href=document_path,
                )
            )

    if not chapters:
        raise SystemExit("EPUB contained no readable spine sections.")
    return ExtractedBook("epub", sections, chapters, title=title, author=author)
