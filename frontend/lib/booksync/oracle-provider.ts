import type { BookId, BookSyncManifest, RelativePackagePath } from "./types";
import type { ByteRange, RemoteBook, StorageProvider } from "./storage-provider";
import { normalizePackagePath, validateManifest } from "../reader/validation";

const CATALOG_LIMIT_BYTES = 2 * 1024 ** 2;
const MANIFEST_LIMIT_BYTES = 8 * 1024 ** 2;
const MAX_CATALOG_BOOKS = 2_000;

export interface OracleLibraryConfig {
  kind: "oracle";
  id: string;
  name: string;
  catalog_url: string;
  object_base_url: string;
  connected_at: string;
}

export interface OracleCatalogBook {
  manifest_path: RelativePackagePath;
}

export interface OracleLibraryCatalog {
  format: "booksync-library" | "booksync-oracle-library";
  schema_version: 1;
  name?: string;
  books: OracleCatalogBook[];
}

export interface DiscoveredOracleBook extends RemoteBook {
  manifest: BookSyncManifest;
  manifest_path: RelativePackagePath;
  object_root: RelativePackagePath | "";
}

function encodePath(path: RelativePackagePath) {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function parseOracleLibraryEndpoint(input: string) {
  let supplied: URL;
  try { supplied = new URL(input.trim()); }
  catch { throw new Error("Enter a complete HTTPS Oracle library or library.json URL."); }
  if (supplied.protocol !== "https:") throw new Error("Oracle libraries must use HTTPS.");
  if (supplied.username || supplied.password) throw new Error("Credentials must not be embedded in the Oracle URL.");
  supplied.hash = "";

  const looksLikeCatalog = supplied.pathname.toLowerCase().endsWith(".json");
  const catalog = new URL(supplied.href);
  if (!looksLikeCatalog) {
    if (!catalog.pathname.endsWith("/")) catalog.pathname += "/";
    catalog.pathname += "library.json";
  }
  const base = new URL(catalog.href);
  base.pathname = base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
  return { catalog_url: catalog.href, object_base_url: base.href };
}

export function resolveOracleObjectUrl(baseUrl: string, path: RelativePackagePath) {
  const safePath = normalizePackagePath(path);
  const base = new URL(baseUrl);
  if (base.protocol !== "https:") throw new Error("Oracle object URLs must use HTTPS.");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  base.pathname += encodePath(safePath);
  return base.href;
}

async function readBounded(response: Response, limit: number, label: string) {
  if (!response.ok) throw new Error(`${label} request failed (${response.status}). Check the Oracle URL, object visibility, and CORS policy.`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw new Error(`${label} exceeds the ${Math.ceil(limit / 1024 ** 2)} MB safety limit.`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > limit) throw new Error(`${label} exceeds the ${Math.ceil(limit / 1024 ** 2)} MB safety limit.`);
  return bytes;
}

function validateCatalog(value: unknown): OracleLibraryCatalog {
  if (!value || typeof value !== "object") throw new Error("Oracle library.json must be a JSON object.");
  const candidate = value as Partial<OracleLibraryCatalog>;
  if (!(["booksync-library", "booksync-oracle-library"] as unknown[]).includes(candidate.format) || candidate.schema_version !== 1 || !Array.isArray(candidate.books)) throw new Error("Unsupported BookSync library catalog format.");
  if (candidate.books.length > MAX_CATALOG_BOOKS) throw new Error(`Oracle library catalog contains more than ${MAX_CATALOG_BOOKS} books.`);
  const paths = new Set<string>();
  const books = candidate.books.map((item) => {
    if (!item || typeof item.manifest_path !== "string") throw new Error("Every Oracle catalog book needs a manifest_path.");
    const manifestPath = normalizePackagePath(item.manifest_path);
    if (!manifestPath.endsWith("manifest.json")) throw new Error(`Oracle manifest path must end in manifest.json: ${manifestPath}`);
    const canonical = manifestPath.toLocaleLowerCase("en-US");
    if (paths.has(canonical)) throw new Error(`Duplicate Oracle manifest path: ${manifestPath}`);
    paths.add(canonical);
    return { manifest_path: manifestPath };
  });
  return { format: candidate.format as OracleLibraryCatalog["format"], schema_version: 1, name: typeof candidate.name === "string" ? candidate.name : undefined, books };
}

async function providerId(catalogUrl: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(catalogUrl));
  return `oracle_${[...new Uint8Array(digest)].slice(0, 10).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function oracleConfigFromUrl(input: string): Promise<OracleLibraryConfig> {
  const endpoint = parseOracleLibraryEndpoint(input);
  return { kind: "oracle", id: await providerId(endpoint.catalog_url), name: "Oracle Library", ...endpoint, connected_at: new Date().toISOString() };
}

export class OracleStorageProvider implements StorageProvider {
  readonly id: string;
  readonly kind = "oracle" as const;
  readonly capabilities = { range_reads: true, uploads: false, deletes: false, offline_pinning: false } as const;
  private discovered = new Map<BookId, DiscoveredOracleBook>();

  constructor(readonly config: OracleLibraryConfig) { this.id = config.id; }

  private async catalog(signal?: AbortSignal) {
    const response = await fetch(this.config.catalog_url, { signal, cache: "no-store" });
    const bytes = await readBounded(response, CATALOG_LIMIT_BYTES, "Oracle catalog");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error("Oracle library.json is not valid JSON."); }
    return validateCatalog(value);
  }

  async discover(signal?: AbortSignal): Promise<DiscoveredOracleBook[]> {
    const catalog = await this.catalog(signal);
    const books: DiscoveredOracleBook[] = [];
    for (const item of catalog.books) {
      const response = await fetch(resolveOracleObjectUrl(this.config.object_base_url, item.manifest_path), { signal, cache: "no-store" });
      const bytes = await readBounded(response, MANIFEST_LIMIT_BYTES, `Manifest ${item.manifest_path}`);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new Error(`Manifest is not valid JSON: ${item.manifest_path}`); }
      const manifest = await validateManifest(value);
      const slash = item.manifest_path.lastIndexOf("/");
      const objectRoot = slash >= 0 ? item.manifest_path.slice(0, slash + 1) as RelativePackagePath : "";
      const book: DiscoveredOracleBook = { book_id: manifest.book_id, title: manifest.title, author: manifest.author, manifest, manifest_path: item.manifest_path, object_root: objectRoot };
      if (this.discovered.has(book.book_id)) throw new Error(`Oracle catalog contains duplicate book ID: ${book.book_id}`);
      this.discovered.set(book.book_id, book);
      books.push(book);
    }
    return books;
  }

  private async book(bookId: BookId, signal?: AbortSignal) {
    if (!this.discovered.has(bookId)) await this.discover(signal);
    const book = this.discovered.get(bookId);
    if (!book) throw new Error(`Oracle library does not contain ${bookId}.`);
    return book;
  }

  async listBooks(signal?: AbortSignal): Promise<RemoteBook[]> { return this.discover(signal); }
  async getManifest(bookId: BookId, signal?: AbortSignal) { return (await this.book(bookId, signal)).manifest; }

  async readFile(bookId: BookId, path: RelativePackagePath, signal?: AbortSignal) {
    const book = await this.book(bookId, signal);
    const response = await fetch(this.objectUrlFor(book, path), { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Oracle object request failed (${response.status}): ${path}`);
    return response.arrayBuffer();
  }

  async readRange(bookId: BookId, path: RelativePackagePath, range: ByteRange, signal?: AbortSignal) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end_exclusive) || range.start < 0 || range.end_exclusive <= range.start) throw new Error("Invalid Oracle byte range.");
    const book = await this.book(bookId, signal);
    const response = await fetch(this.objectUrlFor(book, path), { signal, cache: "no-store", headers: { Range: `bytes=${range.start}-${range.end_exclusive - 1}` } });
    if (!(response.status === 206 || response.ok)) throw new Error(`Oracle range request failed (${response.status}): ${path}`);
    const bytes = await response.arrayBuffer();
    return response.status === 206 ? bytes : bytes.slice(range.start, range.end_exclusive);
  }

  objectUrl(bookId: BookId, objectRoot: RelativePackagePath | "", path: RelativePackagePath) {
    return resolveOracleObjectUrl(this.config.object_base_url, `${objectRoot}${normalizePackagePath(path)}` as RelativePackagePath);
  }

  private objectUrlFor(book: DiscoveredOracleBook, path: RelativePackagePath) { return this.objectUrl(book.book_id, book.object_root, path); }
}
