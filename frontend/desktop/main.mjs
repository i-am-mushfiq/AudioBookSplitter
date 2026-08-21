import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));
const EVENT_PREFIX = "BOOKSYNC_EVENT ";
const RESULT_PREFIX = "BOOKSYNC_RESULT ";
const DEFAULT_REPO = "mdrahman/booksync-library";
const BOOK_EXTENSIONS = new Set([".pdf", ".epub"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".m4b", ".aac", ".wav", ".flac", ".ogg", ".opus", ".wma", ".mp4"]);
const COVER_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

let mainWindow;
let runningJob;
let runningPublish;

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
  if (runningJob) throw new Error("A book is already being processed.");
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
  terminateTree(runningJob);
  terminateTree(runningPublish);
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

ipcMain.handle("booksync:get-settings", () => loadSettings());
ipcMain.handle("booksync:save-settings", (_event, value) => saveSettings(value));
ipcMain.handle("booksync:health", () => runBridge(["health"]));
ipcMain.handle("booksync:choose-book", () => selectFile("Books", ["pdf", "epub"]));
ipcMain.handle("booksync:choose-audio", () => selectFile("Audiobooks", [...AUDIO_EXTENSIONS].map((item) => item.slice(1))));
ipcMain.handle("booksync:choose-cover", () => selectFile("Book covers", ["jpg", "jpeg", "png", "webp"]));
ipcMain.handle("booksync:choose-library-folder", () => selectLibraryFolder());
ipcMain.handle("booksync:cover-data-url", (_event, filePath) => coverDataUrl(filePath));
ipcMain.handle("booksync:start-job", (_event, payload) => startJob(payload));
ipcMain.handle("booksync:cancel-job", () => { terminateTree(runningJob); return { cancelled: Boolean(runningJob) }; });
ipcMain.handle("booksync:refresh-library", (_event, payload) => refreshLibrary(payload));
ipcMain.handle("booksync:publish-book", (_event, payload) => publishBook(payload));
ipcMain.handle("booksync:open-path", async (_event, filePath) => shell.openPath(path.resolve(filePath)));
ipcMain.handle("booksync:show-item", (_event, filePath) => { shell.showItemInFolder(path.resolve(filePath)); return true; });
