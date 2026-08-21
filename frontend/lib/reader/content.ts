import type { BookSyncAudioAsset, BookSyncOverlayEntry } from "../booksync/types";

export async function safeChapterMarkup(source: string): Promise<string> {
  const { default: DOMPurify } = await import("dompurify");
  const document = new DOMParser().parseFromString(source, "text/html");
  return DOMPurify.sanitize(document.body.innerHTML, {
    ALLOWED_TAGS: ["main", "article", "section", "header", "footer", "nav", "div", "p", "span", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "ol", "ul", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "em", "strong", "b", "i", "u", "s", "small", "sub", "sup", "br", "hr"],
    ALLOWED_ATTR: ["id", "class", "lang", "dir", "title", "role", "aria-label", "aria-hidden", "colspan", "rowspan"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    FORBID_TAGS: ["script", "style", "svg", "math", "form", "input", "button", "textarea", "select", "option", "iframe", "object", "embed", "audio", "video", "source", "img", "link", "meta", "base"],
    FORBID_ATTR: ["style", "src", "srcset", "href", "xlink:href", "formaction", "action"],
  });
}

export function activeEntry(entries: BookSyncOverlayEntry[], globalMs: number) {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const timing = entries[middle].audio_locator;
    if (!timing || timing.global_start_ms > globalMs) high = middle - 1;
    else low = middle + 1;
  }
  for (let index = Math.min(high, entries.length - 1); index >= Math.max(0, high - 2); index--) {
    const entry = entries[index];
    if (entry.audio_locator && globalMs <= entry.audio_locator.global_start_ms + entry.audio_locator.end_ms - entry.audio_locator.start_ms) return entry;
  }
  return high >= 0 ? entries[high] : undefined;
}

export function activeWordIndex(entry: BookSyncOverlayEntry | undefined, globalMs: number) {
  const words = entry?.words;
  const locator = entry?.audio_locator;
  if (!words?.length || !locator) return -1;
  const elapsed = globalMs - locator.global_start_ms;
  if (elapsed < 0) return -1;
  const exact = words.findIndex((word) => elapsed >= word.start_ms && elapsed < word.end_ms);
  if (exact >= 0) return exact;
  for (let index = words.length - 1; index >= 0; index--) if (elapsed >= words[index].start_ms) return index;
  return -1;
}

export function loadedAudioAsset(assets: BookSyncAudioAsset[], assetId: string | undefined) {
  if (!assetId) return undefined;
  return assets.find((asset) => asset.id === assetId);
}

export function logicalTimeForAudioAsset(asset: BookSyncAudioAsset, currentTimeSeconds: number) {
  const localMs = Number.isFinite(currentTimeSeconds) ? currentTimeSeconds * 1000 : 0;
  return asset.global_start_ms + Math.max(0, Math.min(localMs, asset.duration_ms));
}

export function nextAudioAsset(assets: BookSyncAudioAsset[], assetId: string | undefined) {
  if (!assetId) return undefined;
  const index = assets.findIndex((asset) => asset.id === assetId);
  return index >= 0 ? assets[index + 1] : undefined;
}

export function sessionTransitionSentenceIds(entries: BookSyncOverlayEntry[]) {
  const transitions: string[] = [];
  let previousAssetId: string | undefined;
  for (const entry of entries) {
    const assetId = entry.audio_locator?.asset_id;
    if (!assetId) continue;
    if (previousAssetId && assetId !== previousAssetId) transitions.push(entry.sentence_id);
    previousAssetId = assetId;
  }
  return transitions;
}

export function formatClock(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
}
