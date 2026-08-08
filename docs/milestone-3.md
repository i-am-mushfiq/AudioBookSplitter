# Milestone 3 — Local EPUB reader

Milestone 3 adds a browser-local reader at `/reader` for BookSync packages produced by the processor.

## Delivered

- Persistent local library backed by IndexedDB
- ZIP package import with package-root and Windows-separator support
- Sanitized chapter HTML rendering
- Logical audiobook playback across physical audio assets
- Sentence highlighting and optional follow-audio scrolling
- Chapter and sentence navigation
- Playback speeds from 0.75× to 2×
- Paper, night, and high-contrast themes
- Adjustable typography and per-book resume position
- Automatic audio-asset and chapter transitions

## Privacy and storage

Packages stay in the browser's IndexedDB database. Removing a title deletes its manifest, package files, and saved position from that browser.

## Memory model

Reading loads one chapter, one overlay, and one audio asset at a time. The prior audio object URL is revoked on every asset or book transition. ZIP import has a temporary archive inflation cost; multi-hour playback does not accumulate audio or chapter objects.

## Verification

- Strict TypeScript compilation
- Vinext production build exposing `/reader`
- Browser import and rendering against BookSync fixtures
- Real 3h23m Animal Farm package recognized as 10 chapters and 25 audio assets

The long-duration gate is implemented structurally through a single-asset lifecycle and deterministic global timing. A continuous multi-hour wall-clock soak remains a release-level test rather than a commit check.
