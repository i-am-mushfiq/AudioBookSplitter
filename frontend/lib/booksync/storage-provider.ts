import type {
  BookId,
  BookSyncManifest,
  RelativePackagePath,
} from "./types";

export type StorageProviderKind = "local" | "oracle" | "huggingface" | "google-drive" | "telegram" | "webdav";

export interface StorageProviderCapabilities {
  range_reads: boolean;
  uploads: boolean;
  deletes: boolean;
  offline_pinning: boolean;
}

export interface RemoteBook {
  book_id: BookId;
  title: string;
  author?: string | null;
  manifest_revision?: string;
  modified_at?: string;
}

export interface ByteRange {
  start: number;
  end_exclusive: number;
}

export interface PackageUploadSource {
  manifest: BookSyncManifest;
  listFiles(): Promise<RelativePackagePath[]>;
  readFile(path: RelativePackagePath): Promise<ArrayBuffer>;
}

export interface StorageProvider {
  readonly id: string;
  readonly kind: StorageProviderKind;
  readonly capabilities: StorageProviderCapabilities;

  listBooks(signal?: AbortSignal): Promise<RemoteBook[]>;
  getManifest(bookId: BookId, signal?: AbortSignal): Promise<BookSyncManifest>;
  readFile(
    bookId: BookId,
    path: RelativePackagePath,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer>;
  readRange(
    bookId: BookId,
    path: RelativePackagePath,
    range: ByteRange,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer>;
  uploadPackage?(
    source: PackageUploadSource,
    signal?: AbortSignal,
  ): Promise<void>;
  deleteBook?(bookId: BookId, signal?: AbortSignal): Promise<void>;
}
