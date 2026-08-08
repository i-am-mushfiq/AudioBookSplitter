import type { BookSyncOverlayEntry } from "../booksync/types";

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

export function formatClock(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
}
