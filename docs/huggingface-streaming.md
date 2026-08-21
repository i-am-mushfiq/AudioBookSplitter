# Private Hugging Face dataset streaming

BookSync supports private Hugging Face **dataset** repositories as provider-neutral expanded libraries. ZIP files remain the offline transfer format; remote playback uses the expanded package so one manifest, chapter, overlay, or audio session can be fetched independently.

## Dataset layout

```text
library.json
Animal_Farm.booksync/
├── manifest.json
├── audio/
├── content/
├── overlays/
└── reports/
Another_Book.booksync/
└── ...
```

The catalog accepts the generic `booksync-library` format and the older `booksync-oracle-library` name for backward compatibility.

## Connect from iPhone

1. Create a fine-grained Hugging Face token with read access only to the private dataset.
2. Open BookSync Reader on the Library screen.
3. Select **Hugging Face**.
4. Enter `owner/dataset` or the complete Hugging Face dataset URL.
5. Paste the read token and connect.

The token is supplied at runtime and is never compiled into the IPA, uploaded package, catalog, or source code. The current Capacitor reader stores the connection in app-local IndexedDB so it survives relaunches. Use a dedicated read-only token because native iOS Keychain storage is not implemented yet.

## Playback and cache behavior

Hugging Face private files require an `Authorization` header. An HTML audio element cannot attach that header to an ordinary source URL, so BookSync performs an authenticated fetch for the current session, verifies byte length and SHA-256 against the manifest, stores it under the managed cache, and plays the resulting local blob URL.

- The whole book is never downloaded automatically.
- Only the current session and one following prefetched session are fetched.
- Oracle and Hugging Face share one 1.5 GiB managed cache.
- The oldest cache turns are released first.
- Chapter HTML, overlays, and audio are validated before use.
- Hugging Face byte ranges remain available through the provider contract for future resumable session caching.

First playback can wait for the current session download. Resumable sub-session caching and native streaming authorization are later improvements.

## Publish a package

Authenticate once without placing the token on the command line:

```powershell
hf auth login
```

Then publish:

```powershell
python .\tools\publish_huggingface_package.py `
  "C:\Books\My_Book.booksync" `
  --repo owner/booksync-library
```

The command:

1. validates the full BookSync contract and checksums;
2. writes an adjacent automated quality scorecard;
3. uploads the expanded package without ZIP or uploader-cache files;
4. merges the package manifest into the root catalog;
5. confirms the repository, catalog, and manifest exist remotely.

The scorecard weights sentence coverage, exact alignment ratio, word-timing coverage, and safe cut ratio. It explicitly does not claim to be a human listening evaluation.

## Verification

Relevant local checks are:

```powershell
cd .\frontend
npm run test:hardening
npm run mobile:build
```

```powershell
conda run --no-capture-output -n animal-farm-splitter `
  python -m unittest discover -s tests
```

The provider tests cover URL/path hardening, bearer-header isolation, private catalog discovery, and byte ranges. A live private-repository verification should additionally confirm CORS from `capacitor://localhost`, a `206 Partial Content` response, and matching remote catalog/manifest hashes.
