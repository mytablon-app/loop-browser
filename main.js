// Loop Browser — Electron shell (built fresh; nothing from agent-loop).
// Glass UI, lean tab manager, browser-wide theme, loading bar.
// CDP 9222 so the CLI engine drives the active tab.

const { app, BrowserWindow, WebContentsView, ipcMain, nativeImage, dialog, clipboard, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const net = require("net");

app.setName("Loop Browser");
process.title = "Loop Browser";   // process listings (the main process) say Loop Browser, not "Electron"

// Per-instance isolation. LOOP_CDP_PORT sets the CDP port (default 9222); LOOP_PROFILE_DIR sets the
// data/login dir. Give each instance a DISTINCT profile dir + port to run several independent browsers
// side by side — one per account/site, each commanded by its own terminal, no intersection. The
// single-instance lock is keyed to userData, so a distinct profile dir is what lets two instances
// coexist (same profile always single-locks, regardless of port). Set userData BEFORE the lock check.
const CDP_PORT = process.env.LOOP_CDP_PORT || "9222";
if (process.env.LOOP_PROFILE_DIR) app.setPath("userData", path.resolve(process.env.LOOP_PROFILE_DIR));

// Single instance per profile. A second launch on the SAME profile would collide on the CDP port
// ("bind() failed: Address already in use"); only the lock-holder claims the port, a loser just
// focuses the running window and quits. Distinct profile + port → independent instances.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.commandLine.appendSwitch("remote-debugging-port", CDP_PORT); // CLI↔browser marriage
  app.on("second-instance", () => {
    const w = win && !win.isDestroyed() ? win : BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  });
}

// Identify as plain Chrome. Electron's default UA includes "Electron/…" + the app
// name, which UA-sniffing sites (WhatsApp, etc.) reject. We ARE Chromium — say so.
app.userAgentFallback =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

const TOOLBAR_H = 88; // 36 tab strip + 52 address row (see ui/toolbar.html)
const HOME = path.join(__dirname, "ui", "home.html");
const VERSION = require("./package.json").version;
// "About Loop Browser" instead of "About Electron" (the menu/About panel when running unpackaged).
app.setAboutPanelOptions({ applicationName: "Loop Browser", applicationVersion: VERSION, version: "" });
const DOWNLOAD_URL = "https://loop-browser.vercel.app"; // where app users grab the new DMG/EXE
const ICON = path.join(__dirname, "assets", "loop-dock-icon.png");
const DARK = "#0a0e1a";
const LIGHT = "#f5f6fb";
const themeFile = () => path.join(app.getPath("userData"), "loop-theme.json");

let win, toolbar, splash, theme = "dark";
let shownMain = false; // first-paint guard: splash → main happens once
let homeReady = false; // the home tab has finished loading
let checksReady = false; // pre-flight requirement checks have passed/cleared
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
    tabs: tabs
      .filter((t) => t.view && t.view.webContents && !t.view.webContents.isDestroyed())
      .map((t) => ({
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

// Re-point the page's native dialogs at the bridged (working) ones — runs in the
// page's main world on every load, since each navigation resets window.confirm.
const PATCH_DIALOGS = `(()=>{const d=window.__loopDialogs;if(!d)return;
  window.alert=(m)=>{d.alert(m);};
  window.confirm=(m)=>!!d.confirm(m);
  window.prompt=(m,v)=>d.prompt(m,v);})();`;

// Rate-limit page-initiated tab opens (window.open / target=_blank) so a hostile
// or buggy page can't spawn tabs in a loop. Max 5 in any rolling 3s.
let _tabOpenTimes = [];
function allowTabOpen() {
  const now = Date.now();
  _tabOpenTimes = _tabOpenTimes.filter((t) => now - t < 3000);
  if (_tabOpenTimes.length >= 5) return false;
  _tabOpenTimes.push(now);
  return true;
}

function newTab(url) {
  const view = new WebContentsView({
    // content-preload bridges window.confirm/alert/prompt to the main process
    // (a WebContentsView has no owner window for Electron's native dialogs).
    webPreferences: { preload: path.join(__dirname, "ui", "content-preload.js") },
  });
  // Real web pages assume a WHITE default background (CSS default). Our dark theme
  // color is only right for the local home tab — using it for websites makes any
  // unpainted region bleed dark navy through the page (LinkedIn's hero, etc.).
  const homeBg = () => (theme === "light" ? LIGHT : DARK);
  view.setBackgroundColor(url ? "#ffffff" : homeBg());
  const id = nextId++;
  tabs.push({ id, view });
  win.contentView.addChildView(view);
  const wc = view.webContents;
  url ? wc.loadURL(url) : wc.loadFile(HOME, { query: { theme } }); // new tab inherits theme
  // Keep the base background matched to what's loading: white for web pages,
  // theme color for our own home tab (so it doesn't bleed dark through sites).
  wc.on("did-start-navigation", (_e, navUrl, _ip, isMain) => {
    if (isMain) view.setBackgroundColor(navUrl.includes("ui/home.html") ? homeBg() : "#ffffff");
  });
  const flagActive = () => wc.executeJavaScript(`window.__loopActiveTab=${id === activeId}`, true).catch(() => {});
  wc.on("did-navigate", () => { sendTabs(); flagActive(); }); // re-assert ASAP after a navigation clears the page global
  wc.on("did-navigate-in-page", sendState);
  wc.on("page-title-updated", sendTabs);
  wc.on("did-finish-load", () => { sendTabs(); if (isHome(wc)) applyTheme(wc); homeReady = true; tryReveal(); flagActive(); });
  const loading = (v) => {
    if (id === activeId && toolbar && !toolbar.webContents.isDestroyed())
      toolbar.webContents.send("loading", v);
  };
  wc.on("did-start-loading", () => loading(true));
  wc.on("did-stop-loading", () => loading(false));
  wc.on("dom-ready", () => { wc.executeJavaScript(PATCH_DIALOGS, true).catch(() => {}); flagActive(); }); // earliest reliable re-assert (≈ domcontentloaded, when `loop open` returns)
  wc.setWindowOpenHandler(({ url: u }) => {
    // Only let a page open a normal web tab — never file:/javascript:/data:/etc. —
    // and rate-limit so a hostile page can't tab-bomb the window.
    const web = /^https?:\/\//i.test(u || "");
    if ((web || !u || u === "about:blank") && allowTabOpen()) newTab(web ? u : undefined);
    return { action: "deny" };
  });
  // Browser keyboard shortcuts — handled in main so they work even when a website
  // (not the toolbar) has focus: ⌘/Ctrl+T new tab, +W close tab, +L focus address bar.
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown" || !(process.platform === "darwin" ? input.meta : input.control)) return;
    const k = (input.key || "").toLowerCase();
    if (k === "t") { e.preventDefault(); newTab(); }
    else if (k === "w") { e.preventDefault(); closeTab(activeId); }
    else if (k === "l") { e.preventDefault(); toolbar.webContents.focus(); toolbar.webContents.send("focus-addr"); }
  });
  // If this tab's web-contents is destroyed out from under us (e.g. closed over
  // CDP, which bypasses closeTab), prune it from tabs[] so sendTabs/activate never
  // touch a dead view. Idempotent with closeTab (findIndex<0 → no-op).
  wc.on("destroyed", () => {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    // NOTE: do NOT removeChildView here — the webContents is already destroyed and
    // touching the view trips a native CHECK (SIGTRAP crash). Pruning tabs[] is enough;
    // Electron reclaims the detached view. (removeChildView is only safe in closeTab,
    // where the view is still alive.)
    tabs.splice(i, 1);
    if (!win || win.isDestroyed()) return; // tearing down — don't respawn/activate into a dying window
    if (!tabs.length) return newTab();
    if (activeId === id) activate(tabs[Math.max(0, i - 1)].id);
    else sendTabs();
  });
  activate(id);
}

function activate(id) {
  if (!tabs.some((t) => t.id === id)) return;
  if (!win || win.isDestroyed()) return; // app tearing down (destroyed events fire during quit) — do nothing
  activeId = id;
  for (const t of tabs) {
    try {
      const wc = t.view && t.view.webContents;
      if (wc && !wc.isDestroyed()) {
        t.view.setVisible(t.id === id);
        // Mark the active tab so the CLI (activePage) drives the tab you're looking
        // at, not just the first one — lets you keep several sites open at once.
        wc.executeJavaScript(`window.__loopActiveTab=${t.id === id}`, true).catch(() => {});
      }
    } catch (_) {}
  }
  try {
    if (toolbar && toolbar.webContents && !toolbar.webContents.isDestroyed())
      win.contentView.addChildView(toolbar); // keep toolbar on top
    layout();
    sendTabs();
  } catch (_) {}
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  win.contentView.removeChildView(t.view);
  // Detaching the view is not enough — the webContents lives on as an invisible
  // "hidden shell" (leaks memory + can confuse the CLI's activePage). Destroy it.
  try { t.view.webContents.close(); } catch (_) {}
  if (!tabs.length) return newTab();
  if (activeId === id) activate(tabs[Math.max(0, i - 1)].id);
  else sendTabs();
}

// ── pre-flight requirement checks (run at startup, shown on the splash) ──
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a command in the user's LOGIN shell so we see their real PATH (nvm, claude,
// etc.) — a GUI-launched Electron app otherwise gets a stripped-down PATH.
function sh(cmd, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(process.env.SHELL || "/bin/zsh", ["-lc", cmd], { timeout }, (err, stdout) =>
      resolve({ ok: !err, out: (stdout || "").trim() })
    );
  });
}

// Is something listening on a local port? (the CLI↔browser CDP bridge)
function portOpen(port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(timeout, () => { s.destroy(); resolve(false); });
  });
}

// Each check: { id, label, required, run() → {status:'ok'|'warn'|'fail', detail} }
const CHECKS = [
  {
    id: "node", label: "Node.js", required: false,
    run: async () => {
      // Packaged app ships its own Node (Electron-as-Node runs the bundled CLI),
      // so a system Node is NOT required for end users — only for dev/npm.
      if (app.isPackaged) return { status: "ok", detail: "bundled" };
      const r = await sh("node --version");
      const major = +((r.out.match(/v(\d+)/) || [])[1] || 0);
      if (r.ok && major >= 18) return { status: "ok", detail: r.out };
      if (r.ok && major) return { status: "warn", detail: `${r.out} — want v18+` };
      return { status: "warn", detail: "not found (dev only)" };
    },
  },
  {
    id: "browser", label: "Browser engine", required: true,
    run: async () => ({ status: "ok", detail: "Chrome " + process.versions.chrome.split(".")[0] }),
  },
  {
    id: "bridge", label: "CLI bridge · :" + CDP_PORT, required: true,
    run: async () =>
      (await portOpen(Number(CDP_PORT)))
        ? { status: "ok", detail: "connected" }
        : { status: "fail", detail: "not reachable" },
  },
  {
    id: "claude", label: "Claude Code", required: false,
    run: async () => {
      const r = await sh("command -v claude");
      return r.ok && r.out
        ? { status: "ok", detail: "connected" }
        : { status: "warn", detail: "optional — authoring/healing only" };
    },
  },
];

async function runChecks() {
  const call = (js) => {
    if (splash && !splash.isDestroyed()) splash.webContents.executeJavaScript(js).catch(() => {});
  };
  let failedRequired = false;
  const total = CHECKS.length;
  for (let i = 0; i < total; i++) {
    const c = CHECKS[i];
    call(`addCheck(${JSON.stringify(c.id)}, ${JSON.stringify(c.label)})`);
    await wait(260); // let the "checking…" row land before it resolves — visible to the eye
    let res;
    try { res = await c.run(); } catch { res = { status: "fail", detail: "check errored" }; }
    call(`setCheck(${JSON.stringify(c.id)}, ${JSON.stringify(res.status)}, ${JSON.stringify(res.detail || "")})`);
    setProgress(0.2 + 0.7 * ((i + 1) / total), null);
    if (c.required && res.status === "fail") failedRequired = true;
    await wait(420); // deliberate pacing between ticks
  }
  call(`summary(${!failedRequired})`);
  if (failedRequired) return; // hold the splash up; user reveals via "Open anyway"
  await wait(450);
  checksReady = true;
  tryReveal();
}

// LB is revealed only when BOTH the home tab is loaded AND checks have cleared.
function tryReveal() {
  if (homeReady && checksReady) revealMain();
}

// First run (packaged app only): show the user a ONE-LINE command to add `loop`
// to their terminal, and offer to copy it. NO admin prompt — the app writes
// nothing to the system; the user runs the command themselves (it just appends a
// PATH line to their shell rc, pointing at the bundled launcher = Electron-as-Node,
// so no separate Node/repo is needed). They stay fully in control.
function maybeInstallCli() {
  if (!app.isPackaged) return; // dev uses `npm link`
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  const flag = path.join(app.getPath("userData"), ".loop-cli-asked");
  try { if (fs.existsSync(flag)) return; } catch {}
  // The bundled launcher dir lives at resources/app/bin on BOTH platforms
  // (POSIX `loop` shim on macOS, `loop.cmd` on Windows — both run cli.mjs via
  // the app's own Electron-as-Node, so no separate Node/repo is needed).
  const bin = path.join(process.resourcesPath, "app", "bin");
  let cmd, detail;
  if (process.platform === "win32") {
    // Append the bin dir to the USER PATH (no admin, persistent, no setx truncation).
    // `loop` then resolves to loop.cmd via PATHEXT. User opens a new terminal after.
    cmd =
      `powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', ` +
      `[Environment]::GetEnvironmentVariable('Path','User') + ';${bin}', 'User')"`;
    detail =
      "Loop Browser is ready. To run automations from any terminal (loop run …), " +
      "add the loop command to your PATH — paste this into PowerShell once, then open a new window:\n\n" +
      cmd +
      "\n\nNo admin needed and nothing changes automatically — you run it yourself.";
  } else {
    const shell = process.env.SHELL || "/bin/zsh";
    const rc = shell.includes("zsh") ? "~/.zshrc" : shell.includes("bash") ? "~/.bash_profile" : "~/.profile";
    cmd = `echo 'export PATH="$PATH:${bin}"' >> ${rc}`;
    detail =
      "Loop Browser is ready. To run automations from any terminal (loop run …), " +
      "add the loop command to your shell — paste this into Terminal once, then open a new tab:\n\n" +
      cmd +
      "\n\nNo password needed and nothing changes automatically — you run it yourself.";
  }
  dialog.showMessageBox({
    type: "info",
    buttons: ["Copy command", "Maybe later"],
    defaultId: 0, cancelId: 1,
    title: "Loop Browser",
    message: "Use “loop” in your terminal",
    detail,
  }).then(({ response }) => {
    try { fs.writeFileSync(flag, "1"); } catch {} // ask only once, whatever they pick
    if (response === 0) { try { clipboard.writeText(cmd); } catch {} }
  }).catch(() => {});
}

// ── splash: instant feedback while Electron + first tab boot ─────────
function createSplash() {
  splash = new BrowserWindow({
    width: 400, height: 380, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, center: true,
    show: false, // show only once painted — avoids an empty transparent flash
    backgroundColor: "#00000000", title: "Loop Browser",
    webPreferences: { preload: path.join(__dirname, "ui", "splash-preload.js") },
  });
  splash.loadFile(path.join(__dirname, "ui", "splash.html"));
  splash.webContents.once("did-finish-load", () => {
    splash.webContents.executeJavaScript(`setTheme(${JSON.stringify(theme)})`).catch(() => {});
  });
  // ready-to-show fires after the splash's first paint. ONLY THEN do we build the
  // heavy LB window + run the requirement checks — so the splash is guaranteed on
  // screen first, and everything else happens behind it. (The splash starts LB.)
  splash.once("ready-to-show", () => {
    if (splash && !splash.isDestroyed()) splash.show();
    setProgress(0.2, "Checking requirements…");
    createWindow();
    runChecks();
  });
}

// "Open anyway" from the splash when a required check failed — user has seen why.
ipcMain.on("splash-continue", () => {
  checksReady = true;
  if (!win) createWindow(); // safety: if LB was never built
  tryReveal();
});
function setProgress(p, label) {
  if (splash && !splash.isDestroyed())
    splash.webContents
      .executeJavaScript(`setProgress(${p}, ${JSON.stringify(label || "")})`)
      .catch(() => {});
}
function revealMain() {
  if (shownMain) return;
  shownMain = true;
  setProgress(1, "Ready");
  // Reveal the fully-loaded browser, THEN drop the splash — main paints under the
  // splash's brief fade, so the swap reads as one smooth step (no empty flash).
  if (win && !win.isDestroyed()) {
    win.show(); // already at full work-area bounds — no maximize() reflow
    win.focus();
  }
  if (splash && !splash.isDestroyed()) {
    splash.webContents.executeJavaScript("finish()").catch(() => {});
    const s = splash;
    splash = null;
    setTimeout(() => { if (!s.isDestroyed()) s.close(); }, 280);
  }
  setTimeout(maybeInstallCli, 1200); // offer the `loop` CLI once the app is visible
}

function createWindow() {
  // Use the full work-area BOUNDS (position + size), not maximize(). Creating the
  // window pre-sized means zero reflow at reveal — maximize() resizes the window
  // the instant it appears, exposing a frame of bare grey vibrancy before content.
  const { x: waX, y: waY, width: screenW, height: screenH } =
    require("electron").screen.getPrimaryDisplay().workArea;
  // Glass is OS-specific. macOS = vibrancy + inset traffic-lights + transparent bg.
  // Windows = acrylic material + a hidden titlebar with a window-controls overlay.
  // Guard the mac-only options so the SAME codebase builds & renders safely on both.
  // (Windows path written here but untested on Windows — verify on a Win build/CI.)
  const isMac = process.platform === "darwin";
  win = new BrowserWindow({
    x: waX,
    y: waY,
    width: screenW,
    height: screenH,
    title: "Loop Browser",
    icon: ICON,
    show: false, // stay hidden until the first tab is ready — no flash of empty glass
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
    setProgress(0.55, "Loading…");
    toolbar.webContents.send("theme", theme);
    newTab();
    setTimeout(checkForUpdate, 4000); // non-blocking: nudge if a newer version is published
  });

  layout(); // size the views now; the window itself stays hidden until revealMain()
  win.on("resize", layout);

  // Safety net for a stalled page load: force the home side ready. This still
  // respects the checks gate — a failed required check keeps holding the splash
  // until the user explicitly chooses "Open anyway".
  setTimeout(() => { homeReady = true; tryReveal(); }, 8000);
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

// Native JS dialogs for content tabs (bridged from content-preload.js, since a
// WebContentsView has no owner window for Electron's built-in dialogs). Shown
// attached to the root window; sync so window.confirm/alert/prompt block as usual.
ipcMain.on("loop-dialog", (event, opts) => {
  const { type, message } = opts || {};
  try {
    if (type === "confirm") {
      const r = dialog.showMessageBoxSync(win, {
        type: "question", message: String(message || ""),
        buttons: ["Cancel", "OK"], defaultId: 1, cancelId: 0, noLink: true,
      });
      event.returnValue = r === 1;
    } else if (type === "alert") {
      dialog.showMessageBoxSync(win, {
        type: "info", message: String(message || ""), buttons: ["OK"], defaultId: 0, noLink: true,
      });
      event.returnValue = undefined;
    } else {
      // prompt(): Electron has no native text-input dialog — return null (cancel).
      event.returnValue = null;
    }
  } catch {
    event.returnValue = type === "confirm" ? false : null;
  }
});

// Toast's "Update" → open the download/release page (works for unsigned app builds).
ipcMain.on("open-update", () => { shell.openExternal(DOWNLOAD_URL).catch(() => {}); });

// Lightweight update check: ask the npm registry for the latest published version,
// compare to the bundled one, and nudge the glass toolbar if newer. No electron-updater,
// no signing — just a heads-up so DMG/EXE users know to re-download. Fails silent offline.
function cmpVer(a, b) { // returns >0 if a newer than b
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
function checkForUpdate() {
  try {
    require("https").get("https://registry.npmjs.org/loop-browser/latest",
      { timeout: 6000 }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const latest = JSON.parse(body).version;
            if (latest && cmpVer(latest, VERSION) > 0 && toolbar && !toolbar.webContents.isDestroyed())
              toolbar.webContents.send("update-available", { latest, current: VERSION });
          } catch {}
        });
      }).on("error", () => {}).on("timeout", function () { this.destroy(); });
  } catch {}
}

if (gotInstanceLock) app.whenReady().then(() => {
  try { theme = JSON.parse(fs.readFileSync(themeFile(), "utf8")).theme || "dark"; } catch {}
  if (process.platform === "darwin") {
    const ic = nativeImage.createFromPath(ICON);
    if (!ic.isEmpty()) app.dock.setIcon(ic);
  }
  createSplash(); // splash paints first, then starts LB behind it (see createSplash)
  app.on("activate", () => {
    // Re-opening after the window was closed (macOS keeps the app alive). Do NOT
    // re-run the splash flow. If a window exists (even one that never revealed
    // because of the shownMain guard), just show it; otherwise build a fresh one
    // and let it reveal (reset the guards so revealMain actually shows it).
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) {
      const w = win && !win.isDestroyed() ? win : wins[0];
      w.show();
      w.focus();
    } else {
      shownMain = false;
      homeReady = false;
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
