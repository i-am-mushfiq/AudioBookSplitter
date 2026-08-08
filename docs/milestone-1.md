# Milestone 1 implementation notes

## Delivered

- Modular processor package with independent extraction, transcription, alignment, audio, packaging, and CLI modules
- PDF and EPUB metadata/text extraction
- EPUB spine and paragraph preservation
- General front-matter filtering when repeated chapter headings are present
- Existing chapter-safe MP3 naming and legacy manifest behavior
- Reusable external transcript cache support
- Canonical chapter HTML with stable sentence IDs
- Initial transcript-to-sentence overlays with confidence states
- Stable package audio IDs independent of exported filenames
- Source, transcript, content, overlay, and audio checksums
- Automatic BookSync package validation after generation
- Synthetic extractor and package-builder integration tests
- Compatibility entry point at `pdf_audiobook_splitter.py`

## CLI behavior

BookSync output is enabled by default:

```powershell
python .\pdf_audiobook_splitter.py --book .\book.epub --audio .\book.mp3
```

The historical `--pdf` option remains an alias for `--book` so the frontend and existing scripts continue to work.

Use an existing transcript without retranscribing:

```powershell
python .\pdf_audiobook_splitter.py --book .\book.epub --audio .\book.mp3 --transcript-cache .\cache\transcript.json
```

Use `--skip-booksync` for only the legacy MP3 export. `--dry-run` plans cuts and writes the legacy planning manifest but does not render audio or build a package.

## Current alignment boundary

Milestone 1 performs an initial monotonic sentence match against the ASR transcript. It is sufficient to produce usable overlays and confidence metrics, but it is not the forced-alignment engine planned for Milestone 2.

Expected limitations:

- Wording changes can produce unmatched sentences.
- Sentence starts use existing ASR word timestamps.
- PDF text locators are provisional until the PDF.js-aware mapping milestone.
- No word-level highlighting guarantee is made.

Low-confidence sentences are marked `unmatched` instead of being presented as exact synchronization.

## Private end-to-end verification

The local Animal Farm EPUB/audiobook pair was processed without committing either source file or generated output:

- 10 narrated chapters
- 25 chapter-safe audio assets
- 203.2 minutes
- 1,677 canonical sentences
- 1,537 initially aligned sentences
- 91.65% initial sentence coverage
- 25 of 25 audio assets readable by FFprobe
- Generated package passed independent BookSync validation

These figures are a regression baseline, not the Milestone 2 accuracy target.
