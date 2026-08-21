# BookSync

Read a book while its audiobook keeps your place.

BookSync turns a matching **PDF or EPUB + audiobook** into:

- a synchronized reading experience with live sentence and word highlighting;
- short, manageable listening sessions that never contain parts of two chapters;
- smoothly cut, clearly named MP3 files; and
- one portable `<Book_Name>.booksync.zip` for the BookSync reader.

Your books stay under your control. You can import them directly for offline use or stream prepared books from your private library.

## BookSync in one minute

There are two parts:

1. **The processor** runs on your PC. Give it a PDF/EPUB and the matching audiobook. It transcribes, aligns, splits, and packages the book.
2. **The reader** opens the resulting `.booksync.zip` in the web app, on Android, or on iPhone. It plays the audiobook while highlighting the corresponding text.

```text
PDF or EPUB + audiobook
            |
            v
     BookSync processor
            |
            v
  Book_Name.booksync.zip
            |
            v
  BookSync synchronized reader
```

## What you can do

- Follow the narration with sentence highlighting and a darker current-word highlight.
- Resume the same book, chapter, session, position, and playback speed after reopening the app.
- Browse by full chapters or shorter timed sessions.
- Change playback speed from `0.5×` to `2.5×`.
- Mark sentences for later recall with **✦ Highlight**.
- See current-session progress, whole-book progress, completed chapters, and your current location.
- Keep imported and streamed books together in one library.
- Identify streamed books by the small cloud/play badge on the cover. No badge means the book is stored locally.
- Download chapter-safe MP3s separately from the synchronized reader package.

## Quick start: process your first book on Windows

The local web app is the currently supported way to process books on Windows.

### 1. Install the requirements

You need:

- [Miniconda or Anaconda](https://docs.conda.io/projects/conda/en/latest/user-guide/install/windows.html)
- [Node.js 22.13 or newer](https://nodejs.org/)
- FFmpeg and FFprobe available on `PATH`
- optionally, an NVIDIA GPU with working CUDA support

From the project folder, create the Python environment:

```powershell
conda env create -f environment.yml
conda activate animal-farm-splitter
```

The environment name is historical; BookSync works with any book.

Install the web app:

```powershell
cd .\frontend
npm install
cd ..
```

### 2. Start BookSync

Open one terminal in the project folder:

```powershell
node .\frontend\local-server.mjs
```

Open a second terminal:

```powershell
cd .\frontend
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

### 3. Create the BookSync package

In the app:

1. Upload the book as a PDF or EPUB.
2. Upload the matching audiobook.
3. Confirm or edit the book name. If left blank, BookSync uses the source filename.
4. Choose **Timed sessions** for manageable parts or **Whole chapters** for one audio file per chapter.
5. Choose a target duration such as 10 minutes. BookSync may make a part slightly shorter or longer to preserve sentences and chapter boundaries.
6. Choose CUDA/GPU when your NVIDIA environment is working; otherwise choose CPU.
7. Start processing and leave both terminals open until it finishes.
8. Download the output ZIP.

Long audiobooks can take a while. GPU transcription is strongly recommended, but not required.

## Open a processed book

Open [http://localhost:3000/reader](http://localhost:3000/reader), select **Import book**, and choose the generated `.booksync.zip`.

The reader opens on your library. Select a cover to read, or use **Continue reading** to return to your last book.

Inside the reader:

- **Contents → Chapters** shows hard chapter boundaries and completion.
- **Contents → Timed sessions** shows the smaller, chapter-safe listening parts.
- **Contents → Highlights** shows sentences you marked for recall.
- **Follow** keeps the narrated sentence in view.
- **A− / A+** changes the reading size.
- The speed control changes narration speed without changing your saved position.

The thin green bar at the top represents the **current listening session**. Whole-book progress is shown separately in the reader and library.

## Use BookSync on iPhone

Numbered iPhone builds are available under [GitHub Releases](https://github.com/i-am-mushfiq/AudioBookSplitter/releases). Download the newest `.ipa` file—not the GitHub Actions artifact ZIP.

An unsigned IPA cannot be installed by tapping it directly. For personal use, a sideloading tool such as AltStore or SideStore can sign it with your Apple ID during installation. A directly installable/TestFlight/App Store build requires an Apple-signed workflow and valid provisioning profile.

After installation:

1. Open BookSync. The first screen is your library.
2. Select **Import book** to add a local `.booksync.zip`.
3. Select **Hugging Face** to connect the configured private streaming library.
4. Select any book to start or resume.

BookSync remembers imported books, playback position, active chapter, listening session, speed, completed chapters, highlights, and the last opened book across relaunches. Keep the original ZIP as a backup because iOS may reclaim app data under severe storage pressure.

## One library: local and streamed books

Local and streamed books appear together in the same library and use the same reader controls.

- **Cloud/play badge:** streamed book.
- **No badge:** locally imported book.

Streaming does not download a whole audiobook. BookSync normally keeps only the previous 2 sessions, the current session, and the next 3 sessions. Older audio is released as you move through the book. A 1.5 GiB emergency ceiling protects against abnormal cache growth.

### Connect the private Hugging Face library

The current mobile build is configured for:

```text
mdrahman/booksync-library
```

Select **Hugging Face** in the library and enter a fine-grained, read-only Hugging Face token with access to that private dataset. The token is stored only in the app's local data, but it currently uses IndexedDB rather than the iOS Keychain. Use a dedicated read-only token.

The repository address is intentionally fixed in the app. Other users can import local BookSync ZIPs, or fork the project and configure their own remote library. Setup and publishing details are in [docs/huggingface-streaming.md](docs/huggingface-streaming.md).

### Connect an Oracle Object Storage library

Select **Oracle** and enter either:

- a read-only OCI Object Storage bucket/prefix pre-authenticated URL; or
- the complete URL of its `library.json`.

The URL is effectively a bearer secret and is stored locally by the app. Give it object-read permission only. See [docs/oracle-streaming.md](docs/oracle-streaming.md) for the complete setup.

## What the reader remembers

For every book, BookSync persists:

- current chapter and timed session;
- listening and reading position;
- furthest whole-book progress;
- completed chapters;
- playback speed;
- personal sentence highlights; and
- the last opened book for quick resume.

The reader also remembers the active theme, font size, and follow-audio preference for the current app session.

## Output you receive

The processor creates:

- chapter-safe MP3 parts using your selected naming style;
- `<Book_Name>.booksync.zip`, ready to import into the reader;
- `<Book_Name>.booksync/`, the expanded package used for validation or publishing;
- resumable transcript and processing checkpoints;
- alignment and quality reports; and
- a legacy MP3-export `manifest.json`.

The synchronized package contains:

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

MP3 filenames can be customized without breaking synchronization. BookSync uses stable internal IDs and content hashes inside the package.

## Known issues and limitations

- **Windows desktop app:** earlier BookSync Studio builds may open as an empty black window and are not currently reliable. Use the local web app for processing. The desktop app is intentionally outside the supported `main` release path for now.
- **iPhone installation:** release IPAs are unsigned. They must be signed by a sideloading tool or by the signed GitHub workflow before installation.
- **Free Apple sideloading:** personal Apple ID signing normally expires after seven days and must be refreshed. The exact behavior depends on the sideloading method and Apple's current restrictions.
- **iPhone storage:** iOS can reclaim local app data under severe storage pressure. Keep original `.booksync.zip` files somewhere safe.
- **Remote startup delay:** private Hugging Face audio must be downloaded and checksum-verified before a session starts. The first play can pause briefly on a slow connection.
- **Remote cache:** BookSync keeps the previous-2/current/next-3 session window and a 1.5 GiB emergency ceiling. Offline pinning, resumable partial downloads, and network-aware prefetch depth are future improvements.
- **Token storage:** the Hugging Face token survives relaunches in app-local IndexedDB. Native iOS Keychain storage remains planned hardening.
- **Long processing time:** transcription is deliberately windowed to prevent whole-audiobook memory exhaustion, but CPU processing can still be slow.
- **Edition mismatch:** synchronization quality falls when the audiobook is abridged, translated, reordered, or from a different edition than the text.
- **Scanned PDFs:** image-only PDFs usually need OCR. EPUB normally provides cleaner chapter structure and text.
- **Automatic alignment:** quality reports help identify weak sections, but a quick listening review is still recommended before publishing a processed book.

## Troubleshooting

### Processing appears stuck

- Check the terminal running `local-server.mjs` for the actual error.
- Keep both the backend and frontend terminals open.
- Confirm FFmpeg and FFprobe are on `PATH`.
- On the first run, allow time for the Whisper model to download.
- If CUDA fails, retry with CPU to separate a GPU setup problem from a book/alignment problem.

### The processor runs out of memory

BookSync uses bounded transcription windows to avoid loading the full audiobook feature matrix into RAM. Keep the default windowing enabled. From the command line, `--window-seconds 300` is a safe starting point. Close other memory-heavy programs and use a smaller Whisper model if necessary.

### The text and audio do not align well

Confirm that the PDF/EPUB and audiobook are the same edition. Introductions, publisher notes, skipped footnotes, abridged narration, or different chapter ordering can shift alignment.

### A streamed book will not start

- Confirm the device is online.
- Reconnect Hugging Face with a valid fine-grained read-only token.
- Confirm the token can access `mdrahman/booksync-library`.
- Allow the current session to finish downloading and validating before playback begins.

## Advanced: command-line processing

If a folder contains exactly one supported book and one audiobook, BookSync can detect them automatically:

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
- `--window-seconds 300`: bounded transcription-window duration and the main memory-exhaustion protection.
- `--minutes 10`: approximate timed-session length.
- `--mode smart`: sentence-aware timed splitting.
- `--mode chapter`: one output per chapter.
- `--resume`: continue from valid audio chunks after an interruption.
- `--transcript-cache <path>`: reuse an existing transcript.
- `--dry-run`: plan cuts without rendering audio.
- `--skip-booksync`: produce only the legacy MP3 export.

You can use a standard Python virtual environment instead of Conda:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Advanced: publish a streaming library

Publish a validated expanded package to the configured Hugging Face dataset:

```powershell
python .\tools\publish_huggingface_package.py `
  ".\output\My_Book.booksync" `
  --repo mdrahman/booksync-library
```

The publisher validates the package, creates a separate quality scorecard, excludes ZIP/cache files, updates `library.json`, uploads the expanded package, and verifies the remote manifest.

For Oracle Object Storage, build the catalog and upload the expanded library:

```powershell
python .\tools\build_oracle_catalog.py "C:\Books\BookSyncCloud"

oci os object bulk-upload `
  --bucket-name BookSync `
  --src-dir "C:\Books\BookSyncCloud" `
  --storage-tier Standard `
  --verify-checksum `
  --overwrite
```

## Build the mobile apps

Android and iPhone use the same reader bundle through Capacitor.

```powershell
cd .\frontend
npm run mobile:sync
```

Build an Android debug APK after installing JDK 17 and the Android SDK:

```powershell
npm run android:apk
```

Building and signing iPhone apps locally requires macOS and Xcode. GitHub Actions can compile the unsigned IPA on a macOS runner. See [frontend/ios/README.md](frontend/ios/README.md) for signing and installation details.

## For contributors

Project layout:

```text
processor/
|-- extractors/       PDF and EPUB extraction
|-- transcription/    bounded faster-whisper transcription
|-- alignment/        chapter and sentence alignment
|-- audio/            FFmpeg rendering and validation
|-- packaging/        BookSync package and quality reports
`-- cli.py             processing orchestration

frontend/
|-- app/               processor and synchronized reader UI
|-- mobile/            Capacitor/PWA mobile bundle
|-- lib/booksync/      package types and validation
|-- lib/reader/        storage, remote sources, cache, and reader logic
`-- tests/             reader hardening tests
```

Run the processor tests:

```powershell
conda run --no-capture-output -n animal-farm-splitter python -m unittest discover -s tests
```

Run the reader tests and production build:

```powershell
cd .\frontend
npm run test:hardening
npm run mobile:build
```

Validate an exported package:

```powershell
conda run --no-capture-output -n animal-farm-splitter python .\tools\validate_booksync_package.py .\output\My_Book.booksync
```

The repository contains source code and synthetic or copyright-free fixtures only. Do not commit personal books, audiobooks, generated packages, caches, tokens, or output ZIPs.
