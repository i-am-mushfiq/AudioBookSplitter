import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./studio.css";

type Settings = {
  libraryFolder: string;
  repoId: string;
  minutes: string;
  mode: "smart" | "chapter";
  model: "tiny" | "base" | "small" | "medium" | "large-v3";
  device: "cuda" | "cpu";
};

type Health = {
  ready: boolean;
  python: string;
  python_version: string;
  ffmpeg: string | null;
  ffprobe: string | null;
  modules: Record<string, boolean>;
  huggingface_authenticated: boolean;
  environment: string | null;
};

type LibraryBook = {
  book_id: string;
  title: string;
  author?: string | null;
  chapters: number;
  duration_ms: number;
  local: boolean;
  remote: boolean;
  state: "local_only" | "synced" | "update_available" | "remote_only";
  package_path?: string | null;
  zip_path?: string | null;
  cover_path?: string | null;
  package_valid?: boolean | null;
};

type Inventory = {
  folder: string;
  repo_id: string;
  books: LibraryBook[];
  counts: { local: number; remote: number; synced: number; update_available: number; local_only: number; remote_only: number };
  warnings: string[];
  remote_error?: string | null;
};

type ProgressUpdate = {
  type: "started" | "progress" | "log" | "finished" | "failed";
  stage?: string;
  percent?: number;
  message?: string;
  text?: string;
  detail?: string;
  zipPath?: string;
  packagePath?: string;
  output?: string;
  bookId?: string;
};

declare global {
  interface Window {
    booksyncDesktop: {
      getSettings: () => Promise<Settings>;
      saveSettings: (settings: Settings) => Promise<Settings>;
      health: () => Promise<Health>;
      chooseBook: () => Promise<string | null>;
      chooseAudio: () => Promise<string | null>;
      chooseCover: () => Promise<string | null>;
      chooseLibraryFolder: () => Promise<string | null>;
      coverDataUrl: (filePath: string) => Promise<string>;
      startJob: (payload: Record<string, unknown>) => Promise<{ started: boolean; output: string }>;
      cancelJob: () => Promise<{ cancelled: boolean }>;
      refreshLibrary: (payload: Record<string, unknown>) => Promise<Inventory>;
      publishBook: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
      openPath: (filePath: string) => Promise<string>;
      showItem: (filePath: string) => Promise<boolean>;
      onJobUpdate: (callback: (update: ProgressUpdate) => void) => () => void;
      onPublishUpdate: (callback: (update: ProgressUpdate) => void) => () => void;
    };
  }
}

const EMPTY_COUNTS = { local: 0, remote: 0, synced: 0, update_available: 0, local_only: 0, remote_only: 0 };

function fileName(value: string) {
  return value.split(/[\\/]/).pop() || value;
}

function duration(value: number) {
  const minutes = Math.round(value / 60000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function sourceLabel(book: LibraryBook) {
  if (book.state === "synced") return "Local + cloud";
  if (book.state === "update_available") return "Cloud update ready";
  if (book.state === "remote_only") return "Cloud only";
  return "Local only";
}

function App() {
  if (!window.booksyncDesktop) return <main className="boot"><b>BookSync Studio could not connect to its desktop bridge.</b><small>Reinstall the current build. The interface loaded, but its secure preload component is missing.</small></main>;
  return <Studio />;
}

function Studio() {
  const [screen, setScreen] = useState<"create" | "library">("create");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [book, setBook] = useState("");
  const [audio, setAudio] = useState("");
  const [cover, setCover] = useState("");
  const [coverUrl, setCoverUrl] = useState("");
  const [bookName, setBookName] = useState("");
  const [job, setJob] = useState<ProgressUpdate>({ type: "progress", stage: "ready", percent: 0, message: "Choose the three source files to begin." });
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [cloudChecked, setCloudChecked] = useState(false);
  const [token, setToken] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [publishState, setPublishState] = useState<Record<string, ProgressUpdate>>({});
  const [libraryCovers, setLibraryCovers] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    Promise.all([window.booksyncDesktop.getSettings(), window.booksyncDesktop.health()]).then(async ([loadedSettings, loadedHealth]) => {
      if (!active) return;
      setSettings(loadedSettings);
      setHealth(loadedHealth);
      setLibraryBusy(true);
      try {
        const result = await window.booksyncDesktop.refreshLibrary({ ...loadedSettings, localOnly: !loadedHealth.huggingface_authenticated });
        if (active) {
          setInventory(result);
          setCloudChecked(loadedHealth.huggingface_authenticated);
        }
      } catch (error) {
        if (active) setLibraryError(error instanceof Error ? error.message : "Could not read the library folder.");
      } finally {
        if (active) setLibraryBusy(false);
      }
    }).catch((error) => setLibraryError(error instanceof Error ? error.message : "BookSync could not start."));
    return () => { active = false; };
  }, []);

  useEffect(() => window.booksyncDesktop.onJobUpdate((update) => {
    if (update.type === "started") {
      setRunning(true);
      setLogs([]);
      setJob(update);
    } else if (update.type === "progress") {
      setJob(update);
    } else if (update.type === "log" && update.text) {
      setLogs((current) => [...current, update.text!.trim()].filter(Boolean).slice(-80));
    } else if (update.type === "finished") {
      setRunning(false);
      setJob(update);
      void refreshLibrary(true);
    } else if (update.type === "failed") {
      setRunning(false);
      setJob(update);
      if (update.detail) setLogs((current) => [...current, update.detail!].slice(-80));
    }
  }), [settings, token]);

  useEffect(() => window.booksyncDesktop.onPublishUpdate((update) => {
    if (!update.bookId) return;
    setPublishState((current) => ({ ...current, [update.bookId!]: update }));
    if (update.type === "finished") void refreshLibrary(false);
  }), [settings, token]);

  useEffect(() => {
    let active = true;
    const next: Record<string, string> = {};
    Promise.all((inventory?.books || []).filter((item) => item.cover_path).map(async (item) => {
      try { next[item.book_id] = await window.booksyncDesktop.coverDataUrl(item.cover_path!); }
      catch { /* letter artwork remains available */ }
    })).then(() => { if (active) setLibraryCovers(next); });
    return () => { active = false; };
  }, [inventory]);

  const canBuild = Boolean(settings && health?.ready && book && audio && !running);
  const counts = inventory?.counts || EMPTY_COUNTS;
  const readinessProblems = health ? [
    !health.ffmpeg && "FFmpeg",
    !health.ffprobe && "FFprobe",
    ...Object.entries(health.modules).filter(([, ready]) => !ready).map(([name]) => name),
  ].filter(Boolean) as string[] : [];

  function updateSettings(patch: Partial<Settings>) {
    setSettings((current) => current ? { ...current, ...patch } : current);
  }

  async function pickBook() {
    const selected = await window.booksyncDesktop.chooseBook();
    if (!selected) return;
    setBook(selected);
    if (!bookName) setBookName(fileName(selected).replace(/\.(pdf|epub)$/i, ""));
  }

  async function pickAudio() {
    const selected = await window.booksyncDesktop.chooseAudio();
    if (selected) setAudio(selected);
  }

  async function pickCover() {
    const selected = await window.booksyncDesktop.chooseCover();
    if (!selected) return;
    setCover(selected);
    try { setCoverUrl(await window.booksyncDesktop.coverDataUrl(selected)); }
    catch { setCoverUrl(""); }
  }

  async function pickLibraryFolder() {
    const selected = await window.booksyncDesktop.chooseLibraryFolder();
    if (!selected || !settings) return;
    const next = { ...settings, libraryFolder: selected };
    setSettings(next);
    await window.booksyncDesktop.saveSettings(next);
    await refreshLibrary(true, next);
  }

  async function build() {
    if (!settings) return;
    try {
      setJob({ type: "progress", stage: "preparing", percent: 0, message: "Starting the processing engine…" });
      await window.booksyncDesktop.startJob({ ...settings, book, audio, cover, bookName });
    } catch (error) {
      setJob({ type: "failed", message: error instanceof Error ? error.message : "Could not start processing." });
    }
  }

  async function refreshLibrary(localOnly = false, suppliedSettings = settings) {
    if (!suppliedSettings) return;
    setLibraryBusy(true);
    setLibraryError("");
    try {
      const result = await window.booksyncDesktop.refreshLibrary({ ...suppliedSettings, token, localOnly });
      setInventory(result);
      setCloudChecked(!localOnly && !result.remote_error);
      if (result.remote_error && !localOnly) setLibraryError(result.remote_error);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "Could not refresh the library.");
    } finally {
      setLibraryBusy(false);
    }
  }

  async function upload(item: LibraryBook) {
    if (!settings || !item.package_path) return;
    try {
      await window.booksyncDesktop.publishBook({ ...settings, token, bookId: item.book_id, packagePath: item.package_path });
    } catch (error) {
      setPublishState((current) => ({ ...current, [item.book_id]: { type: "failed", message: error instanceof Error ? error.message : "Upload failed." } }));
    }
  }

  if (!settings) return <main className="boot"><span className="spinner" /><b>Opening BookSync Studio…</b>{libraryError && <small>{libraryError}</small>}</main>;

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">B</span><span><b>BookSync</b><small>STUDIO</small></span></div>
      <nav aria-label="Main navigation">
        <button className={screen === "create" ? "active" : ""} onClick={() => setScreen("create")}><span>＋</span><b>Create</b></button>
        <button className={screen === "library" ? "active" : ""} onClick={() => setScreen("library")}><span>▦</span><b>Library</b><em>{counts.local + counts.remote}</em></button>
      </nav>
      <div className={`engine-card ${health?.ready ? "ready" : "blocked"}`}>
        <span />
        <div><b>{health?.ready ? "Processor ready" : "Setup needed"}</b><small>{health?.ready ? `${health.environment || "Python"} · ${settings.device.toUpperCase()}` : `${readinessProblems.join(", ")} missing`}</small></div>
      </div>
      <p className="sidebar-foot">Local-first processing.<br />Private cloud sync when you choose.</p>
    </aside>

    <section className="workspace">
      <header className="topbar">
        <div><p className="eyebrow">BOOKSYNC STUDIO</p><h1>{screen === "create" ? "Build a synchronized book" : "Your complete library"}</h1></div>
        <button className="folder-button" onClick={pickLibraryFolder}><span>⌂</span><span><small>LIBRARY FOLDER</small><b>{fileName(settings.libraryFolder)}</b></span><em>Change</em></button>
      </header>

      {!health?.ready && <section className="setup-warning"><b>The processing engine is not ready.</b><span>Install the Conda environment and FFmpeg, then reopen Studio. Missing: {readinessProblems.join(", ") || "health check unavailable"}.</span><code>{health?.python || "Python was not found"}</code></section>}

      {screen === "create" ? <>
        <section className="intro-card">
          <div><p className="eyebrow">ONE RUN · TWO READY OUTPUTS</p><h2>From source files to a book you can read, listen to, and stream.</h2><p>Studio creates the portable reader ZIP and the expanded, validated server package together.</p></div>
          <div className="output-pair"><span><b>.ZIP</b><small>Import anywhere</small></span><i>＋</i><span><b>.BOOKSYNC</b><small>Upload ready</small></span></div>
        </section>

        <section className="source-grid">
          <button className={`source-card cover-card ${cover ? "selected" : ""}`} onClick={pickCover}>
            <span className="source-index">01</span>
            <span className="cover-preview">{coverUrl ? <img src={coverUrl} alt="Selected cover" /> : <b>＋</b>}</span>
            <span className="source-copy"><small>BOOK COVER · OPTIONAL</small><b>{cover ? fileName(cover) : "Choose cover"}</b><em>JPG, PNG, or WebP</em></span>
          </button>
          <button className={`source-card ${book ? "selected" : ""}`} onClick={pickBook}>
            <span className="source-index">02</span><span className="source-icon">Aa</span>
            <span className="source-copy"><small>READING SOURCE</small><b>{book ? fileName(book) : "Choose EPUB or PDF"}</b><em>{book || "The exact edition used by the narrator"}</em></span>
          </button>
          <button className={`source-card ${audio ? "selected" : ""}`} onClick={pickAudio}>
            <span className="source-index">03</span><span className="source-icon">♪</span>
            <span className="source-copy"><small>AUDIOBOOK</small><b>{audio ? fileName(audio) : "Choose audiobook"}</b><em>{audio || "MP3, M4A, M4B, FLAC, WAV, OGG, and more"}</em></span>
          </button>
        </section>

        <section className="build-layout">
          <section className="settings-panel">
            <div className="section-heading"><div><p className="eyebrow">PROCESSING OPTIONS</p><h3>Shape the listening experience</h3></div><span>Chapter boundaries stay absolute</span></div>
            <label className="text-field"><span>Book name</span><input value={bookName} onChange={(event) => setBookName(event.target.value)} placeholder="Uses the EPUB/PDF filename when blank" /></label>
            <div className="option-row">
              <div className="option-group"><span>Division</span><div className="segmented"><button className={settings.mode === "smart" ? "chosen" : ""} onClick={() => updateSettings({ mode: "smart" })}>Timed sessions</button><button className={settings.mode === "chapter" ? "chosen" : ""} onClick={() => updateSettings({ mode: "chapter" })}>Whole chapters</button></div></div>
              {settings.mode === "smart" && <div className="option-group"><span>Target length</span><div className="segmented compact">{[5, 10, 15, 20, 30].map((value) => <button key={value} className={settings.minutes === String(value) ? "chosen" : ""} onClick={() => updateSettings({ minutes: String(value) })}>{value}m</button>)}</div></div>}
            </div>
            <div className="option-row">
              <div className="option-group"><span>Engine</span><div className="segmented"><button className={settings.device === "cuda" ? "chosen" : ""} onClick={() => updateSettings({ device: "cuda" })}>NVIDIA GPU</button><button className={settings.device === "cpu" ? "chosen" : ""} onClick={() => updateSettings({ device: "cpu" })}>CPU</button></div></div>
              <label className="select-field"><span>Accuracy / speed</span><select value={settings.model} onChange={(event) => updateSettings({ model: event.target.value as Settings["model"] })}><option value="tiny">Tiny · fastest</option><option value="base">Base</option><option value="small">Small · recommended</option><option value="medium">Medium</option><option value="large-v3">Large v3 · slowest</option></select></label>
            </div>
            <div className="save-destination"><span>Outputs save to</span><b>{settings.libraryFolder}</b><button onClick={pickLibraryFolder}>Change folder</button></div>
          </section>

          <section className={`progress-panel ${running ? "running" : ""} ${job.type === "finished" ? "complete" : ""} ${job.type === "failed" ? "failed" : ""}`}>
            <div className="progress-top"><span>{job.type === "finished" ? "✓" : job.type === "failed" ? "!" : running ? "↻" : "→"}</span><div><small>{(job.stage || job.type || "ready").replaceAll("_", " ").toUpperCase()}</small><b>{job.message || "Ready to process"}</b></div><em>{Math.round(job.percent || 0)}%</em></div>
            <div className="progress-track"><i style={{ width: `${Math.max(0, Math.min(100, job.percent || 0))}%` }} /></div>
            {job.type === "finished" ? <div className="results">
              <button onClick={() => job.zipPath && window.booksyncDesktop.showItem(job.zipPath)}><span>.ZIP</span><b>Reader package</b><small>{job.zipPath && fileName(job.zipPath)}</small></button>
              <button onClick={() => job.packagePath && window.booksyncDesktop.openPath(job.packagePath)}><span>☁</span><b>Server-ready folder</b><small>{job.packagePath && fileName(job.packagePath)}</small></button>
            </div> : <div className="progress-actions"><button className="primary" disabled={!canBuild} onClick={build}>{running ? "Processing…" : "Build BookSync package"}</button>{running && <button className="cancel" onClick={() => window.booksyncDesktop.cancelJob()}>Cancel</button>}</div>}
            {logs.length > 0 && <details className="activity"><summary>Technical activity</summary><pre>{logs.join("\n")}</pre></details>}
          </section>
        </section>
      </> : <>
        <section className="library-controls">
          <div className="library-location"><small>SCANNING</small><b>{settings.libraryFolder}</b><span>Expanded packages and portable BookSync ZIPs</span></div>
          <label className="token-field"><span>Hugging Face write token <em>Not saved</em></span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={health?.huggingface_authenticated ? "Using your existing hf login" : "Paste a fine-grained token to compare or upload"} /></label>
          <button className="sync-button" disabled={libraryBusy} onClick={() => refreshLibrary(false)}>{libraryBusy ? "Checking…" : "Compare with cloud"}</button>
        </section>

        <section className="summary-grid">
          <article><span className="summary-icon local">⌂</span><div><small>IN THIS FOLDER</small><b>{counts.local}</b><em>local books</em></div></article>
          <article><span className="summary-icon synced">✓</span><div><small>FULLY SYNCED</small><b>{counts.synced}</b><em>local + cloud</em></div></article>
          <article><span className="summary-icon upload">↑</span><div><small>READY TO SEND</small><b>{counts.local_only + counts.update_available}</b><em>new or updated</em></div></article>
          <article><span className="summary-icon cloud">☁</span><div><small>CLOUD ONLY</small><b>{counts.remote_only}</b><em>not in this folder</em></div></article>
        </section>

        {libraryError && <p className="library-error"><b>Cloud comparison unavailable.</b> {libraryError}</p>}
        {!cloudChecked && !libraryError && <p className="library-note">Showing local books. Select <b>Compare with cloud</b> to classify synced and cloud-only titles.</p>}
        {(inventory?.warnings || []).length > 0 && <details className="warnings"><summary>{inventory!.warnings.length} local item(s) could not be read</summary><ul>{inventory!.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}

        <section className="book-list">
          <div className="book-list-heading"><span>BOOK</span><span>LOCATION</span><span>PACKAGE</span><span>ACTION</span></div>
          {libraryBusy && !inventory ? <div className="library-empty"><span className="spinner" /><b>Reading your BookSync library…</b></div> : inventory?.books.length ? inventory.books.map((item) => {
            const uploadState = publishState[item.book_id];
            return <article className="book-row" key={item.book_id}>
              <div className="book-identity"><span className="book-cover">{libraryCovers[item.book_id] ? <img src={libraryCovers[item.book_id]} alt="" /> : <b>{item.title.trim().slice(0, 1).toUpperCase()}</b>}{item.remote && <i title="Available from Hugging Face">☁</i>}</span><span><b>{item.title}</b><small>{item.author || "Unknown author"}</small><em>{item.chapters} chapters · {duration(item.duration_ms)}</em></span></div>
              <span className={`location-pill ${item.state}`}>{sourceLabel(item)}</span>
              <span className="package-state">{item.package_path ? <><b>{item.package_valid === false ? "Needs review" : "Server ready"}</b><small>Expanded .booksync</small></> : item.zip_path ? <><b>Reader ZIP only</b><small>Reprocess to upload</small></> : <><b>Remote package</b><small>Streams on demand</small></>}</span>
              <div className="row-actions">
                {(item.state === "local_only" || item.state === "update_available") && item.package_path ? <button className="upload-button" disabled={uploadState?.type === "started" || uploadState?.type === "progress" || item.package_valid === false} onClick={() => upload(item)}>{uploadState?.type === "started" || uploadState?.type === "progress" ? `${Math.round(uploadState.percent || 0)}%` : item.state === "update_available" ? "Update cloud" : "Send to cloud"}</button> : item.state === "synced" ? <span className="done-action">✓ Synced</span> : item.state === "remote_only" ? <span className="cloud-action">Stream only</span> : null}
                {(item.package_path || item.zip_path) && <button className="more-button" title="Show local file" onClick={() => window.booksyncDesktop.showItem(item.package_path || item.zip_path!)}>•••</button>}
                {uploadState?.type === "failed" && <small className="upload-error" title={uploadState.message}>Upload failed</small>}
              </div>
            </article>;
          }) : <div className="library-empty"><span>＋</span><b>No processed BookSync books found</b><small>Create a package or choose a different library folder.</small><button onClick={() => setScreen("create")}>Create your first book</button></div>}
        </section>
      </>}
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
