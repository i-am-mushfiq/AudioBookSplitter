const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("booksyncDesktop", {
  getSettings: () => ipcRenderer.invoke("booksync:get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("booksync:save-settings", settings),
  health: () => ipcRenderer.invoke("booksync:health"),
  chooseBook: () => ipcRenderer.invoke("booksync:choose-book"),
  chooseAudio: () => ipcRenderer.invoke("booksync:choose-audio"),
  chooseCover: () => ipcRenderer.invoke("booksync:choose-cover"),
  chooseLibraryFolder: () => ipcRenderer.invoke("booksync:choose-library-folder"),
  coverDataUrl: (filePath) => ipcRenderer.invoke("booksync:cover-data-url", filePath),
  startJob: (payload) => ipcRenderer.invoke("booksync:start-job", payload),
  cancelJob: () => ipcRenderer.invoke("booksync:cancel-job"),
  refreshLibrary: (payload) => ipcRenderer.invoke("booksync:refresh-library", payload),
  publishBook: (payload) => ipcRenderer.invoke("booksync:publish-book", payload),
  openPath: (filePath) => ipcRenderer.invoke("booksync:open-path", filePath),
  showItem: (filePath) => ipcRenderer.invoke("booksync:show-item", filePath),
  onJobUpdate: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on("booksync:job-update", listener);
    return () => ipcRenderer.removeListener("booksync:job-update", listener);
  },
  onPublishUpdate: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on("booksync:publish-update", listener);
    return () => ipcRenderer.removeListener("booksync:publish-update", listener);
  },
});
