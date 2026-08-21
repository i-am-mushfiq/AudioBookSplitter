import type { BookId, BookSyncManifest, RelativePackagePath } from "./types";
import type { ByteRange, RemoteBook, StorageProvider } from "./storage-provider";
import { normalizePackagePath, validateManifest } from "../reader/validation";

const CATALOG_LIMIT_BYTES = 2 * 1024 ** 2;
const MANIFEST_LIMIT_BYTES = 8 * 1024 ** 2;
const MAX_CATALOG_BOOKS = 2_000;

export interface HuggingFaceLibraryConfig {
  kind: "huggingface";
  id: string;
  name: string;
  repo_id: string;
  revision: string;
  token: string;
  connected_at: string;
}

interface CatalogBook { manifest_path: RelativePackagePath; }
interface LibraryCatalog {
  format: "booksync-library" | "booksync-oracle-library";
  schema_version: 1;
  name?: string;
  books: CatalogBook[];
}

export interface DiscoveredHuggingFaceBook extends RemoteBook {
  manifest: BookSyncManifest;
  manifest_path: RelativePackagePath;
  object_root: RelativePackagePath | "";
}

function encodePath(path: string) {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function parseHuggingFaceRepo(input: string) {
  const supplied = input.trim();
  let repoId = supplied;
  if (/^https?:\/\//i.test(supplied)) {
    let url: URL;
    try { url = new URL(supplied); }
    catch { throw new Error("Enter a Hugging Face dataset URL or owner/dataset name."); }
    if (url.protocol !== "https:" || url.hostname !== "huggingface.co") throw new Error("Only HTTPS huggingface.co dataset URLs are supported.");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "datasets" || parts.length < 3) throw new Error("Use a Hugging Face dataset URL such as https://huggingface.co/datasets/owner/booksync-library.");
    repoId = `${parts[1]}/${parts[2]}`;
  }
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repoId)) throw new Error("Repository must use the owner/dataset form.");
  return repoId;
}

export function resolveHuggingFaceFileUrl(repoId: string, revision: string, path: RelativePackagePath) {
  const safePath = normalizePackagePath(path);
  const [owner, dataset] = parseHuggingFaceRepo(repoId).split("/");
  const safeRevision = revision.trim();
  if (!safeRevision || safeRevision.includes("..") || /[?#\\]/.test(safeRevision)) throw new Error("Unsafe Hugging Face revision.");
  return `https://huggingface.co/datasets/${encodeURIComponent(owner)}/${encodeURIComponent(dataset)}/resolve/${encodeURIComponent(safeRevision)}/${encodePath(safePath)}?download=true`;
}

async function readBounded(response: Response, limit: number, label: string) {
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error(`${label} was denied. Use a read token that can access this private dataset.`);
    throw new Error(`${label} request failed (${response.status}). Check the dataset name, revision, network, and CORS access.`);
  }
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw new Error(`${label} exceeds the ${Math.ceil(limit / 1024 ** 2)} MB safety limit.`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > limit) throw new Error(`${label} exceeds the ${Math.ceil(limit / 1024 ** 2)} MB safety limit.`);
  return bytes;
}

function validateCatalog(value: unknown): LibraryCatalog {
  if (!value || typeof value !== "object") throw new Error("Hugging Face library.json must be a JSON object.");
  const candidate = value as Partial<LibraryCatalog>;
  if (!(["booksync-library", "booksync-oracle-library"] as unknown[]).includes(candidate.format) || candidate.schema_version !== 1 || !Array.isArray(candidate.books)) throw new Error("Unsupported BookSync library catalog format.");
  if (candidate.books.length > MAX_CATALOG_BOOKS) throw new Error(`Library catalog contains more than ${MAX_CATALOG_BOOKS} books.`);
  const paths = new Set<string>();
  const books = candidate.books.map((item) => {
    if (!item || typeof item.manifest_path !== "string") throw new Error("Every catalog book needs a manifest_path.");
    const manifestPath = normalizePackagePath(item.manifest_path);
    if (!manifestPath.endsWith("manifest.json")) throw new Error(`Manifest path must end in manifest.json: ${manifestPath}`);
    const canonical = manifestPath.toLocaleLowerCase("en-US");
    if (paths.has(canonical)) throw new Error(`Duplicate manifest path: ${manifestPath}`);
    paths.add(canonical);
    return { manifest_path: manifestPath };
  });
  return { format: candidate.format as LibraryCatalog["format"], schema_version: 1, name: typeof candidate.name === "string" ? candidate.name : undefined, books };
}

async function providerId(repoId: string, revision: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${repoId}@${revision}`));
  return `huggingface_${[...new Uint8Array(digest)].slice(0, 10).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function huggingFaceConfig(repoInput: string, tokenInput: string, revision = "main"): Promise<HuggingFaceLibraryConfig> {
  const repoId = parseHuggingFaceRepo(repoInput);
  const token = tokenInput.trim();
  if (!token) throw new Error("Enter a Hugging Face read token.");
  if (/\s/.test(token)) throw new Error("The Hugging Face token cannot contain spaces.");
  return { kind: "huggingface", id: await providerId(repoId, revision), name: "Hugging Face Library", repo_id: repoId, revision, token, connected_at: new Date().toISOString() };
}

export class HuggingFaceStorageProvider implements StorageProvider {
  readonly id: string;
  readonly kind = "huggingface" as const;
  readonly capabilities = { range_reads: true, uploads: false, deletes: false, offline_pinning: false } as const;
  private discovered = new Map<BookId, DiscoveredHuggingFaceBook>();

  constructor(readonly config: HuggingFaceLibraryConfig) { this.id = config.id; }

  private headers(range?: ByteRange) {
    return { Authorization: `Bearer ${this.config.token}`, ...(range ? { Range: `bytes=${range.start}-${range.end_exclusive - 1}` } : {}) };
  }

  async fetchPath(path: RelativePackagePath, signal?: AbortSignal, range?: ByteRange) {
    return fetch(resolveHuggingFaceFileUrl(this.config.repo_id, this.config.revision, path), { signal, cache: "no-store", headers: this.headers(range) });
  }

  private async catalog(signal?: AbortSignal) {
    const response = await this.fetchPath("library.json" as RelativePackagePath, signal);
    const bytes = await readBounded(response, CATALOG_LIMIT_BYTES, "Hugging Face catalog");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error("Hugging Face library.json is not valid JSON."); }
    return validateCatalog(value);
  }

  async discover(signal?: AbortSignal): Promise<DiscoveredHuggingFaceBook[]> {
    const catalog = await this.catalog(signal);
    this.discovered.clear();
    const books: DiscoveredHuggingFaceBook[] = [];
    for (const item of catalog.books) {
      const response = await this.fetchPath(item.manifest_path, signal);
      const bytes = await readBounded(response, MANIFEST_LIMIT_BYTES, `Manifest ${item.manifest_path}`);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new Error(`Manifest is not valid JSON: ${item.manifest_path}`); }
      const manifest = await validateManifest(value);
      const slash = item.manifest_path.lastIndexOf("/");
      const objectRoot = slash >= 0 ? item.manifest_path.slice(0, slash + 1) as RelativePackagePath : "";
      const book: DiscoveredHuggingFaceBook = { book_id: manifest.book_id, title: manifest.title, author: manifest.author, manifest, manifest_path: item.manifest_path, object_root: objectRoot };
      if (this.discovered.has(book.book_id)) throw new Error(`Hugging Face catalog contains duplicate book ID: ${book.book_id}`);
      this.discovered.set(book.book_id, book);
      books.push(book);
    }
    return books;
  }

  private async book(bookId: BookId, signal?: AbortSignal) {
    if (!this.discovered.has(bookId)) await this.discover(signal);
    const book = this.discovered.get(bookId);
    if (!book) throw new Error(`Hugging Face library does not contain ${bookId}.`);
    return book;
  }

  async listBooks(signal?: AbortSignal): Promise<RemoteBook[]> { return this.discover(signal); }
  async getManifest(bookId: BookId, signal?: AbortSignal) { return (await this.book(bookId, signal)).manifest; }

  async readFile(bookId: BookId, path: RelativePackagePath, signal?: AbortSignal) {
    const book = await this.book(bookId, signal);
    const response = await this.fetchPath(`${book.object_root}${normalizePackagePath(path)}` as RelativePackagePath, signal);
    if (!response.ok) throw new Error(`Hugging Face object request failed (${response.status}): ${path}`);
    return response.arrayBuffer();
  }

  async readRange(bookId: BookId, path: RelativePackagePath, range: ByteRange, signal?: AbortSignal) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end_exclusive) || range.start < 0 || range.end_exclusive <= range.start) throw new Error("Invalid Hugging Face byte range.");
    const book = await this.book(bookId, signal);
    const response = await this.fetchPath(`${book.object_root}${normalizePackagePath(path)}` as RelativePackagePath, signal, range);
    if (!(response.status === 206 || response.ok)) throw new Error(`Hugging Face range request failed (${response.status}): ${path}`);
    const bytes = await response.arrayBuffer();
    return response.status === 206 ? bytes : bytes.slice(range.start, range.end_exclusive);
  }
}
