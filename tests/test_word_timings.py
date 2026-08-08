from __future__ import annotations

import unittest

from processor.alignment.backends import SentenceAlignment
from processor.models import Word
from processor.packaging.booksync import CanonicalSentence, word_timings


class WordTimingTests(unittest.TestCase):
    def test_emits_source_words_with_sentence_relative_monotonic_times(self) -> None:
        sentence = CanonicalSentence("sent_1", 1, "Hello, brave world!", 1, 0, 19)
        alignment = SentenceAlignment("sent_1", 10.0, 11.5, 0.99, "exact", ())
        transcript = [Word("Hello", 10.0, 10.4), Word("brave", 10.5, 10.9), Word("world", 1.0 + 10.0, 11.5)]

        timings = word_timings(sentence, alignment, transcript)

        self.assertEqual([item["text"] for item in timings], ["Hello,", "brave", "world!"])
        self.assertEqual(timings[0]["start_ms"], 0)
        self.assertTrue(all(left["end_ms"] <= right["start_ms"] for left, right in zip(timings, timings[1:])))
        self.assertLessEqual(timings[-1]["end_ms"], 1500)


if __name__ == "__main__":
    unittest.main()
