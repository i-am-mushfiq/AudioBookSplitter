# Milestone 2 implementation notes

## Delivered

- Pluggable `AlignmentBackend` contract
- Chapter-bounded global sequence alignment
- Explicit source and transcript gaps
- One-to-many and many-to-one sentence transitions
- Transcript-token timing refinement inside grouped matches
- Confidence-aware exact, approximate, and unmatched states
- Abbreviation- and dialogue-aware sentence segmentation
- Number-word normalization such as `Four` and `4`
- End-of-book EPUB boilerplate removal
- Balanced smart-mode chapter parts
- Sentence, speech-pause, and chapter-safe cut diagnostics
- Resume-safe rendered-audio reuse with FFprobe duration checks
- Atomic progress checkpoints
- Per-chapter quality report
- Standalone HTML alignment review

## Alignment semantics

The default `sequence` backend aligns canonical book sentences against ASR
sentences globally within each chapter. This fixes the Milestone 1 failure mode
where a repeated phrase could make a greedy matcher jump forward and lose a
large block of otherwise narrated text.

Sentence timing has two levels:

- `token-refined`: the sentence was relocated to matching ASR word positions.
- `proportional-timing`: a grouped match was divided proportionally when a
  reliable local token start was unavailable.

This is not yet acoustic forced alignment. The manifest and quality report do
not claim that it is. A future backend can implement the same interface using
WhisperX, Montreal Forced Aligner, or another acoustic aligner without changing
the BookSync package contract.

## Animal Farm regression result

The ignored local EPUB/audiobook pair produced:

- 10 chapters
- 25 chapter-safe parts
- 5.82 to 10.06 minutes per part
- No part under four minutes
- No unsafe internal cuts
- 1,614 canonical sentences after segmentation and boilerplate cleanup
- 1,610 aligned sentences
- 1,394 exact text matches
- 216 approximate text matches
- 4 deliberately suppressed low-confidence sentences
- 99.75% sentence coverage
- 1,371 token-refined sentence timings
- No unmatched run longer than one sentence
- 25 of 25 audio files readable by FFprobe
- Full package validation passed

Milestone 1 baseline coverage was 91.65% with 140 unmatched entries and tail
parts as short as 1.25 minutes.

## Remaining quality gate

The plan's median and 95th-percentile timing-error targets require an
independent manually labeled sample. The generated alignment review provides
the inspection surface, while `quality-report.json` records manual timing
evaluation as incomplete until real measurements are supplied.
