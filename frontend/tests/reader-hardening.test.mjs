import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { webcrypto } from "node:crypto";
import { createServer } from "vite";

globalThis.crypto ??= webcrypto;
const root = resolve(import.meta.dirname, "..");
const vite = await createServer({
  root,
  configFile: false,
  cacheDir: resolve(root, ".vite-hardening-cache"),
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: "custom",
  server: { middlewareMode: true },
});
after(() => vite.close());
const validation = await vite.ssrLoadModule("/lib/reader/validation.ts");
const content = await vite.ssrLoadModule("/lib/reader/content.ts");
const oracle = await vite.ssrLoadModule("/lib/booksync/oracle-provider.ts");
const huggingFace = await vite.ssrLoadModule("/lib/booksync/huggingface-provider.ts");
const cachePolicy = await vite.ssrLoadModule("/lib/reader/remote-cache-policy.ts");
const fixtureRoot = resolve(root, "..", "examples", "minimal.booksync");

test("keeps chapter HTML stable while audio timing updates", async () => {
  const readerSource = await readFile(resolve(root, "app", "reader", "page.tsx"), "utf8");
  assert.match(readerSource, /const renderedChapter = useMemo\(/);
  assert.match(readerSource, /<section className=\{`reader-stage/);
  assert.doesNotMatch(readerSource, /<article[^>]+onClick=\{handleReaderTap\}[^>]+dangerouslySetInnerHTML/);
});

test("uses the canonical private Hugging Face dataset without an editable repository field", async () => {
  const readerSource = await readFile(resolve(root, "app", "reader", "page.tsx"), "utf8");
  assert.match(readerSource, /const CANONICAL_HUGGING_FACE_REPO = "mdrahman\/booksync-library"/);
  assert.match(readerSource, /connectHuggingFaceLibrary\(CANONICAL_HUGGING_FACE_REPO,/);
  assert.doesNotMatch(readerSource, /setHuggingFaceRepo|<span>Dataset<\/span>/);
});

test("refreshes a saved Hugging Face connection and keeps listening/highlight data device-local", async () => {
  const readerSource = await readFile(resolve(root, "app", "reader", "page.tsx"), "utf8");
  const remoteLibrarySource = await readFile(resolve(root, "lib", "reader", "oracle-library.ts"), "utf8");
  const localLibrarySource = await readFile(resolve(root, "lib", "reader", "library.ts"), "utf8");
  assert.match(remoteLibrarySource, /export async function refreshHuggingFaceLibraries/);
  assert.match(readerSource, /visibilitychange/);
  assert.match(readerSource, /refreshHuggingFaceLibraries\(controller\.signal\)/);
  assert.match(localLibrarySource, /const LISTENING = "listening"/);
  assert.match(readerSource, /recordListeningSegment/);
  assert.match(readerSource, /navigator\.share/);
});

test("presents local and streamed books in one library with only a stream badge as source chrome", async () => {
  const readerSource = await readFile(resolve(root, "app", "reader", "page.tsx"), "utf8");
  const sourcesSource = await readFile(resolve(root, "lib", "reader", "sources.ts"), "utf8");
  assert.match(readerSource, /isRemoteBook\(record\) && <span className="book-stream-badge">/);
  assert.doesNotMatch(readerSource, /Oracle stream|>Offline<|\? "Hugging Face"/);
  assert.match(sourcesSource, /for \(const record of remote\) books\.set\(record\.book_id, record\);/);
  assert.match(sourcesSource, /for \(const record of local\) books\.set\(record\.book_id, record\);/);
});

test("accepts the canonical manifest and overlay", async () => {
  const manifest = await validation.validateManifest(JSON.parse(await readFile(resolve(fixtureRoot, "manifest.json"), "utf8")));
  const overlayPath = manifest.overlay_assets[0].path;
  const overlay = await validation.validateOverlay(JSON.parse(await readFile(resolve(fixtureRoot, overlayPath), "utf8")), manifest, overlayPath);
  assert.equal(overlay.entries.length, 1);
});

test("verifies declared size and checksum", async () => {
  const manifest = await validation.validateManifest(JSON.parse(await readFile(resolve(fixtureRoot, "manifest.json"), "utf8")));
  const chapter = manifest.chapters[0];
  const blob = new Blob([await readFile(resolve(fixtureRoot, chapter.content_path))]);
  await validation.validateDeclaredBlob({ path: chapter.content_path, media_type: "text/html", sha256: chapter.content_sha256, byte_length: chapter.content_byte_length }, blob);
  await assert.rejects(() => validation.validateDeclaredBlob({ path: chapter.content_path, media_type: "text/html", sha256: "0".repeat(64), byte_length: chapter.content_byte_length }, blob), /Checksum mismatch/);
});

test("rejects traversal, zip-bomb ratios, and timeline gaps", async () => {
  assert.throws(() => validation.normalizePackagePath("../escape.txt"), /Unsafe package path/);
  assert.throws(() => validation.validateArchiveEntry("padding.bin", 100, 100_000), /Suspicious compression ratio/);
  const manifest = JSON.parse(await readFile(resolve(fixtureRoot, "manifest.json"), "utf8"));
  manifest.audio_assets[0].global_start_ms = 50;
  await assert.rejects(() => validation.validateManifest(manifest), /gap or overlap/);
});

test("binary sentence lookup remains stable at boundaries", () => {
  const entries = [{ sentence_id: "sent_1", ordinal: 1, text: "One", text_locator: { type: "epub", document: "content/a.html", element_id: "sent_1" }, audio_locator: { asset_id: "aud_1", start_ms: 100, end_ms: 200, global_start_ms: 100 }, confidence: 1, alignment: "exact" }];
  assert.equal(content.activeEntry(entries, 100)?.sentence_id, "sent_1");
  assert.equal(content.activeEntry(entries, 200)?.sentence_id, "sent_1");
});

test("word lookup follows sentence-relative timing", () => {
  const entry = { sentence_id: "sent_1", ordinal: 1, text: "One two", text_locator: { type: "epub", document: "content/a.html", element_id: "sent_1" }, audio_locator: { asset_id: "aud_1", start_ms: 100, end_ms: 500, global_start_ms: 2100 }, confidence: 1, alignment: "exact", words: [{ text: "One", start_ms: 0, end_ms: 180 }, { text: "two", start_ms: 180, end_ms: 400 }] };
  assert.equal(content.activeWordIndex(entry, 2100), 0);
  assert.equal(content.activeWordIndex(entry, 2280), 1);
  assert.equal(content.activeWordIndex(entry, 2500), 1);
  assert.equal(content.activeWordIndex(entry, 2000), -1);
});

test("loaded audio identity prevents a timed-session boundary from skipping ahead", () => {
  const assets = [
    { id: "aud_1", global_start_ms: 0, duration_ms: 600_000 },
    { id: "aud_2", global_start_ms: 600_000, duration_ms: 600_000 },
    { id: "aud_3", global_start_ms: 1_200_000, duration_ms: 300_000 },
  ];
  const loaded = content.loadedAudioAsset(assets, "aud_1");
  assert.equal(loaded.id, "aud_1");
  assert.equal(content.logicalTimeForAudioAsset(loaded, 600), 600_000);
  assert.equal(content.nextAudioAsset(assets, loaded.id).id, "aud_2");
});

test("a chapter-boundary session advances exactly one asset", () => {
  const assets = [
    { id: "chapter_1_part_1", global_start_ms: 0, duration_ms: 600_000 },
    { id: "chapter_1_part_2", global_start_ms: 600_000, duration_ms: 240_000 },
    { id: "chapter_2_part_1", global_start_ms: 840_000, duration_ms: 600_000 },
  ];
  const ended = content.loadedAudioAsset(assets, "chapter_1_part_2");
  assert.equal(content.logicalTimeForAudioAsset(ended, 240), 840_000);
  assert.equal(content.nextAudioAsset(assets, ended.id).id, "chapter_2_part_1");
  assert.equal(content.nextAudioAsset(assets, "chapter_2_part_1"), undefined);
});

test("identifies only real in-chapter session transitions", () => {
  const locator = (asset_id, global_start_ms) => ({ asset_id, start_ms: 0, end_ms: 100, global_start_ms });
  const entries = [
    { sentence_id: "s1", audio_locator: locator("aud_1", 0) },
    { sentence_id: "s2", audio_locator: locator("aud_1", 100) },
    { sentence_id: "unmatched", audio_locator: null },
    { sentence_id: "s3", audio_locator: locator("aud_2", 600_000) },
    { sentence_id: "s4", audio_locator: locator("aud_2", 600_100) },
    { sentence_id: "s5", audio_locator: locator("aud_3", 1_200_000) },
  ];
  assert.deepEqual(content.sessionTransitionSentenceIds(entries), ["s3", "s5"]);
});

test("builds safe Oracle catalog and object URLs", () => {
  const endpoint = oracle.parseOracleLibraryEndpoint("https://objectstorage.ap-dhaka-1.oraclecloud.com/p/token/n/ns/b/books/o/");
  assert.equal(endpoint.catalog_url, "https://objectstorage.ap-dhaka-1.oraclecloud.com/p/token/n/ns/b/books/o/library.json");
  assert.equal(oracle.resolveOracleObjectUrl(endpoint.object_base_url, "books/My Book/audio/session 01.mp3"), "https://objectstorage.ap-dhaka-1.oraclecloud.com/p/token/n/ns/b/books/o/books/My%20Book/audio/session%2001.mp3");
  assert.throws(() => oracle.parseOracleLibraryEndpoint("http://example.com/library.json"), /HTTPS/);
  assert.throws(() => oracle.resolveOracleObjectUrl(endpoint.object_base_url, "../escape.mp3"), /Unsafe package path/);
});

test("discovers an Oracle book through the catalog without listing the bucket", async () => {
  const manifestText = await readFile(resolve(fixtureRoot, "manifest.json"), "utf8");
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/library.json")) return new Response(JSON.stringify({ format: "booksync-oracle-library", schema_version: 1, books: [{ manifest_path: "Synthetic.booksync/manifest.json" }] }));
    if (url.endsWith("/Synthetic.booksync/manifest.json")) return new Response(manifestText);
    return new Response("missing", { status: 404 });
  };
  try {
    const provider = new oracle.OracleStorageProvider({ id: "oracle_test", name: "Test", catalog_url: "https://objects.example/library.json", object_base_url: "https://objects.example/", connected_at: new Date(0).toISOString() });
    const books = await provider.discover();
    assert.equal(books.length, 1);
    assert.equal(books[0].title, "Synthetic Contract Fixture");
    assert.deepEqual(requests, ["https://objects.example/library.json", "https://objects.example/Synthetic.booksync/manifest.json"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("builds authenticated, traversal-safe Hugging Face dataset URLs", () => {
  assert.equal(huggingFace.parseHuggingFaceRepo("https://huggingface.co/datasets/mdrahman/booksync-library/tree/main"), "mdrahman/booksync-library");
  assert.equal(huggingFace.resolveHuggingFaceFileUrl("mdrahman/booksync-library", "main", "My Book.booksync/audio/part 01.mp3"), "https://huggingface.co/datasets/mdrahman/booksync-library/resolve/main/My%20Book.booksync/audio/part%2001.mp3?download=true");
  assert.throws(() => huggingFace.parseHuggingFaceRepo("https://example.com/datasets/me/books"), /huggingface\.co/);
  assert.throws(() => huggingFace.resolveHuggingFaceFileUrl("mdrahman/booksync-library", "main", "../token.txt"), /Unsafe package path/);
});

test("discovers a private Hugging Face book with bearer auth and supports ranges", async () => {
  const manifestText = await readFile(resolve(fixtureRoot, "manifest.json"), "utf8");
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init.headers).get("authorization"), range: new Headers(init.headers).get("range") });
    if (url.includes("library.json")) return new Response(JSON.stringify({ format: "booksync-library", schema_version: 1, books: [{ manifest_path: "Synthetic.booksync/manifest.json" }] }));
    if (url.includes("manifest.json")) return new Response(manifestText);
    if (url.includes("audio/audio-0001.mp3")) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 206 });
    return new Response("missing", { status: 404 });
  };
  try {
    const provider = new huggingFace.HuggingFaceStorageProvider({ kind: "huggingface", id: "huggingface_test", name: "Test", repo_id: "mdrahman/booksync-library", revision: "main", token: "private-test-token", connected_at: new Date(0).toISOString() });
    const books = await provider.discover();
    assert.equal(books[0].title, "Synthetic Contract Fixture");
    const bytes = await provider.readRange(books[0].book_id, "audio/audio-0001.mp3", { start: 10, end_exclusive: 14 });
    assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3, 4]);
    assert.ok(requests.every((request) => request.authorization === "Bearer private-test-token"));
    assert.equal(requests.at(-1).range, "bytes=10-13");
    assert.ok(requests.every((request) => !request.url.includes("private-test-token")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote audio cache retains previous 2, current, and next 3 sessions", () => {
  assert.deepEqual(cachePolicy.planSessionCacheWindow(10, 4), {
    retain_indexes: [2, 3, 4, 5, 6, 7],
    prefetch_indexes: [5, 6, 7, 3, 2],
  });
  assert.deepEqual(cachePolicy.planSessionCacheWindow(10, 0), {
    retain_indexes: [0, 1, 2, 3],
    prefetch_indexes: [1, 2, 3],
  });
  assert.deepEqual(cachePolicy.planSessionCacheWindow(10, 9), {
    retain_indexes: [7, 8, 9],
    prefetch_indexes: [8, 7],
  });
});

test("remote cache still enforces the 1.5 GiB emergency ceiling", () => {
  const gib = 1024 ** 3;
  const plan = cachePolicy.planRoundRobinEviction([
    { key: "first", size: 0.6 * gib, sequence: 1 },
    { key: "second", size: 0.6 * gib, sequence: 2 },
  ], { key: "third", size: 0.6 * gib, sequence: 3 });
  assert.equal(plan.cacheable, true);
  assert.deepEqual(plan.evict, ["first"]);
  assert.ok(plan.total_after <= cachePolicy.REMOTE_CACHE_LIMIT_BYTES);
  assert.equal(cachePolicy.planRoundRobinEviction([], { key: "oversized", size: 2 * gib, sequence: 1 }).cacheable, false);
});

const privatePackage = resolve(root, "..", "local-data", "books", "in-hugging-face", "Animal_Farm", "generated", "test1-milestone2-output", "Animal_Farm.booksync");
test("validates every declared file in the available full-book package", { skip: !existsSync(privatePackage) }, async () => {
  const manifest = await validation.validateManifest(JSON.parse(await readFile(resolve(privatePackage, "manifest.json"), "utf8")));
  let checked = 0;
  for (const [path, asset] of validation.declaredFiles(manifest)) {
    const bytes = await readFile(resolve(privatePackage, path));
    await validation.validateDeclaredBlob(asset, new Blob([bytes]));
    if (path.startsWith("overlays/")) await validation.validateOverlay(JSON.parse(bytes.toString("utf8")), manifest, path);
    checked += 1;
  }
  assert.ok(checked >= 45);
});
