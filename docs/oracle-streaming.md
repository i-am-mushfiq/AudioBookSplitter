# Oracle Object Storage streaming

BookSync can connect to an expanded library in Oracle Cloud Infrastructure (OCI) Object Storage. The original `.booksync.zip` remains the offline/import artifact; Oracle receives the expanded `.booksync` directories so that individual chapters, overlays, covers, and audio sessions can be requested independently.

## Remote layout

```text
BookSyncCloud/
├── library.json
├── First_Book.booksync/
│   ├── manifest.json
│   ├── content/
│   ├── overlays/
│   └── audio/
└── Second_Book.booksync/
    └── ...
```

Generate the catalog without copying or modifying the expanded books:

```powershell
python .\tools\build_oracle_catalog.py "C:\Books\BookSyncCloud"
```

Upload that directory recursively with the OCI CLI:

```powershell
oci os object bulk-upload `
  --bucket-name BookSync `
  --src-dir "C:\Books\BookSyncCloud" `
  --storage-tier Standard `
  --verify-checksum `
  --overwrite
```

Use the Standard tier: Oracle's Archive tier cannot serve an audio session immediately.

## Read-only access

In the OCI console, create a pre-authenticated request (PAR) for the bucket or the BookSync object-name prefix:

1. Choose **Permit object reads** only.
2. Use a long but finite expiry and record a reminder before it expires.
3. Copy the generated URL immediately; OCI only displays the full secret URL when it is created.
4. Do not enable writes or expose OCI API credentials to the app.

The generated URL normally ends in `/o/`. In BookSync Reader, open **Oracle**, paste that URL, and connect. Pasting the complete `library.json` URL is also supported.

OCI Object Storage responses expose byte-range and content-length headers and PAR object URLs can be used directly by the media player. A PAR URL is a bearer secret: anyone who receives it can read the permitted objects until it expires.

OCI's Object Storage API returns fixed CORS headers, including a wildcard allowed origin; there is no per-bucket CORS rule to configure. Oracle also documents byte-range support for `GetObject`. See Oracle's [Object Storage FAQ](https://www.oracle.com/cloud/storage/object-storage/faq/) and [GetObject request reference](https://docs.oracle.com/en-us/iaas/tools/typescript/latest/interfaces/_objectstorage_lib_request_get_object_request_.getobjectrequest.html).

## Current cache policy

- The current session is downloaded and checksum-validated before playback.
- The audio window contains the previous 2 sessions, current session, and next 3 sessions, never the complete book.
- Audio outside the active window is proactively removed; next sessions are prefetched before previous sessions.
- Chapter HTML, overlays, covers, and cached sessions are checksum-validated before entering IndexedDB.
- The managed remote cache has a hard 1.5 GiB limit.
- The hard limit is an emergency fallback. Normal storage use is bounded by the six-session window rather than allowed to grow toward 1.5 GiB.
- Offline ZIP imports are user-owned library data and are separate from the 1.5 GiB remote cache.

WebKit may retain small transient network buffers outside BookSync's managed IndexedDB cache. iOS can also reclaim website data under severe storage pressure.

## Later cache work

Advanced caching remains a separate milestone. It includes configurable limits, resumable chunk caching, offline book pinning, network-aware prefetch depth, cache inspection and manual clearing, and provider-aware cache prioritization.
