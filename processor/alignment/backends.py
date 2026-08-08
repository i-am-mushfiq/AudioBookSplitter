from __future__ import annotations

import difflib
from dataclasses import dataclass
from typing import Protocol, Sequence

from processor.models import Word
from processor.text import norm


EXACT_MIN = 0.85
APPROXIMATE_MIN = 0.60


class AlignableSentence(Protocol):
    sentence_id: str
    ordinal: int
    text: str


@dataclass(frozen=True)
class TranscriptSentence:
    text: str
    start: float
    end: float
    first_word_index: int
    final_word_index: int


@dataclass(frozen=True)
class SentenceAlignment:
    sentence_id: str
    start: float | None
    end: float | None
    confidence: float
    state: str
    reasons: tuple[str, ...]


class AlignmentBackend(Protocol):
    name: str

    def align(
        self,
        sentences: Sequence[AlignableSentence],
        words: list[Word],
        chapter_start: float,
        chapter_end: float,
    ) -> list[SentenceAlignment]: ...


def transcript_sentences(
    words: list[Word],
    chapter_start: float,
    chapter_end: float,
    max_words: int = 45,
) -> list[TranscriptSentence]:
    selected = [
        (index, word)
        for index, word in enumerate(words)
        if chapter_start <= word.start < chapter_end
    ]
    if not selected:
        return []

    units: list[TranscriptSentence] = []
    current: list[tuple[int, Word]] = []
    for item in selected:
        current.append(item)
        word = item[1].text.rstrip()
        if word.endswith((".", "!", "?", '."', '!"', '?"', ".”", "!”", "?”")) or len(current) >= max_words:
            units.append(_make_transcript_sentence(current))
            current = []
    if current:
        units.append(_make_transcript_sentence(current))
    return units


def _make_transcript_sentence(items: list[tuple[int, Word]]) -> TranscriptSentence:
    return TranscriptSentence(
        text=" ".join(word.text for _, word in items),
        start=items[0][1].start,
        end=items[-1][1].end,
        first_word_index=items[0][0],
        final_word_index=items[-1][0],
    )


def similarity(left: str, right: str) -> float:
    left_tokens = norm(left)
    right_tokens = norm(right)
    return token_similarity(left_tokens, right_tokens)


def token_similarity(left_tokens: list[str], right_tokens: list[str]) -> float:
    if not left_tokens or not right_tokens:
        return 0.0
    sequence = difflib.SequenceMatcher(None, left_tokens, right_tokens, autojunk=False).ratio()
    left_set = set(left_tokens)
    right_set = set(right_tokens)
    overlap = 2 * len(left_set & right_set) / (len(left_set) + len(right_set))
    return max(sequence, overlap * 0.96)


def alignment_state(confidence: float) -> str:
    if confidence >= EXACT_MIN:
        return "exact"
    if confidence >= APPROXIMATE_MIN:
        return "approximate"
    return "unmatched"


class TranscriptSequenceAlignmentBackend:
    """Globally align source and ASR sentences within one chapter.

    The dynamic program supports one-to-many and many-to-one transitions, plus
    explicit gaps on either side. This prevents a repeated phrase from causing
    the greedy forward jumps produced by the Milestone 1 matcher.
    """

    name = "transcript-sequence-v2"
    source_gap_penalty = -0.42
    transcript_gap_penalty = -0.28
    minimum_match_similarity = 0.48
    maximum_source_group = 5
    maximum_transcript_group = 3

    def align(
        self,
        sentences: Sequence[AlignableSentence],
        words: list[Word],
        chapter_start: float,
        chapter_end: float,
    ) -> list[SentenceAlignment]:
        source = list(sentences)
        transcript = transcript_sentences(words, chapter_start, chapter_end)
        if not source:
            return []
        if not transcript:
            return [self._unmatched(item, "chapter-has-no-transcript") for item in source]

        source_count = len(source)
        transcript_count = len(transcript)
        negative_infinity = float("-inf")
        scores = [[negative_infinity] * (transcript_count + 1) for _ in range(source_count + 1)]
        previous: list[list[tuple[int, int, str, int, int, float] | None]] = [
            [None] * (transcript_count + 1) for _ in range(source_count + 1)
        ]
        scores[0][0] = 0.0
        source_groups = {
            (index, size): norm(" ".join(item.text for item in source[index : index + size]))
            for index in range(source_count)
            for size in range(1, min(self.maximum_source_group, source_count - index) + 1)
        }
        transcript_groups = {
            (index, size): norm(" ".join(item.text for item in transcript[index : index + size]))
            for index in range(transcript_count)
            for size in range(1, min(self.maximum_transcript_group, transcript_count - index) + 1)
        }

        for source_index in range(source_count + 1):
            for transcript_index in range(transcript_count + 1):
                current = scores[source_index][transcript_index]
                if current == negative_infinity:
                    continue
                if source_index < source_count:
                    self._update(
                        scores,
                        previous,
                        source_index + 1,
                        transcript_index,
                        current + self.source_gap_penalty,
                        (source_index, transcript_index, "skip-source", 1, 0, 0.0),
                    )
                if transcript_index < transcript_count:
                    self._update(
                        scores,
                        previous,
                        source_index,
                        transcript_index + 1,
                        current + self.transcript_gap_penalty,
                        (source_index, transcript_index, "skip-transcript", 0, 1, 0.0),
                    )
                for source_group in range(1, self.maximum_source_group + 1):
                    if source_index + source_group > source_count:
                        break
                    for transcript_group in range(1, self.maximum_transcript_group + 1):
                        if transcript_index + transcript_group > transcript_count:
                            break
                        match_similarity = token_similarity(
                            source_groups[(source_index, source_group)],
                            transcript_groups[(transcript_index, transcript_group)],
                        )
                        if match_similarity < self.minimum_match_similarity:
                            continue
                        grouping_penalty = 0.10 * (source_group + transcript_group - 2)
                        match_score = 2.6 * match_similarity - 1.05 - grouping_penalty
                        self._update(
                            scores,
                            previous,
                            source_index + source_group,
                            transcript_index + transcript_group,
                            current + match_score,
                            (
                                source_index,
                                transcript_index,
                                "match",
                                source_group,
                                transcript_group,
                                match_similarity,
                            ),
                        )

        operations: list[tuple[int, int, str, int, int, float]] = []
        source_index = source_count
        transcript_index = transcript_count
        while source_index or transcript_index:
            operation = previous[source_index][transcript_index]
            if operation is None:
                raise RuntimeError("Sequence alignment backtrace is incomplete")
            operations.append(operation)
            source_index, transcript_index = operation[0], operation[1]
        operations.reverse()

        results: dict[str, SentenceAlignment] = {}
        for source_index, transcript_index, operation, source_group, transcript_group, match_similarity in operations:
            if operation == "skip-source":
                item = source[source_index]
                results[item.sentence_id] = self._unmatched(item, "source-gap")
                continue
            if operation != "match":
                continue

            source_items = source[source_index : source_index + source_group]
            transcript_items = transcript[transcript_index : transcript_index + transcript_group]
            refined = self._refine_group(source_items, transcript_items, words)
            for item, (item_start, item_end, local_similarity, timing_reason) in zip(source_items, refined):
                item_confidence = max(match_similarity * 0.95, local_similarity)
                state = alignment_state(item_confidence)
                if state == "unmatched":
                    results[item.sentence_id] = self._unmatched(item, "weak-sequence-match", item_confidence)
                else:
                    results[item.sentence_id] = SentenceAlignment(
                        sentence_id=item.sentence_id,
                        start=item_start,
                        end=item_end,
                        confidence=round(item_confidence, 4),
                        state=state,
                        reasons=(self.name, f"group-{source_group}:{transcript_group}", timing_reason),
                    )

        return [results.get(item.sentence_id, self._unmatched(item, "source-gap")) for item in source]

    @staticmethod
    def _update(scores, previous, row: int, column: int, score: float, operation) -> None:
        if score > scores[row][column]:
            scores[row][column] = score
            previous[row][column] = operation

    @staticmethod
    def _refine_group(
        source_items: Sequence[AlignableSentence],
        transcript_items: list[TranscriptSentence],
        words: list[Word],
    ) -> list[tuple[float, float, float, str]]:
        first_word = transcript_items[0].first_word_index
        final_word = transcript_items[-1].final_word_index
        span_words = words[first_word : final_word + 1]
        transcript_tokens: list[str] = []
        token_word_indexes: list[int] = []
        for relative_word_index, word in enumerate(span_words):
            for token in norm(word.text):
                transcript_tokens.append(token)
                token_word_indexes.append(relative_word_index)

        interval_start = transcript_items[0].start
        interval_end = transcript_items[-1].end
        weights = [max(1, len(norm(item.text))) for item in source_items]
        total_weight = sum(weights)
        elapsed_weight = 0
        cursor_token = 0
        previous_end = interval_start
        results: list[tuple[float, float, float, str]] = []
        for item, weight in zip(source_items, weights):
            fallback_start = interval_start + (interval_end - interval_start) * elapsed_weight / total_weight
            elapsed_weight += weight
            fallback_end = interval_start + (interval_end - interval_start) * elapsed_weight / total_weight
            target = norm(item.text)
            best: tuple[float, int] | None = None
            if target and transcript_tokens:
                candidate_positions = [
                    index
                    for index in range(cursor_token, len(transcript_tokens))
                    if transcript_tokens[index] == target[0]
                ]
                for candidate in candidate_positions:
                    comparison = transcript_tokens[candidate : candidate + len(target)]
                    score = token_similarity(target, comparison)
                    if best is None or score > best[0]:
                        best = (score, candidate)
                        if score >= 0.995:
                            break
            if best is not None and best[0] >= 0.58:
                score, candidate = best
                final_token = min(len(token_word_indexes) - 1, candidate + len(target) - 1)
                start_word = span_words[token_word_indexes[candidate]]
                end_word = span_words[token_word_indexes[final_token]]
                item_start = max(previous_end, start_word.start)
                item_end = max(item_start + 0.001, end_word.end)
                results.append((item_start, item_end, score, "token-refined"))
                cursor_token = final_token + 1
                previous_end = item_end
            else:
                item_start = max(previous_end, fallback_start)
                item_end = max(item_start + 0.001, fallback_end)
                results.append((item_start, item_end, best[0] if best else 0.0, "proportional-timing"))
                cursor_token = max(cursor_token, round(len(transcript_tokens) * elapsed_weight / total_weight))
                previous_end = item_end
        return results

    @staticmethod
    def _unmatched(
        sentence: AlignableSentence,
        reason: str,
        confidence: float = 0.0,
    ) -> SentenceAlignment:
        return SentenceAlignment(
            sentence_id=sentence.sentence_id,
            start=None,
            end=None,
            confidence=round(confidence, 4),
            state="unmatched",
            reasons=("transcript-sequence-v2", reason),
        )


def create_alignment_backend(name: str) -> AlignmentBackend:
    if name == "sequence":
        return TranscriptSequenceAlignmentBackend()
    raise ValueError(f"Unknown alignment backend: {name}")
