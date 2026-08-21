import { Unzip, UnzipInflate, UnzipPassThrough, unzip } from "fflate";
import type { BookId, BookSyncManifest, RelativePackagePath } from "../booksync/types";
import { IMPORT_LIMITS, PackageValidationError, declaredFiles, expectedExpandedBytes, normalizePackagePath, validateArchiveEntry, validateDeclaredBlob, validateManifest, validateOverlay } from "./validation";

const DB_NAME = "booksync-local-library";
const DB_VERSION = 4;
const BOOKS = "books";
const FILES = "files";
const POSITIONS = "positions";
const IMPORTS = "imports";
const SETTINGS = "settings";

export type ImportPhase = "reading-manifest" | "checking-storage" | "extracting" | "validating" | "committing";
export interface ImportProgress { phase: ImportPhase; completed: number; total: number; path?: string }
export interface ImportOptions { signal?: AbortSignal; onProgress?: (progress: ImportProgress) => void }

export interface LocalBookRecord {
  book_id: BookId;
  manifest: BookSyncManifest;
  imported_at: string;
  size: number;
  storage_id: string;
  state: "ready";
}

export interface ReaderPosition {
  book_id: BookId;
  global_ms: number;
  chapter_id: string;
  sentence_id?: string;
  playback_rate: number;
  /** Furthest point reached; used for whole-book progress rather than just the last seek. */
  furthest_global_ms?: number;
  /** Chapter IDs completed by listening through at least 90% of the chapter. */
  completed_chapter_ids?: string[];
  completed_at?: string;
  updated_at: string;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function transactionDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const pending = indexedDB.open(DB_NAME, DB_VERSION);
    pending.onupgradeneeded = () => {
      const db = pending.result;
      // Never rebuild existing stores during an upgrade: an iOS app update must
      // preserve already imported private books and their audio assets.
      if (!db.objectStoreNames.contains(BOOKS)) db.createObjectStore(BOOKS, { keyPath: "book_id" });
      if (!db.objectStoreNames.contains(FILES)) {
        const files = db.createObjectStore(FILES, { keyPath: "key" });
        files.createIndex("storage_id", "storage_id", { unique: false });
      }
      if (!db.objectStoreNames.contains(IMPORTS)) db.createObjectStore(IMPORTS, { keyPath: "storage_id" });
      if (!db.objectStoreNames.contains(POSITIONS)) db.createObjectStore(POSITIONS, { keyPath: "book_id" });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: "key" });
    };
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error);
  });
}

async function transaction<T>(store: string, mode: IDBTransactionMode, action: (objectStore: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDatabase();
  try {
    const tx = db.transaction(store, mode);
    const result = await request(action(tx.objectStore(store)));
    await transactionDone(tx);
    return result;
  } finally { db.close(); }
}

async function deleteStorage(storageId: string) {
  const db = await openDatabase();
  const tx = db.transaction([FILES, IMPORTS], "readwrite");
  const cursor = tx.objectStore(FILES).index("storage_id").openCursor(IDBKeyRange.only(storageId));
  cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } };
  tx.objectStore(IMPORTS).delete(storageId);
  await transactionDone(tx);
  db.close();
}

async function cleanupAbandonedImports() {
  const imports = await transaction(IMPORTS, "readonly", (store) => store.getAll()) as Array<{ storage_id: string; started_at: string }>;
  const staleBefore = Date.now() - 24 * 60 * 60 * 1000;
  await Promise.all(imports.filter((item) => Date.parse(item.started_at) < staleBefore).map((item) => deleteStorage(item.storage_id)));
}

export async function listLocalBooks(): Promise<LocalBookRecord[]> {
  const books = await transaction(BOOKS, "readonly", (store) => store.getAll());
  return (books as LocalBookRecord[]).filter((book) => book.state === "ready").sort((a, b) => b.imported_at.localeCompare(a.imported_at));
}

async function getBook(bookId: BookId) {
  return transaction(BOOKS, "readonly", (store) => store.get(bookId)) as Promise<LocalBookRecord | undefined>;
}

export async function readPackageFile(bookId: BookId, path: RelativePackagePath): Promise<Blob> {
  const book = await getBook(bookId);
  if (!book) throw new Error("Book is not available in the local library.");
  const row = await transaction(FILES, "readonly", (store) => store.get(`${book.storage_id}:${path}`));
  if (!row) throw new Error(`Package file is missing: ${path}`);
  return (row as { blob: Blob }).blob;
}

export async function readPackageText(bookId: BookId, path: RelativePackagePath): Promise<string> { return (await readPackageFile(bookId, path)).text(); }
export async function verifyLocalBook(record: LocalBookRecord) {
  for (const path of declaredFiles(record.manifest).keys()) {
    const row = await transaction(FILES, "readonly", (store) => store.get(`${record.storage_id}:${path}`));
    if (!row) throw new PackageValidationError(`The local copy is incomplete (${path}). Remove it and import the package again.`);
  }
}
export async function loadPosition(bookId: BookId): Promise<ReaderPosition | undefined> { return transaction(POSITIONS, "readonly", (store) => store.get(bookId)); }
export async function savePosition(position: ReaderPosition): Promise<void> { await transaction(POSITIONS, "readwrite", (store) => store.put(position)); }
export async function listPositions(): Promise<ReaderPosition[]> { return transaction(POSITIONS, "readonly", (store) => store.getAll()) as Promise<ReaderPosition[]>; }

export async function loadLastOpenedBookId(): Promise<BookId | undefined> {
  const value = await transaction(SETTINGS, "readonly", (store) => store.get("last-opened-book")) as { value?: BookId } | undefined;
  return value?.value;
}

export async function saveLastOpenedBookId(bookId: BookId | undefined): Promise<void> {
  await transaction(SETTINGS, "readwrite", (store) => store.put({ key: "last-opened-book", value: bookId }));
}

export async function deleteLocalBook(bookId: BookId): Promise<void> {
  const book = await getBook(bookId);
  if (!book) return;
  const db = await openDatabase();
  const tx = db.transaction([BOOKS, POSITIONS], "readwrite");
  tx.objectStore(BOOKS).delete(bookId); tx.objectStore(POSITIONS).delete(bookId);
  await transactionDone(tx); db.close();
  await deleteStorage(book.storage_id);
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Package import was cancelled.", "AbortError");
}

function extractManifest(file: File, signal?: AbortSignal): Promise<{ manifest: BookSyncManifest; root: string }> {
  return file.arrayBuffer().then((buffer) => new Promise((resolve, reject) => {
    abortIfNeeded(signal);
    unzip(new Uint8Array(buffer), { filter: ({ name, size, originalSize }) => {
      const path = name.replaceAll("\\", "/");
      if (!(path === "manifest.json" || path.endsWith("/manifest.json"))) return false;
      validateArchiveEntry(path, size, originalSize);
      return true;
    } }, (error, files) => {
      if (error) return reject(error);
      try {
        abortIfNeeded(signal);
        const manifestPath = Object.keys(files).find((path) => { const normalized = path.replaceAll("\\", "/"); return normalized === "manifest.json" || normalized.endsWith("/manifest.json"); });
        if (!manifestPath) throw new PackageValidationError("This ZIP does not contain a BookSync manifest.json file.");
        const normalizedManifestPath = manifestPath.replaceAll("\\", "/");
        validateManifest(JSON.parse(new TextDecoder().decode(files[manifestPath]))).then((manifest) => resolve({ manifest, root: normalizedManifestPath.slice(0, -"manifest.json".length) }), reject);
      } catch (caught) { reject(caught); }
    });
  }));
}

async function assertStorageCapacity(requiredBytes: number) {
  if (!navigator.storage?.estimate) return;
  const estimate = await navigator.storage.estimate();
  if (estimate.quota == null) return;
  const available = estimate.quota - (estimate.usage ?? 0);
  const reserve = Math.max(25 * 1024 ** 2, requiredBytes * 0.1);
  if (available < requiredBytes + reserve) throw new PackageValidationError(`Not enough browser storage. This package needs about ${Math.ceil((requiredBytes + reserve) / 1024 ** 2)} MB free.`);
}

function mediaType(manifest: BookSyncManifest, path: RelativePackagePath) { return declaredFiles(manifest).get(path)?.media_type || "application/octet-stream"; }

async function performImport(file: File, options: ImportOptions): Promise<LocalBookRecord> {
  if (file.size > IMPORT_LIMITS.compressedBytes) throw new PackageValidationError("The compressed package exceeds the 2 GB import limit.");
  abortIfNeeded(options.signal); options.onProgress?.({ phase: "reading-manifest", completed: 0, total: file.size });
  await cleanupAbandonedImports();
  const { manifest, root } = await extractManifest(file, options.signal);
  const expected = declaredFiles(manifest);
  const expectedBytes = expectedExpandedBytes(manifest);
  if (expectedBytes > IMPORT_LIMITS.expandedBytes) throw new PackageValidationError("The expanded package exceeds the 8 GB import limit.");
  options.onProgress?.({ phase: "checking-storage", completed: 0, total: expectedBytes });
  await assertStorageCapacity(expectedBytes);

  const storageId = `import_${crypto.randomUUID()}`;
  const previous = await getBook(manifest.book_id);
  await transaction(IMPORTS, "readwrite", (store) => store.put({ storage_id: storageId, book_id: manifest.book_id, started_at: new Date().toISOString() }));
  const seen = new Set<string>();
  const stored = new Set<RelativePackagePath>();
  const overlayValues = new Map<RelativePackagePath, unknown>();
  let fileCount = 0;
  let expandedTotal = 0;
  let extracted = 0;
  let extractionError: unknown;

  try {
    const writes: Promise<unknown>[] = [];
    const archive = new Unzip((entry) => {
      try {
        abortIfNeeded(options.signal);
        const normalized = entry.name.replaceAll("\\", "/");
        if (normalized.endsWith("/")) return;
        const archivePath = validateArchiveEntry(normalized, entry.size, entry.originalSize);
        const canonical = archivePath.toLocaleLowerCase("en-US");
        if (seen.has(canonical)) throw new PackageValidationError(`Duplicate or case-colliding archive path: ${archivePath}`);
        seen.add(canonical); fileCount += 1; expandedTotal += entry.originalSize ?? 0;
        if (fileCount > IMPORT_LIMITS.fileCount) throw new PackageValidationError("The package contains too many files.");
        if (expandedTotal > IMPORT_LIMITS.expandedBytes) throw new PackageValidationError("The package expands beyond the 8 GB limit.");
        if (!normalized.startsWith(root)) return;
        const path = normalizePackagePath(normalized.slice(root.length));
        const auxiliary = !expected.has(path);
        const chunks: Uint8Array[] = [];
        entry.ondata = (error, chunk, final) => {
          if (error) { extractionError = error; return; }
          chunks.push(chunk);
          if (!final) return;
          if (auxiliary) return;
          const blob = new Blob(chunks as BlobPart[], { type: mediaType(manifest, path) });
          extracted += blob.size;
          options.onProgress?.({ phase: "extracting", completed: extracted, total: expectedBytes, path });
          if (expected.has(path)) {
            stored.add(path);
            if (path.startsWith("overlays/")) writes.push(blob.text().then((text) => overlayValues.set(path, JSON.parse(text))));
          }
          writes.push(transaction(FILES, "readwrite", (store) => store.put({ key: `${storageId}:${path}`, storage_id: storageId, path, blob })));
        };
        entry.start();
      } catch (caught) { extractionError = caught; }
    });
    archive.register(UnzipInflate); archive.register(UnzipPassThrough);
    const stream = file.stream().getReader();
    while (true) {
      abortIfNeeded(options.signal);
      if (extractionError) throw extractionError;
      const { done, value } = await stream.read();
      if (done) break;
      archive.push(value, false);
    }
    archive.push(new Uint8Array(), true);
    if (extractionError) throw extractionError;
    await Promise.all(writes);

    options.onProgress?.({ phase: "validating", completed: 0, total: expected.size });
    let validated = 0;
    for (const [path, asset] of expected) {
      abortIfNeeded(options.signal);
      if (!stored.has(path)) throw new PackageValidationError(`Required package file is missing: ${path}`);
      const row = await transaction(FILES, "readonly", (store) => store.get(`${storageId}:${path}`)) as { blob: Blob } | undefined;
      if (!row) throw new PackageValidationError(`Required package file was not stored: ${path}`);
      await validateDeclaredBlob(asset, row.blob);
      if (path.startsWith("overlays/")) await validateOverlay(overlayValues.get(path), manifest, path);
      options.onProgress?.({ phase: "validating", completed: ++validated, total: expected.size, path });
    }

    options.onProgress?.({ phase: "committing", completed: expected.size, total: expected.size });
    const record: LocalBookRecord = { book_id: manifest.book_id, manifest, imported_at: new Date().toISOString(), size: file.size, storage_id: storageId, state: "ready" };
    const db = await openDatabase();
    const tx = db.transaction([BOOKS, IMPORTS], "readwrite");
    tx.objectStore(BOOKS).put(record); tx.objectStore(IMPORTS).delete(storageId);
    await transactionDone(tx); db.close();
    if (previous && previous.storage_id !== storageId) await deleteStorage(previous.storage_id);
    return record;
  } catch (caught) {
    await deleteStorage(storageId).catch(() => undefined);
    if (caught instanceof DOMException && caught.name === "QuotaExceededError") throw new PackageValidationError("Browser storage filled up during import. The previous library copy was preserved.");
    throw caught;
  }
}

export async function importBookSyncZip(file: File, options: ImportOptions = {}): Promise<LocalBookRecord> {
  if (navigator.locks) return await navigator.locks.request("booksync-package-import", { mode: "exclusive", signal: options.signal }, () => performImport(file, options));
  return performImport(file, options);
}
