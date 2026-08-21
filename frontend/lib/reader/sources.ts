import type { BookSyncAudioAsset, RelativePackagePath } from "../booksync/types";
import { deleteLocalBook, listLocalBooks, readPackageFile, verifyLocalBook, type LocalBookRecord } from "./library";
import { listOracleBooks, oraclePlayableAudio, prefetchOracleAudio, readOraclePackageFile, removeOracleBook, type OracleBookRecord } from "./oracle-library";

export type ReaderBookRecord = LocalBookRecord | OracleBookRecord;

export function isOracleBook(record: ReaderBookRecord): record is OracleBookRecord {
  return "source" in record && record.source === "oracle";
}

export async function listReaderBooks(): Promise<ReaderBookRecord[]> {
  const [local, oracle] = await Promise.all([listLocalBooks(), listOracleBooks()]);
  const books = new Map<string, ReaderBookRecord>();
  for (const record of oracle) books.set(record.book_id, record);
  for (const record of local) books.set(record.book_id, record);
  return [...books.values()].sort((a, b) => b.imported_at.localeCompare(a.imported_at));
}

export async function readReaderFile(record: ReaderBookRecord, path: RelativePackagePath) {
  return isOracleBook(record) ? readOraclePackageFile(record, path) : readPackageFile(record.book_id, path);
}

export async function readReaderText(record: ReaderBookRecord, path: RelativePackagePath) { return (await readReaderFile(record, path)).text(); }

export async function verifyReaderBook(record: ReaderBookRecord) {
  if (!isOracleBook(record)) await verifyLocalBook(record);
}

export async function removeReaderBook(record: ReaderBookRecord) {
  if (isOracleBook(record)) await removeOracleBook(record);
  else await deleteLocalBook(record.book_id);
}

export async function playableAudio(record: ReaderBookRecord, asset: BookSyncAudioAsset) {
  if (isOracleBook(record)) return oraclePlayableAudio(record, asset);
  return { kind: "blob" as const, blob: await readPackageFile(record.book_id, asset.path), cached: true };
}

export async function prefetchAudio(record: ReaderBookRecord, asset: BookSyncAudioAsset, signal?: AbortSignal) {
  if (isOracleBook(record)) await prefetchOracleAudio(record, asset, signal);
}
