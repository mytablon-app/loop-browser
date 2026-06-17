// Loop Browser — Electron shell (built fresh; nothing from agent-loop).
// Glass UI, lean tab manager, browser-wide theme, loading bar.
// CDP 9222 so the CLI engine drives the active tab.

const { app, BrowserWindow, WebContentsView, ipcMain, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");

app.setName("Loop Browser");
app.commandLine.appendSwitch("remote-debugging-port", "9222"); // CLI↔browser marriage

// Identify as plain Chrome. Electron's default UA includes "Electron/…" + the app
// name, which UA-sniffing sites (WhatsApp, etc.) reject. We ARE Chromium — say so.
app.userAgentFallback =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

const TOOLBAR_H = 88; // 36 tab strip + 52 address row (see ui/toolbar.html)
const HOME = path.join(__dirname, "ui", "home.html");
const ICON = path.join(__dirname, "assets", "loop-dock-icon.png");
const DARK = "#0a0e1a";
const LIGHT = "#f5f6fb";
const themeFile = () => path.join(app.getPath("userData"), "loop-theme.json");

let win, toolbar, theme = "dark";
const tabs = []; // [{ id, view }]
let activeId = 0;
let nextId = 1;

const active = () => tabs.find((t) => t.id === activeId);
const isHome = (wc) => wc.getURL().includes("ui/home.html");

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  toolbar.setBounds({ x: 0, y: 0, width: w, height: TOOLBAR_H });
  const a = active();
  if (a) a.view.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: Math.max(0, h - TOOLBAR_H) });
}

function sendTabs() {
  if (!toolbar || toolbar.webContents.isDestroyed()) return;
  toolbar.webContents.send("tabs", {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.view.webContents.getTitle() || "New Tab",
      active: t.id === activeId,
    })),
  });
  sendState();
}

function sendState() {
  const a = active();
  if (!a || !toolbar || toolbar.webContents.isDestroyed()) return;
  const wc = a.view.webContents;
  const url = wc.getURL();
  toolbar.webContents.send("state", {
    url: url.startsWith("file://") ? "" : url,
    canBack: wc.navigationHistory.canGoBack(),
    canFwd: wc.navigationHistory.canGoForward(),
  });
}

// ── browser-wide theme ───────────────────────────────────────────────
function applyTheme(wc) {
  wc.executeJavaScript(
    `document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`
  ).catch(() => {});
}
function broadcastTheme() {
  if (toolbar && !toolbar.webContents.isDestroyed()) toolbar.webContents.send("theme", theme);
  for (const t of tabs) if (isHome(t.view.webContents)) applyTheme(t.view.webContents);
}
function setTheme(next) {
  theme = next === "light" || next === "dark" ? next : theme === "dark" ? "light" : "dark";
  try { fs.writeFileSync(themeFile(), JSON.stringify({ theme })); } catch {}
  broadcastTheme();
}

function newTab(url) {
  const view = new WebContentsView();
  view.setBackgroundColor(theme === "light" ? LIGHT : DARK);
  const id = nextId++;
  tabs.push({ id, view });
  win.contentView.addChildView(view);
  const wc = view.webContents;
  url ? wc.loadURL(url) : wc.loadFile(HOME, { query: { theme } }); // new tab inherits theme
  wc.on("did-navigate", sendTabs);
  wc.on("did-navigate-in-page", sendState);
  wc.on("page-title-updated", sendTabs);
  wc.on("did-finish-load", () => { sendTabs(); if (isHome(wc)) applyTheme(wc); });
  const loading = (v) => {
    if (id === activeId && toolbar && !toolbar.webContents.isDestroyed())
      toolbar.webContents.send("loading", v);
  };
  wc.on("did-start-loading", () => loading(true));
  wc.on("did-stop-loading", () => loading(false));
  wc.setWindowOpenHandler(({ url: u }) => {
    newTab(u && u !== "about:blank" ? u : undefined); // popups → new tab
    return { action: "deny" };
  });
  activate(id);
}

function activate(id) {
  if (!tabs.some((t) => t.id === id)) return;
  activeId = id;
  for (const t of tabs) t.view.setVisible(t.id === id);
  win.contentView.addChildView(toolbar); // keep toolbar on top
  layout();
  sendTabs();
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  win.contentView.removeChildView(t.view);
  if (!tabs.length) return newTab();
  if (activeId === id) activate(tabs[Math.max(0, i - 1)].id);
  else sendTabs();
}

function createWindow() {
  const { width: screenW, height: screenH } = require("electron").screen.getPrimaryDisplay().workAreaSize;
  // Glass is OS-specific. macOS = vibrancy + inset traffic-lights + transparent bg.
  // Windows = acrylic material + a hidden titlebar with a window-controls overlay.
  // Guard the mac-only options so the SAME codebase builds & renders safely on both.
  // (Windows path written here but untested on Windows — verify on a Win build/CI.)
  const isMac = process.platform === "darwin";
  win = new BrowserWindow({
    width: screenW,
    height: screenH,
    title: "Loop Browser",
    icon: ICON,
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 18, y: 20 },
          vibrancy: "under-window",
          visualEffectState: "active",
          backgroundColor: "#00000000",
        }
      : {
          titleBarStyle: "hidden",
          titleBarOverlay: { color: "#0b1120", symbolColor: "#e9eef7", height: 36 },
          backgroundMaterial: "acrylic", // Win 11 glass; falls back to solid on older Windows
          backgroundColor: "#0b1120",
        }),
  });
  win.webContents.loadURL("about:blank"); // root CDP target init (prevents connectOverCDP hang)

  toolbar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, "ui", "preload.js") },
  });
  toolbar.setBackgroundColor("#00000000");
  win.contentView.addChildView(toolbar);
  toolbar.webContents.loadFile(path.join(__dirname, "ui", "toolbar.html"));
  toolbar.webContents.once("did-finish-load", () => {
    toolbar.webContents.send("theme", theme);
    newTab();
  });

  win.maximize();
  layout();
  win.on("resize", layout);
}

ipcMain.on("nav", (_e, action, value) => {
  const a = active();
  if (!a) return;
  const wc = a.view.webContents;
  if (action === "go") {
    const u = (value || "").trim();
    if (!u) return;
    const isUrl = /^https?:\/\//i.test(u) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(u);
    wc.loadURL(
      isUrl
        ? /^https?:/i.test(u) ? u : "https://" + u
        : "https://www.google.com/search?q=" + encodeURIComponent(u)
    );
  } else if (action === "back") {
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  } else if (action === "forward") {
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  } else if (action === "reload") {
    wc.reload();
  } else if (action === "home") {
    wc.loadFile(HOME, { query: { theme } });
  }
});

ipcMain.on("tab", (_e, action, id) => {
  if (action === "new") newTab();
  else if (action === "activate") activate(id);
  else if (action === "close") closeTab(id);
});

ipcMain.on("theme", () => setTheme());

app.whenReady().then(() => {
  try { theme = JSON.parse(fs.readFileSync(themeFile(), "utf8")).theme || "dark"; } catch {}
  if (process.platform === "darwin") {
    const ic = nativeImage.createFromPath(ICON);
    if (!ic.isEmpty()) app.dock.setIcon(ic);
  }
  createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
