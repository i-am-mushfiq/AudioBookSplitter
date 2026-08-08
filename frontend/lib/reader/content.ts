import type { BookSyncOverlayEntry } from "../booksync/types";

export function safeChapterMarkup(source: string): string {
  const document = new DOMParser().parseFromString(source, "text/html");
  document.querySelectorAll("script, style, iframe, object, embed, link, meta, base").forEach((node) => node.remove());
  document.body.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith("on") || ["src", "href", "style"].includes(attribute.name)) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  return document.body.innerHTML;
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

export function formatClock(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
}
