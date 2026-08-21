# BookSync

Turn a PDF or EPUB and its matching audiobook into short, chapter-safe listening sessions and a private synchronized reader. BookSync never deliberately combines two chapters in one MP3, and each cut receives a short fade rather than an abrupt stop.

## Start here

The quickest reliable route is the local web app.

1. Install the Python environment once:

   ```powershell
   conda env create -f environment.yml
   conda activate animal-farm-splitter
   ```

2. Install the web app once:

   ```powershell
   cd .\frontend
   npm install
   ```

3. Start the local processing service from the project root:

   ```powershell
   node .\frontend\local-server.mjs
   ```

4. In a second terminal, start the interface:

   ```powershell
   cd .\frontend
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000), upload your PDF/EPUB and audiobook, choose your options, and process the book.

The result includes chapter-safe MP3 files and a portable `<Book_Name>.booksync.zip` that can be opened by the synchronized reader.

## What to do in the app

1. Choose the book source: **PDF** or **EPUB**.
2. Choose its matching audiobook file.
3. Enter a book name if you do not want to use the file name.
4. Choose a target session length, such as 10 minutes. BookSync keeps chapter boundaries hard even when this means a part is shorter or longer.
5. Select **CUDA/GPU** when your NVIDIA environment is ready; otherwise select CPU.
6. Start processing and download the ZIP when it finishes.

For focused reading and listening, open [http://localhost:3000/reader](http://localhost:3000/reader) and import the generated `.booksync.zip`.

## Reader: what it remembers

The reader is local and private. After importing a BookSync ZIP, it keeps the library in browser/app storage. The app always opens on the library, with a prominent **Continue reading** card for the last book.

It remembers:

- current chapter, sentence, listening position, and playback speed;
- furthest book progress and completed chapters;
- the last opened book;
- reader theme, font size, and follow-audio preference for the current session.

It also provides sentence highlighting, optional darker current-word highlighting, a cover-based mobile library, progress scrubber, chapter completion state, and speed controls from `0.5×` to `2.5×`.

Inside a book, select **Contents** to switch between two useful views:

- **Chapters** shows the book's hard chapter boundaries, duration, completion, and current chapter.
- **Timed sessions** shows every manageable audio part already created by BookSync. These sessions remain chapter-safe and never combine two chapters.

The mobile reader uses larger type and touch targets, a compact audiobook player, sentence-by-sentence navigation, and a separate playback-speed panel so the book itself has more room on screen. When playback starts, Follow immediately centers the sentence already being narrated. A subtle short divider marks each timed-session transition in the text, and the thin green bar tracks the current session rather than the whole book.

For personal recall marks, turn on **✦ Highlight** and tap a sentence once. Tap it again to remove the mark. Personal highlights persist with the local book, remain visually distinct from the live narrator highlight, and are available from **Contents → Highlights**.

## Streaming from Oracle Object Storage

The reader can now combine offline ZIP imports with an Oracle-hosted library. On the Library screen, select **Oracle** and paste a read-only OCI Object Storage bucket/prefix pre-authenticated URL or its complete `library.json` URL.

Remote books do not download as complete audiobooks. BookSync loads their manifest and current chapter metadata, then maintains a moving audio window containing the previous 2 sessions, the current session, and the next 3 sessions. Audio outside that window is released proactively. The managed remote cache retains its **1.5 GiB** emergency ceiling.

To prepare and upload a library:

```powershell
python .\tools\build_oracle_catalog.py "C:\Books\BookSyncCloud"

oci os object bulk-upload `
  --bucket-name BookSync `
  --src-dir "C:\Books\BookSyncCloud" `
  --storage-tier Standard `
  --verify-checksum `
  --overwrite
```

`BookSyncCloud` should contain the expanded `.booksync` directories produced next to each ZIP. Create an Oracle PAR with **object read** permission only; the URL is a bearer secret stored locally by the app. Detailed setup and cache behavior are in [docs/oracle-streaming.md](docs/oracle-streaming.md).

## Streaming from a private Hugging Face dataset

The iPhone/mobile reader connects to the canonical private Hugging Face dataset. On the Library screen, select **Hugging Face** and provide a fine-grained read-only token that can access it; the repository is fixed in the app to prevent accidental connections to the wrong library.

For the current personal library:

```text
mdrahman/booksync-library
```

Private audio is fetched with bearer authentication, checked against the BookSync manifest, and played as a verified session blob. BookSync retains previous 2/current/next 3 sessions and removes outside-window audio instead of filling storage up to the limit. Oracle and Hugging Face share the same **1.5 GiB** emergency ceiling.

Publish a completed expanded package and update the remote catalog in one validated operation:

```powershell
python .\tools\publish_huggingface_package.py `
  ".\output\My_Book.booksync" `
  --repo mdrahman/booksync-library
```

The publisher refuses invalid packages, creates a separate automated quality scorecard, excludes ZIP/cache files, uploads the expanded package, merges `library.json`, and verifies the remote manifest. See [docs/huggingface-streaming.md](docs/huggingface-streaming.md) for token, privacy, cache, and testing details.

## Mobile apps

Android and iPhone use the same reader bundle through Capacitor.

### Downloading an iPhone build

Manually run the **Build unsigned iPhone IPA** or **Build iPhone IPA** workflow in GitHub Actions with **Publish release** enabled. Successful manual builds create a numbered direct `.ipa` download under [GitHub Releases](https://github.com/i-am-mushfiq/AudioBookSplitter/releases).

Example filename:

```text
BookSync-Reader-v0.1.0-development-r12.ipa
```

The number after `r` is the GitHub Actions run number. Actions artifacts are retained as a 14-day fallback but GitHub wraps them in a ZIP; Release assets download as the IPA itself.

Unsigned IPA builds prove that the app compiles. They cannot be installed on a physical iPhone. For an installable IPA, use the signed workflow with an Apple development/ad-hoc/App Store provisioning profile and signing certificate.

### Building mobile projects locally

```powershell
cd .\frontend
npm run mobile:sync
```

Build an Android debug APK after installing JDK 17 and the Android SDK:

```powershell
npm run android:apk
```

The iPhone project requires macOS/Xcode for a local signed build. See [frontend/ios/README.md](frontend/ios/README.md) for Apple signing details.

## Known issues and limitations

- **Windows desktop app:** not currently reliable. Earlier BookSync Studio installer builds can open as a blank/black window. Do not use them for processing; use the local web app above instead. The desktop app is not part of the supported `main` branch release path.
- **Unsigned iPhone IPA:** downloads directly but cannot be installed on an iPhone. Apple signing is mandatory for device installation, TestFlight, or App Store distribution.
- **Local iPhone storage:** the reader requests persistent storage, but iOS can still reclaim local data under severe storage pressure. Keep the original `.booksync.zip` so you can re-import it.
- **Remote cache:** the previous-2/current/next-3 session window minimizes normal storage use; the 1.5 GiB cap is a final safety boundary. The cap applies to BookSync's managed remote cache, not deliberately imported offline ZIPs or WebKit's small transient networking buffers. Resumable chunk caching, offline pinning, and network-aware depth remain planned work.
- **Hugging Face token storage:** the token is entered at runtime and never embedded in the IPA or package, but the Capacitor web reader currently persists it in its app-local IndexedDB so the library survives relaunches. Use a fine-grained read-only token dedicated to this dataset; native Keychain storage remains a hardening improvement.
- **Hugging Face session startup:** authenticated private media cannot be assigned to the audio element as an unauthenticated URL. The current session is downloaded and checksum-validated before playback begins, so first play may pause briefly on a slow connection. Whole books are not downloaded.
- **Long audiobook processing:** transcription is intentionally windowed to avoid whole-book memory exhaustion. It can still take a long time, especially on CPU.
- **Alignment quality:** the audiobook must match the edition closely. Different abridgements, translations, skipped introductions, or inaccurate source chapter headings can reduce alignment quality.
- **PDF structure:** EPUB normally provides cleaner chapters than PDF. Scanned/image-only PDFs may need OCR or a better source file.

## Requirements

- Python 3.11+
- FFmpeg and FFprobe on `PATH`
- Node.js 22.13+ for the web interface
- An NVIDIA GPU and CUDA are optional, but recommended for fast transcription

### Python environment

Conda is recommended:

```powershell
conda env create -f environment.yml
conda activate animal-farm-splitter
```

The historical Conda environment name is retained for compatibility; BookSync is not specific to Animal Farm.

Alternatively, use a virtual environment:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Command-line processing

If the current folder contains exactly one supported book and audiobook, BookSync can detect them automatically:

```powershell
python .\pdf_audiobook_splitter.py --device cuda --model small
```

For explicit paths:

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
- `--window-seconds 300`: transcription window size; this is the main protection against large memory allocations.
- `--minutes 10`: approximate time-based part length.
- `--mode smart`: sentence-aware time-based splitting. `chapter` creates one output per chapter.
- `--resume`: continue from valid existing audio chunks after an interruption.
- `--transcript-cache <path>`: reuse an existing transcript.
- `--dry-run`: plan cuts without rendering audio.
- `--skip-booksync`: produce only the legacy MP3 output.

## Output files

The output directory contains:

- chapter-safe MP3 listening parts with your selected naming style;
- `manifest.json` for the legacy MP3 export;
- a resumable transcript and processing checkpoints;
- `<Book_Name>.booksync/`, the synchronized reader package;
- `<Book_Name>.booksync.zip`, the portable package for the reader;
- alignment quality and review reports.
- a separate `*-scorecard.json` when `tools/score_booksync_package.py` or the Hugging Face publisher is run. The score is an automated structural heuristic, not a substitute for listening review.

The package itself contains canonical content, audio, transcript, overlays, reports, source publication, manifest, and checksums:

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

Custom MP3 names are presentation details. Stable internal IDs and content hashes maintain synchronization regardless of naming style.

## For contributors

Architecture:

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
|-- mobile/            Capacitor/PWA mobile bundle
|-- lib/booksync/      package types
|-- lib/reader/        validation, local storage, and reader logic
`-- tests/             reader hardening tests
```

Run the checks:

```powershell
conda run --no-capture-output -n animal-farm-splitter python -m unittest discover -s tests
```

```powershell
cd .\frontend
npm test
npm run mobile:build
```

Validate an exported package:

```powershell
conda run --no-capture-output -n animal-farm-splitter python .\tools\validate_booksync_package.py .\output\My_Book.booksync
```

The repository contains source code and synthetic/copyright-free fixtures only. Keep personal books, audiobooks, generated packages, caches, and output ZIPs untracked.
