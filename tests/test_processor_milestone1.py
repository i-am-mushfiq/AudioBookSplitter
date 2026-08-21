from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from processor.alignment.backends import TranscriptSequenceAlignmentBackend
from processor.alignment.planning import build_processing_plan, select_narrated_chapters
from processor.extractors import extract_book
from processor.extractors.epub import EpubTextParser
from processor.models import Chapter, ChapterRange, Cut, ExtractedBook, ProcessingPlan, Word
from processor.packaging import build_booksync_package
from processor.text import norm, split_sentences
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
            self.assertNotIn("promotional", book.chapters[1].text)

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

    def test_div_based_epub_prose_is_not_dropped_by_sparse_block_markup(self) -> None:
        parser = EpubTextParser()
        parser.feed("<html><head><title>Book</title></head><body><h1>Chapter One</h1><div>" + ("Narrated prose sentence. " * 20) + "</div></body></html>")
        parser.close()
        paragraph_text = " ".join(parser.paragraphs)
        self.assertGreater(len(parser.text), len(paragraph_text) * 4)

    def test_output_chapter_numbers_are_sequential_after_front_matter(self) -> None:
        chapters = [
            Chapter("1", "Cover", 1, "Cover"),
            Chapter("7", "Chapter One", 7, "Chapter One begins with enough matching words here."),
            Chapter("8", "Chapter Two", 8, "Chapter Two begins with enough matching words here."),
        ]
        book = ExtractedBook("epub", [], chapters, "Synthetic", None)
        words = [
            Word("Chapter", 0.0, 0.2), Word("One", 0.2, 0.4), Word("begins", 0.4, 0.6),
            Word("with", 0.6, 0.8), Word("enough", 0.8, 1.0), Word("matching", 1.0, 1.2), Word("words", 1.2, 1.4), Word("here.", 1.4, 1.6),
            Word("Chapter", 100.0, 100.2), Word("Two", 100.2, 100.4), Word("begins", 100.4, 100.6),
            Word("with", 100.6, 100.8), Word("enough", 100.8, 101.0), Word("matching", 101.0, 101.2), Word("words", 101.2, 101.4), Word("here.", 101.4, 101.6),
        ]
        plan = build_processing_plan(book, words, "Synthetic", 200.0, 10.0, "smart")
        self.assertEqual([cut.chapter_number for cut in plan.cuts], ["1", "2"])

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
                "alignment_backend": TranscriptSequenceAlignmentBackend(),
            }
            package = build_booksync_package(**builder_arguments)
            rebuilt_package = build_booksync_package(**builder_arguments)

            self.assertEqual(validate_package(package), [])
            self.assertEqual(package, rebuilt_package)
            manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["alignment"]["sentence_coverage"], 1.0)
            self.assertEqual(manifest["chapters"][0]["id"], "ch_0001")
            self.assertTrue((package / "content" / "chapter-0001.html").is_file())

    def test_sentence_segmentation_preserves_abbreviations_and_dialogue(self) -> None:
        paragraph = 'Mr. Jones left. "Mollie!" she cried. It was late.'
        self.assertEqual(
            split_sentences(paragraph),
            ["Mr. Jones left.", '"Mollie!" she cried.', "It was late."],
        )

    def test_number_words_and_digits_share_canonical_tokens(self) -> None:
        self.assertEqual(norm("Chapter Four"), norm("Chapter 4"))

    def test_sequence_alignment_skips_omission_without_losing_later_repetition(self) -> None:
        source_texts = [
            "I do not believe that.",
            "Snowball fought bravely at the Battle of the Cowshed.",
            "But Boxer was still a little uneasy.",
            "I do not believe that Snowball was a traitor at the beginning.",
            "What he has done since is different.",
        ]
        transcript_texts = [source_texts[0], source_texts[2], source_texts[3], source_texts[4]]
        sentences = [
            type("Sentence", (), {"sentence_id": f"sent_{index}", "ordinal": index, "text": text})()
            for index, text in enumerate(source_texts, 1)
        ]
        words: list[Word] = []
        clock = 0.0
        for sentence in transcript_texts:
            tokens = sentence.split()
            for token in tokens:
                words.append(Word(token, clock, clock + 0.1))
                clock += 0.1
        aligned = TranscriptSequenceAlignmentBackend().align(sentences, words, 0.0, clock + 0.1)
        self.assertEqual(aligned[1].state, "unmatched")
        self.assertNotEqual(aligned[3].state, "unmatched")
        self.assertGreater(aligned[3].start or 0, aligned[0].start or 0)
        starts = [item.start for item in aligned if item.start is not None]
        self.assertEqual(starts, sorted(starts))

    def test_smart_cutting_balances_short_chapter_remainders(self) -> None:
        chapter_text = " ".join(f"Sentence {index}." for index in range(1, 13))
        chapter = Chapter("1", "Chapter One", 1, chapter_text, paragraphs=[chapter_text])
        book = ExtractedBook("epub", [chapter_text], [chapter], "Synthetic", None)
        words = [Word(f"sentence{index}.", index * 60.0, index * 60.0 + 0.2) for index in range(12)]
        plan = build_processing_plan(book, words, "Synthetic", 701.0, 10.0, "smart")
        durations = [cut.end - cut.start for cut in plan.cuts]
        self.assertEqual(len(durations), 2)
        self.assertGreater(min(durations), 300)

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
<body><h1>Chapter Two</h1><p>Third sentence.</p><p>THE END</p><p>promotional download site</p></body></html>"""
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
            archive.writestr("META-INF/container.xml", container)
            archive.writestr("EPUB/package.opf", package)
            archive.writestr("EPUB/chapter1.xhtml", chapter_one)
            archive.writestr("EPUB/chapter2.xhtml", chapter_two)


if __name__ == "__main__":
    unittest.main()
