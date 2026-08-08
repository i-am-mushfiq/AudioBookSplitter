from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from processor.alignment.planning import select_narrated_chapters
from processor.extractors import extract_book
from processor.models import Chapter, ChapterRange, Cut, ExtractedBook, ProcessingPlan, Word
from processor.packaging import build_booksync_package
from tools.validate_booksync_package import validate_package


class MilestoneOneProcessorTests(unittest.TestCase):
    def test_epub_extractor_preserves_metadata_spine_and_paragraphs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            epub = Path(directory) / "fixture.epub"
            self._write_minimal_epub(epub)
            book = extract_book(epub)

            self.assertEqual(book.source_type, "epub")
            self.assertEqual(book.title, "Synthetic Book")
            self.assertEqual(book.author, "Test Author")
            self.assertEqual(len(book.chapters), 2)
            self.assertEqual(book.chapters[0].title, "Chapter One")
            self.assertEqual(
                book.chapters[0].paragraphs,
                ["Chapter One", "First sentence. Second sentence!"],
            )

    def test_repeated_chapter_headings_exclude_front_matter(self) -> None:
        book = ExtractedBook(
            "epub",
            [],
            [
                Chapter("1", "Cover", 1, "Cover"),
                Chapter("2", "Contents", 2, "Contents"),
                Chapter("3", "Chapter One", 3, "One"),
                Chapter("4", "Chapter Two", 4, "Two"),
            ],
        )
        selected = select_narrated_chapters(book)
        self.assertEqual([chapter.title for chapter in selected], ["Chapter One", "Chapter Two"])

    def test_package_builder_emits_a_valid_booksync_package(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "book.epub"
            source.write_bytes(b"synthetic epub source")
            original_audio = root / "audiobook.wav"
            original_audio.write_bytes(b"synthetic original audio")
            transcript = root / "transcript.json"
            sentence = "This is a synthetic sentence for package validation."
            tokens = sentence.rstrip(".").split()
            words = [
                Word(token, index * 0.1, (index + 1) * 0.1)
                for index, token in enumerate(tokens)
            ]
            transcript.write_text(
                json.dumps({"words": [vars(word) for word in words]}),
                encoding="utf-8",
            )

            output = root / "output"
            output.mkdir()
            legacy_name = "Synthetic_C01_P01.mp3"
            (output / legacy_name).write_bytes(b"synthetic rendered audio asset")
            chapter = Chapter(
                "1",
                "Chapter One",
                1,
                sentence,
                paragraphs=[sentence],
                source_href="chapter.xhtml",
            )
            cut = Cut(1, 0.0, 1.0, 1, 1, "final chunk", legacy_name, "1", "Chapter One", 1)
            plan = ProcessingPlan(
                page_times=[],
                chapter_starts=[(chapter, 0.0)],
                chapter_ranges=[ChapterRange(chapter, 0.0, 1.0)],
                cuts=[cut],
            )
            book = ExtractedBook("epub", [sentence], [chapter], "Synthetic Book", "Test Author")

            builder_arguments = {
                "output_root": output,
                "book_path": source,
                "audio_path": original_audio,
                "transcript_path": transcript,
                "book": book,
                "plan": plan,
                "words": words,
                "book_name": "Synthetic_Book",
                "language": "en",
                "mode": "smart",
                "minutes": 10,
                "naming_template": "{B}.mp3",
            }
            package = build_booksync_package(**builder_arguments)
            rebuilt_package = build_booksync_package(**builder_arguments)

            self.assertEqual(validate_package(package), [])
            self.assertEqual(package, rebuilt_package)
            manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["alignment"]["sentence_coverage"], 1.0)
            self.assertEqual(manifest["chapters"][0]["id"], "ch_0001")
            self.assertTrue((package / "content" / "chapter-0001.html").is_file())

    @staticmethod
    def _write_minimal_epub(path: Path) -> None:
        container = """<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""
        package = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Synthetic Book</dc:title><dc:creator>Test Author</dc:creator>
  </metadata>
  <manifest>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>"""
        chapter_one = """<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head>
<body><h1>Chapter One</h1><p>First sentence. Second sentence!</p></body></html>"""
        chapter_two = """<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head>
<body><h1>Chapter Two</h1><p>Third sentence.</p></body></html>"""
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
            archive.writestr("META-INF/container.xml", container)
            archive.writestr("EPUB/package.opf", package)
            archive.writestr("EPUB/chapter1.xhtml", chapter_one)
            archive.writestr("EPUB/chapter2.xhtml", chapter_two)


if __name__ == "__main__":
    unittest.main()
