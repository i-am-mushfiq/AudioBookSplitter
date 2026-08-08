"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookSyncOverlay, BookSyncOverlayEntry } from "../../lib/booksync/types";
import { activeEntry, formatClock, safeChapterMarkup } from "../../lib/reader/content";
import { deleteLocalBook, importBookSyncZip, listLocalBooks, loadPosition, readPackageFile, readPackageText, savePosition, type LocalBookRecord } from "../../lib/reader/library";
import "./reader.css";

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
  const [follow, setFollow] = useState(true);
  const [theme, setTheme] = useState<Theme>("paper");
  const [fontSize, setFontSize] = useState(20);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrl = useRef<string | undefined>(undefined);
  const activeAssetId = useRef<string | undefined>(undefined);
  const readerRef = useRef<HTMLElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const manifest = book?.manifest;
  const chapter = manifest?.chapters[chapterIndex];
  const currentSentence = useMemo(() => activeEntry(entries, globalMs), [entries, globalMs]);

  const refreshLibrary = useCallback(async () => setLibrary(await listLocalBooks()), []);
  useEffect(() => { void refreshLibrary(); }, [refreshLibrary]);

  const seekGlobal = useCallback(async (targetMs: number, autoplay = playing) => {
    if (!manifest || !audioRef.current) return;
    const bounded = Math.max(0, Math.min(targetMs, manifest.total_duration_ms - 1));
    const asset = manifest.audio_assets.find((item) => bounded >= item.global_start_ms && bounded < item.global_start_ms + item.duration_ms) ?? manifest.audio_assets.at(-1);
    if (!asset) return;
    const audio = audioRef.current;
    if (activeAssetId.current !== asset.id) {
      if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
      audioUrl.current = URL.createObjectURL(await readPackageFile(manifest.book_id, asset.path));
      activeAssetId.current = asset.id;
      audio.src = audioUrl.current;
      audio.load();
      await new Promise<void>((resolve) => audio.addEventListener("loadedmetadata", () => resolve(), { once: true }));
    }
    audio.currentTime = Math.max(0, (bounded - asset.global_start_ms) / 1000);
    audio.playbackRate = rate;
    setGlobalMs(bounded);
    if (autoplay) await audio.play();
  }, [manifest, playing, rate]);

  useEffect(() => {
    if (!manifest || !chapter) return;
    let cancelled = false;
    Promise.all([
      readPackageText(manifest.book_id, chapter.content_path),
      readPackageText(manifest.book_id, manifest.overlay_assets.find((item) => item.id === chapter.overlay_id)!.path),
    ]).then(([html, overlayText]) => {
      if (cancelled) return;
      setMarkup(safeChapterMarkup(html));
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
      const index = manifest.chapters.findIndex((item) => target >= item.audio_start_ms && target < item.audio_end_ms);
      setChapterIndex(Math.max(0, index)); setGlobalMs(target); setRate(position?.playback_rate ?? 1);
      void seekGlobal(target, false);
    });
    return () => { cancelled = true; };
  }, [manifest?.book_id]);

  useEffect(() => {
    if (!manifest) return;
    const next = manifest.chapters.findIndex((item) => globalMs >= item.audio_start_ms && globalMs < item.audio_end_ms);
    if (next >= 0 && next !== chapterIndex) setChapterIndex(next);
  }, [globalMs, manifest, chapterIndex]);

  useEffect(() => {
    const root = readerRef.current;
    if (!root) return;
    root.querySelectorAll(".booksync-active").forEach((node) => node.classList.remove("booksync-active"));
    if (!currentSentence) return;
    const element = root.querySelector(`#${CSS.escape(currentSentence.sentence_id)}`);
    element?.classList.add("booksync-active");
    if (follow && playing) element?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentSentence, follow, playing, markup]);

  useEffect(() => {
    if (!manifest || !chapter) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void savePosition({ book_id: manifest.book_id, global_ms: globalMs, chapter_id: chapter.id, sentence_id: currentSentence?.sentence_id, playback_rate: rate, updated_at: new Date().toISOString() }), 700);
    return () => clearTimeout(saveTimer.current);
  }, [manifest, chapter, globalMs, rate, currentSentence]);

  useEffect(() => () => { if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); }, []);

  async function openBook(record: LocalBookRecord) {
    setBook(record); setError(""); setMarkup(""); setEntries([]);
  }

  async function importPackage(file: File) {
    setImporting(true); setError("");
    try { const record = await importBookSyncZip(file); await refreshLibrary(); await openBook(record); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Package import failed."); }
    finally { setImporting(false); }
  }

  async function removeBook(record: LocalBookRecord) {
    await deleteLocalBook(record.book_id);
    if (book?.book_id === record.book_id) { setBook(undefined); setPlaying(false); audioRef.current?.pause(); }
    await refreshLibrary();
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
    if (!manifest || !activeAsset) return;
    const index = manifest.audio_assets.findIndex((item) => item.id === activeAsset.id);
    const following = manifest.audio_assets[index + 1];
    if (following) void seekGlobal(following.global_start_ms, true);
    else { setPlaying(false); setGlobalMs(manifest.total_duration_ms); }
  }

  const activeAsset = manifest?.audio_assets.find((item) => item.id === activeAssetId.current);
  return <main className={`reader-app theme-${theme}`}>
    <audio ref={audioRef} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(event) => setGlobalMs((activeAsset?.global_start_ms ?? 0) + event.currentTarget.currentTime * 1000)} onEnded={handleAssetEnd} />
    <header className="reader-topbar"><a href="/" className="reader-brand">chapter<span>.</span>cut</a><strong>{manifest?.title ?? "Local reader"}</strong><div><label className="reader-import">{importing ? "Importing…" : "Import .zip"}<input type="file" accept=".zip,application/zip" disabled={importing} onChange={(event) => event.target.files?.[0] && void importPackage(event.target.files[0])} /></label></div></header>
    <aside className="reader-library"><div className="library-title"><span>LOCAL LIBRARY</span><b>{library.length}</b></div>{library.length ? library.map((item) => <div className={`library-book ${book?.book_id === item.book_id ? "active" : ""}`} key={item.book_id}><button onClick={() => void openBook(item)}><strong>{item.manifest.title}</strong><small>{item.manifest.author || "Unknown author"} · {formatClock(item.manifest.total_duration_ms)}</small></button><button className="book-delete" title="Remove from this device" onClick={() => void removeBook(item)}>×</button></div>) : <div className="library-empty">Import a processed BookSync ZIP. It stays in this browser.</div>}</aside>
    {manifest && chapter ? <>
      <nav className="chapter-nav"><span>CHAPTERS</span>{manifest.chapters.map((item, index) => <button className={index === chapterIndex ? "active" : ""} key={item.id} onClick={() => { setChapterIndex(index); void seekGlobal(item.audio_start_ms); }}><b>{String(index + 1).padStart(2, "0")}</b><span>{item.title || item.label}</span></button>)}</nav>
      <section className="reader-stage"><div className="reader-tools"><div><button onClick={() => setTheme("paper")} aria-label="Paper theme">☀</button><button onClick={() => setTheme("night")} aria-label="Night theme">◐</button><button onClick={() => setTheme("contrast")} aria-label="High contrast theme">◒</button></div><div><button onClick={() => setFontSize(Math.max(15, fontSize - 1))}>A−</button><span>{fontSize}</span><button onClick={() => setFontSize(Math.min(30, fontSize + 1))}>A+</button></div><label><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> Follow audio</label></div><article ref={readerRef} className="book-content" style={{ fontSize }} dangerouslySetInnerHTML={{ __html: markup }} /></section>
      <footer className="player"><div className="now-reading"><small>{chapter.title || chapter.label}</small><strong>{currentSentence?.text ?? "Ready to listen"}</strong></div><div className="transport"><div><button onClick={() => chapterStep(-1)} title="Previous chapter">|‹</button><button onClick={() => sentenceStep(-1)} title="Previous sentence">‹</button><button className="play" onClick={() => playing ? audioRef.current?.pause() : void seekGlobal(globalMs, true)}>{playing ? "Ⅱ" : "▶"}</button><button onClick={() => sentenceStep(1)} title="Next sentence">›</button><button onClick={() => chapterStep(1)} title="Next chapter">›|</button></div><label><span>{formatClock(globalMs)}</span><input type="range" min="0" max={manifest.total_duration_ms} step="1000" value={globalMs} onChange={(event) => { audioRef.current?.pause(); void seekGlobal(Number(event.target.value), false); }} onMouseUp={() => playing && void audioRef.current?.play()} /><span>{formatClock(manifest.total_duration_ms)}</span></label></div><select value={rate} onChange={(event) => { const next = Number(event.target.value); setRate(next); if (audioRef.current) audioRef.current.playbackRate = next; }}>{[0.75, 1, 1.25, 1.5, 1.75, 2].map((value) => <option key={value} value={value}>{value}×</option>)}</select></footer>
    </> : <section className="reader-welcome"><span>LOCAL · PRIVATE · SYNCHRONIZED</span><h1>Read with<br />the narrator.</h1><p>Import a BookSync ZIP to read the EPUB, hear the audiobook, and follow each sentence as it is spoken.</p><label className="welcome-import">{importing ? "Importing package…" : "Choose a BookSync ZIP"}<input type="file" accept=".zip,application/zip" disabled={importing} onChange={(event) => event.target.files?.[0] && void importPackage(event.target.files[0])} /></label>{error && <p className="reader-error">{error}</p>}</section>}
    {error && manifest && <div className="reader-toast">{error}</div>}
  </main>;
}
