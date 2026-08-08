# PDF-synced audiobook splitter

This project splits any audiobook paired with a book PDF or EPUB into approximately
10-minute MP3 files. It uses the PDF as the text reference and local
`faster-whisper` word timestamps to find chapter starts and sentence boundaries.
Chapter boundaries are hard boundaries: no MP3 contains audio from two PDF
chapters. Longer chapters become numbered parts. Output names include the book
name, total chapter count, and total fraction count, for example:
`Animal_Farm__Chapter_01_of_10__Part_01_of_25.mp3`.
Each output chunk receives a short fade-in/fade-out to prevent clicks or abrupt
cutoffs. `output/manifest.json` records the audio times and estimated PDF pages.

## Setup

The included `environment.yml` creates a Conda environment. CPU mode works on
any modern machine; CUDA mode is substantially faster with an NVIDIA GPU.

```powershell
conda env create -f environment.yml
conda activate pdf-audiobook-splitter
```

If Conda is unavailable:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

FFmpeg must be installed and available on `PATH` (`ffmpeg` and `ffprobe`).

## Run

The first run downloads the selected Whisper model and writes a reusable
transcript cache. Transcription is bounded to five-minute windows by default,
so long audiobooks do not create a giant NumPy STFT in memory. Progress is
checkpointed after every window and resumes from the partial transcript if the
job is interrupted. The default `small` model is a good quality/speed balance.

```powershell
python .\pdf_audiobook_splitter.py --model small --device cpu
```

To change the bounded window size:

```powershell
python .\pdf_audiobook_splitter.py --window-seconds 180 --model small --device cuda
```

When the folder contains exactly one PDF or EPUB and one MP3, the inputs are detected
automatically. For multiple books, pass them explicitly:

```powershell
python .\pdf_audiobook_splitter.py --pdf .\book.pdf --audio .\book.mp3 --device cuda
```

For a faster NVIDIA GPU run:

```powershell
python .\pdf_audiobook_splitter.py --model medium --device cuda
```

For the upload frontend, run the local processing service alongside the
frontend dev server:

```powershell
node .\frontend\local-server.mjs
```

The frontend at `http://localhost:3000` sends uploaded files to the local
service on port 3001. It returns a new ZIP for every export; it does not use a
hard-coded book archive.

To inspect the planned cuts without rendering MP3s:

```powershell
python .\pdf_audiobook_splitter.py --dry-run
```

Outputs are placed in `output/`: numbered MP3 chunks, the legacy
`manifest.json`, the cached `transcript.json`, and a validated
`<Book_Name>.booksync/` package. The BookSync package contains the source book,
stable audio assets, canonical chapter HTML, sentence overlays, checksums, and
its own versioned manifest. The audio and book cannot be synchronized from file
metadata alone, so the Whisper alignment step is intentionally required.

The original command remains the compatibility entry point, while the
implementation is divided into focused modules under `processor/`:

```text
processor/
├── extractors/
├── transcription/
├── alignment/
├── audio/
├── packaging/
└── cli.py
```

To reuse a transcript stored elsewhere:

```powershell
python .\pdf_audiobook_splitter.py --pdf .\book.epub --audio .\book.mp3 --transcript-cache .\cache\transcript.json
```

Use `--skip-booksync` when only the legacy MP3 export is wanted.

Milestone 2 uses chapter-wide sequence alignment by default. It can align
one-to-many and many-to-one sentence groups, skip source or transcript
omissions without losing later matches, and refine sentence times back onto
ASR word timestamps. Use `--resume` to reuse already rendered, FFprobe-valid
audio parts after an interrupted run.

Each BookSync package now includes:

- `reports/quality-report.json` with chapter coverage and cut diagnostics
- `reports/alignment-review.html` for human review of every sentence

The current backend uses ASR word timestamps. Its backend interface is ready
for a future acoustic forced aligner, but the quality report deliberately does
not claim that acoustic forced alignment or manual timing evaluation occurred.

## BookSync v1 contract

Milestone 0 of the synchronized-reader roadmap defines the provider-neutral
BookSync package contract. The versioned JSON Schemas are in `schemas/`, the
normative package rules and architecture decisions are in `docs/`, and a
generated, copyright-free fixture is in `examples/minimal.booksync/`.

Validate the example package:

```powershell
conda run --no-capture-output -n animal-farm-splitter python .\tools\validate_booksync_package.py .\examples\minimal.booksync
```

Run the contract tests:

```powershell
conda run --no-capture-output -n animal-farm-splitter python -m unittest tests.test_booksync_contract -v
```

The processor emits BookSync v1 packages by default. See `plan.md` for the
remaining reader and storage roadmap.
