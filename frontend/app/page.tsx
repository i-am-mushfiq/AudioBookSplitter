"use client";

import { useEffect, useMemo, useState } from "react";

type Mode = "smart" | "chapter" | "fixed";
type Naming = string;

const namingOptions = [
  { group: "Symbol-led", id: "symbols", label: "Brackets + pipes · recommended", template: "[01|{T}]_{B}__C[01|{CT}]__P[1|{PT}].mp3" },
  { group: "Compact", id: "dash", label: "Dash counts", template: "01-{T}_{B}__C01-{CT}_P1-{PT}.mp3" },
  { group: "Compact", id: "of", label: "of counts", template: "01of{T}_{B}__C01of{CT}_P1of{PT}.mp3" },
  { group: "Compact", id: "book-dash", label: "Book prefix + dashes", template: "B01-{T}_{B}__C01-{CT}_P1-{PT}.mp3" },
  { group: "Compact", id: "underscore", label: "Underscore counts", template: "B01_{T}_{B}__C01_{CT}_P1_{PT}.mp3" },
  { group: "Compact", id: "bare", label: "Bare sortable", template: "01_{T}_{B}_C01_{CT}_P1_{PT}.mp3" },
  { group: "Compact", id: "short", label: "Shortest", template: "01-{T}__{B}__C01__P1.mp3" },
  { group: "Compact", id: "padded", label: "Zero-padded", template: "001-{T3}_{B}__C01-{CT2}_P01-{PT2}.mp3" },
  { group: "Readable", id: "bookpart", label: "Book part first", template: "{B}__BookPart_01_of_{T}__Chapter_01_of_{CT}__Part_1_of_{PT}.mp3" },
  { group: "Readable", id: "book-chapter", label: "Book → chapter → part", template: "{B}__Book_01_of_{T}__Ch_01_of_{CT}__Part_1_of_{PT}.mp3" },
  { group: "Readable", id: "hyphen-readable", label: "Readable hyphens", template: "{B}__BookPart_01-{T}__Chapter_01-{CT}__Part_1-{PT}.mp3" },
  { group: "Readable", id: "fraction", label: "Fraction labels", template: "{B}__Fraction_01_of_{T}__Chapter_01_of_{CT}__Part_1_of_{PT}.mp3" },
  { group: "Readable", id: "plain-readable", label: "Plain readable", template: "{B}__01_of_{T}__Chapter_01_of_{CT}__Part_1_of_{PT}.mp3" },
  { group: "Readable", id: "underscore-readable", label: "Underscore readable", template: "{B}__Book_01_{T}__Chapter_01_{CT}__Part_1_{PT}.mp3" },
  { group: "Readable", id: "part-first", label: "Part first", template: "{B}__Part_01_of_{T}__Ch_01_of_{CT}__ChPart_1_of_{PT}.mp3" },
  { group: "Readable", id: "whole-book", label: "Whole book labels", template: "{B}__WholeBook_01_of_{T}__Chapter_01_of_{CT}__Part_1_of_{PT}.mp3" },
  { group: "Chapter-first", id: "chapter-dash", label: "Chapter + dash counts", template: "C01-{CT}_P1-{PT}_B01-{T}_{B}.mp3" },
  { group: "Chapter-first", id: "chapter-of", label: "Chapter + of counts", template: "C01of{CT}_P1of{PT}_B01of{T}_{B}.mp3" },
  { group: "Chapter-first", id: "chapter-readable", label: "Full chapter first", template: "Chapter_01_of_{CT}__Part_1_of_{PT}__Book_01_of_{T}__{B}.mp3" },
  { group: "Chapter-first", id: "chapter-compact", label: "Compact chapter first", template: "Ch01-{CT}__Part1-{PT}__Book01-{T}__{B}.mp3" },
  { group: "Chapter-first", id: "chapter-underscore", label: "Chapter underscore", template: "C01_{CT}_P1_{PT}_B01_{T}_{B}.mp3" },
  { group: "Chapter-first", id: "chapter-book", label: "Chapter + book", template: "C01of{CT}_P1of{PT}__{B}__Book01of{T}.mp3" },
  { group: "Visual separators", id: "bullet", label: "Bullet separators", template: "01•{T}_{B}__C01•{CT}__P1•{PT}.mp3" },
  { group: "Visual separators", id: "middle-dot", label: "Middle-dot separators", template: "01·{T}_{B}__C01·{CT}__P1·{PT}.mp3" },
  { group: "Visual separators", id: "pipe", label: "Pipe separators", template: "01|{T}_{B}__C01|{CT}__P1|{PT}.mp3" },
  { group: "Visual separators", id: "hyphen-final", label: "Hyphen separators", template: "01-{T}-{B}-C01-{CT}-P1-{PT}.mp3" },
  { group: "Visual separators", id: "bracketed", label: "Bracketed labels", template: "[01-{T}]_{B}_[C01-{CT}]_[P1-{PT}].mp3" },
  { group: "Visual separators", id: "colon", label: "Colon-style labels", template: "01:{T}_{B}__C01:{CT}__P1:{PT}.mp3" },
] as const;

function renderName(template: string, book: string, totalParts: number) {
  return template.replaceAll("{B}", book).replaceAll("{T3}", String(totalParts).padStart(3, "0")).replaceAll("{T2}", String(totalParts).padStart(2, "0")).replaceAll("{T}", String(totalParts)).replaceAll("{CT2}", "10").replaceAll("{CT}", "10").replaceAll("{PT2}", "03").replaceAll("{PT}", "3");
}

function UploadZone({ kind, file, accept, onFile }: { kind: "Book" | "Audiobook"; file: File | null; accept: string; onFile: (file: File) => void }) {
  return (
    <label className={`upload-zone ${file ? "has-file" : ""}`}>
      <input type="file" accept={accept} onChange={(event) => event.target.files?.[0] && onFile(event.target.files[0])} />
      <span className="upload-icon">{kind === "Book" ? "▤" : "◉"}</span>
      <span className="upload-body">
        <strong>{file ? file.name : `Drop your ${kind === "Book" ? "book PDF or EPUB" : "audiobook"} here`}</strong>
        <small>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · ready` : kind === "Book" ? "or click to browse · PDF, EPUB" : "or click to browse · MP3, M4A, WAV"}</small>
      </span>
      <span className="upload-action">{file ? "Change" : "Browse"}</span>
      {file && <span className="upload-check">✓</span>}
    </label>
  );
}

function Switch({ value, onChange }: { value: boolean; onChange: (next: boolean) => void }) {
  return <button className={`switch ${value ? "on" : ""}`} aria-pressed={value} onClick={() => onChange(!value)}><span /></button>;
}

export default function Home() {
  const [pdf, setPdf] = useState<File | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [bookNameInput, setBookNameInput] = useState("");
  const [mode, setMode] = useState<Mode>("smart");
  const [minutes, setMinutes] = useState(10);
  const [naming, setNaming] = useState<Naming>("symbols");
  const [chapterLock, setChapterLock] = useState(true);
  const [fade, setFade] = useState(true);
  const [silence, setSilence] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  const bookName = useMemo(() => (bookNameInput.trim() || pdf?.name?.replace(/\.[^.]+$/, "") || "").replace(/[^a-z0-9]+/gi, "_"), [bookNameInput, pdf]);
  const hasSources = Boolean(pdf && audio);
  const totalParts = mode === "chapter" ? 10 : minutes === 5 ? 40 : minutes === 15 ? 15 : 25;
  const selectedNaming = namingOptions.find((option) => option.id === naming) || namingOptions[0];
  const namePreview = renderName(selectedNaming.template, bookName || "Book_Name", totalParts);
  const exportSummary = hasSources ? `${mode === "chapter" ? "Whole-chapter files" : `${totalParts} chapter-safe listening sessions`} · processed from your uploaded files.` : "Upload both files to calculate the export.";
  useEffect(() => {
    if (downloadUrl) document.querySelectorAll<HTMLAnchorElement>('a[href^="blob:"]').forEach((link) => { link.download = `${bookName || "Book"}_export.zip`; });
  }, [downloadUrl, bookName]);

  async function runExport() {
    if (!pdf || !audio) {
      setError("Select both the PDF and audiobook before exporting.");
      return;
    }
    setProcessing(true);
    setError("");
    setDownloadUrl(null);
    const form = new FormData();
    form.append("pdf", pdf);
    form.append("audio", audio);
    form.append("mode", mode);
    form.append("minutes", String(minutes));
    form.append("template", selectedNaming.template);
    form.append("book_name", bookNameInput.trim());
    try {
      const response = await fetch("http://127.0.0.1:3001/api/process", { method: "POST", body: form });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "The processing job failed.");
      }
      setDownloadUrl(URL.createObjectURL(await response.blob()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The processing job failed.");
    } finally {
      setProcessing(false);
    }
  }

  return (
    <main className="site">
      <header className="nav"><div className="logo"><span>↗</span> chapter<span>.</span>cut</div><div className="nav-right"><a href="/reader">Open reader</a><span className="green-dot" /> Private workspace <button className="question">?</button></div></header>
      <div className="page">
        <section className="intro"><div><p className="overline">AUDIOBOOK PREP STUDIO</p><h1>Make a book<br /><span>easy to pick up.</span></h1><p className="lede">Upload two files. Set the rules. Get chapter-safe listening sessions with names you can actually understand.</p></div><div className="intro-badge"><strong>{hasSources ? "✓" : "—"}</strong><span>{hasSources ? "sources<br />ready" : "awaiting<br />sources"}</span></div></section>

        <div className="progress"><div className="progress-step current"><b>1</b><span>Sources</span></div><i /><div className="progress-step"><b>2</b><span>Chunking</span></div><i /><div className="progress-step"><b>3</b><span>Naming</span></div><i /><div className="progress-step"><b>4</b><span>Export</span></div></div>

        <section className="step-section"><div className="section-top"><div><small>STEP 01</small><h2>Bring your book in</h2></div><span className="step-note">PDF or EPUB + audiobook</span></div><div className="uploads"><UploadZone kind="Book" file={pdf} accept="application/pdf,.epub" onFile={setPdf} /><UploadZone kind="Audiobook" file={audio} accept="audio/*" onFile={setAudio} /></div><p className="privacy-note"><span>●</span> Files stay on this device during setup. Nothing is uploaded to a third-party service.</p></section>

        <section className="step-section"><div className="section-top"><div><small>STEP 02</small><h2>Choose the cut logic</h2></div><span className="step-note">Every cut follows a sentence boundary</span></div><div className="choice-row">
          <button className={`choice ${mode === "smart" ? "selected" : ""}`} onClick={() => setMode("smart")}><span className="choice-symbol">✦</span><span><b>Smart sessions</b><small>Target a duration, never mix chapters</small></span><em>{mode === "smart" ? "Selected" : ""}</em></button>
          <button className={`choice ${mode === "chapter" ? "selected" : ""}`} onClick={() => setMode("chapter")}><span className="choice-symbol">▥</span><span><b>Whole chapters</b><small>One MP3 per chapter, no time cuts</small></span><em>{mode === "chapter" ? "Selected" : ""}</em></button>
          <button className={`choice ${mode === "fixed" ? "selected" : ""}`} onClick={() => setMode("fixed")}><span className="choice-symbol">◷</span><span><b>Fixed intervals</b><small>Same length across the entire book</small></span><em>{mode === "fixed" ? "Selected" : ""}</em></button>
        </div>{mode !== "chapter" && <div className="duration-control"><div><b>{mode === "smart" ? "Session target" : "Interval length"}</b><strong>{minutes} min</strong></div><input type="range" min="5" max="30" step="5" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /><div className="ticks"><span>5</span><span>15</span><span>30 minutes</span></div></div>}<div className="rule-grid"><label><span><b>Lock chapter boundaries</b><small>No file contains two chapters</small></span><Switch value={chapterLock} onChange={setChapterLock} /></label><label><span><b>Move cuts toward silence</b><small>Find a natural pause nearby</small></span><Switch value={silence} onChange={setSilence} /></label><label><span><b>Soft fade at handoff</b><small>1.5s in and out to avoid clicks</small></span><Switch value={fade} onChange={setFade} /></label></div></section>

        <section className="step-section"><div className="section-top"><div><small>STEP 03</small><h2>Pick a naming pattern</h2></div><span className="step-note">Slash-style counts, made filesystem-safe</span></div><div className="naming-grid"><label className={`naming-card ${naming === "readable" ? "selected" : ""}`}><input type="radio" name="name" checked={naming === "readable"} onChange={() => setNaming("readable")} /><span><b>Readable default</b><small>Best for Finder, Explorer, and players</small><code>{bookName}__Ch01_of_10__Part_01_of_03__Book_01_of_{totalParts}.mp3</code></span></label><label className={`naming-card ${naming === "compact" ? "selected" : ""}`}><input type="radio" name="name" checked={naming === "compact"} onChange={() => setNaming("compact")} /><span><b>Compact</b><small>Short and sortable on mobile</small><code>{bookName}__C01_of_10__P1_of_3__B01_of_{totalParts}.mp3</code></span></label><label className={`naming-card ${naming === "chapter-first" ? "selected" : ""}`}><input type="radio" name="name" checked={naming === "chapter-first"} onChange={() => setNaming("chapter-first")} /><span><b>Chapter-first</b><small>Chapter is the first thing you see</small><code>Ch01_of_10__Part_01_of_03__{bookName}__Book_01_of_{totalParts}.mp3</code></span></label></div><p className="slash-note">Your example uses “/” as a visual separator. Actual filenames use <code>_of_</code> because “/” creates folders and breaks downloads on Windows and macOS.</p></section>

        <section className="export-panel"><div><small>STEP 04 · READY TO EXPORT</small><h2>{bookName} is set up.</h2><p>{mode === "chapter" ? "10 whole-chapter files" : `${totalParts} chapter-safe listening sessions`} · PDF pages will be tracked in the manifest.</p></div><div className="export-actions"><a href="/book-export.zip" download className="export-button">Download ZIP <span>↓</span></a><button className="secondary-button">Save preset</button></div></section>

        <section className="step-section naming-library"><div className="section-top"><div><small>STEP 03</small><h2>Pick a naming pattern</h2></div><span className="step-note">28 presets · symbol-led default</span></div><div className="format-picker"><label htmlFor="format">Filename style</label><select id="format" value={naming} onChange={(event) => setNaming(event.target.value)}>{["Symbol-led", "Compact", "Readable", "Chapter-first", "Visual separators"].map((group) => <optgroup label={group} key={group}>{namingOptions.filter((option) => option.group === group).map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</optgroup>)}</select><div className="format-preview"><small>Live example</small><code>{namePreview}</code></div></div><p className="slash-note">Your visual separators are preserved where filenames allow them. The patterns use <code>|</code>, <code>•</code>, <code>·</code>, brackets, and hyphens; the slash character itself is never used because it creates folders on Windows and macOS.</p></section>
        <section className="export-panel live-export"><div><small>STEP 04 · READY TO EXPORT</small><h2>{processing ? "Building your export…" : `${bookName} is set up.`}</h2><p>{error || (downloadUrl ? "Your fresh ZIP is ready to download." : `${mode === "chapter" ? "10 whole-chapter files" : `${totalParts} chapter-safe listening sessions`} · processed from your uploaded files.`)}</p></div><div className="export-actions">{downloadUrl ? <a href={downloadUrl} download="chapter-cut-export.zip" className="export-button">Download fresh ZIP <span>↓</span></a> : <button className="export-button" onClick={runExport} disabled={processing}>{processing ? "Processing…" : "Process & ZIP"} <span>{processing ? "…" : "↓"}</span></button>}<button className="secondary-button" onClick={() => { setDownloadUrl(null); setError(""); }}>Reset</button></div></section>
        <section className="chapter-strip fresh-chapter-strip"><div className="section-top"><div><small>AT A GLANCE</small><h2>Chapter map</h2></div><span className="step-note">{pdf ? "Analysis pending" : "No book selected"}</span></div><div className="chapter-empty">{pdf ? <><strong>{pdf.name}</strong><span>Chapter details will appear after the PDF is analyzed.</span></> : <><strong>Nothing to show yet.</strong><span>Upload a PDF to build its chapter map.</span></>}</div></section>
        <section className="step-section fresh-naming"><div className="section-top"><div><small>STEP 03</small><h2>Book name & filename style</h2></div><span className="step-note">Examples update as you choose</span></div><label className="book-name-field"><span>Book name</span><input value={bookNameInput} onChange={(event) => setBookNameInput(event.target.value)} placeholder="Book_Name" /></label><div className="format-picker"><label htmlFor="format-fresh">Filename style</label><select id="format-fresh" value={naming} onChange={(event) => setNaming(event.target.value)}>{["Symbol-led", "Compact", "Readable", "Chapter-first", "Visual separators"].map((group) => <optgroup label={group} key={group}>{namingOptions.filter((option) => option.group === group).map((option) => <option value={option.id} key={option.id}>{option.label} — {renderName(option.template, bookName || "Book_Name", totalParts)}</option>)}</optgroup>)}</select><div className="format-preview"><small>Live example</small><code>{namePreview}</code></div></div></section>
        <section className="export-panel fresh-export"><div><small>STEP 04 · READY TO EXPORT</small><h2>{hasSources ? `${bookName || "Your book"} is ready.` : "Waiting for your files."}</h2><p>{error || (downloadUrl ? "Your fresh ZIP is ready to download." : exportSummary)}</p></div><div className="export-actions">{downloadUrl ? <a href={downloadUrl} download="chapter-cut-export.zip" className="export-button">Download fresh ZIP <span>↓</span></a> : <button className="export-button" onClick={runExport} disabled={processing || !hasSources}>{processing ? "Processing…" : "Process & ZIP"} <span>{processing ? "…" : "↓"}</span></button>}<button className="secondary-button" onClick={() => { setDownloadUrl(null); setError(""); }}>Reset</button></div></section>
      </div>
      <footer><span>chapter.cut</span><span>PDF-aware audio tools for long-form listening</span><span>Local & private</span></footer>
    </main>
  );
}
