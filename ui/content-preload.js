// Preload for CONTENT tabs (the websites LB drives).
//
// A WebContentsView has no owner BrowserWindow, so Electron's built-in native
// JavaScript dialogs (window.confirm / alert / prompt) can't anchor and are
// silently auto-dismissed — confirm() returns false, so confirm-based buttons
// do nothing (e.g. npm's "Delete the token?" → Confirm). We bridge them to the
// main process here and show a real native dialog attached to the window.
//
// contextIsolation stays ON (secure): we only expose a tiny sync bridge; a
// main-world shim (injected from main on dom-ready) re-points the page's native
// dialog functions at it. ipcRenderer.sendSync blocks the renderer, matching the
// real blocking semantics of window.confirm/alert/prompt.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__loopDialogs", {
  alert:   (message)      => ipcRenderer.sendSync("loop-dialog", { type: "alert",   message: String(message ?? "") }),
  confirm: (message)      => ipcRenderer.sendSync("loop-dialog", { type: "confirm", message: String(message ?? "") }),
  prompt:  (message, def) => ipcRenderer.sendSync("loop-dialog", { type: "prompt",  message: String(message ?? ""), default: def == null ? "" : String(def) }),
});
