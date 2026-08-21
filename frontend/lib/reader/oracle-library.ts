import type { BookSyncAudioAsset, BookSyncManifest, RelativePackagePath } from "../booksync/types";
import { OracleStorageProvider, oracleConfigFromUrl, type OracleLibraryConfig } from "../booksync/oracle-provider";
import { HuggingFaceStorageProvider, huggingFaceConfig, type HuggingFaceLibraryConfig } from "../booksync/huggingface-provider";
import { declaredFiles, normalizePackagePath, validateDeclaredBlob, validateOverlay } from "./validation";
import { planRoundRobinEviction, planSessionCacheWindow, REMOTE_CACHE_LIMIT_BYTES } from "./remote-cache-policy";

const DB_NAME = "booksync-remote-library";
const DB_VERSION = 1;
const PROVIDERS = "providers";
const BOOKS = "books";
const CACHE = "cache";
const SETTINGS = "settings";
const CACHE_STATE_KEY = "cache-state";
const ACTIVE_AUDIO_WINDOW_KEY = "active-audio-window";

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

export interface HuggingFaceBookRecord extends Omit<OracleBookRecord, "source"> {
  source: "huggingface";
}

export type RemoteBookRecord = OracleBookRecord | HuggingFaceBookRecord;
export type RemoteLibraryConfig = OracleLibraryConfig | HuggingFaceLibraryConfig;

export interface OracleCacheStats {
  bytes: number;
  entries: number;
  audio_entries: number;
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
  kind?: "audio" | "package";
}

interface ActiveAudioWindowRecord {
  key: typeof ACTIVE_AUDIO_WINDOW_KEY;
  allowed_keys: string[];
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
function cacheKey(record: RemoteBookRecord, path: RelativePackagePath) { return `${record.provider_id}:${record.book_id}:${path}`; }
function isAudioCacheRecord(record: CacheRecord) {
  return record.kind === "audio" || /\.(?:aac|flac|m4a|m4b|mp3|ogg|opus|wav)$/i.test(record.path);
}

function audioWindow(record: RemoteBookRecord, assets: BookSyncAudioAsset[], currentAssetId: string) {
  const currentIndex = assets.findIndex((asset) => asset.id === currentAssetId);
  const plan = planSessionCacheWindow(assets.length, currentIndex);
  return {
    allowedKeys: plan.retain_indexes.map((index) => cacheKey(record, assets[index].path)),
    prefetchAssets: plan.prefetch_indexes.map((index) => assets[index]),
  };
}

export async function listOracleBooks(): Promise<OracleBookRecord[]> {
  return (await listRemoteBooks()).filter((book): book is OracleBookRecord => book.source === "oracle");
}

export async function listRemoteBooks(): Promise<RemoteBookRecord[]> {
  const values = await simpleTransaction(BOOKS, "readonly", (store) => store.getAll()) as RemoteBookRecord[];
  return values.filter((book) => book.state === "ready" && (book.source === "oracle" || book.source === "huggingface")).sort((a, b) => b.imported_at.localeCompare(a.imported_at));
}

export async function listOracleProviders(): Promise<OracleLibraryConfig[]> {
  const values = await listRemoteProviders();
  return values.filter((provider): provider is OracleLibraryConfig => provider.kind === "oracle" || (!('kind' in provider) && 'catalog_url' in provider));
}

export async function listHuggingFaceProviders(): Promise<HuggingFaceLibraryConfig[]> {
  const values = await listRemoteProviders();
  return values.filter((provider): provider is HuggingFaceLibraryConfig => provider.kind === "huggingface");
}

export async function listRemoteProviders(): Promise<RemoteLibraryConfig[]> {
  return simpleTransaction(PROVIDERS, "readonly", (store) => store.getAll()) as Promise<RemoteLibraryConfig[]>;
}

export async function connectOracleLibrary(input: string, signal?: AbortSignal) {
  const config = await oracleConfigFromUrl(input);
  const provider = new OracleStorageProvider(config);
  const discovered = await provider.discover(signal);
  return saveDiscoveredLibrary(config, "oracle", discovered);
}

export async function connectHuggingFaceLibrary(repo: string, token: string, signal?: AbortSignal) {
  const config = await huggingFaceConfig(repo, token);
  const provider = new HuggingFaceStorageProvider(config);
  const discovered = await provider.discover(signal);
  return saveDiscoveredLibrary(config, "huggingface", discovered);
}

async function saveDiscoveredLibrary(
  config: RemoteLibraryConfig,
  source: RemoteBookRecord["source"],
  discovered: Array<{ book_id: BookSyncManifest["book_id"]; manifest: BookSyncManifest; manifest_path: RelativePackagePath; object_root: RelativePackagePath | "" }>,
) {
  const connectedAt = new Date().toISOString();
  const records: RemoteBookRecord[] = discovered.map((book) => ({
    record_id: recordId(config.id, book.book_id), source, book_id: book.book_id, manifest: book.manifest,
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
  return disconnectRemoteLibrary(providerId);
}

export async function disconnectRemoteLibrary(providerId: string) {
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

export async function removeOracleBook(record: RemoteBookRecord) {
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

async function providerFor(record: RemoteBookRecord) {
  const config = await simpleTransaction(PROVIDERS, "readonly", (store) => store.get(record.provider_id)) as RemoteLibraryConfig | undefined;
  if (!config) throw new Error("This remote library is disconnected. Connect it again from the Library screen.");
  return record.source === "huggingface"
    ? new HuggingFaceStorageProvider(config as HuggingFaceLibraryConfig)
    : new OracleStorageProvider(config as OracleLibraryConfig);
}

async function getCached(record: RemoteBookRecord, path: RelativePackagePath) {
  return simpleTransaction(CACHE, "readonly", (store) => store.get(cacheKey(record, path))) as Promise<CacheRecord | undefined>;
}

async function putCached(record: RemoteBookRecord, path: RelativePackagePath, blob: Blob, kind: CacheRecord["kind"] = "package") {
  if (blob.size > REMOTE_CACHE_LIMIT_BYTES) return false;
  const db = await openDatabase();
  try {
    const tx = db.transaction([CACHE, SETTINGS], "readwrite");
    const cache = tx.objectStore(CACHE);
    const settings = tx.objectStore(SETTINGS);
    const [existing, state, activeWindow] = await Promise.all([
      request(cache.getAll()) as Promise<CacheRecord[]>,
      request(settings.get(CACHE_STATE_KEY)) as Promise<{ key: string; next_sequence: number } | undefined>,
      request(settings.get(ACTIVE_AUDIO_WINDOW_KEY)) as Promise<ActiveAudioWindowRecord | undefined>,
    ]);
    const sequence = state?.next_sequence ?? 1;
    const key = cacheKey(record, path);
    if (kind === "audio" && activeWindow && !activeWindow.allowed_keys.includes(key)) {
      await transactionDone(tx);
      return false;
    }
    const plan = planRoundRobinEviction(existing, { key, size: blob.size, sequence });
    if (!plan.cacheable) { tx.abort(); return false; }
    for (const evicted of plan.evict) cache.delete(evicted);
    cache.put({ key, provider_id: record.provider_id, book_id: record.book_id, path, blob, size: blob.size, sequence, cached_at: new Date().toISOString(), kind } satisfies CacheRecord);
    settings.put({ key: CACHE_STATE_KEY, next_sequence: sequence + 1 });
    await transactionDone(tx);
    return true;
  } finally { db.close(); }
}

export async function setRemoteAudioCacheWindow(record: RemoteBookRecord, assets: BookSyncAudioAsset[], currentAssetId: string) {
  const { allowedKeys, prefetchAssets } = audioWindow(record, assets, currentAssetId);
  if (!allowedKeys.length) throw new Error(`The current audio session ${currentAssetId} is not in this book's manifest.`);
  const allowed = new Set(allowedKeys);
  const db = await openDatabase();
  try {
    const tx = db.transaction([CACHE, SETTINGS], "readwrite");
    const cache = tx.objectStore(CACHE);
    const entries = await request(cache.getAll()) as CacheRecord[];
    for (const entry of entries) if (isAudioCacheRecord(entry) && !allowed.has(entry.key)) cache.delete(entry.key);
    tx.objectStore(SETTINGS).put({ key: ACTIVE_AUDIO_WINDOW_KEY, allowed_keys: allowedKeys } satisfies ActiveAudioWindowRecord);
    await transactionDone(tx);
  } finally { db.close(); }
  return prefetchAssets;
}

async function fetchDeclaredBlob(response: Response, expectedBytes: number, mediaType: string, label: string) {
  if (!response.ok) throw new Error(`${label} object request failed (${response.status}). Check the connection, permissions, and CORS policy.`);
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

export async function readOraclePackageFile(record: RemoteBookRecord, path: RelativePackagePath, signal?: AbortSignal) {
  const safePath = normalizePackagePath(path);
  const cached = await getCached(record, safePath);
  if (cached) return cached.blob;
  const asset = declaredFiles(record.manifest).get(safePath);
  if (!asset) throw new Error(`Remote package does not declare ${safePath}.`);
  const provider = await providerFor(record);
  const response = record.source === "huggingface"
    ? await (provider as HuggingFaceStorageProvider).fetchPath(`${record.object_root}${safePath}` as RelativePackagePath, signal)
    : await fetch((provider as OracleStorageProvider).objectUrl(record.book_id, record.object_root, safePath), { signal, cache: "no-store" });
  const blob = await fetchDeclaredBlob(response, asset.byte_length, asset.media_type, record.source === "huggingface" ? "Hugging Face" : "Oracle");
  await validateDeclaredBlob(asset, blob);
  if (safePath.startsWith("overlays/")) await validateOverlay(JSON.parse(await blob.text()), record.manifest, safePath);
  const kind = record.manifest.audio_assets.some((audio) => audio.path === safePath) ? "audio" : "package";
  await putCached(record, safePath, blob, kind);
  return blob;
}

export async function oraclePlayableAudio(record: RemoteBookRecord, asset: BookSyncAudioAsset, signal?: AbortSignal) {
  const cached = await getCached(record, asset.path);
  if (cached) return { kind: "blob" as const, blob: cached.blob, cached: true };
  return { kind: "blob" as const, blob: await readOraclePackageFile(record, asset.path, signal), cached: false };
}

export async function prefetchOracleAudio(record: RemoteBookRecord, asset: BookSyncAudioAsset, signal?: AbortSignal) {
  if (asset.byte_length > REMOTE_CACHE_LIMIT_BYTES) return;
  if (await getCached(record, asset.path)) return;
  await readOraclePackageFile(record, asset.path, signal);
}

export async function prefetchRemoteAudioWindow(record: RemoteBookRecord, assets: BookSyncAudioAsset[], currentAssetId: string, signal?: AbortSignal) {
  const prefetchAssets = await setRemoteAudioCacheWindow(record, assets, currentAssetId);
  for (const asset of prefetchAssets) {
    if (signal?.aborted) return;
    try { await prefetchOracleAudio(record, asset, signal); }
    catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      throw error;
    }
  }
}

export async function getOracleCacheStats(): Promise<OracleCacheStats> {
  const entries = await simpleTransaction(CACHE, "readonly", (store) => store.getAll()) as CacheRecord[];
  return { bytes: entries.reduce((sum, item) => sum + item.size, 0), entries: entries.length, audio_entries: entries.filter(isAudioCacheRecord).length, limit_bytes: REMOTE_CACHE_LIMIT_BYTES };
}
