# AudioBookSplitter / BookSync

BookSync turns a PDF or EPUB and its matching audiobook into chapter-safe listening files and a synchronized local reading package.

It can:

- detect chapters from PDF or EPUB content;
- transcribe long audiobooks in bounded, resumable windows with `faster-whisper`;
- align book sentences to audiobook timestamps;
- split audio near the requested duration without crossing chapter boundaries;
- export readable, configurable MP3 filenames and a downloadable ZIP;
- build a validated `.booksync` package containing canonical chapter HTML, audio assets, checksums, sentence overlays, and optional word timings;
- highlight the spoken sentence and current word in the browser reader;
- preserve a private offline library, playback speed, chapter, and listening position in browser storage.

## Requirements

- Windows, macOS, or Linux with Python 3.11+
- FFmpeg and FFprobe available on `PATH`
- Node.js 22.13+ for the web interface
- NVIDIA GPU and CUDA are optional but recommended for transcription

## Python setup

Using Conda:

```powershell
conda env create -f environment.yml
conda activate animal-farm-splitter
```

The historical environment name is retained for compatibility; the application itself is book-agnostic.

Using `venv`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Command-line processing

When the working directory contains exactly one PDF or EPUB and one audiobook, inputs can be detected automatically:

```powershell
python .\pdf_audiobook_splitter.py --device cuda --model small
```

Explicit inputs and output directory:

```powershell
python .\pdf_audiobook_splitter.py `
  --book .\book.epub `
  --audio .\audiobook.mp3 `
  --output .\output `
  --device cuda `
  --minutes 10 `
  --mode smart
```

Useful options:

- `--device cpu|cuda`: transcription device.
- `--model small|medium|...`: Whisper model.
- `--window-seconds 300`: bounded transcription window, preventing whole-book STFT memory exhaustion.
- `--minutes 10`: approximate target duration for time-based parts.
- `--mode smart`: sentence-aware timed splitting; chapter-wide output is also available through the UI.
- `--resume`: reuse checkpoints and valid rendered audio after interruption.
- `--transcript-cache <path>`: reuse a transcript generated elsewhere.
- `--dry-run`: inspect the planned cuts without rendering MP3s.
- `--skip-booksync`: produce only the legacy MP3 export.

Chapter boundaries are always hard boundaries: one output MP3 never contains two chapters. Cuts receive short fades to avoid abrupt transitions.

## Web application

Install frontend dependencies:

```powershell
cd .\frontend
npm install
```

Run the local processing service from the repository root:

```powershell
node .\frontend\local-server.mjs
```

Run the frontend in another terminal:

```powershell
cd .\frontend
npm run dev
```

Open `http://localhost:3000`. The splitter accepts a PDF or EPUB plus an audiobook, exposes chunking and filename options, processes the uploaded files through the local service on port 3001, and downloads the actual result as a ZIP.

The synchronized reader is available at `http://localhost:3000/reader`.

Every processed book now also produces a portable `<Book_Name>.booksync.zip`. This is the full reader package—source publication, chapter content, synchronized audio, overlays, transcript, quality reports, manifest, and checksums—and can be imported on desktop, Android, or iPhone.

## Synchronized reader

Import a processed BookSync ZIP in `/reader` to:

- read sanitized EPUB-derived chapter content;
- play a continuous logical audiobook timeline across split audio assets;
- retain the full active-sentence highlight;
- show the current spoken word in darker green when word timings are available;
- navigate by chapter or sentence;
- change theme, font size, follow mode, and playback speed;
- reopen the last book automatically, with its saved chapter, sentence, position, and speed;
- retain an offline local library across relaunches, with visible whole-book and chapter completion progress;
- use larger touch controls, a mobile library drawer, and a persistent audio progress scrubber on iPhone.

Older BookSync packages without the optional `words` overlay field continue to work with sentence-only highlighting. Reprocess an older source pair to add word highlighting.

Reader imports validate schemas, exact sizes, SHA-256 checksums, paths, archive limits, timeline consistency, and word timing order before committing data atomically to IndexedDB. EPUB markup is sanitized with DOMPurify. Database upgrades preserve existing local books rather than rebuilding their storage.

## Mobile targets

The reader has one shared static PWA bundle with Capacitor projects for Android and iPhone. Build the shared mobile bundle and synchronize native projects:

```powershell
cd .\frontend
npm run mobile:sync
```

Android debug APK builds with `npm run android:apk` after installing JDK 17 and the Android SDK. iPhone IPA export requires macOS, Xcode, and an Apple Developer signing team; see [`frontend/ios/README.md`](frontend/ios/README.md).

## Output structure

The selected output directory contains:

- chapter-safe MP3 listening parts;
- `manifest.json` for the legacy split export;
- resumable transcript and processing checkpoints;
- `<Book_Name>.booksync/`, the synchronized package directory;
- alignment quality and review reports.

The BookSync package contains:

```text
<Book_Name>.booksync/
|-- manifest.json
|-- checksums.json
|-- audio/
|-- content/
|-- overlays/
|-- transcript/
|-- reports/
`-- source/
```

User-selected filenames are presentation details. Internal stable IDs and content hashes preserve synchronization independently of export naming.

## Architecture

```text
processor/
|-- extractors/       PDF and EPUB extraction
|-- transcription/    bounded faster-whisper transcription
|-- alignment/        chapter and sentence alignment
|-- audio/            FFmpeg rendering and validation
|-- packaging/        BookSync package and quality reports
`-- cli.py             processing orchestration

frontend/
|-- app/               splitter and synchronized reader UI
|-- lib/booksync/      BookSync types
|-- lib/reader/        validation, storage, and reader logic
`-- tests/             reader hardening tests
```

The package contract and roadmap are documented in [docs/booksync-package-v1.md](docs/booksync-package-v1.md), [docs/milestone-3.md](docs/milestone-3.md), [docs/milestone-3.5-p0-hardening.md](docs/milestone-3.5-p0-hardening.md), and [PLAN.md](PLAN.md).

## Validation and tests

Run all Python tests:

```powershell
conda run --no-capture-output -n animal-farm-splitter python -m unittest discover -s tests
```

Validate a package:

```powershell
conda run --no-capture-output -n animal-farm-splitter python .\tools\validate_booksync_package.py .\output\My_Book.booksync
```

Build the frontend and run reader tests:

```powershell
cd .\frontend
npm test
```

The repository includes only source code and synthetic/copyright-free fixtures. Personal books, audiobooks, generated packages, caches, and output ZIPs must remain untracked.
