"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { BookSyncOverlay, BookSyncOverlayEntry } from "../../lib/booksync/types";
import { activeEntry, activeWordIndex, formatClock, loadedAudioAsset, logicalTimeForAudioAsset, nextAudioAsset, safeChapterMarkup } from "../../lib/reader/content";
import { deleteLocalBook, importBookSyncZip, listLocalBooks, listPositions, loadHighlights, loadLastOpenedBookId, loadPosition, readPackageFile, readPackageText, saveHighlights, saveLastOpenedBookId, savePosition, verifyLocalBook, type ImportProgress, type LocalBookRecord, type ReaderHighlight, type ReaderPosition } from "../../lib/reader/library";
import "./reader.css";
import "./highlight.css";
import "./reader-progress.css";

type Theme = "paper" | "night" | "contrast";
type ReaderSurface = "library" | "reader";
type ContentsTab = "chapters" | "sessions" | "highlights";

export default function ReaderPage() {
  const [library, setLibrary] = useState<LocalBookRecord[]>([]);
  const [book, setBook] = useState<LocalBookRecord>();
  const [chapterIndex, setChapterIndex] = useState(0);
  const [markup, setMarkup] = useState("");
  const [entries, setEntries] = useState<BookSyncOverlayEntry[]>([]);
  const [globalMs, setGlobalMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [furthestGlobalMs, setFurthestGlobalMs] = useState(0);
  const [completedChapterIds, setCompletedChapterIds] = useState<string[]>([]);
  const [positions, setPositions] = useState<Record<string, ReaderPosition>>({});
  const [surface, setSurface] = useState<ReaderSurface>("library");
  const [lastOpenedBookId, setLastOpenedBookId] = useState<string>();
  const [contentsOpen, setContentsOpen] = useState(false);
  const [contentsTab, setContentsTab] = useState<ContentsTab>("chapters");
  const [speedOpen, setSpeedOpen] = useState(false);
  const [highlightMode, setHighlightMode] = useState(false);
  const [savedHighlights, setSavedHighlights] = useState<ReaderHighlight[]>([]);
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const [follow, setFollow] = useState(true);
  const [theme, setTheme] = useState<Theme>("paper");
  const [fontSize, setFontSize] = useState(23);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress>();
  const [storagePersistent, setStoragePersistent] = useState<boolean>();
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrl = useRef<string | undefined>(undefined);
  const activeAssetId = useRef<string | undefined>(undefined);
  const readerRef = useRef<HTMLElement>(null);
  const highlightedSentenceId = useRef<string | undefined>(undefined);
  const previousPlaying = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestPosition = useRef<Parameters<typeof savePosition>[0] | undefined>(undefined);
  const importController = useRef<AbortController | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const seekGeneration = useRef(0);
  const manifest = book?.manifest;
  const chapter = manifest?.chapters[chapterIndex];
  const currentSentence = useMemo(() => activeEntry(entries, globalMs), [entries, globalMs]);
  const renderedChapter = <article ref={readerRef} className={`book-content ${highlightMode ? "highlight-mode" : ""}`} style={{ fontSize }} onClick={handleReaderTap} dangerouslySetInnerHTML={{ __html: markup }} />;
  latestPosition.current = manifest && chapter ? {
    book_id: manifest.book_id,
    global_ms: globalMs,
    chapter_id: chapter.id,
    sentence_id: currentSentence?.sentence_id,
    playback_rate: rate,
    furthest_global_ms: furthestGlobalMs,
    completed_chapter_ids: completedChapterIds,
    completed_at: completedChapterIds.length === manifest.chapters.length ? new Date().toISOString() : undefined,
    updated_at: new Date().toISOString(),
  } : undefined;

  const refreshLibrary = useCallback(async () => {
    const [books, savedPositions] = await Promise.all([listLocalBooks(), listPositions()]);
    setLibrary(books);
    setPositions(Object.fromEntries(savedPositions.map((position) => [position.book_id, position])));
    return books;
  }, []);
  useEffect(() => {
    let active = true;
    void refreshLibrary().then(async (books) => {
      const lastBookId = await loadLastOpenedBookId();
      if (active && books.some((item) => item.book_id === lastBookId)) setLastOpenedBookId(lastBookId);
    });
    return () => { active = false; };
  }, [refreshLibrary]);
  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    void Promise.all(library.map(async (record) => {
      if (!record.manifest.cover) return undefined;
      try {
        const blob = await readPackageFile(record.book_id, record.manifest.cover.path);
        const url = URL.createObjectURL(blob); created.push(url);
        return [record.book_id, url] as const;
      } catch { return undefined; }
    })).then((items) => {
      if (cancelled) { created.forEach((url) => URL.revokeObjectURL(url)); return; }
      setCoverUrls(Object.fromEntries(items.filter((item): item is readonly [string, string] => Boolean(item))));
    });
    return () => { cancelled = true; created.forEach((url) => URL.revokeObjectURL(url)); };
  }, [library]);
  useEffect(() => {
    void navigator.storage?.persist?.().then(setStoragePersistent).catch(() => undefined);
    void navigator.storage?.persisted?.().then(setStoragePersistent);
  }, []);

  const setLogicalTime = useCallback((milliseconds: number) => {
    setGlobalMs(milliseconds);
    if (!manifest) return;
    const next = manifest.chapters.findIndex((item) => milliseconds >= item.audio_start_ms && milliseconds < item.audio_end_ms);
    if (next >= 0) setChapterIndex((current) => current === next ? current : next);
  }, [manifest]);

  const seekGlobal = useCallback(async (targetMs: number, autoplay = playing) => {
    if (!manifest || !audioRef.current) return;
    const generation = ++seekGeneration.current;
    const bounded = Math.max(0, Math.min(targetMs, manifest.total_duration_ms - 1));
    const asset = manifest.audio_assets.find((item) => bounded >= item.global_start_ms && bounded < item.global_start_ms + item.duration_ms) ?? manifest.audio_assets.at(-1);
    if (!asset) return;
    const audio = audioRef.current;
    if (activeAssetId.current !== asset.id) {
      const blob = await readPackageFile(manifest.book_id, asset.path);
      if (generation !== seekGeneration.current) return;
      const nextUrl = URL.createObjectURL(blob);
      const previousUrl = audioUrl.current;
      audioUrl.current = nextUrl;
      audio.src = nextUrl;
      audio.load();
      await new Promise<void>((resolve, reject) => {
        audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
        audio.addEventListener("error", () => reject(new Error(`This browser could not decode ${asset.display_filename}.`)), { once: true });
      });
      if (generation !== seekGeneration.current) { URL.revokeObjectURL(nextUrl); return; }
      activeAssetId.current = asset.id;
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    }
    if (generation !== seekGeneration.current) return;
    audio.currentTime = Math.max(0, (bounded - asset.global_start_ms) / 1000);
    audio.playbackRate = rate;
    setLogicalTime(bounded);
    if (autoplay) await audio.play();
  }, [manifest, playing, rate, setLogicalTime]);

  useEffect(() => {
    if (!manifest || !chapter) return;
    let cancelled = false;
    Promise.all([
      readPackageText(manifest.book_id, chapter.content_path),
      readPackageText(manifest.book_id, manifest.overlay_assets.find((item) => item.id === chapter.overlay_id)!.path),
    ]).then(([html, overlayText]) => {
      if (cancelled) return;
      void safeChapterMarkup(html).then((safe) => { if (!cancelled) setMarkup(safe); });
      setEntries((JSON.parse(overlayText) as BookSyncOverlay).entries);
    }).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not open this chapter."));
    return () => { cancelled = true; };
  }, [manifest, chapter]);

  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    loadPosition(manifest.book_id).then((position) => {
      if (cancelled) return;
      const target = position?.global_ms ?? 0;
      const restoredRate = position?.playback_rate ?? 1;
      const index = manifest.chapters.findIndex((item) => target >= item.audio_start_ms && target < item.audio_end_ms);
      setChapterIndex(Math.max(0, index)); setGlobalMs(target); setRate(restoredRate);
      setFurthestGlobalMs(position?.furthest_global_ms ?? target);
      setCompletedChapterIds(position?.completed_chapter_ids ?? []);
      void seekGlobal(target, false).then(() => { if (audioRef.current) audioRef.current.playbackRate = restoredRate; });
    });
    return () => { cancelled = true; };
    // Resume is intentionally keyed to book identity; seekGlobal is recreated by playback state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest?.book_id]);

  useEffect(() => {
    if (!manifest) { setSavedHighlights([]); return; }
    let cancelled = false;
    setHighlightMode(false);
    void loadHighlights(manifest.book_id).then((items) => { if (!cancelled) setSavedHighlights(items); }).catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load saved highlights.");
    });
    return () => { cancelled = true; };
  }, [manifest?.book_id]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    if (!chapter) return;
    setFurthestGlobalMs((current) => Math.max(current, globalMs));
    const chapterDuration = chapter.audio_end_ms - chapter.audio_start_ms;
    if (globalMs >= chapter.audio_start_ms + chapterDuration * 0.9) {
      setCompletedChapterIds((current) => current.includes(chapter.id) ? current : [...current, chapter.id]);
    }
  }, [chapter, globalMs]);

  useEffect(() => {
    const root = readerRef.current;
    if (!root) return;
    const playbackStarted = playing && !previousPlaying.current;
    previousPlaying.current = playing;
    if (!currentSentence) {
      root.querySelectorAll(".booksync-active").forEach((node) => node.classList.remove("booksync-active"));
      highlightedSentenceId.current = undefined;
      return;
    }
    // Sentence IDs come from the imported package. Avoid treating them as CSS
    // selectors: getElementById handles arbitrary valid IDs without CSS.escape
    // support or selector parsing edge cases.
    const candidate = document.getElementById(currentSentence.sentence_id);
    const element = candidate && root.contains(candidate) ? candidate : null;
    root.querySelectorAll(".booksync-active").forEach((node) => {
      if (node !== element) node.classList.remove("booksync-active");
    });
    if (element && !element.classList.contains("booksync-active")) element.classList.add("booksync-active");
    if (element && currentSentence.words?.length && !element.querySelector("[data-booksync-word]")) {
      const parts = element.textContent?.match(/\S+|\s+/g) ?? [];
      const visibleWords = parts.filter((part) => /\S/.test(part));
      if (visibleWords.length === currentSentence.words.length) {
        element.replaceChildren();
        let wordIndex = 0;
        for (const part of parts) {
          if (!/\S/.test(part)) { element.append(document.createTextNode(part)); continue; }
          const span = document.createElement("span");
          span.dataset.booksyncWord = String(wordIndex++);
          span.textContent = part;
          element.append(span);
        }
      }
    }
    const changed = highlightedSentenceId.current !== currentSentence.sentence_id;
    highlightedSentenceId.current = currentSentence.sentence_id;
    if ((changed || playbackStarted) && follow && playing) element?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentSentence, follow, playing, markup]);

  useEffect(() => {
    const root = readerRef.current;
    if (!root) return;
    const index = activeWordIndex(currentSentence, globalMs);
    const sentence = currentSentence ? document.getElementById(currentSentence.sentence_id) : null;
    const activeWord = sentence && root.contains(sentence) && index >= 0
      ? sentence.querySelector(`[data-booksync-word="${index}"]`)
      : null;
    root.querySelectorAll(".booksync-word-active").forEach((node) => {
      if (node !== activeWord) node.classList.remove("booksync-word-active");
    });
    activeWord?.classList.add("booksync-word-active");
  }, [currentSentence, globalMs]);

  useEffect(() => {
    const root = readerRef.current;
    if (!root) return;
    const savedIds = new Set(savedHighlights.map((item) => item.sentence_id));
    root.querySelectorAll(".booksync-saved-highlight").forEach((node) => {
      if (!(node instanceof HTMLElement) || !savedIds.has(node.id)) node.classList.remove("booksync-saved-highlight");
    });
    for (const sentenceId of savedIds) {
      const candidate = document.getElementById(sentenceId);
      if (candidate && root.contains(candidate)) candidate.classList.add("booksync-saved-highlight");
    }
  }, [savedHighlights, markup]);

  useEffect(() => {
    if (!manifest || !chapter || playing) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const position = latestPosition.current;
      if (!position) return;
      void savePosition(position).then(() => setPositions((current) => ({ ...current, [position.book_id]: position })));
    }, 700);
    return () => clearTimeout(saveTimer.current);
  }, [manifest, chapter, globalMs, rate, currentSentence, playing]);

  useEffect(() => {
    if (!playing || !manifest) return;
    const persist = () => {
      const position = latestPosition.current;
      if (!position) return;
      void savePosition(position).then(() => setPositions((current) => ({ ...current, [position.book_id]: position })));
    };
    const interval = setInterval(persist, 2_000);
    window.addEventListener("pagehide", persist);
    return () => { clearInterval(interval); window.removeEventListener("pagehide", persist); persist(); };
  }, [playing, manifest]);

  useEffect(() => () => { if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); }, []);

  async function openBook(record: LocalBookRecord) {
    setError("");
    try {
      await verifyLocalBook(record);
      audioRef.current?.pause();
      if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
      audioUrl.current = undefined; activeAssetId.current = undefined;
      audioRef.current?.removeAttribute("src"); audioRef.current?.load();
      setBook(record); setMarkup(""); setEntries([]); setSurface("reader"); setContentsOpen(false); setSpeedOpen(false);
      setLastOpenedBookId(record.book_id);
      await saveLastOpenedBookId(record.book_id);
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The local package is incomplete."); }
  }

  async function importPackage(file: File) {
    importController.current?.abort();
    const controller = new AbortController(); importController.current = controller;
    setImporting(true); setImportProgress(undefined); setError("");
    try {
      const record = await importBookSyncZip(file, { signal: controller.signal, onProgress: setImportProgress });
      if (navigator.storage?.persist) setStoragePersistent(await navigator.storage.persist());
      await refreshLibrary(); await openBook(record);
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Package import failed."); }
    finally { if (importController.current === controller) { setImporting(false); setImportProgress(undefined); importController.current = undefined; } }
  }

  async function removeBook(record: LocalBookRecord) {
    await deleteLocalBook(record.book_id);
    if (book?.book_id === record.book_id) {
      setBook(undefined); setSurface("library"); setPlaying(false); audioRef.current?.pause();
      await saveLastOpenedBookId(undefined);
      setLastOpenedBookId(undefined);
    }
    await refreshLibrary();
  }

  const importLabel = importProgress ? `${importProgress.phase.replace("-", " ")} ${importProgress.total ? Math.min(100, Math.round(importProgress.completed / importProgress.total * 100)) : 0}%` : "Importing…";

  function handleReaderTap(event: MouseEvent<HTMLElement>) {
    if (!highlightMode || !manifest || !chapter || !readerRef.current) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const target = event.target instanceof Element ? event.target.closest("[id]") : null;
    if (!(target instanceof HTMLElement) || !readerRef.current.contains(target)) return;
    const entry = entries.find((item) => item.sentence_id === target.id);
    if (!entry) return;
    setSavedHighlights((current) => {
      const exists = current.some((item) => item.sentence_id === entry.sentence_id);
      const next = exists ? current.filter((item) => item.sentence_id !== entry.sentence_id) : [...current, {
        sentence_id: entry.sentence_id,
        chapter_id: chapter.id,
        text: entry.text,
        global_ms: entry.audio_locator?.global_start_ms,
        created_at: new Date().toISOString(),
      }];
      void saveHighlights(manifest.book_id, next).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not save this highlight."));
      return next;
    });
  }

  function sentenceStep(direction: -1 | 1) {
    const index = Math.max(0, entries.findIndex((entry) => entry.sentence_id === currentSentence?.sentence_id));
    const candidate = entries[index + direction];
    if (candidate?.audio_locator) void seekGlobal(candidate.audio_locator.global_start_ms, playing);
  }

  function chapterStep(direction: -1 | 1) {
    if (!manifest) return;
    const next = Math.max(0, Math.min(manifest.chapters.length - 1, chapterIndex + direction));
    setChapterIndex(next); void seekGlobal(manifest.chapters[next].audio_start_ms, playing);
  }

  function handleAssetEnd() {
    if (!manifest) return;
    const following = nextAudioAsset(manifest.audio_assets, activeAssetId.current);
    if (following) void seekGlobal(following.global_start_ms, true);
    else { setPlaying(false); setLogicalTime(manifest.total_duration_ms); }
  }

  function handleTimeUpdate(audio: HTMLAudioElement) {
    if (!manifest) return;
    const loaded = loadedAudioAsset(manifest.audio_assets, activeAssetId.current);
    if (loaded) setLogicalTime(logicalTimeForAudioAsset(loaded, audio.currentTime));
  }

  const activeAsset = manifest?.audio_assets.find((item) => globalMs >= item.global_start_ms && globalMs < item.global_start_ms + item.duration_ms) ?? manifest?.audio_assets.at(-1);
  const bookProgress = manifest ? Math.min(100, Math.round(Math.max(globalMs, furthestGlobalMs) / manifest.total_duration_ms * 100)) : 0;
  const chapterProgress = chapter ? Math.min(100, Math.round(Math.max(0, globalMs - chapter.audio_start_ms) / (chapter.audio_end_ms - chapter.audio_start_ms) * 100)) : 0;
  const resumeBook = library.find((item) => item.book_id === lastOpenedBookId);
  const activeSessionIndex = manifest && activeAsset ? manifest.audio_assets.findIndex((item) => item.id === activeAsset.id) : -1;
  const artwork = (record: LocalBookRecord) => <div className="book-artwork" aria-hidden="true">{coverUrls[record.book_id] ? <img src={coverUrls[record.book_id]} alt="" /> : <span>{record.manifest.title.trim().slice(0, 1).toUpperCase() || "B"}</span>}</div>;

  return <main className={`reader-app theme-${theme} surface-${surface}`}>
    {/* Audiobook text is rendered and highlighted in the adjacent reader instead of a WebVTT track. */}
    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
    <audio ref={audioRef} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(event) => handleTimeUpdate(event.currentTarget)} onEnded={handleAssetEnd} />
    <input ref={fileInputRef} className="reader-file-input" type="file" accept=".zip,application/zip" aria-label="Choose a BookSync ZIP" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void importPackage(file); }} />
    {surface === "library" ? <section className="library-home">
      <header className="library-home-header">
        <div><span>BOOKSYNC READER</span><h1>Library</h1></div>
        {importing ? <button className="reader-cancel" onClick={() => importController.current?.abort()}>{importLabel} · Cancel</button> : <button className="reader-import" onClick={() => fileInputRef.current?.click()}><b>＋</b><span>Import book</span></button>}
      </header>
      {resumeBook && <button className="resume-card" onClick={() => void openBook(resumeBook)}>
        {artwork(resumeBook)}
        <span><small>CONTINUE READING</small><strong>{resumeBook.manifest.title}</strong><em>{resumeBook.manifest.author || "Unknown author"}</em></span>
        <b>Resume&nbsp;›</b>
      </button>}
      <div className="library-section-title"><h2>{library.length ? "Your books" : "Your library is empty"}</h2><span>{library.length} {library.length === 1 ? "book" : "books"}</span></div>
      <div className="library-grid">
      {library.length ? library.map((item) => {
        const progress = positions[item.book_id];
        const percent = Math.min(100, Math.round((progress?.furthest_global_ms ?? progress?.global_ms ?? 0) / item.manifest.total_duration_ms * 100));
        return <article className="library-row" key={item.book_id}>
          <button className="library-open-book" onClick={() => void openBook(item)}>{artwork(item)}<span className="library-book-copy"><strong>{item.manifest.title}</strong><small>{item.manifest.author || "Unknown author"}</small><em>{item.manifest.chapters.length} chapters · {formatClock(item.manifest.total_duration_ms)}</em><i><span style={{ width: `${percent}%` }} /></i><b>{percent}% complete</b></span><span className="row-arrow">›</span></button>
          <button className="book-delete" title="Remove from this device" aria-label={`Remove ${item.manifest.title}`} onClick={() => void removeBook(item)}>×</button>
        </article>;
      }) : <div className="library-empty"><b>Bring your first book.</b><span>Import a processed BookSync ZIP to keep the text, audiobook, highlights, and progress together on this device.</span></div>}
      </div>
      <p className="storage-state">{storagePersistent ? "Books are stored offline and protected from automatic cleanup." : "Books are stored on this device. iOS may reclaim them if storage becomes critically low."}</p>
      {error && <p className="reader-error library-error">{error}</p>}
      {book && <button className="library-mini-player" onClick={() => setSurface("reader")}>{artwork(book)}<span><small>{playing ? "NOW PLAYING" : "READY TO RESUME"}</small><strong>{book.manifest.title}</strong></span><b>Open&nbsp;›</b></button>}
    </section> : manifest && chapter ? <>
      <section className="reader-stage">
        <div className="reader-tools">
          <button className="inline-back" onClick={() => { setSurface("library"); setContentsOpen(false); setSpeedOpen(false); }} aria-label="Return to library">‹ <span>Library</span></button>
          <button className="chapter-location" onClick={() => setContentsOpen(true)} aria-label={`Open contents. Chapter ${chapterIndex + 1} of ${manifest.chapters.length}: ${chapter.title || chapter.label}`}><small>CHAPTER {chapterIndex + 1} OF {manifest.chapters.length}</small><strong>{chapter.title || chapter.label}</strong></button>
          <button className={`highlight-toggle ${highlightMode ? "active" : ""}`} aria-pressed={highlightMode} onClick={() => setHighlightMode((value) => !value)} title="Single-tap sentence highlighting"><b>✦</b><span>{highlightMode ? "Tap text" : "Highlight"}</span>{savedHighlights.length > 0 && <em>{savedHighlights.length}</em>}</button>
          <div><button onClick={() => setFontSize(Math.max(19, fontSize - 1))} aria-label="Decrease text size">A−</button><span>{fontSize}px</span><button onClick={() => setFontSize(Math.min(38, fontSize + 1))} aria-label="Increase text size">A+</button></div>
          <button className={`follow-toggle ${follow ? "active" : ""}`} aria-pressed={follow} onClick={() => setFollow((value) => !value)} title="Follow the narrated sentence"><b>◎</b><span>{follow ? "Follow" : "Free"}</span></button>
        </div>
        <div className="reader-progress-strip"><span style={{ width: `${bookProgress}%` }} /><small>{bookProgress}% of book</small></div>
        {renderedChapter}
      </section>
      <footer className="player">
        <button className="now-reading" onClick={() => setContentsOpen(true)}><span><small>{activeSessionIndex >= 0 ? `SESSION ${activeSessionIndex + 1} OF ${manifest.audio_assets.length}` : "READY"}</small><strong>{chapter.title || chapter.label}</strong></span><b>{chapterProgress}%</b></button>
        <div className="transport"><label><span>{formatClock(globalMs)}</span><input aria-label="Audiobook progress" type="range" min="0" max={manifest.total_duration_ms} step="1000" value={globalMs} onChange={(event) => { audioRef.current?.pause(); void seekGlobal(Number(event.target.value), false); }} onMouseUp={() => playing && void audioRef.current?.play()} onTouchEnd={() => playing && void audioRef.current?.play()} /><span>−{formatClock(Math.max(0, manifest.total_duration_ms - globalMs))}</span></label><div><button onClick={() => chapterStep(-1)} title="Previous chapter" aria-label="Previous chapter">|‹</button><button onClick={() => sentenceStep(-1)} title="Previous sentence" aria-label="Previous sentence">‹</button><button className="play" onClick={() => playing ? audioRef.current?.pause() : void seekGlobal(globalMs, true)} aria-label={playing ? "Pause audiobook" : "Play audiobook"}>{playing ? "Ⅱ" : "▶"}</button><button onClick={() => sentenceStep(1)} title="Next sentence" aria-label="Next sentence">›</button><button onClick={() => chapterStep(1)} title="Next chapter" aria-label="Next chapter">›|</button></div></div>
        <button className="speed-pill" onClick={() => setSpeedOpen(true)} aria-label={`Playback speed ${rate} times`}>{rate}×</button>
      </footer>

      {contentsOpen && <div className="sheet-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setContentsOpen(false); }}><section className="reader-sheet contents-sheet" role="dialog" aria-modal="true" aria-labelledby="contents-title"><header><button onClick={() => setContentsOpen(false)} aria-label="Close contents">×</button><h2 id="contents-title">Book contents</h2><span /></header><div className="sheet-tabs three" role="tablist"><button role="tab" aria-selected={contentsTab === "chapters"} onClick={() => setContentsTab("chapters")}>Chapters</button><button role="tab" aria-selected={contentsTab === "sessions"} onClick={() => setContentsTab("sessions")}>Sessions</button><button role="tab" aria-selected={contentsTab === "highlights"} onClick={() => setContentsTab("highlights")}>Highlights</button></div><div className="contents-list">{contentsTab === "chapters" ? manifest.chapters.map((item, index) => <button className={index === chapterIndex ? "active" : ""} key={item.id} onClick={() => { setChapterIndex(index); void seekGlobal(item.audio_start_ms, playing); setContentsOpen(false); }}><b>{completedChapterIds.includes(item.id) ? "✓" : String(index + 1).padStart(2, "0")}</b><span><strong>{item.title || item.label}</strong><small>{formatClock(item.audio_start_ms)} · {formatClock(item.audio_end_ms - item.audio_start_ms)}</small></span><em>{index === chapterIndex ? "Now" : "›"}</em></button>) : contentsTab === "sessions" ? manifest.audio_assets.map((item, index) => { const owner = manifest.chapters.find((candidate) => item.global_start_ms >= candidate.audio_start_ms && item.global_start_ms < candidate.audio_end_ms); return <button className={item.id === activeAsset?.id ? "active" : ""} key={item.id} onClick={() => { void seekGlobal(item.global_start_ms, playing); setContentsOpen(false); }}><b>{String(index + 1).padStart(2, "0")}</b><span><strong>Session {index + 1}</strong><small>{owner?.title || owner?.label || "Book audio"} · {formatClock(item.duration_ms)}</small></span><em>{item.id === activeAsset?.id ? "Now" : "›"}</em></button>; }) : savedHighlights.length ? savedHighlights.map((item, index) => { const ownerIndex = manifest.chapters.findIndex((candidate) => candidate.id === item.chapter_id); const owner = manifest.chapters[ownerIndex]; return <button className={item.sentence_id === currentSentence?.sentence_id ? "active" : ""} key={item.sentence_id} onClick={() => { if (ownerIndex >= 0) setChapterIndex(ownerIndex); if (item.global_ms != null) void seekGlobal(item.global_ms, playing); setContentsOpen(false); }}><b>✦</b><span><strong>{item.text}</strong><small>{owner?.title || owner?.label || `Chapter ${ownerIndex + 1}`} · Highlight {index + 1}</small></span><em>›</em></button>; }) : <div className="highlights-empty"><b>No saved highlights yet.</b><span>Turn on ✦ Highlight, then tap any sentence you want to remember.</span></div>}</div></section></div>}

      {speedOpen && <div className="sheet-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSpeedOpen(false); }}><section className="reader-sheet speed-sheet" role="dialog" aria-modal="true" aria-labelledby="speed-title"><header><button onClick={() => setSpeedOpen(false)} aria-label="Close speed controls">×</button><h2 id="speed-title">Playback speed</h2><span /></header><p>Choose a comfortable narration speed.</p><div className="speed-options">{[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5].map((value) => <button key={value} className={rate === value ? "active" : ""} onClick={() => { setRate(value); if (audioRef.current) audioRef.current.playbackRate = value; setSpeedOpen(false); }} aria-pressed={rate === value}>{value}×{rate === value && <span>✓</span>}</button>)}</div></section></div>}
    </> : null}
    {error && manifest && <div className="reader-toast">{error}</div>}
  </main>;
}
