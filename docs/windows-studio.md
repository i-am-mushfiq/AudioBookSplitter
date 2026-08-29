# BookSync Studio for Windows

BookSync Studio turns a cover, book file, and audiobook into both reader-ready and cloud-ready BookSync outputs. It also acts as the control center for the local and Hugging Face libraries.

## Install once

1. Install Miniconda or Anaconda, Node.js 22+, and Git.
2. Clone or download the BookSync repository.
3. From the repository folder, create the processing environment:

   ```powershell
   conda env create -f environment.yml
   ```

4. Download and run the newest `BookSync-Studio-*-Setup.exe` from GitHub Releases.

Studio automatically checks the `booksync`, `pdf-audiobook-splitter`, and `animal-farm-splitter` Conda environments. Set `BOOKSYNC_PYTHON` to an explicit `python.exe` before opening Studio if the environment is elsewhere.

## Create a synchronized book

1. Open **Create**.
2. Choose a cover. This is optional, but recommended for the reader library.
3. Choose the matching PDF or EPUB.
4. Choose the audiobook. Studio accepts MP3, M4A, M4B, AAC, WAV, FLAC, OGG, Opus, WMA, and MP4 audio containers supported by FFmpeg.
5. Confirm the title.
6. Choose timed sessions or whole chapters.
7. Choose NVIDIA GPU or CPU and a Whisper model.
8. Select **Build BookSync package**.

The live status panel reports the current stage and percentage. Technical output remains collapsed unless you need it for diagnosis.

Successful processing creates both files in the selected library folder:

```text
My_Book.booksync.zip     portable reader import
My_Book.booksync\        expanded, validated upload package
```

The chapter-safe MP3 exports and processing reports remain beside them.

## Run a folder pipeline

Open **Pipeline** when several books are ready. Choose one source folder where
each EPUB/PDF is beside its matching audiobook folder. Studio discovers the
pairs, joins naturally ordered multi-part audio when needed, and resumes any
existing checkpoints in the selected library folder.

The lanes run in tandem:

- one GPU transcription runs at a time;
- as soon as its transcript checkpoint is complete, that book continues with
  CPU alignment/rendering/packaging while the next book takes the GPU;
- completed packages enter a separate single-file upload lane, so uploading can
  continue while processing is still running.

The Spotify-style live pipeline view shows the current GPU owner, downstream CPU
books, active upload, every book's stage and percentage, and one unified live
log. Enable automatic upload only when the chosen token or existing `hf auth`
login has write access. Stopping and starting again is recovery-safe because the
processor uses `--resume` and recognizes completed packages.

## Compare the local and cloud libraries

Open **Library**. Studio scans the selected folder recursively and reads expanded `.booksync` packages and `.booksync.zip` files.

The location labels mean:

- **Local only:** present in the folder but absent from Hugging Face.
- **Local + cloud:** the same canonical book ID exists in both places.
- **Cloud only:** available to stream but absent from the selected local folder.

Library refresh performs a fast manifest and file-size integrity pass. It does not re-hash every audiobook session. A full schema and checksum validation always runs before upload.

## Connect and upload to Hugging Face

The default dataset is `mdrahman/booksync-library`.

Use either approach:

- authenticate once with `hf auth login`; or
- paste a fine-grained token into Studio for the current session.

Use a token with write access only when uploading. Studio does not save a token entered in the app. Select **Send to cloud** beside a valid local-only expanded package. Studio validates and scores it, uploads the expanded files, updates `library.json`, and verifies the remote manifest.

Reader ZIP-only records cannot be uploaded because efficient streaming requires the expanded package. Reprocess that book or restore its `.booksync` folder.

## Recovery and troubleshooting

- **Setup needed:** confirm the Conda environment exists and contains the packages from `environment.yml`.
- **Black window:** uninstall pre-0.2.0 builds and install the current release. Current Studio shows an explicit load or preload error instead of silently remaining black.
- **CUDA failure:** try CPU once. If CPU works, repair the NVIDIA/CUDA environment rather than changing the book.
- **Processing interrupted:** keep the same output folder and run again. Studio passes `--resume`, so valid rendered sessions and transcript checkpoints can be reused.
- **Cloud comparison fails:** confirm `hf auth whoami` succeeds or paste a valid token, and verify access to the private dataset.
- **Upload disabled:** an expanded package is missing or failed the fast integrity check. The ZIP alone is insufficient for server publishing.

The application stores only non-sensitive preferences such as library folder, model, device, session mode, and dataset name under Electron's per-user application data folder.
