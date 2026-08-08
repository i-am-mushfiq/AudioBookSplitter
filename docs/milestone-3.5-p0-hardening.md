# Milestone 3.5 — P0 hardening

This pass closes the critical trust, storage, and playback gaps identified after Milestones 0–3.

## Package trust boundary

- Shared draft 2020-12 manifest and overlay schemas are compiled in the browser with AJV.
- Every declared content, overlay, audio, source, transcript, cover, and report file is checked for exact byte length and SHA-256.
- IDs, chapter/overlay references, entry counts, audio locators, global/local timing, chapter order, and the logical audio timeline are checked before commit.
- Unsafe, absolute, traversal, duplicate, and case-colliding paths are rejected.

## Archive limits

- 2 GB compressed package limit
- 8 GB expanded package limit
- 1.5 GB individual entry limit
- 32 MB metadata-entry limit
- 20,000 file limit
- 250:1 maximum compression ratio
- Import cancellation and visible stage progress

Limits are enforced from ZIP metadata and again while entries are streamed.

## Atomic local storage

Imports are serialized with the Web Locks API where available. Files are written beneath an invisible staging ID, verified, and atomically promoted to `ready`. Failure, cancellation, checksum errors, and quota exhaustion remove staging data while preserving the prior good package. Stale staging imports are cleaned after 24 hours.

The reader estimates available browser storage before extraction, requests persistent local storage after a successful user-initiated import, and detects incomplete local packages before opening them.

## EPUB isolation

Chapter markup is sanitized with a current DOMPurify release and a restrictive allowlist. Scripts, event handlers, forms, SVG/MathML, media, images, links, styles, remote resources, and active attributes are removed before insertion.

## Playback races

Logical seeks carry generation IDs. Stale asynchronous file reads or media metadata events cannot replace a newer seek. Object URLs are revoked after safe handoff, decode errors are surfaced, final playback stops cleanly, and playback rate survives transitions.

## Verification

- Valid package import and rendering
- Size/checksum mismatch rejection with prior copy preservation
- Traversal and case-collision rejection
- Compression-bomb rejection
- Hostile EPUB markup removal
- Import cancellation
- Two-asset automatic chapter transition
- Rapid cross-asset seek ordering
- Canonical fixture schema/checksum tests
- Full private Animal Farm manifest, overlay, and declared-file checksum validation when available
- Production dependency audit: zero vulnerabilities
