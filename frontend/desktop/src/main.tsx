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

type BatchBookState = { bookId: string; title: string; stage: string; workload: string; percent: number; message: string; uploadStage?: string; uploadPercent?: number };
type BatchUpdate = { type: "started" | "book" | "upload" | "scheduler" | "log" | "finished" | "warning"; books?: Array<{ bookId: string; title: string; audioFiles: number }>; bookId?: string; title?: string; stage?: string; workload?: string; percent?: number; message?: string; source?: string; gpuBook?: string | null; cpuBook?: string; queued?: number; success?: boolean; failures?: string[] };
type PipelineSnapshot = { supervisor: string; paused: boolean; headline?: string; gpu_book?: string | null; cpu_books?: string[]; upload_book?: string | null; events?: Array<{ created_at: string; level: string; stage: string; message: string }>; books: Array<{ job_id: string; title: string; state: string; stage: string; workload: string; percent: number; message: string; uploaded: number }> };

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
      chooseBatchFolder: () => Promise<string | null>;
      coverDataUrl: (filePath: string) => Promise<string>;
      startJob: (payload: Record<string, unknown>) => Promise<{ started: boolean; output: string }>;
      startBatch: (payload: Record<string, unknown>) => Promise<{ started: boolean; output: string }>;
      pipelineStatus: () => Promise<PipelineSnapshot>;
      pauseBatch: () => Promise<{ paused: boolean }>;
      cancelJob: () => Promise<{ cancelled: boolean }>;
      cancelBatch: () => Promise<{ paused: boolean }>;
      refreshLibrary: (payload: Record<string, unknown>) => Promise<Inventory>;
      publishBook: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
      openPath: (filePath: string) => Promise<string>;
      showItem: (filePath: string) => Promise<boolean>;
      onJobUpdate: (callback: (update: ProgressUpdate) => void) => () => void;
      onPublishUpdate: (callback: (update: ProgressUpdate) => void) => () => void;
      onBatchUpdate: (callback: (update: BatchUpdate) => void) => () => void;
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
  const [screen, setScreen] = useState<"create" | "pipeline" | "library">("create");
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
  const [batchFolder, setBatchFolder] = useState("D:\\Audiobooks\\__Ready");
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchPaused, setBatchPaused] = useState(false);
  const [batchAutoUpload, setBatchAutoUpload] = useState(true);
  const [batchBooks, setBatchBooks] = useState<Record<string, BatchBookState>>({});
  const [batchLogs, setBatchLogs] = useState<string[]>([]);
  const [batchStatus, setBatchStatus] = useState("Choose a source folder to scan and start.");
  const [batchGpu, setBatchGpu] = useState("Idle");

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

  useEffect(() => window.booksyncDesktop.onBatchUpdate((update) => {
    if (update.type === "started") {
      setBatchRunning(true); setBatchLogs([]); setBatchStatus(`Discovered ${update.books?.length || 0} book pairs.`);
      setBatchBooks(Object.fromEntries((update.books || []).map((item) => [item.bookId, { ...item, stage: "queued", workload: "queued", percent: 0, message: `${item.audioFiles} audio file${item.audioFiles === 1 ? "" : "s"}` }])));
    } else if (update.type === "book" && update.bookId) {
      setBatchBooks((current) => ({ ...current, [update.bookId!]: { ...(current[update.bookId!] || { bookId: update.bookId!, title: update.title || update.bookId! }), stage: update.stage || "processing", workload: update.workload || "cpu", percent: update.percent || 0, message: update.message || "Working" } }));
    } else if (update.type === "upload" && update.bookId) {
      setBatchBooks((current) => ({ ...current, [update.bookId!]: { ...(current[update.bookId!] || { bookId: update.bookId!, title: update.title || update.bookId!, stage: "complete", workload: "done", percent: 100, message: "Package ready" }), uploadStage: update.stage || "uploading", uploadPercent: update.percent || 0 } }));
    } else if (update.type === "scheduler") {
      setBatchGpu(update.gpuBook || "Transitioning to next book"); setBatchStatus(update.message || "Pipeline running");
    } else if (update.type === "log" || update.type === "warning") {
      setBatchLogs((current) => [...current, `[${update.source || update.type}] ${update.message || ""}`].slice(-250));
    } else if (update.type === "finished") {
      setBatchRunning(false); setBatchGpu("Idle"); setBatchStatus(update.message || (update.success ? "Pipeline complete" : "Pipeline stopped"));
      if (update.failures?.length) setBatchLogs((current) => [...current, ...update.failures!.map((item) => `[error] ${item}`)].slice(-250));
      void refreshLibrary(true);
    }
  }), [settings, token]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const snapshot = await window.booksyncDesktop.pipelineStatus();
        if (!active) return;
        const runningNow = ["running", "recovering", "starting"].includes(snapshot.supervisor);
        setBatchRunning(runningNow);
        setBatchPaused(snapshot.paused || snapshot.supervisor === "paused");
        setBatchGpu(snapshot.gpu_book || "Idle");
        setBatchStatus(snapshot.headline || `Pipeline ${snapshot.supervisor}`);
        if (snapshot.events?.length) setBatchLogs(snapshot.events.map((item) => `[${item.created_at}] [${item.stage}] ${item.message}`).slice(-250));
        if (snapshot.books.length) setBatchBooks(Object.fromEntries(snapshot.books.map((item) => [item.job_id, {
          bookId: item.job_id, title: item.title, stage: item.stage, workload: item.workload,
          percent: item.percent, message: item.message,
          uploadStage: item.uploaded ? "complete" : item.workload === "upload" ? item.stage : item.state === "staged" ? "queued" : undefined,
          uploadPercent: item.workload === "upload" ? Math.max(0, Math.min(100, (item.percent - 94) * 20)) : undefined,
        }])));
      } catch { /* transient status reads are retried */ }
    };
    void refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

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

  async function pickBatchFolder() {
    const selected = await window.booksyncDesktop.chooseBatchFolder();
    if (selected) setBatchFolder(selected);
  }

  async function runBatch() {
    if (!settings || !batchFolder) return;
    try {
      setBatchStatus("Starting folder discovery…");
      await window.booksyncDesktop.startBatch({ ...settings, sourceFolder: batchFolder, autoUpload: batchAutoUpload, token });
    } catch (error) {
      setBatchRunning(false); setBatchStatus(error instanceof Error ? error.message : "Could not start the pipeline.");
    }
  }

  async function pausePipeline() {
    await window.booksyncDesktop.pauseBatch();
    setBatchStatus("Pausing safely after checkpoint…");
    setBatchPaused(true);
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
        <button className={screen === "pipeline" ? "active" : ""} onClick={() => setScreen("pipeline")}><span>≋</span><b>Pipeline</b><em>{Object.keys(batchBooks).length || ""}</em></button>
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
        <div><p className="eyebrow">BOOKSYNC STUDIO</p><h1>{screen === "create" ? "Build a synchronized book" : screen === "pipeline" ? "Run your audiobook pipeline" : "Your complete library"}</h1></div>
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
      </> : screen === "pipeline" ? <>
        <section className="pipeline-hero">
          <div><p className="eyebrow">TANDEM PROCESSING</p><h2>One GPU lane. CPU work and uploads keep moving.</h2><p>Choose a folder where each EPUB/PDF sits beside its matching audiobook folder. Studio discovers the pairs, joins multi-part audio, resumes checkpoints, and starts the next transcription as soon as the GPU is released.</p></div>
          <span className={batchRunning ? "spinning-disc" : ""}>▶</span>
        </section>
        <section className="pipeline-controls">
          <button className={`pipeline-folder ${batchFolder ? "selected" : ""}`} onClick={pickBatchFolder}><span>⌂</span><div><small>SOURCE FOLDER</small><b>{batchFolder ? fileName(batchFolder) : "Choose audiobook collection"}</b><em>{batchFolder || "EPUB/PDF files beside matching audiobook folders"}</em></div><strong>Browse</strong></button>
          <label className="pipeline-token"><span>HF write token <em>used only by the upload lane</em></span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={health?.huggingface_authenticated ? "Using existing hf login" : "hf_…"} /></label>
          <label className="upload-toggle"><input type="checkbox" checked={batchAutoUpload} onChange={(event) => setBatchAutoUpload(event.target.checked)} /><span><b>Upload finished books automatically</b><small>One verified upload at a time, while processing continues.</small></span></label>
          <div className="pipeline-run"><button className="primary" disabled={!batchFolder || batchRunning || !health?.ready} onClick={runBatch}>{batchPaused ? "Resume from checkpoints" : batchRunning ? "Pipeline running…" : "Start tandem pipeline"}</button>{batchRunning && <button className="cancel" onClick={pausePipeline}>Pause safely</button>}</div>
        </section>
        <section className="workload-strip">
          <article><span className={batchRunning ? "live-dot" : ""}>GPU</span><div><small>TRANSCRIPTION LANE</small><b>{batchGpu}</b></div></article>
          <article><span>CPU</span><div><small>DOWNSTREAM WORK</small><b>{Object.values(batchBooks).filter((item) => item.workload === "cpu" && item.stage !== "complete").map((item) => item.title).join(", ") || "Idle"}</b></div></article>
          <article><span>↑</span><div><small>UPLOAD LANE</small><b>{Object.values(batchBooks).find((item) => item.uploadStage === "uploading")?.title || (batchAutoUpload ? "Watching packages" : "Off")}</b></div></article>
        </section>
        <section className="pipeline-live">
          <header><div><p className="eyebrow">LIVE PIPELINE</p><h3>{batchStatus}</h3></div><span>{Object.values(batchBooks).filter((item) => item.stage === "complete").length}/{Object.keys(batchBooks).length} packaged</span></header>
          <div className="pipeline-book-list">{Object.values(batchBooks).length ? Object.values(batchBooks).map((item) => <article key={item.bookId}><span className={`lane ${item.workload}`}>{item.stage === "complete" ? "✓" : item.workload === "gpu" ? "GPU" : item.workload === "cpu" ? "CPU" : "…"}</span><div><b>{item.title}</b><small>{item.message}</small><i><span style={{ width: `${Math.max(0, Math.min(100, item.percent))}%` }} /></i></div><em>{Math.round(item.percent)}%</em><strong className={`upload-state ${item.uploadStage || "waiting"}`}>{item.uploadStage === "complete" ? "Uploaded" : item.uploadStage === "uploading" ? `Upload ${Math.round(item.uploadPercent || 0)}%` : batchAutoUpload ? "Upload queued" : "Local only"}</strong></article>) : <div className="pipeline-empty">Books appear here as soon as folder discovery begins.</div>}</div>
          <div className="live-console"><header><b>Live log</b><span>{batchRunning ? "● streaming" : "○ stopped"}</span></header><pre>{batchLogs.length ? batchLogs.join("\n") : "Waiting for pipeline activity…"}</pre></div>
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
