import type { BookSyncAudioAsset, BookSyncManifest, RelativePackagePath } from "../booksync/types";
import { OracleStorageProvider, oracleConfigFromUrl, type OracleLibraryConfig } from "../booksync/oracle-provider";
import { declaredFiles, normalizePackagePath, validateDeclaredBlob, validateOverlay } from "./validation";
import { planRoundRobinEviction, REMOTE_CACHE_LIMIT_BYTES } from "./remote-cache-policy";

const DB_NAME = "booksync-remote-library";
const DB_VERSION = 1;
const PROVIDERS = "providers";
const BOOKS = "books";
const CACHE = "cache";
const SETTINGS = "settings";
const CACHE_STATE_KEY = "cache-state";

export interface OracleBookRecord {
  record_id: string;
  source: "oracle";
  book_id: BookSyncManifest["book_id"];
  manifest: BookSyncManifest;
  imported_at: string;
  size: number;
  storage_id: string;
  state: "ready";
  provider_id: string;
  manifest_path: RelativePackagePath;
  object_root: RelativePackagePath | "";
}

export interface OracleCacheStats {
  bytes: number;
  entries: number;
  limit_bytes: number;
}

interface CacheRecord {
  key: string;
  provider_id: string;
  book_id: string;
  path: RelativePackagePath;
  blob: Blob;
  size: number;
  sequence: number;
  cached_at: string;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function transactionDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const pending = indexedDB.open(DB_NAME, DB_VERSION);
    pending.onupgradeneeded = () => {
      const db = pending.result;
      if (!db.objectStoreNames.contains(PROVIDERS)) db.createObjectStore(PROVIDERS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BOOKS)) {
        const books = db.createObjectStore(BOOKS, { keyPath: "record_id" });
        books.createIndex("provider_id", "provider_id", { unique: false });
      }
      if (!db.objectStoreNames.contains(CACHE)) {
        const cache = db.createObjectStore(CACHE, { keyPath: "key" });
        cache.createIndex("provider_id", "provider_id", { unique: false });
        cache.createIndex("book_id", "book_id", { unique: false });
      }
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: "key" });
    };
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error);
  });
}

async function simpleTransaction<T>(store: string, mode: IDBTransactionMode, action: (objectStore: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDatabase();
  try {
    const tx = db.transaction(store, mode);
    const result = await request(action(tx.objectStore(store)));
    await transactionDone(tx);
    return result;
  } finally { db.close(); }
}

function recordId(providerId: string, bookId: string) { return `${providerId}:${bookId}`; }
function cacheKey(record: OracleBookRecord, path: RelativePackagePath) { return `${record.provider_id}:${record.book_id}:${path}`; }

export async function listOracleBooks(): Promise<OracleBookRecord[]> {
  const values = await simpleTransaction(BOOKS, "readonly", (store) => store.getAll()) as OracleBookRecord[];
  return values.filter((book) => book.state === "ready").sort((a, b) => b.imported_at.localeCompare(a.imported_at));
}

export async function listOracleProviders(): Promise<OracleLibraryConfig[]> {
  return simpleTransaction(PROVIDERS, "readonly", (store) => store.getAll()) as Promise<OracleLibraryConfig[]>;
}

export async function connectOracleLibrary(input: string, signal?: AbortSignal) {
  const config = await oracleConfigFromUrl(input);
  const provider = new OracleStorageProvider(config);
  const discovered = await provider.discover(signal);
  const connectedAt = new Date().toISOString();
  const records: OracleBookRecord[] = discovered.map((book) => ({
    record_id: recordId(config.id, book.book_id), source: "oracle", book_id: book.book_id, manifest: book.manifest,
    imported_at: connectedAt, size: [...declaredFiles(book.manifest).values()].reduce((sum, asset) => sum + asset.byte_length, 0),
    storage_id: config.id, state: "ready", provider_id: config.id, manifest_path: book.manifest_path, object_root: book.object_root,
  }));

  const db = await openDatabase();
  try {
    const tx = db.transaction([PROVIDERS, BOOKS], "readwrite");
    tx.objectStore(PROVIDERS).put({ ...config, connected_at: connectedAt });
    await deleteByIndex(tx.objectStore(BOOKS), "provider_id", config.id);
    for (const record of records) tx.objectStore(BOOKS).put(record);
    await transactionDone(tx);
  } finally { db.close(); }
  return records;
}

async function deleteByIndex(store: IDBObjectStore, indexName: string, value: string) {
  await new Promise<void>((resolve, reject) => {
    const cursor = store.index(indexName).openCursor(IDBKeyRange.only(value));
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      if (!cursor.result) { resolve(); return; }
      cursor.result.delete();
      cursor.result.continue();
    };
  });
}

export async function disconnectOracleLibrary(providerId: string) {
  const db = await openDatabase();
  try {
    const tx = db.transaction([PROVIDERS, BOOKS, CACHE], "readwrite");
    tx.objectStore(PROVIDERS).delete(providerId);
    await Promise.all([
      deleteByIndex(tx.objectStore(BOOKS), "provider_id", providerId),
      deleteByIndex(tx.objectStore(CACHE), "provider_id", providerId),
    ]);
    await transactionDone(tx);
  } finally { db.close(); }
}

export async function removeOracleBook(record: OracleBookRecord) {
  const db = await openDatabase();
  try {
    const tx = db.transaction([BOOKS, CACHE], "readwrite");
    tx.objectStore(BOOKS).delete(record.record_id);
    await new Promise<void>((resolve, reject) => {
      const cursor = tx.objectStore(CACHE).index("provider_id").openCursor(IDBKeyRange.only(record.provider_id));
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        if (!cursor.result) { resolve(); return; }
        if ((cursor.result.value as CacheRecord).book_id === record.book_id) cursor.result.delete();
        cursor.result.continue();
      };
    });
    await transactionDone(tx);
  } finally { db.close(); }
}

async function providerFor(record: OracleBookRecord) {
  const config = await simpleTransaction(PROVIDERS, "readonly", (store) => store.get(record.provider_id)) as OracleLibraryConfig | undefined;
  if (!config) throw new Error("This Oracle library is disconnected. Connect it again from the Library screen.");
  return new OracleStorageProvider(config);
}

async function getCached(record: OracleBookRecord, path: RelativePackagePath) {
  return simpleTransaction(CACHE, "readonly", (store) => store.get(cacheKey(record, path))) as Promise<CacheRecord | undefined>;
}

async function putCached(record: OracleBookRecord, path: RelativePackagePath, blob: Blob) {
  if (blob.size > REMOTE_CACHE_LIMIT_BYTES) return false;
  const db = await openDatabase();
  try {
    const tx = db.transaction([CACHE, SETTINGS], "readwrite");
    const cache = tx.objectStore(CACHE);
    const settings = tx.objectStore(SETTINGS);
    const [existing, state] = await Promise.all([
      request(cache.getAll()) as Promise<CacheRecord[]>,
      request(settings.get(CACHE_STATE_KEY)) as Promise<{ key: string; next_sequence: number } | undefined>,
    ]);
    const sequence = state?.next_sequence ?? 1;
    const key = cacheKey(record, path);
    const plan = planRoundRobinEviction(existing, { key, size: blob.size, sequence });
    if (!plan.cacheable) { tx.abort(); return false; }
    for (const evicted of plan.evict) cache.delete(evicted);
    cache.put({ key, provider_id: record.provider_id, book_id: record.book_id, path, blob, size: blob.size, sequence, cached_at: new Date().toISOString() } satisfies CacheRecord);
    settings.put({ key: CACHE_STATE_KEY, next_sequence: sequence + 1 });
    await transactionDone(tx);
    return true;
  } finally { db.close(); }
}

async function fetchDeclaredBlob(url: string, expectedBytes: number, mediaType: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Oracle object request failed (${response.status}). Check the pre-authenticated URL and CORS policy.`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength && contentLength !== expectedBytes) throw new Error("Oracle object size does not match the BookSync manifest.");
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size !== expectedBytes) throw new Error("Oracle object size does not match the BookSync manifest.");
    return blob.slice(0, blob.size, mediaType);
  }
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > expectedBytes) { await reader.cancel(); throw new Error("Oracle object exceeded its declared BookSync size."); }
    chunks.push(value);
  }
  if (received !== expectedBytes) throw new Error("Oracle object size does not match the BookSync manifest.");
  return new Blob(chunks as BlobPart[], { type: mediaType });
}

export async function readOraclePackageFile(record: OracleBookRecord, path: RelativePackagePath, signal?: AbortSignal) {
  const safePath = normalizePackagePath(path);
  const cached = await getCached(record, safePath);
  if (cached) return cached.blob;
  const asset = declaredFiles(record.manifest).get(safePath);
  if (!asset) throw new Error(`Oracle package does not declare ${safePath}.`);
  const provider = await providerFor(record);
  const url = provider.objectUrl(record.book_id, record.object_root, safePath);
  const blob = await fetchDeclaredBlob(url, asset.byte_length, asset.media_type, signal);
  await validateDeclaredBlob(asset, blob);
  if (safePath.startsWith("overlays/")) await validateOverlay(JSON.parse(await blob.text()), record.manifest, safePath);
  await putCached(record, safePath, blob);
  return blob;
}

export async function oraclePlayableAudio(record: OracleBookRecord, asset: BookSyncAudioAsset) {
  const cached = await getCached(record, asset.path);
  if (cached) return { kind: "blob" as const, blob: cached.blob, cached: true };
  const provider = await providerFor(record);
  return { kind: "remote" as const, url: provider.objectUrl(record.book_id, record.object_root, asset.path), cached: false };
}

export async function prefetchOracleAudio(record: OracleBookRecord, asset: BookSyncAudioAsset, signal?: AbortSignal) {
  if (asset.byte_length > REMOTE_CACHE_LIMIT_BYTES) return;
  if (await getCached(record, asset.path)) return;
  await readOraclePackageFile(record, asset.path, signal);
}

export async function getOracleCacheStats(): Promise<OracleCacheStats> {
  const entries = await simpleTransaction(CACHE, "readonly", (store) => store.getAll()) as CacheRecord[];
  return { bytes: entries.reduce((sum, item) => sum + item.size, 0), entries: entries.length, limit_bytes: REMOTE_CACHE_LIMIT_BYTES };
}
