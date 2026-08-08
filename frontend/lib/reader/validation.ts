import type { ErrorObject, ValidateFunction } from "ajv";
import manifestSchema from "../../../schemas/manifest.schema.json";
import overlaySchema from "../../../schemas/overlay.schema.json";
import type { BookSyncManifest, BookSyncOverlay, PackageFileAsset, RelativePackagePath } from "../booksync/types";

export const IMPORT_LIMITS = {
  compressedBytes: 2 * 1024 ** 3,
  expandedBytes: 8 * 1024 ** 3,
  entryBytes: 1536 * 1024 ** 2,
  metadataEntryBytes: 32 * 1024 ** 2,
  fileCount: 20_000,
  compressionRatio: 250,
} as const;

let validatorsPromise: Promise<{ manifest: ValidateFunction; overlay: ValidateFunction }> | undefined;
async function validators() {
  validatorsPromise ??= import("ajv/dist/2020.js").then(({ default: Ajv }) => {
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    return { manifest: ajv.compile(manifestSchema), overlay: ajv.compile(overlaySchema) };
  });
  return validatorsPromise;
}
const SAFE_PATH = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]+$/;
const METADATA_EXTENSIONS = /\.(?:json|html?|xhtml|xml|css|txt)$/i;

export class PackageValidationError extends Error {
  constructor(message: string) { super(message); this.name = "PackageValidationError"; }
}

function schemaMessage(kind: string, errors: ErrorObject[] | null | undefined) {
  const detail = errors?.slice(0, 3).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
  return `${kind} schema validation failed${detail ? `: ${detail}` : "."}`;
}

export function normalizePackagePath(path: string): RelativePackagePath {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!SAFE_PATH.test(normalized) || normalized.includes("//")) throw new PackageValidationError(`Unsafe package path: ${path}`);
  return normalized as RelativePackagePath;
}

export async function validateManifest(value: unknown): Promise<BookSyncManifest> {
  const { manifest: manifestValidator } = await validators();
  if (!manifestValidator(value)) throw new PackageValidationError(schemaMessage("Manifest", manifestValidator.errors));
  const manifest = value as unknown as BookSyncManifest;
  const chapterIds = new Set<string>();
  const overlayIds = new Set<string>();
  const audioIds = new Set<string>();
  const paths = new Set<string>();
  let previousChapterEnd = 0;
  for (const chapter of manifest.chapters) {
    if (chapterIds.has(chapter.id)) throw new PackageValidationError(`Duplicate chapter ID: ${chapter.id}`);
    chapterIds.add(chapter.id);
    if (chapter.audio_start_ms < previousChapterEnd || chapter.audio_end_ms <= chapter.audio_start_ms || chapter.audio_end_ms > manifest.total_duration_ms) throw new PackageValidationError(`Invalid or non-monotonic chapter timeline at ${chapter.id}.`);
    previousChapterEnd = chapter.audio_end_ms;
  }
  let previousAudioEnd = 0;
  for (const asset of manifest.audio_assets) {
    if (audioIds.has(asset.id)) throw new PackageValidationError(`Duplicate audio ID: ${asset.id}`);
    audioIds.add(asset.id);
    if (asset.global_start_ms < previousAudioEnd - 2 || asset.global_start_ms > previousAudioEnd + 2) throw new PackageValidationError(`Audio timeline has a gap or overlap at ${asset.id}.`);
    previousAudioEnd = asset.global_start_ms + asset.duration_ms;
  }
  if (Math.abs(previousAudioEnd - manifest.total_duration_ms) > 2) throw new PackageValidationError("Audio assets do not cover the declared total duration.");
  for (const overlay of manifest.overlay_assets) {
    if (overlayIds.has(overlay.id)) throw new PackageValidationError(`Duplicate overlay ID: ${overlay.id}`);
    overlayIds.add(overlay.id);
    if (!chapterIds.has(overlay.chapter_id)) throw new PackageValidationError(`Overlay references an unknown chapter: ${overlay.chapter_id}`);
  }
  for (const chapter of manifest.chapters) {
    if (!overlayIds.has(chapter.overlay_id)) throw new PackageValidationError(`Chapter references an unknown overlay: ${chapter.overlay_id}`);
  }
  for (const path of declaredFiles(manifest).keys()) {
    const canonical = normalizePackagePath(path).toLocaleLowerCase("en-US");
    if (paths.has(canonical)) throw new PackageValidationError(`Duplicate or case-colliding declared path: ${path}`);
    paths.add(canonical);
  }
  return manifest;
}

export function declaredFiles(manifest: BookSyncManifest): Map<RelativePackagePath, PackageFileAsset> {
  const files = new Map<RelativePackagePath, PackageFileAsset>();
  for (const chapter of manifest.chapters) files.set(chapter.content_path, { path: chapter.content_path, media_type: "text/html", sha256: chapter.content_sha256, byte_length: chapter.content_byte_length });
  for (const asset of manifest.audio_assets) files.set(asset.path, asset);
  for (const overlay of manifest.overlay_assets) files.set(overlay.path, { path: overlay.path, media_type: "application/json", sha256: overlay.sha256, byte_length: overlay.byte_length });
  for (const asset of [manifest.cover, manifest.transcript, manifest.quality_report, manifest.alignment_review]) if (asset) files.set(asset.path, asset);
  if (manifest.source.included_path) files.set(manifest.source.included_path, { path: manifest.source.included_path, media_type: manifest.source.type === "epub" ? "application/epub+zip" : "application/pdf", sha256: manifest.source.sha256, byte_length: manifest.source.byte_length });
  return files;
}

export function expectedExpandedBytes(manifest: BookSyncManifest) {
  return [...declaredFiles(manifest).values()].reduce((total, asset) => total + asset.byte_length, 0);
}

export function validateArchiveEntry(name: string, compressedSize: number | undefined, expandedSize: number | undefined) {
  const path = normalizePackagePath(name);
  const expanded = expandedSize ?? 0;
  const compressed = compressedSize ?? expanded;
  if (expanded > IMPORT_LIMITS.entryBytes) throw new PackageValidationError(`Archive entry is too large: ${path}`);
  if (METADATA_EXTENSIONS.test(path) && expanded > IMPORT_LIMITS.metadataEntryBytes) throw new PackageValidationError(`Metadata entry is too large: ${path}`);
  if (compressed > 0 && expanded / compressed > IMPORT_LIMITS.compressionRatio) throw new PackageValidationError(`Suspicious compression ratio for ${path}.`);
  return path;
}

export async function sha256(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validateDeclaredBlob(asset: PackageFileAsset, blob: Blob) {
  if (blob.size !== asset.byte_length) throw new PackageValidationError(`Size mismatch for ${asset.path}.`);
  if (await sha256(blob) !== asset.sha256) throw new PackageValidationError(`Checksum mismatch for ${asset.path}.`);
}

export async function validateOverlay(value: unknown, manifest: BookSyncManifest, expectedPath: RelativePackagePath): Promise<BookSyncOverlay> {
  const { overlay: overlayValidator } = await validators();
  if (!overlayValidator(value)) throw new PackageValidationError(schemaMessage(`Overlay ${expectedPath}`, overlayValidator.errors));
  const overlay = value as unknown as BookSyncOverlay;
  const declared = manifest.overlay_assets.find((asset) => asset.path === expectedPath)!;
  if (!declared || overlay.book_id !== manifest.book_id || overlay.overlay_id !== declared.id || overlay.chapter_id !== declared.chapter_id || overlay.entries.length !== declared.entry_count) throw new PackageValidationError(`Overlay identity or entry count mismatch: ${expectedPath}`);
  const audio = new Map(manifest.audio_assets.map((asset) => [asset.id, asset]));
  const sentenceIds = new Set<string>();
  let previousGlobal = -1;
  for (const entry of overlay.entries) {
    if (sentenceIds.has(entry.sentence_id)) throw new PackageValidationError(`Duplicate sentence ID in ${expectedPath}: ${entry.sentence_id}`);
    sentenceIds.add(entry.sentence_id);
    if (!entry.audio_locator) continue;
    const asset = audio.get(entry.audio_locator.asset_id);
    if (!asset || entry.audio_locator.end_ms <= entry.audio_locator.start_ms || entry.audio_locator.end_ms > asset.duration_ms) throw new PackageValidationError(`Invalid audio locator in ${expectedPath}.`);
    const expectedGlobal = asset.global_start_ms + entry.audio_locator.start_ms;
    if (entry.audio_locator.global_start_ms !== expectedGlobal || expectedGlobal < previousGlobal) throw new PackageValidationError(`Non-monotonic or inconsistent global timing in ${expectedPath}.`);
    previousGlobal = expectedGlobal;
  }
  return overlay;
}
