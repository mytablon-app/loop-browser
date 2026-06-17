// Minimal bridge for the splash: lets the "Open anyway" button (shown only when a
// required check fails) tell main to reveal Loop Browser regardless.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("loopSplash", {
  continue: () => ipcRenderer.send("splash-continue"),
});
