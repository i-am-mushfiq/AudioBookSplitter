import type { BookSyncAudioAsset, RelativePackagePath } from "../booksync/types";
import { deleteLocalBook, listLocalBooks, readPackageFile, verifyLocalBook, type LocalBookRecord } from "./library";
import { listRemoteBooks, oraclePlayableAudio, prefetchOracleAudio, readOraclePackageFile, removeOracleBook, type RemoteBookRecord } from "./oracle-library";

export type ReaderBookRecord = LocalBookRecord | RemoteBookRecord;

export function isRemoteBook(record: ReaderBookRecord): record is RemoteBookRecord {
  return "source" in record && (record.source === "oracle" || record.source === "huggingface");
}

export function isOracleBook(record: ReaderBookRecord) {
  return isRemoteBook(record) && record.source === "oracle";
}

export function isHuggingFaceBook(record: ReaderBookRecord) {
  return isRemoteBook(record) && record.source === "huggingface";
}

export async function listReaderBooks(): Promise<ReaderBookRecord[]> {
  const [local, remote] = await Promise.all([listLocalBooks(), listRemoteBooks()]);
  const books = new Map<string, ReaderBookRecord>();
  for (const record of remote) books.set(record.book_id, record);
  for (const record of local) books.set(record.book_id, record);
  return [...books.values()].sort((a, b) => b.imported_at.localeCompare(a.imported_at));
}

export async function readReaderFile(record: ReaderBookRecord, path: RelativePackagePath) {
  return isRemoteBook(record) ? readOraclePackageFile(record, path) : readPackageFile(record.book_id, path);
}

export async function readReaderText(record: ReaderBookRecord, path: RelativePackagePath) { return (await readReaderFile(record, path)).text(); }

export async function verifyReaderBook(record: ReaderBookRecord) {
  if (!isRemoteBook(record)) await verifyLocalBook(record);
}

export async function removeReaderBook(record: ReaderBookRecord) {
  if (isRemoteBook(record)) await removeOracleBook(record);
  else await deleteLocalBook(record.book_id);
}

export async function playableAudio(record: ReaderBookRecord, asset: BookSyncAudioAsset) {
  if (isRemoteBook(record)) return oraclePlayableAudio(record, asset);
  return { kind: "blob" as const, blob: await readPackageFile(record.book_id, asset.path), cached: true };
}

export async function prefetchAudio(record: ReaderBookRecord, asset: BookSyncAudioAsset, signal?: AbortSignal) {
  if (isRemoteBook(record)) await prefetchOracleAudio(record, asset, signal);
}
