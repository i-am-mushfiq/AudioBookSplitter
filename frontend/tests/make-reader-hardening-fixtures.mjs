import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { zipSync } from "fflate";

const root = resolve(process.argv[2] || "../examples/minimal.booksync");
const output = resolve(process.argv[3] || "../.reader-hardening-fixtures");
const paths = [
  "manifest.json", "checksums.json", "README.md", "audio/audio-001.wav",
  "content/chapter-001.html", "overlays/chapter-001.json", "transcript/transcript.json",
];
const base = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, new Uint8Array(await readFile(resolve(root, path)))])));
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = async (name, files) => writeFile(resolve(output, name), zipSync(files, { level: 1 }));

await mkdir(output, { recursive: true });
await save("valid.zip", base);

const tampered = { ...base, "content/chapter-001.html": encoder.encode(decoder.decode(base["content/chapter-001.html"]).replace("synthetic", "malicious")) };
await save("checksum-mismatch.zip", tampered);

const hostileMarkup = encoder.encode(`<!doctype html><html><body><main><h1 onclick="globalThis.__epubPwned=1">Chapter One</h1><script>globalThis.__epubPwned=2</script><svg onload="globalThis.__epubPwned=3"><circle /></svg><form action="https://example.invalid"><input autofocus></form><img src="https://example.invalid/tracker"><p><span id="sent_0001_000001">This is a synthetic sentence for validating the BookSync package contract.</span></p></main></body></html>`);
const hostileManifest = JSON.parse(decoder.decode(base["manifest.json"]));
hostileManifest.chapters[0].content_sha256 = hash(hostileMarkup);
hostileManifest.chapters[0].content_byte_length = hostileMarkup.byteLength;
await save("hostile-markup.zip", { ...base, "manifest.json": encoder.encode(JSON.stringify(hostileManifest)), "content/chapter-001.html": hostileMarkup });

await save("path-traversal.zip", { ...base, "../evil.txt": encoder.encode("blocked") });
await save("case-collision.zip", { ...base, "Content/chapter-001.html": base["content/chapter-001.html"] });
await save("compression-bomb.zip", { ...base, "padding.bin": new Uint8Array(3 * 1024 * 1024) });
await save("cancellable-large.zip", { ...base, "padding.bin": randomBytes(24 * 1024 * 1024) });

const transitionManifest = JSON.parse(decoder.decode(base["manifest.json"]));
const chapterTwo = encoder.encode(`<!doctype html><html><body><main><h1>Chapter Two</h1><p><span id="sent_0002_000001">The second synchronized sentence.</span></p></main></body></html>`);
const overlayTwo = encoder.encode(JSON.stringify({
  format: "booksync-overlay", schema_version: 1, overlay_id: "ov_0002", book_id: transitionManifest.book_id, chapter_id: "ch_0002",
  entries: [{ sentence_id: "sent_0002_000001", ordinal: 1, text: "The second synchronized sentence.", text_locator: { type: "epub", document: "content/chapter-002.html", element_id: "sent_0002_000001" }, audio_locator: { asset_id: "aud_0002", start_ms: 0, end_ms: 1000, global_start_ms: 1000 }, confidence: 0.99, alignment: "exact" }],
}));
transitionManifest.total_duration_ms = 2000;
transitionManifest.chapters.push({ id: "ch_0002", index: 2, label: "2", title: "Chapter Two", content_path: "content/chapter-002.html", content_sha256: hash(chapterTwo), content_byte_length: chapterTwo.byteLength, overlay_id: "ov_0002", audio_start_ms: 1000, audio_end_ms: 2000 });
transitionManifest.audio_assets.push({ ...transitionManifest.audio_assets[0], id: "aud_0002", path: "audio/audio-002.wav", global_start_ms: 1000, display_filename: "Synthetic_Contract_Fixture_C02.wav" });
transitionManifest.overlay_assets.push({ id: "ov_0002", chapter_id: "ch_0002", path: "overlays/chapter-002.json", sha256: hash(overlayTwo), byte_length: overlayTwo.byteLength, entry_count: 1 });
transitionManifest.alignment = { ...transitionManifest.alignment, sentence_count: 2, aligned_sentence_count: 2, exact_sentence_count: 2 };
await save("two-asset-transition.zip", { ...base, "manifest.json": encoder.encode(JSON.stringify(transitionManifest)), "audio/audio-002.wav": base["audio/audio-001.wav"], "content/chapter-002.html": chapterTwo, "overlays/chapter-002.json": overlayTwo });

console.log(output);
