# BookSync Reader and Storage Plan

## Document status

- Status: Active roadmap
- Implementation status: Milestones 0, 1, and 2 implemented; manual timing evaluation remains an explicit quality gate
- Scope: Synchronized PDF/EPUB reading, audiobook playback, and remote storage
- Existing foundation: PDF/EPUB extraction, bounded GPU transcription, chapter-safe audio splitting, manifests, and a React processing frontend

## Product direction

The strongest direction is to build one product with three independent layers:

1. A processor creates a portable, synchronized book package.
2. A reader consumes that package and highlights the text being narrated.
3. Storage providers deliver the same package from local disk, Google Drive, Telegram, or another provider.

The transcript is an input to synchronization, not the final synchronization model. Accurate highlighting requires an explicit mapping from audiobook time to exact locations in the source book.

## Recommended priorities

1. Define and validate the portable BookSync package.
2. Improve sentence-level alignment quality.
3. Build a local EPUB reader.
4. Add digitally generated PDF support.
5. Add a local library and offline cache.
6. Add Google Drive streaming.
7. Add Telegram storage and retrieval.
8. Add optional word-level highlighting.
9. Add OCR, hosted deployment, and mobile packaging later.

EPUB should be the first complete reader format because its text is structured. PDF support is substantially harder because text order, coordinates, columns, scanned pages, and decorative layouts vary between documents.

Sentence-level highlighting should be the first synchronization target. Word-level highlighting should only be enabled after sentence alignment is consistently reliable.

## Goals

- Highlight the exact sentence currently being narrated.
- Keep playback and highlighting synchronized across multiple audio files.
- Support local, offline-first reading.
- Support EPUB and text-based PDF publications.
- Resume playback and reading position reliably.
- Keep processing, reading, and storage modular.
- Store books remotely without coupling the reader to one provider.
- Preserve user privacy by keeping processing local by default.
- Degrade gracefully when narration differs from the printed book.
- Keep package formats versioned and migratable.

## Non-goals for the first release

- Perfect word-level karaoke highlighting.
- Reliable highlighting for arbitrary scanned PDFs.
- DRM-protected EPUB or PDF support.
- Editing the original book content.
- Public multi-user hosting.
- Social features, comments, or shared annotations.
- Direct, uncached Telegram playback for every file size.
- Pixel-perfect reproduction of every EPUB publisher style.

## High-level architecture

```text
PDF or EPUB ---------> Canonical text extractor ---------+
                                                       |
Audiobook -----------> ASR transcription ---------------+--> Hierarchical alignment
                                                                  |
                                                                  v
                                                      BookSync package builder
                                                                  |
                                     +----------------------------+-------------------------+
                                     |                            |                         |
                                     v                            v                         v
                              Local filesystem              Google Drive               Telegram
                                     |                            |                         |
                                     +----------------------------+-------------------------+
                                                                  |
                                                                  v
                                                        Synchronized reader
```

The processor, reader, and storage gateway communicate through versioned schemas rather than importing each other's internal code.

## Portable BookSync package

Processing should produce a logical package rather than only a ZIP containing named MP3 files.

```text
Animal_Farm.booksync/
├── manifest.json
├── source/
│   └── book.epub
├── content/
│   ├── chapter-001.html
│   └── chapter-002.html
├── audio/
│   ├── audio-001.mp3
│   └── audio-002.mp3
├── overlays/
│   ├── chapter-001.json
│   └── chapter-002.json
├── transcript/
│   └── transcript.json
└── checksums.json
```

The package may be exported as a ZIP for download, backup, or transfer. Remote providers should normally store it expanded so the reader can fetch the manifest, one chapter, or one audio range without downloading the entire ZIP.

### Manifest responsibilities

`manifest.json` is the stable contract between the processor, reader, and storage providers.

It should contain:

- Schema version
- Stable book ID
- Title and author
- Language
- Source type and source hash
- Audiobook hash
- Chapters and reading order
- Audio assets and durations
- Overlay assets
- Total duration
- Alignment summary
- Package creation metadata
- Optional cover information

Example:

```json
{
  "schema_version": 1,
  "book_id": "sha256-based-id",
  "title": "Animal Farm",
  "author": "George Orwell",
  "language": "en",
  "source_type": "epub",
  "duration_ms": 12216000,
  "chapters": [],
  "audio_assets": [],
  "overlay_assets": [],
  "alignment": {
    "sentence_coverage": 0.98,
    "low_confidence_sentences": 12
  }
}
```

### Stable identity

- Internal assets use stable IDs, not user-selected filenames.
- User-selected MP3 names remain export and display names.
- Source and audio hashes detect incompatible replacements.
- Checksums allow cache validation and corruption recovery.
- A renamed book or audio file must not invalidate synchronization.

### Overlay schema

Each overlay entry maps visible book text to an audio interval.

```json
{
  "sentence_id": "ch001-s0042",
  "chapter_id": "ch001",
  "text": "The sentence visible in the reader.",
  "text_locator": {
    "type": "epub",
    "document": "content/chapter-001.html",
    "element_id": "ch001-s0042"
  },
  "audio_locator": {
    "asset_id": "audio-001",
    "start_ms": 48210,
    "end_ms": 52940,
    "global_start_ms": 48210
  },
  "confidence": 0.97,
  "alignment": "exact"
}
```

PDF locators should retain page and text-layer information:

```json
{
  "text_locator": {
    "type": "pdf",
    "page": 14,
    "spans": [
      {
        "text_item": 87,
        "start_character": 4,
        "end_character": 51
      }
    ]
  }
}
```

### Overlay sharding

Overlays should be stored per chapter rather than in one large JSON document. This provides:

- Faster initial loading
- Lower memory use
- Easier remote caching
- Smaller updates
- Simpler chapter-level validation

## Processing and alignment pipeline

### Stage 1: canonical book extraction

#### EPUB

- Follow the OPF spine in reading order.
- Preserve headings, paragraphs, emphasis, images, and footnotes where practical.
- Remove navigation and repeated boilerplate.
- Normalize text for matching while retaining the original text for display.
- Split content into chapters, paragraphs, sentences, and tokens.
- Inject stable sentence IDs into sanitized chapter XHTML.
- Retain mappings to original EPUB locations.

#### PDF

- Extract text items and their coordinates.
- Determine likely reading order.
- Detect headers, footers, and page numbers.
- Detect columns where possible.
- Form sentences while preserving page and text-span coordinates.
- Detect image-only pages and flag them as requiring OCR.

Normalization must always retain a reverse map to the original content. Curly quotes, punctuation, case, and whitespace may be normalized for matching, but the reader must display the original text.

### Stage 2: bounded transcription

Retain the current bounded-window GPU transcription design:

- Decode only a bounded audio window at a time.
- Keep the speech model loaded once.
- Save resumable checkpoints.
- Record word and segment timestamps.
- Avoid allocating memory for the entire audiobook.
- Keep transcription output separate from source-book text.

### Stage 3: hierarchical matching

Alignment should proceed from coarse to fine:

1. Chapter alignment
2. Paragraph alignment
3. Sentence alignment
4. Word alignment

The matcher must be monotonic: mapped positions may only move forward through the book and audio. This prevents repeated phrases from matching an earlier chapter.

The matcher must tolerate:

- Audiobook introductions and credits
- Spoken chapter announcements
- Small wording changes
- Added or removed attribution
- Skipped footnotes
- Repeated phrases
- OCR errors
- Abridged recordings
- Narrator improvisation or corrections

### Stage 4: forced alignment

Once a book passage and audio region are matched, forced alignment should run against the actual book text.

The alignment backend should be pluggable:

```python
class AlignmentBackend:
    def align(self, audio_region, canonical_text):
        ...
```

Recommended initial strategy:

- Use WhisperX-style forced alignment as the primary long-form/GPU path.
- Keep Montreal Forced Aligner as an optional backend for supported languages and difficult cases.
- Do not encode backend-specific data into the BookSync schema.

### Stage 5: confidence and fallback

Every sentence mapping receives:

- A numeric confidence score
- An alignment state: `exact`, `approximate`, or `unmatched`
- Optional diagnostic reasons

Reader behavior:

- High confidence: highlight the sentence.
- Medium confidence: highlight the paragraph or use a softer indicator.
- Low confidence: suppress highlighting while audio continues.

An absent highlight is preferable to a confidently wrong highlight.

### Quality report

Every processed package should include a report containing:

- Chapter coverage
- Sentence coverage
- Unmatched audio ranges
- Unmatched book ranges
- Low-confidence sections
- Suspected abridgement
- Timing anomalies
- Backward-jump violations
- Processing model and settings

## Reader architecture

The reader consists of four independent components:

```text
Reader shell
├── Publication renderer
│   ├── EPUB renderer
│   └── PDF renderer
├── Logical audio player
├── Synchronization controller
└── Storage provider
```

### Publication renderer contract

```ts
interface PublicationRenderer {
  openChapter(chapterId: string): Promise<void>;
  showLocator(locator: TextLocator): Promise<void>;
  highlight(locator: TextLocator, level: "sentence" | "word"): void;
  clearHighlight(): void;
  getCurrentLocation(): ReadingLocation;
}
```

#### EPUB renderer

- Render processed chapter XHTML inside a sandboxed iframe.
- Highlight stable sentence elements.
- Support paginated and continuous modes eventually.
- Preserve basic publisher structure without permitting arbitrary EPUB scripts.
- Support themes, type scale, reading width, and line spacing.

#### PDF renderer

- Use PDF.js for page rendering and text layers.
- Map overlay locators to text-layer spans.
- Follow the current sentence across pages.
- Fall back to a page or paragraph indicator when exact text spans are unavailable.

### Logical audio player

The player presents multiple physical audio assets as one continuous book timeline.

```ts
interface BookPlayer {
  play(): Promise<void>;
  pause(): void;
  seekGlobal(milliseconds: number): Promise<void>;
  getGlobalPosition(): number;
  setRate(rate: number): void;
}
```

Responsibilities:

- Convert global time to an audio asset and local offset.
- Preload the current and next audio assets.
- Move between parts without losing the logical position.
- Persist the last position.
- Support playback speed.
- Support previous/next sentence navigation.
- Preserve chapter boundaries.
- Report buffering and offline status.

### Synchronization controller

The controller is the only component that connects playback time to visible text.

Responsibilities:

- Load the current chapter overlay.
- Use binary search to locate the active sentence.
- Request page or chapter navigation when required.
- Apply and remove highlights.
- Respect the follow-audio setting.
- Pause auto-scroll after manual user navigation.
- Resume following only after explicit user action or a defined timeout.

### EPUB reader MVP features

- Local library
- Book package import
- Sentence highlighting
- Auto-scroll/follow audio
- Follow-audio toggle
- Chapter navigation
- Previous/next sentence controls
- Playback speed from 0.75x to 3x
- Resume position
- Light, dark, and sepia themes
- Font, width, and spacing controls
- Keyboard shortcuts
- Alignment-quality indicator
- Offline playback

Word-level highlighting is deliberately excluded from the first reader milestone.

## Storage architecture

### Provider contract

```ts
interface StorageProvider {
  listBooks(): Promise<RemoteBook[]>;
  getManifest(bookId: string): Promise<BookManifest>;
  readFile(path: string): Promise<ArrayBuffer>;
  readRange(path: string, start: number, end: number): Promise<ArrayBuffer>;
  uploadPackage?(book: LocalPackage): Promise<void>;
}
```

Planned providers:

1. `LocalStorageProvider`
2. `GoogleDriveProvider`
3. `TelegramProvider`
4. `WebDavProvider`

### Cache policy

The reader should cache:

- Manifest and chapter metadata
- Current chapter content
- Current chapter overlay
- Current audio asset
- At least the next two audio assets
- Cover image and small library metadata

The cache needs:

- Configurable size limits
- Least-recently-used eviction
- Per-book offline pinning
- Checksum validation
- Partial-download recovery
- Clear distinction between cached copies and remote originals

### Credentials and security

- Credentials must never be written into BookSync packages.
- OAuth refresh tokens and Telegram credentials must remain in the local gateway or operating-system credential store.
- EPUB scripts must not execute in the reader.
- Remote paths and filenames must not be trusted as filesystem paths.
- Provider access should use the smallest practical permission scope.
- Disconnecting a provider should revoke or delete local credentials without deleting remote books.

## Google Drive strategy

Google Drive should be the first remote provider because blob files support partial downloads using HTTP byte ranges.

Planned behavior:

- OAuth connection with minimum permissions
- User-selected or application folder
- Manifest-first library discovery
- Authenticated range requests through the local gateway
- Resumable package uploads
- Background prefetch
- Offline pinning
- Token refresh and disconnect flow

The first Drive milestone is read-only playback. Upload and two-way metadata synchronization should follow after remote reading is stable.

## Telegram strategy

Telegram should initially be treated as personal storage and synchronization, not as the primary streaming backend.

Constraints:

- Regular Bot API downloads are limited to 20 MB.
- File links are temporary.
- Bot credentials must not be exposed to the browser.
- Whole-chapter audio files can exceed the bot download limit.

Planned behavior:

- Use a private channel as the book store.
- Keep Telegram file IDs in provider metadata, outside the portable package.
- Proxy retrieval through the local gateway.
- Keep individual Telegram transport objects below approximately 15 MB.
- Cache transport objects before and during playback.
- Refresh expired links automatically.

Listening structure and transport structure must be independent. A 50-minute chapter may remain one logical chapter while being stored as several transport objects.

MTProto or a locally hosted Telegram Bot API server may be evaluated later if Telegram becomes a primary provider.

## Proposed repository structure

```text
AudioBookSplitter/
├── processor/
│   ├── extractors/
│   │   ├── epub.py
│   │   └── pdf.py
│   ├── transcription/
│   ├── alignment/
│   ├── audio/
│   ├── packaging/
│   └── cli.py
├── schemas/
│   ├── manifest.schema.json
│   └── overlay.schema.json
├── gateway/
│   ├── api/
│   ├── library/
│   └── providers/
├── frontend/
│   ├── processing/
│   ├── reader/
│   ├── library/
│   ├── player/
│   └── synchronization/
└── tests/
    ├── alignment/
    ├── packages/
    ├── reader/
    ├── providers/
    └── fixtures/
```

The existing upload/split experience remains the processing workspace. The reader should become a separate route and module rather than being added to the existing page as another panel.

## Milestones

### Milestone 0: architecture contract — complete

Deliverables:

- Versioned BookSync manifest schema
- Versioned overlay schema
- Example package
- Schema validation
- Stable ID and checksum rules
- Alignment confidence definitions
- Storage provider interface
- Architecture decision records

Exit gate:

- The processor and reader can be developed independently against the same package contract.

### Milestone 1: modular processing pipeline — complete

Deliverables:

- Split the current Python script into extractor, transcription, alignment, audio, and packaging modules.
- Preserve current chapter-safe splitting behavior.
- Produce canonical chapters, paragraphs, and sentence IDs.
- Produce chapter-sharded overlays.
- Add synthetic and public-domain test fixtures.
- Validate packages during processing.

Exit gate:

- A PDF or EPUB plus audiobook produces a valid BookSync package without regressing current exports.

### Milestone 2: alignment engine v2 — implemented

Deliverables:

- Hierarchical chapter, paragraph, and sentence alignment
- Forced-alignment backend interface
- Confidence scoring
- Quality report
- Manual inspection view
- Resume-safe processing
- Alignment evaluation corpus

Acceptance targets for clean EPUB/audiobook pairs:

- At least 98% of narrated sentences mapped
- No backward alignment jumps
- All chapter boundaries monotonic
- Median sentence-start error below 500 ms
- Low-confidence mismatches suppressed rather than highlighted

The targets must be measured against manually labeled samples, not inferred from the alignment system itself.

### Milestone 3: local EPUB reader

Deliverables:

- Local library
- Package import
- EPUB chapter rendering
- Logical audiobook playback
- Sentence highlighting
- Follow-audio behavior
- Chapter and sentence navigation
- Playback speed
- Reader themes and typography
- Resume position

Exit gate:

- A complete multi-hour EPUB audiobook can be read and played without synchronization drift, unbounded memory growth, or chapter transition failures.

### Milestone 4: PDF reader

Deliverables:

- PDF.js integration
- Text-layer locator mapping
- Page-aware sentence highlighting
- Automatic page following
- Low-confidence fallback
- Scanned-PDF detection

Exit gate:

- Digitally generated, single-column PDFs with valid text layers work end to end.

OCR and complex multi-column PDFs remain outside this gate.

### Milestone 5: local library and cache

Deliverables:

- Local metadata database
- Import and export
- Package validation and migration
- Cache limits and eviction
- Offline book pinning
- Corruption recovery
- Per-device progress

Exit gate:

- Multiple books can be managed without stale UI state or accidental deletion of source files.

### Milestone 6: Google Drive

Deliverables:

- OAuth connection
- Folder selection
- Remote library listing
- Manifest-first loading
- Range-based audio retrieval
- Background prefetch
- Offline cache
- Resumable upload
- Disconnect and token-revocation flow

Exit gate:

- A remotely stored book begins playback without downloading the complete audiobook.

### Milestone 7: Telegram

Deliverables:

- Bot/private-channel connection
- Upload as transport-safe objects
- Remote manifest index
- Background retrieval
- Local caching
- Expired-link recovery
- Explicit 20 MB compatibility handling

Exit gate:

- A Telegram-hosted book begins playback after retrieving only its metadata and first transport object.

### Milestone 8: hardening and packaging

Deliverables:

- Long-book stress tests
- Network interruption recovery
- Accessibility review
- Keyboard and screen-reader support
- Credential and EPUB-content security review
- Package migration tests
- Desktop packaging decision
- Installation and update strategy

## Testing strategy

### Fixture policy

- Do not commit copyrighted books or audiobooks.
- Use generated fixtures and public-domain excerpts.
- Keep private full-book tests outside Git.
- Commit expected manifests and overlays only for distributable fixtures.

### Unit tests

- Text normalization and reverse mapping
- Sentence segmentation
- Stable IDs
- Manifest and overlay validation
- Global/local audio time conversion
- Naming rules
- Confidence thresholds
- Provider path validation

### Alignment tests

- Exact narration
- Changed punctuation
- Repeated sentences
- Introductions and credits
- Skipped paragraphs
- Added narrator text
- Abridged chapters
- Long silences
- Incorrect chapter metadata

### Integration tests

- EPUB to package
- PDF to package
- Package to reader
- Seek across audio assets
- Resume after interruption
- Partial provider download
- Cache eviction and redownload
- Expired provider credentials

### End-to-end tests

- Import a book.
- Process it.
- Open it in the reader.
- Play, pause, seek, and change chapters.
- Verify visible sentence changes against audio time.
- Close and reopen the application.
- Verify restored reading and playback position.
- Repeat from local, Drive, and Telegram sources.

### Performance tests

- Eight-hour audiobook processing
- Eight-hour reader session
- Large EPUB chapter
- Large text-based PDF
- Slow network playback
- Cache at configured capacity
- Repeated seeking across distant chapters

## Major risks and mitigations

### Narration differs from the book

Mitigation:

- Hierarchical monotonic alignment
- Confidence scoring
- Abridgement detection
- Paragraph-level fallback
- Manual correction tools later

### PDF reading order is incorrect

Mitigation:

- Start with text-based, single-column PDFs
- Preserve coordinates
- Add layout detection incrementally
- Suppress exact highlighting when confidence is low

### Word timestamps are inaccurate

Mitigation:

- Ship sentence highlighting first
- Use forced alignment against source text
- Evaluate against manually labeled samples
- Keep alignment backends replaceable

### Remote playback stalls

Mitigation:

- Manifest-first loading
- Current/next asset prefetch
- Range requests where supported
- Transport-sized Telegram objects
- Persistent offline cache

### Provider lock-in

Mitigation:

- Provider-neutral package
- Small provider interface
- No provider credentials in manifests
- ZIP import/export
- Local provider as the reference implementation

### Package schema changes

Mitigation:

- Explicit schema versions
- JSON schema validation
- Migration functions
- Golden package fixtures
- Reader support for at least one prior schema version

## Definition of the first useful product

The first useful product is complete when a user can:

1. Process an EPUB and audiobook locally.
2. Receive a validated BookSync package.
3. Open it in a local library.
4. Play the audiobook.
5. See reliable sentence-level highlighting.
6. Navigate chapters and sentences.
7. Close and resume later.
8. Use the book entirely offline.

Cloud storage is the next layer, not part of proving the synchronized-reader core.

## Estimated sequence

A realistic focused-development sequence is approximately 12 to 15 weeks:

- Architecture and schemas: less than 1 week
- Processor modularization: 1 to 2 weeks
- Alignment v2: 2 to 3 weeks
- EPUB reader: 2 weeks
- PDF reader: 2 to 3 weeks
- Library and cache: 1 week
- Google Drive: 1 to 2 weeks
- Telegram: 1 to 2 weeks
- Hardening: ongoing, with a focused final pass

Milestone exit gates should control progression. Calendar estimates must not override alignment quality.

## Decision log

The following decisions are recommended unless testing produces contrary evidence:

- Build one package-based product rather than separate reader and storage applications.
- Keep processing local-first.
- Use sentence highlighting before word highlighting.
- Complete EPUB support before PDF support.
- Support text-based PDFs before OCR PDFs.
- Use Google Drive before Telegram for remote playback.
- Treat Telegram as cached personal storage initially.
- Store expanded packages remotely; use ZIP for transfer and download.
- Separate logical chapters from transport-sized audio objects.
- Keep the renderer, player, synchronizer, and storage provider independent.
- Refuse low-confidence highlights rather than displaying misleading ones.

## Reference material

- [EPUB 3.3 Media Overlays](https://www.w3.org/TR/epub-33/#sec-media-overlays)
- [EPUB Reading Systems 3.3 media overlay processing](https://www.w3.org/TR/epub-rs-33/#sec-media-overlays-processing)
- [PDF.js documentation](https://mozilla.github.io/pdf.js/getting_started/)
- [WhisperX: Time-Accurate Speech Transcription of Long-Form Audio](https://arxiv.org/abs/2303.00747)
- [Montreal Forced Aligner documentation](https://montreal-forced-aligner.readthedocs.io/en/v3.3.3/user_guide/workflows/alignment.html)
- [Google Drive partial downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Telegram Bot API file downloads](https://core.telegram.org/bots/api#getfile)
