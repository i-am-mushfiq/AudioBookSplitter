# BookSync end-to-end pipeline

This document is the source of truth for the Windows batch workflow.

## Folder lifecycle

1. A source book begins in `D:\Audiobooks\__Ready\<book>`. The folder must contain exactly one EPUB and at least one supported audio file. PDF-only folders are not eligible.
2. GPU transcription runs through the recoverable processor and writes checkpoints below `local-data\books\raw_processing\<book-id>`.
3. As soon as `transcript.json` is durable, the GPU lane is released to the next book. Alignment, audio rendering, overlay creation, validation, and packaging continue in a CPU lane for the previous book.
4. A book is considered packaged only when its expanded `.booksync` package passes the full package validator.
5. After validation, the original source folder moves atomically from `__Ready` to `__Processed`.
6. Only the validated expanded `.booksync` directory moves into a clean one-package parent folder in `local-data\books\upload_ready`. Processing intermediates remain in `raw_processing` for recovery/audit.
7. The durable single-writer uploader uploads one package, verifies all expected remote paths, byte-compares `manifest.json` and `checksums.json`, verifies the catalog entry, and then moves the clean package folder to `C:\Users\Mushfiq\Downloads\BookSync`.
8. Only after that verified upload state is recorded does the corresponding original source folder move from `D:\Audiobooks\__Processed` to `D:\Audiobooks\__in_hugging_face`.

## Work lanes

- **GPU lane:** exactly one active transcription.
- **CPU lane:** up to two downstream processors by default. CPU work from a completed transcription may overlap the next GPU transcription.
- **Upload lane:** exactly one durable Hugging Face writer. It may overlap GPU and CPU work.
- **Packaging and upload never determine GPU availability.** The existence of a durable transcript checkpoint does.

## Durable state and recovery

The controller is `tools\booksync_pipeline_supervisor.py`. Its SQLite database and replacing snapshots live in `local-data\books\.pipeline-state`:

- `pipeline.sqlite3` — durable job/source/package mapping and state transitions.
- `pipeline-status.json` — machine-readable dashboard snapshot, atomically replaced.
- `live.txt` — human-readable live snapshot, atomically replaced.
- `PAUSE` — cooperative pause request.
- `pipeline.lock` — current single-controller ownership.

On every run or resume the controller reconciles the database against all five folder locations, valid raw packages, the uploader database, and verified Downloads packages. Interrupted GPU/CPU work restarts with `--resume`; valid transcripts and rendered chunks are reused. A package already uploaded but not source-finalized is finalized without retransmission.

## Controls

```powershell
tools\run_ready_pipeline_live.ps1 -Command run
tools\run_ready_pipeline_live.ps1 -Command pause
tools\run_ready_pipeline_live.ps1 -Command resume
tools\run_ready_pipeline_live.ps1 -Command status
tools\run_ready_pipeline_live.ps1 -Command scan
```

The Spotify-styled Windows Studio Pipeline screen reads `pipeline-status.json` every two seconds and exposes **Pause safely** and **Resume from checkpoints** controls. Closing the app or losing power does not invalidate processor checkpoints or the durable upload queue.

## Safety invariants

- A source folder never moves to `__Processed` before package validation.
- A source folder never moves to `__in_hugging_face` before verified upload completion.
- Downloads receives only a canonical parent containing one expanded `.booksync` package (and optional cover art when separately retained).
- Folder conflicts stop the affected book; existing targets are never overwritten.
- There is one pipeline controller and one Hugging Face writer.
- Tokens are inherited at process launch and are never persisted in pipeline state or snapshots.

## Resolved ambiguities

- “Book file” means EPUB for `__Ready`; PDF does not qualify.
- `raw_processing` retains rebuild artifacts. Only the validated expanded package advances to `upload_ready`.
- Pause is checkpoint-safe termination, not an in-memory freeze. Resume starts new processes and reuses durable work.
- The original source folder keeps its original folder name through `__Processed` and `__in_hugging_face`; the package uses its canonical processor slug. Their mapping is stored in SQLite.
