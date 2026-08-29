import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, promises as fs, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextWatchdogDelay, shouldRestartPipeline } from "./pipeline-watchdog.mjs";

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));
const EVENT_PREFIX = "BOOKSYNC_EVENT ";
const RESULT_PREFIX = "BOOKSYNC_RESULT ";
const BATCH_EVENT_PREFIX = "BOOKSYNC_BATCH_EVENT ";
const DEFAULT_REPO = "mdrahman/booksync-library";
const BOOK_EXTENSIONS = new Set([".pdf", ".epub"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".m4b", ".aac", ".wav", ".flac", ".ogg", ".opus", ".wma", ".mp4"]);
const COVER_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

let mainWindow;
let runningJob;
let runningPublish;
let runningBatch;
let batchRestartTimer;
let batchGeneration = 0;
let appQuitting = false;

function coreDirectory() {
  return app.isPackaged ? path.join(process.resourcesPath, "booksync-core") : path.resolve(desktopDirectory, "..", "..");
}

function rendererFile() {
  return app.isPackaged
    ? path.join(app.getAppPath(), "desktop-app-dist", "index.html")
    : path.resolve(desktopDirectory, "..", "desktop-app-dist", "index.html");
}

function defaultLibraryFolder() {
  return path.join(app.getPath("downloads"), "BookSync");
}

function pipelinePaths() {
  const requestedWorkspace = path.resolve(process.env.BOOKSYNC_WORKSPACE || "C:\\Personal_Endeavours\\BookSync2");
  const workspace = existsSync(requestedWorkspace) ? requestedWorkspace : path.join(app.getPath("userData"), "pipeline-workspace");
  return {
    source: "D:\\Audiobooks\\__Ready",
    processed: "D:\\Audiobooks\\__Processed",
    inHuggingFace: "D:\\Audiobooks\\__in_hugging_face",
    output: path.join(workspace, "local-data", "books", "raw_processing"),
    uploadReady: path.join(workspace, "local-data", "books", "upload_ready"),
    state: path.join(workspace, "local-data", "books", ".pipeline-state"),
  };
}

function settingsFile() {
  return path.join(app.getPath("userData"), "studio-settings.json");
}

function safeSettings(value = {}) {
  const folder = typeof value.libraryFolder === "string" && value.libraryFolder.trim()
    ? path.resolve(value.libraryFolder)
    : defaultLibraryFolder();
  const repoId = typeof value.repoId === "string" && /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(value.repoId.trim())
    ? value.repoId.trim()
    : DEFAULT_REPO;
  return {
    libraryFolder: folder,
    repoId,
    minutes: ["5", "10", "15", "20", "30"].includes(String(value.minutes)) ? String(value.minutes) : "10",
    mode: ["smart", "chapter"].includes(value.mode) ? value.mode : "smart",
    model: ["tiny", "base", "small", "medium", "large-v3"].includes(value.model) ? value.model : "small",
    device: value.device === "cpu" ? "cpu" : "cuda",
  };
}

async function loadSettings() {
  try {
    return safeSettings(JSON.parse(await fs.readFile(settingsFile(), "utf8")));
  } catch {
    return safeSettings();
  }
}

async function saveSettings(value) {
  const settings = safeSettings(value);
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
  return settings;
}

function pythonCandidates() {
  const userProfile = process.env.USERPROFILE || "";
  const condaRoots = [path.join(userProfile, "miniconda3", "envs"), path.join(userProfile, "anaconda3", "envs")];
  return [
    process.env.BOOKSYNC_PYTHON,
    path.join(coreDirectory(), ".venv", "Scripts", "python.exe"),
    ...condaRoots.flatMap((root) => ["booksync", "pdf-audiobook-splitter", "animal-farm-splitter"].map((name) => path.join(root, name, "python.exe"))),
    "python.exe",
    "python",
  ].filter(Boolean);
}

function resolvePython() {
  return pythonCandidates().find((candidate) => !path.isAbsolute(candidate) || existsSync(candidate)) || "python.exe";
}

function publish(channel, update) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, update);
}

function parseLines(onLine) {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) onLine(line);
    },
    finish() { if (pending) onLine(pending); pending = ""; },
  };
}

function runBridge(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolvePython(),
      [path.join(coreDirectory(), "tools", "booksync_desktop_bridge.py"), ...args],
      { cwd: coreDirectory(), windowsHide: true, env: { ...process.env, ...env } },
    );
    let result;
    let details = "";
    const stdout = parseLines((line) => {
      if (line.startsWith(RESULT_PREFIX)) {
        try { result = JSON.parse(line.slice(RESULT_PREFIX.length)); }
        catch { details += `${line}\n`; }
      } else if (line.trim()) details += `${line}\n`;
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => { details = `${details}${chunk}`.slice(-20000); });
    child.on("error", reject);
    child.on("close", (code) => {
      stdout.finish();
      if (code === 0 && result) resolve(result);
      else reject(new Error(details.trim() || `BookSync helper stopped with code ${code}.`));
    });
  });
}

function ensureFile(filePath, extensions, label, optional = false) {
  if (optional && !filePath) return null;
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error(`Choose ${label}.`);
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) throw new Error(`${label} can no longer be found.`);
  if (!extensions.has(path.extname(resolved).toLowerCase())) throw new Error(`${label} has an unsupported file type.`);
  return resolved;
}

async function selectFile(name, extensions) {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"], filters: [{ name, extensions }] });
  return result.canceled ? null : result.filePaths[0];
}

async function selectLibraryFolder() {
  const settings = await loadSettings();
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: settings.libraryFolder,
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
}

async function selectBatchFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose the folder containing EPUB/PDF files and neighbouring audiobook folders",
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
}

async function coverDataUrl(filePath) {
  const resolved = ensureFile(filePath, COVER_EXTENSIONS, "a cover image");
  const stat = await fs.stat(resolved);
  if (stat.size > 20 * 1024 * 1024) throw new Error("Cover image is larger than 20 MB.");
  const mime = path.extname(resolved).toLowerCase() === ".png" ? "image/png" : path.extname(resolved).toLowerCase() === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${(await fs.readFile(resolved)).toString("base64")}`;
}

function terminateTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
  else child.kill("SIGTERM");
}

async function startJob(payload) {
  if (runningJob || runningBatch || batchRestartTimer) throw new Error("A BookSync processing pipeline is already running.");
  const book = ensureFile(payload?.book, BOOK_EXTENSIONS, "a PDF or EPUB");
  const audio = ensureFile(payload?.audio, AUDIO_EXTENSIONS, "an audiobook");
  const cover = ensureFile(payload?.cover, COVER_EXTENSIONS, "a JPG, PNG, or WebP cover", true);
  const settings = safeSettings(payload);
  const output = path.resolve(settings.libraryFolder);
  await fs.mkdir(output, { recursive: true });
  await saveSettings(settings);
  const args = [
    path.join(coreDirectory(), "pdf_audiobook_splitter.py"),
    "--book", book,
    "--audio", audio,
    "--output", output,
    "--model", settings.model,
    "--device", settings.device,
    "--minutes", settings.minutes,
    "--mode", settings.mode,
    "--resume",
  ];
  if (cover) args.push("--cover", cover);
  if (typeof payload.bookName === "string" && payload.bookName.trim()) args.push("--book-name", payload.bookName.trim());

  publish("booksync:job-update", { type: "started", stage: "preparing", percent: 0, message: "Starting the BookSync processor", output });
  const child = spawn(resolvePython(), args, { cwd: coreDirectory(), windowsHide: true });
  runningJob = child;
  let details = "";
  let finalEvent;
  const stdout = parseLines((line) => {
    if (line.startsWith(EVENT_PREFIX)) {
      try {
        const event = JSON.parse(line.slice(EVENT_PREFIX.length));
        finalEvent = event.stage === "complete" ? event : finalEvent;
        publish("booksync:job-update", { type: "progress", ...event });
        return;
      } catch { /* show malformed lines in details */ }
    }
    if (line.trim()) {
      details = `${details}${line}\n`.slice(-24000);
      publish("booksync:job-update", { type: "log", text: line });
    }
  });
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    details = `${details}${text}`.slice(-24000);
    publish("booksync:job-update", { type: "log", text });
  });
  child.on("error", (error) => publish("booksync:job-update", { type: "failed", message: `Could not start Python: ${error.message}` }));
  child.on("close", (code) => {
    stdout.finish();
    runningJob = undefined;
    if (code === 0 && finalEvent?.booksync_zip && finalEvent?.booksync_package) {
      publish("booksync:job-update", {
        type: "finished",
        percent: 100,
        message: "Reader ZIP and server-ready package are complete",
        zipPath: path.resolve(finalEvent.booksync_zip),
        packagePath: path.resolve(finalEvent.booksync_package),
        output,
      });
    } else if (code !== 0) {
      publish("booksync:job-update", { type: "failed", message: code === null ? "Processing was cancelled." : `Processing stopped with code ${code}.`, detail: details });
    } else {
      publish("booksync:job-update", { type: "failed", message: "Processing ended without returning its package paths.", detail: details });
    }
  });
  return { started: true, output };
}

async function startBatch(payload) {
  if (runningJob || runningBatch || batchRestartTimer) throw new Error("A BookSync processing pipeline is already running.");
  if (typeof payload?.sourceFolder !== "string" || !payload.sourceFolder.trim()) throw new Error("Choose the batch source folder.");
  const sourceFolder = path.resolve(payload.sourceFolder);
  if (!existsSync(sourceFolder)) throw new Error("The batch source folder can no longer be found.");
  const settings = safeSettings(payload);
  await fs.mkdir(settings.libraryFolder, { recursive: true });
  await saveSettings(settings);
  const paths = pipelinePaths();
  await fs.rm(path.join(paths.state, "PAUSE"), { force: true });
  await fs.rm(path.join(paths.uploadReady, ".upload-state", "STOP"), { force: true });
  const args = [
    path.join(coreDirectory(), "tools", "booksync_pipeline_supervisor.py"), "resume",
    "--source", sourceFolder,
    "--processed", paths.processed,
    "--in-hugging-face", paths.inHuggingFace,
    "--output", paths.output,
    "--upload-ready", paths.uploadReady,
    "--destination", settings.libraryFolder,
    "--state-dir", paths.state,
    "--model", settings.model,
    "--device", settings.device,
    "--minutes", settings.minutes,
    "--mode", settings.mode,
    "--repo", settings.repoId,
  ];
  args.push(payload?.autoUpload === false ? "--no-auto-upload" : "--auto-upload");
  const env = { ...process.env, ...(typeof payload?.token === "string" && payload.token.trim() ? { HF_TOKEN: payload.token.trim() } : {}) };
  const generation = ++batchGeneration;
  launchBatchAttempt({ args, env, generation, attempt: 0 });
  return { started: true, sourceFolder, output: paths.output };
}

async function appendWatchdogAudit(event, details = {}) {
  try {
    const state = pipelinePaths().state;
    await fs.mkdir(state, { recursive: true });
    await fs.appendFile(path.join(state, "desktop-watchdog.jsonl"),
      `${JSON.stringify({ created_at: new Date().toISOString(), event, ...details })}\n`, "utf8");
  } catch (error) {
    console.error("Could not persist pipeline watchdog event:", error);
  }
}

async function readPipelineTerminalState() {
  try {
    const value = JSON.parse(await fs.readFile(path.join(pipelinePaths().state, "pipeline-status.json"), "utf8"));
    return typeof value.supervisor === "string" ? value.supervisor : "unknown";
  } catch {
    return "unknown";
  }
}

function launchBatchAttempt(context) {
  const pauseMarker = path.join(pipelinePaths().state, "PAUSE");
  if (context.generation !== batchGeneration || appQuitting) return;
  const startedAt = Date.now();
  const child = spawn(resolvePython(), context.args, { cwd: coreDirectory(), windowsHide: true, env: context.env });
  runningBatch = child;
  let details = "";
  const onLine = (line) => {
    if (line.startsWith(BATCH_EVENT_PREFIX)) {
      try { publish("booksync:batch-update", JSON.parse(line.slice(BATCH_EVENT_PREFIX.length))); return; }
      catch { /* retain malformed event in the visible log */ }
    }
    if (line.trim()) {
      details = `${details}${line}\n`.slice(-40000);
      publish("booksync:batch-update", { type: "log", source: "Pipeline", message: line });
    }
  };
  const stdout = parseLines(onLine);
  const stderr = parseLines(onLine);
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", (error) => { details = `${details}${error.stack || error.message}\n`.slice(-40000); });
  child.on("close", async (code) => {
    stdout.finish(); stderr.finish(); runningBatch = undefined;
    const paused = existsSync(pauseMarker);
    const terminalState = await readPipelineTerminalState();
    const stableRun = Date.now() - startedAt >= 5 * 60 * 1000;
    const attempt = stableRun ? 0 : context.attempt;
    if (context.generation !== batchGeneration) {
      await appendWatchdogAudit("controller_superseded", { exit_code: code, terminal_state: terminalState });
      return;
    }
    if (shouldRestartPipeline({ exitCode: code, paused, quitting: appQuitting, terminalState, attempt })) {
      const delay = nextWatchdogDelay(attempt);
      const nextAttempt = attempt + 1;
      await appendWatchdogAudit("restart_scheduled", { exit_code: code, terminal_state: terminalState,
        attempt: nextAttempt, delay_ms: delay, details: details.slice(-8000) });
      publish("booksync:batch-update", { type: "warning", source: "Watchdog",
        message: `Controller stopped unexpectedly; recovering from checkpoints in ${Math.round(delay / 1000)}s (${nextAttempt}/5).` });
      batchRestartTimer = setTimeout(() => {
        batchRestartTimer = undefined;
        launchBatchAttempt({ ...context, attempt: nextAttempt });
      }, delay);
      return;
    }
    await appendWatchdogAudit("controller_closed", { exit_code: code, terminal_state: terminalState,
      paused, quitting: appQuitting, details: details.slice(-8000) });
    if (code !== 0 && code !== 2 && !["complete", "attention", "waiting_upload"].includes(terminalState)) {
      publish("booksync:batch-update", { type: "finished", success: false,
        failures: [details.trim() || `Pipeline stopped with code ${code}.`],
        message: context.attempt >= 5 ? "Pipeline watchdog exhausted; manual attention required" : "Pipeline stopped" });
    }
  });
}

async function pipelineStatus() {
  const statusFile = path.join(pipelinePaths().state, "pipeline-status.json");
  try {
    const value = JSON.parse(await fs.readFile(statusFile, "utf8"));
    const age = Date.now() - Date.parse(value.updated_at || 0);
    if (["running", "recovering", "starting"].includes(value.supervisor) && (!Number.isFinite(age) || age > 15000)) {
      return { ...value, supervisor: "interrupted", paused: true, headline: "Previous run was interrupted; resume from checkpoints" };
    }
    return value;
  }
  catch { return { supervisor: "stopped", paused: false, books: [], counts: {}, gpu_book: null, cpu_books: [], upload_book: null }; }
}

async function pauseBatch() {
  if (batchRestartTimer) {
    clearTimeout(batchRestartTimer);
    batchRestartTimer = undefined;
  }
  batchGeneration += 1;
  const paths = pipelinePaths();
  await fs.mkdir(paths.state, { recursive: true });
  await fs.writeFile(path.join(paths.state, "PAUSE"), new Date().toISOString(), "utf8");
  const uploadState = path.join(paths.uploadReady, ".upload-state");
  await fs.mkdir(uploadState, { recursive: true });
  await fs.writeFile(path.join(uploadState, "STOP"), new Date().toISOString(), "utf8");
  await appendWatchdogAudit("pause_requested");
  return { paused: true };
}

async function refreshLibrary(payload) {
  const settings = safeSettings(payload);
  await fs.mkdir(settings.libraryFolder, { recursive: true });
  await saveSettings(settings);
  const args = ["inventory", "--folder", settings.libraryFolder, "--repo", settings.repoId, "--revision", "main"];
  if (payload?.localOnly) args.push("--local-only");
  return runBridge(args, typeof payload?.token === "string" && payload.token.trim() ? { HF_TOKEN: payload.token.trim() } : {});
}

async function publishBook(payload) {
  if (runningPublish) throw new Error("A package is already being uploaded.");
  if (typeof payload?.packagePath !== "string") throw new Error("Choose an expanded .booksync package to upload.");
  const packagePath = path.resolve(payload.packagePath);
  if (path.extname(packagePath).toLowerCase() !== ".booksync" || !existsSync(path.join(packagePath, "manifest.json"))) throw new Error("Only an expanded, validated .booksync package can be uploaded.");
  const settings = safeSettings(payload);
  const args = [path.join(coreDirectory(), "tools", "publish_huggingface_package.py"), packagePath, "--repo", settings.repoId, "--revision", "main"];
  const env = { ...process.env, ...(typeof payload.token === "string" && payload.token.trim() ? { HF_TOKEN: payload.token.trim() } : {}) };
  publish("booksync:publish-update", { type: "started", bookId: payload.bookId, packagePath, message: "Validating package before upload", percent: 0 });
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePython(), args, { cwd: coreDirectory(), windowsHide: true, env });
    runningPublish = child;
    let details = "";
    let completed;
    const stdout = parseLines((line) => {
      if (line.startsWith(EVENT_PREFIX)) {
        try {
          const event = JSON.parse(line.slice(EVENT_PREFIX.length));
          if (event.stage === "complete") completed = event;
          publish("booksync:publish-update", { type: "progress", bookId: payload.bookId, ...event });
          return;
        } catch { /* keep line as diagnostic text */ }
      }
      if (line.trim()) {
        details = `${details}${line}\n`.slice(-24000);
        publish("booksync:publish-update", { type: "log", bookId: payload.bookId, text: line });
      }
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      details = `${details}${text}`.slice(-24000);
      publish("booksync:publish-update", { type: "log", bookId: payload.bookId, text });
    });
    child.on("error", reject);
    child.on("close", (code) => {
      stdout.finish();
      runningPublish = undefined;
      if (code === 0 && completed) {
        publish("booksync:publish-update", { type: "finished", bookId: payload.bookId, ...completed });
        resolve(completed);
      } else {
        const error = new Error(details.trim() || `Upload stopped with code ${code}.`);
        publish("booksync:publish-update", { type: "failed", bookId: payload.bookId, message: error.message });
        reject(error);
      }
    });
  });
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workAreaSize;
  // Cap the logical design size, but account for Windows display scaling when
  // the runtime reports physical work-area pixels.
  const scale = Math.max(1, display.scaleFactor);
  mainWindow = new BrowserWindow({
    width: Math.min(workArea.width - 30, Math.round(1400 * scale)),
    height: Math.min(workArea.height - 30, Math.round(900 * scale)),
    minWidth: Math.min(workArea.width, Math.round(840 * scale)),
    minHeight: Math.min(workArea.height, Math.round(480 * scale)),
    show: false,
    backgroundColor: "#0b0b0b",
    title: "BookSync Studio",
    webPreferences: {
      preload: path.join(desktopDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`Preload failed: ${preloadPath}`, error);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer process stopped:", details);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    dialog.showErrorBox("BookSync Studio could not open", `${description} (${code})\n\nExpected interface: ${rendererFile()}`);
  });
  mainWindow.loadFile(rendererFile()).catch((error) => dialog.showErrorBox("BookSync Studio could not open", error.message));
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await fs.mkdir(defaultLibraryFolder(), { recursive: true });
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", () => {
  appQuitting = true;
  batchGeneration += 1;
  if (batchRestartTimer) clearTimeout(batchRestartTimer);
  if (runningBatch) {
    try {
      const paths = pipelinePaths();
      mkdirSync(paths.state, { recursive: true });
      writeFileSync(path.join(paths.state, "PAUSE"), new Date().toISOString(), "utf8");
      const uploadState = path.join(paths.uploadReady, ".upload-state");
      mkdirSync(uploadState, { recursive: true });
      writeFileSync(path.join(uploadState, "STOP"), new Date().toISOString(), "utf8");
    } catch (error) {
      console.error("Could not persist pipeline pause during application shutdown:", error);
    }
  }
  terminateTree(runningJob);
  terminateTree(runningPublish);
  terminateTree(runningBatch);
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

ipcMain.handle("booksync:get-settings", () => loadSettings());
ipcMain.handle("booksync:save-settings", (_event, value) => saveSettings(value));
ipcMain.handle("booksync:health", () => runBridge(["health"]));
ipcMain.handle("booksync:choose-book", () => selectFile("Books", ["pdf", "epub"]));
ipcMain.handle("booksync:choose-audio", () => selectFile("Audiobooks", [...AUDIO_EXTENSIONS].map((item) => item.slice(1))));
ipcMain.handle("booksync:choose-cover", () => selectFile("Book covers", ["jpg", "jpeg", "png", "webp"]));
ipcMain.handle("booksync:choose-library-folder", () => selectLibraryFolder());
ipcMain.handle("booksync:choose-batch-folder", () => selectBatchFolder());
ipcMain.handle("booksync:cover-data-url", (_event, filePath) => coverDataUrl(filePath));
ipcMain.handle("booksync:start-job", (_event, payload) => startJob(payload));
ipcMain.handle("booksync:start-batch", (_event, payload) => startBatch(payload));
ipcMain.handle("booksync:pipeline-status", () => pipelineStatus());
ipcMain.handle("booksync:pause-batch", () => pauseBatch());
ipcMain.handle("booksync:cancel-job", () => { terminateTree(runningJob); return { cancelled: Boolean(runningJob) }; });
ipcMain.handle("booksync:cancel-batch", () => pauseBatch());
ipcMain.handle("booksync:refresh-library", (_event, payload) => refreshLibrary(payload));
ipcMain.handle("booksync:publish-book", (_event, payload) => publishBook(payload));
ipcMain.handle("booksync:open-path", async (_event, filePath) => shell.openPath(path.resolve(filePath)));
ipcMain.handle("booksync:show-item", (_event, filePath) => { shell.showItemInFolder(path.resolve(filePath)); return true; });
