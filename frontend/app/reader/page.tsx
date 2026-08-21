"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookSyncOverlay, BookSyncOverlayEntry } from "../../lib/booksync/types";
import { activeEntry, activeWordIndex, formatClock, safeChapterMarkup } from "../../lib/reader/content";
import { deleteLocalBook, importBookSyncZip, listLocalBooks, listPositions, loadLastOpenedBookId, loadPosition, readPackageFile, readPackageText, saveLastOpenedBookId, savePosition, verifyLocalBook, type ImportProgress, type LocalBookRecord, type ReaderPosition } from "../../lib/reader/library";
import "./reader.css";
import "./highlight.css";
import "./reader-progress.css";

type Theme = "paper" | "night" | "contrast";

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
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [follow, setFollow] = useState(true);
  const [theme, setTheme] = useState<Theme>("paper");
  const [fontSize, setFontSize] = useState(20);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress>();
  const [storagePersistent, setStoragePersistent] = useState<boolean>();
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrl = useRef<string | undefined>(undefined);
  const activeAssetId = useRef<string | undefined>(undefined);
  const readerRef = useRef<HTMLElement>(null);
  const highlightedSentenceId = useRef<string | undefined>(undefined);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestPosition = useRef<Parameters<typeof savePosition>[0] | undefined>(undefined);
  const importController = useRef<AbortController | undefined>(undefined);
  const seekGeneration = useRef(0);
  const manifest = book?.manifest;
  const chapter = manifest?.chapters[chapterIndex];
  const currentSentence = useMemo(() => activeEntry(entries, globalMs), [entries, globalMs]);
  const renderedChapter = useMemo(() => <article ref={readerRef} className="book-content" style={{ fontSize }} dangerouslySetInnerHTML={{ __html: markup }} />, [fontSize, markup]);
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
      const savedBook = books.find((item) => item.book_id === lastBookId);
      if (active && savedBook) await openBook(savedBook);
    });
    return () => { active = false; };
    // Initial restore is deliberately run once. openBook only updates local reader state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshLibrary]);
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
    if (changed && follow && playing) element?.scrollIntoView({ behavior: "smooth", block: "center" });
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
      setBook(record); setMarkup(""); setEntries([]); setLibraryOpen(false);
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
      setBook(undefined); setPlaying(false); audioRef.current?.pause();
      await saveLastOpenedBookId(undefined);
    }
    await refreshLibrary();
  }

  const importLabel = importProgress ? `${importProgress.phase.replace("-", " ")} ${importProgress.total ? Math.min(100, Math.round(importProgress.completed / importProgress.total * 100)) : 0}%` : "Importing…";

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
    if (!manifest || !activeAsset) return;
    const index = manifest.audio_assets.findIndex((item) => item.id === activeAsset.id);
    const following = manifest.audio_assets[index + 1];
    if (following) void seekGlobal(following.global_start_ms, true);
    else { setPlaying(false); setLogicalTime(manifest.total_duration_ms); }
  }

  const activeAsset = manifest?.audio_assets.find((item) => globalMs >= item.global_start_ms && globalMs < item.global_start_ms + item.duration_ms) ?? manifest?.audio_assets.at(-1);
  const bookProgress = manifest ? Math.min(100, Math.round(Math.max(globalMs, furthestGlobalMs) / manifest.total_duration_ms * 100)) : 0;
  const chapterProgress = chapter ? Math.min(100, Math.round(Math.max(0, globalMs - chapter.audio_start_ms) / (chapter.audio_end_ms - chapter.audio_start_ms) * 100)) : 0;
  return <main className={`reader-app theme-${theme}`}>
    {/* Audiobook text is rendered and highlighted in the adjacent reader instead of a WebVTT track. */}
    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
    <audio ref={audioRef} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(event) => setLogicalTime((activeAsset?.global_start_ms ?? 0) + event.currentTarget.currentTime * 1000)} onEnded={handleAssetEnd} />
    <header className="reader-topbar">
      <a href="/" className="reader-brand">chapter<span>.</span>cut</a>
      <strong>{manifest?.title ?? "Local reader"}</strong>
      <div className="reader-actions">
        <button className="library-trigger" onClick={() => setLibraryOpen((open) => !open)} aria-expanded={libraryOpen}>Library <b>{library.length}</b></button>
        {importing ? <button className="reader-cancel" onClick={() => importController.current?.abort()}>{importLabel} · Cancel</button> : <label className="reader-import">Import .zip<input type="file" accept=".zip,application/zip" onChange={(event) => event.target.files?.[0] && void importPackage(event.target.files[0])} /></label>}
      </div>
    </header>
    <aside className={`reader-library ${libraryOpen ? "mobile-open" : ""}`}>
      <div className="library-title"><span>YOUR LIBRARY</span><b>{library.length}</b><button className="library-close" onClick={() => setLibraryOpen(false)} aria-label="Close library">×</button></div>
      {library.length ? library.map((item) => {
        const progress = positions[item.book_id];
        const percent = Math.min(100, Math.round((progress?.furthest_global_ms ?? progress?.global_ms ?? 0) / item.manifest.total_duration_ms * 100));
        return <div className={`library-book ${book?.book_id === item.book_id ? "active" : ""}`} key={item.book_id}>
          <button onClick={() => void openBook(item)}><strong>{item.manifest.title}</strong><small>{item.manifest.author || "Unknown author"} · {percent}% complete</small><i><em style={{ width: `${percent}%` }} /></i></button>
          <button className="book-delete" title="Remove from this device" aria-label={`Remove ${item.manifest.title}`} onClick={() => void removeBook(item)}>×</button>
        </div>;
      }) : <div className="library-empty">Import a processed BookSync ZIP. It remains available after you close the app.</div>}
    </aside>
    {manifest && chapter ? <>
      <nav className="chapter-nav"><span>CHAPTERS · {completedChapterIds.length}/{manifest.chapters.length}</span>{manifest.chapters.map((item, index) => <button className={`${index === chapterIndex ? "active" : ""} ${completedChapterIds.includes(item.id) ? "complete" : ""}`} key={item.id} onClick={() => { setChapterIndex(index); void seekGlobal(item.audio_start_ms); }}><b>{completedChapterIds.includes(item.id) ? "✓" : String(index + 1).padStart(2, "0")}</b><span>{item.title || item.label}</span></button>)}</nav>
      <section className="reader-stage">
        <div className="reader-tools"><div><button onClick={() => setTheme("paper")} aria-label="Paper theme">☀</button><button onClick={() => setTheme("night")} aria-label="Night theme">◐</button><button onClick={() => setTheme("contrast")} aria-label="High contrast theme">◒</button></div><div><button onClick={() => setFontSize(Math.max(17, fontSize - 1))} aria-label="Decrease text size">A−</button><span>{fontSize}px</span><button onClick={() => setFontSize(Math.min(32, fontSize + 1))} aria-label="Increase text size">A+</button></div><label><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> Follow audio</label></div>
        <div className="progress-card"><div><span>BOOK PROGRESS</span><b>{bookProgress}%</b></div><progress value={bookProgress} max="100" /><small>{completedChapterIds.length} of {manifest.chapters.length} chapters completed · Chapter {chapterIndex + 1} is {chapterProgress}% complete</small></div>
        {renderedChapter}
      </section>
      <footer className="player"><div className="now-reading"><small>{chapter.title || chapter.label} · {chapterProgress}%</small><strong>{currentSentence?.text ?? "Ready to listen"}</strong></div><div className="transport"><div><button onClick={() => chapterStep(-1)} title="Previous chapter" aria-label="Previous chapter">|‹</button><button onClick={() => sentenceStep(-1)} title="Previous sentence" aria-label="Previous sentence">‹</button><button className="play" onClick={() => playing ? audioRef.current?.pause() : void seekGlobal(globalMs, true)} aria-label={playing ? "Pause audiobook" : "Play audiobook"}>{playing ? "Ⅱ" : "▶"}</button><button onClick={() => sentenceStep(1)} title="Next sentence" aria-label="Next sentence">›</button><button onClick={() => chapterStep(1)} title="Next chapter" aria-label="Next chapter">›|</button></div><label><span>{formatClock(globalMs)}</span><input aria-label="Audiobook progress" type="range" min="0" max={manifest.total_duration_ms} step="1000" value={globalMs} onChange={(event) => { audioRef.current?.pause(); void seekGlobal(Number(event.target.value), false); }} onMouseUp={() => playing && void audioRef.current?.play()} onTouchEnd={() => playing && void audioRef.current?.play()} /><span>{formatClock(manifest.total_duration_ms)}</span></label></div><div className="speed-control" aria-label="Playback speed">{[0.75, 1, 1.25, 1.5, 1.75, 2].map((value) => <button key={value} className={rate === value ? "active" : ""} onClick={() => { setRate(value); if (audioRef.current) audioRef.current.playbackRate = value; }} aria-pressed={rate === value}>{value}×</button>)}</div></footer>
    </> : <section className="reader-welcome"><span>LOCAL · PRIVATE · SYNCHRONIZED</span><h1>Read with<br />the narrator.</h1><p>Import a validated BookSync ZIP to read the EPUB, hear the audiobook, and follow each sentence as it is spoken.</p>{importing ? <button className="welcome-import reader-cancel" onClick={() => importController.current?.abort()}>{importLabel} · Cancel</button> : <label className="welcome-import">Choose a BookSync ZIP<input type="file" accept=".zip,application/zip" onChange={(event) => event.target.files?.[0] && void importPackage(event.target.files[0])} /></label>}<small className="storage-state">{storagePersistent ? "Offline storage is protected from automatic eviction." : "Your browser may reclaim local books when storage is low."}</small>{error && <p className="reader-error">{error}</p>}</section>}
    {error && manifest && <div className="reader-toast">{error}</div>}
  </main>;
}
