import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { webcrypto } from "node:crypto";
import { createServer } from "vite";

globalThis.crypto ??= webcrypto;
const root = resolve(import.meta.dirname, "..");
const vite = await createServer({ root, configFile: false, appType: "custom", server: { middlewareMode: true } });
after(() => vite.close());
const validation = await vite.ssrLoadModule("/lib/reader/validation.ts");
const content = await vite.ssrLoadModule("/lib/reader/content.ts");
const fixtureRoot = resolve(root, "..", "examples", "minimal.booksync");

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

const privatePackage = resolve(root, "..", "test1-milestone2-output", "Animal_Farm.booksync");
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
