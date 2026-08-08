export const BOOKSYNC_SCHEMA_VERSION = 1 as const;

export type Sha256 = string;
export type BookId = `book_${string}`;
export type InternalId = string;
export type RelativePackagePath = string;

export type AlignmentState = "exact" | "approximate" | "unmatched";

export interface SourceIdentity {
  type: "epub" | "pdf";
  sha256: Sha256;
  byte_length: number;
  original_filename: string;
  included_path?: RelativePackagePath;
}

export interface PackageFileAsset {
  path: RelativePackagePath;
  media_type: string;
  sha256: Sha256;
  byte_length: number;
}

export interface CoverAsset extends PackageFileAsset {
  media_type: `image/${string}`;
}

export interface BookSyncChapter {
  id: InternalId;
  index: number;
  label: string;
  title: string | null;
  content_path: RelativePackagePath;
  content_sha256: Sha256;
  content_byte_length: number;
  overlay_id: InternalId;
  audio_start_ms: number;
  audio_end_ms: number;
}

export interface BookSyncAudioAsset {
  id: InternalId;
  path: RelativePackagePath;
  media_type: `audio/${string}`;
  sha256: Sha256;
  byte_length: number;
  duration_ms: number;
  global_start_ms: number;
  display_filename: string;
}

export interface BookSyncOverlayAsset {
  id: InternalId;
  chapter_id: InternalId;
  path: RelativePackagePath;
  sha256: Sha256;
  byte_length: number;
  entry_count: number;
}

export interface AlignmentThresholds {
  exact_min: number;
  approximate_min: number;
}

export interface AlignmentSummary {
  sentence_count: number;
  aligned_sentence_count: number;
  exact_sentence_count: number;
  approximate_sentence_count: number;
  unmatched_sentence_count: number;
  sentence_coverage: number;
  thresholds: AlignmentThresholds;
}

export interface BookSyncGenerator {
  name: string;
  version: string;
  settings?: Record<string, unknown>;
}

export interface BookSyncManifestV1 {
  format: "booksync";
  schema_version: typeof BOOKSYNC_SCHEMA_VERSION;
  book_id: BookId;
  title: string;
  author?: string | null;
  language: string;
  source: SourceIdentity;
  audiobook_sha256: Sha256;
  cover?: CoverAsset;
  total_duration_ms: number;
  chapters: BookSyncChapter[];
  audio_assets: BookSyncAudioAsset[];
  overlay_assets: BookSyncOverlayAsset[];
  transcript?: PackageFileAsset;
  quality_report?: PackageFileAsset;
  alignment_review?: PackageFileAsset;
  alignment: AlignmentSummary;
  created_at: string;
  generator: BookSyncGenerator;
}

export interface EpubTextLocator {
  type: "epub";
  document: RelativePackagePath;
  element_id: string;
}

export interface PdfTextSpan {
  text_item: number;
  start_character: number;
  end_character: number;
  quad?: [number, number, number, number];
}

export interface PdfTextLocator {
  type: "pdf";
  page: number;
  spans: PdfTextSpan[];
}

export type TextLocator = EpubTextLocator | PdfTextLocator;

export interface AudioLocator {
  asset_id: InternalId;
  start_ms: number;
  end_ms: number;
  global_start_ms: number;
}

export interface WordTiming {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence?: number;
}

export interface BookSyncOverlayEntry {
  sentence_id: InternalId;
  ordinal: number;
  text: string;
  text_locator: TextLocator;
  audio_locator: AudioLocator | null;
  confidence: number;
  alignment: AlignmentState;
  reasons?: string[];
  words?: WordTiming[];
}

export interface BookSyncOverlayV1 {
  format: "booksync-overlay";
  schema_version: typeof BOOKSYNC_SCHEMA_VERSION;
  overlay_id: InternalId;
  book_id: BookId;
  chapter_id: InternalId;
  entries: BookSyncOverlayEntry[];
}

export type BookSyncManifest = BookSyncManifestV1;
export type BookSyncOverlay = BookSyncOverlayV1;
