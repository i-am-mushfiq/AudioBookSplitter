# BookSync Package Specification v1

## Status

BookSync Package v1 is the architecture contract for the processor, reader, and storage providers. It is implemented by the JSON Schemas in [`schemas/`](../schemas/) and validated by `tools/validate_booksync_package.py`.

The modular processor emits this package alongside the splitter's legacy MP3 files and export manifest. The legacy format remains available for existing frontend downloads.

## Package form

A BookSync package is a logical directory rooted at `manifest.json`. It can be stored as:

- An expanded directory for local or remote streaming
- A ZIP archive for transfer and download

All paths use `/`, are relative to the package root, and must not contain `..`, drive letters, backslashes, query strings, or URL fragments. Symlinks are not part of the package format.

## Required files

- `manifest.json`: package identity, reading order, and asset index
- `checksums.json`: payload integrity index
- One content document per chapter
- One overlay document per chapter
- One or more audio assets

The original PDF or EPUB and the ASR transcript are optional. Their identities remain recorded even when they are not included.

## Identity rules

### Book ID

`book_id` is immutable and has this form:

```text
book_<64 lowercase hexadecimal characters>
```

The digest is SHA-256 over this canonical identity tuple, encoded as UTF-8 with each field separated by a single line feed:

```text
booksync-book-v1
source_sha256
audiobook_sha256
```

Changing either source changes the book ID. Changing a title, author, filename, naming template, cache location, or storage provider does not.

### Internal IDs

Internal IDs are stable within a package and match:

```text
^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$
```

Recommended forms:

- Chapter: `ch_0001`
- Audio asset: `aud_0001`
- Overlay: `ov_0001`
- Sentence: `sent_0001_000001`

Indices are one-based. IDs do not contain titles because titles can be corrected without invalidating references.

### Filenames

Filenames are transport and presentation details. The reader resolves assets by internal ID and manifest path. Renaming an exported listening file must not change its internal ID.

## Checksums

- SHA-256 is the only checksum algorithm in schema version 1.
- Digests use exactly 64 lowercase hexadecimal characters.
- Byte length is measured from the stored file bytes.
- Every referenced content, audio, overlay, transcript, cover, or included source file must appear in `checksums.json`.
- `checksums.json` does not include itself.
- Validation must reject checksum or byte-length mismatches.

## Time model

- All times are integer milliseconds.
- Audio asset times are local to the asset.
- `global_start_ms` places an asset or sentence on the book-wide timeline.
- Intervals are half-open: `[start_ms, end_ms)`.
- `end_ms` must be greater than `start_ms`.
- Audio assets must be ordered and non-overlapping on the global timeline.
- Overlay entries must be monotonic by ordinal and global time.

Transport splitting is independent from chapter structure. A chapter may use several audio assets, and one logical source recording may be transported as several provider-sized objects.

## Alignment confidence

Version 1 uses these default thresholds:

| State | Score | Reader behavior |
| --- | ---: | --- |
| `exact` | `>= 0.85` | Highlight the sentence |
| `approximate` | `>= 0.60` and `< 0.85` | Use a softer sentence or paragraph indicator |
| `unmatched` | `< 0.60` | Do not highlight |

Packages record their actual thresholds in `manifest.alignment.thresholds`. Validators enforce internal consistency, not a globally fixed threshold.

Rules:

- `exact` entries require a non-null audio locator and a score at or above `exact_min`.
- `approximate` entries require a non-null audio locator and a score at or above `approximate_min` but below `exact_min`.
- `unmatched` entries must not cause exact highlighting; their audio locator may be null.
- Confidence is evidence about alignment quality, not ASR word probability alone.

## EPUB text locators

Processed EPUB content is sanitized chapter XHTML. Every alignable sentence receives a stable element ID. EPUB locators contain:

- The relative processed chapter path
- The sentence element ID

The original EPUB may additionally be mapped through EPUB CFI in a future schema version. The v1 reader contract depends only on stable processed content.

## PDF text locators

PDF locators contain:

- One-based page number
- One or more text-layer item indices
- Character offsets within each text item
- Optional rendering quads

The processor must retain the text-layer order used to produce these indices. Image-only pages are not exact-highlight capable without OCR.

## Forward compatibility

- Readers must reject unknown major schema versions with a clear message.
- Readers may ignore unknown optional fields only after a schema migration makes them valid.
- Writers must not silently change the meaning of an existing field.
- Migration creates a new validated package and never edits the only copy in place.
- The reader should eventually support the current and immediately previous package versions.

## Security

- Packages never contain provider credentials or OAuth tokens.
- Readers must not execute scripts from EPUB content.
- Paths are resolved only after traversal validation.
- Package content is untrusted, even when loaded from local disk.
- Storage metadata and credentials live outside the portable package.
