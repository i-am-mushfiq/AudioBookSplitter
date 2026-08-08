import { Unzip, UnzipInflate, UnzipPassThrough, unzip } from "fflate";
import type { BookId, BookSyncManifest, RelativePackagePath } from "../booksync/types";

const DB_NAME = "booksync-local-library";
const DB_VERSION = 2;
const BOOKS = "books";
const FILES = "files";
const POSITIONS = "positions";

export interface LocalBookRecord {
  book_id: BookId;
  manifest: BookSyncManifest;
  imported_at: string;
  size: number;
}

export interface ReaderPosition {
  book_id: BookId;
  global_ms: number;
  chapter_id: string;
  sentence_id?: string;
  playback_rate: number;
  updated_at: string;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const pending = indexedDB.open(DB_NAME, DB_VERSION);
    pending.onupgradeneeded = () => {
      const db = pending.result;
      if (!db.objectStoreNames.contains(BOOKS)) db.createObjectStore(BOOKS, { keyPath: "book_id" });
      if (db.objectStoreNames.contains(FILES)) db.deleteObjectStore(FILES);
      const files = db.createObjectStore(FILES, { keyPath: "key" });
      files.createIndex("book_id", "book_id", { unique: false });
      if (!db.objectStoreNames.contains(POSITIONS)) db.createObjectStore(POSITIONS, { keyPath: "book_id" });
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
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return result;
  } finally {
    db.close();
  }
}

export async function listLocalBooks(): Promise<LocalBookRecord[]> {
  const books = await transaction(BOOKS, "readonly", (store) => store.getAll());
  return (books as LocalBookRecord[]).sort((a, b) => b.imported_at.localeCompare(a.imported_at));
}

export async function readPackageFile(bookId: BookId, path: RelativePackagePath): Promise<Blob> {
  const row = await transaction(FILES, "readonly", (store) => store.get(`${bookId}:${path}`));
  if (!row) throw new Error(`Package file is missing: ${path}`);
  return (row as { blob: Blob }).blob;
}

export async function readPackageText(bookId: BookId, path: RelativePackagePath): Promise<string> {
  return (await readPackageFile(bookId, path)).text();
}

export async function loadPosition(bookId: BookId): Promise<ReaderPosition | undefined> {
  return transaction(POSITIONS, "readonly", (store) => store.get(bookId));
}

export async function savePosition(position: ReaderPosition): Promise<void> {
  await transaction(POSITIONS, "readwrite", (store) => store.put(position));
}

export async function deleteLocalBook(bookId: BookId): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([BOOKS, FILES, POSITIONS], "readwrite");
  tx.objectStore(BOOKS).delete(bookId);
  tx.objectStore(POSITIONS).delete(bookId);
  const fileStore = tx.objectStore(FILES);
  const cursor = fileStore.index("book_id").openCursor(IDBKeyRange.only(bookId));
  cursor.onsuccess = () => {
    if (!cursor.result) return;
    cursor.result.delete();
    cursor.result.continue();
  };
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function extractManifest(file: File): Promise<{ manifest: BookSyncManifest; root: string }> {
  return file.arrayBuffer().then((buffer) => new Promise((resolve, reject) => {
    unzip(new Uint8Array(buffer), {
      filter: ({ name }) => {
        const path = name.replaceAll("\\", "/");
        return path === "manifest.json" || path.endsWith("/manifest.json");
      },
    }, (error, files) => {
      if (error) return reject(error);
      try {
        const { manifestPath, root } = packagePaths(files);
        resolve({ manifest: JSON.parse(new TextDecoder().decode(files[manifestPath])) as BookSyncManifest, root });
      } catch (caught) { reject(caught); }
    });
  }));
}

function packagePaths(files: Record<string, Uint8Array>) {
  const manifestPath = Object.keys(files).find((path) => {
    const normalized = path.replaceAll("\\", "/");
    return normalized === "manifest.json" || normalized.endsWith("/manifest.json");
  });
  if (!manifestPath) throw new Error("This ZIP does not contain a BookSync manifest.json file.");
  const normalizedManifestPath = manifestPath.replaceAll("\\", "/");
  const root = normalizedManifestPath.slice(0, -"manifest.json".length);
  return { manifestPath, root };
}

export async function importBookSyncZip(file: File): Promise<LocalBookRecord> {
  const { manifest, root } = await extractManifest(file);
  if (manifest.format !== "booksync" || manifest.schema_version !== 1 || !manifest.book_id) {
    throw new Error("Unsupported or invalid BookSync package.");
  }
  const record: LocalBookRecord = {
    book_id: manifest.book_id,
    manifest,
    imported_at: new Date().toISOString(),
    size: file.size,
  };
  await transaction(BOOKS, "readwrite", (store) => store.put(record));

  const writes: Promise<unknown>[] = [];
  const archive = new Unzip((entry) => {
    const normalizedPath = entry.name.replaceAll("\\", "/");
    if (!normalizedPath.startsWith(root) || normalizedPath.endsWith("/")) return;
    const path = normalizedPath.slice(root.length) as RelativePackagePath;
    const chunks: Uint8Array[] = [];
    entry.ondata = (error, chunk, final) => {
      if (error) throw error;
      chunks.push(chunk);
      if (final) {
        const blob = new Blob(chunks as BlobPart[]);
        writes.push(transaction(FILES, "readwrite", (store) => store.put({ key: `${manifest.book_id}:${path}`, book_id: manifest.book_id, path, blob })));
      }
    };
    entry.start();
  });
  archive.register(UnzipInflate);
  archive.register(UnzipPassThrough);
  const stream = file.stream().getReader();
  while (true) {
    const { done, value } = await stream.read();
    if (done) break;
    archive.push(value, false);
  }
  archive.push(new Uint8Array(), true);
  await Promise.all(writes);
  await readPackageFile(manifest.book_id, manifest.chapters[0].content_path);
  return record;
}
