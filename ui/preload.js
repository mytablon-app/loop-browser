// Safe bridge between the glass toolbar UI and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("loop", {
  go: (url) => ipcRenderer.send("nav", "go", url),
  back: () => ipcRenderer.send("nav", "back"),
  forward: () => ipcRenderer.send("nav", "forward"),
  reload: () => ipcRenderer.send("nav", "reload"),
  home: () => ipcRenderer.send("nav", "home"),
  tabNew: () => ipcRenderer.send("tab", "new"),
  tabActivate: (id) => ipcRenderer.send("tab", "activate", id),
  tabClose: (id) => ipcRenderer.send("tab", "close", id),
  themeToggle: () => ipcRenderer.send("theme"),
  onState: (cb) => ipcRenderer.on("state", (_e, s) => cb(s)),
  onTabs: (cb) => ipcRenderer.on("tabs", (_e, d) => cb(d.tabs)),
  onLoading: (cb) => ipcRenderer.on("loading", (_e, v) => cb(v)),
  onTheme: (cb) => ipcRenderer.on("theme", (_e, t) => cb(t)),
  onUpdate: (cb) => ipcRenderer.on("update-available", (_e, d) => cb(d)),
  openUpdate: () => ipcRenderer.send("open-update"),
});
