// Shared core: connect to the persistent visible browser + watchable helpers.
// Every command reuses ONE tab and brings it to the front before acting.

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, statSync, readdirSync } from "fs";
import { spawn, execFileSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { homedir } from "os";
import path from "path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CDP port is per-instance: a terminal sets LOOP_CDP_PORT (+ LOOP_PROFILE_DIR) to target its own
// browser. launchDetached's spawn inherits process.env, so the launched Electron binds the same port.
const CDP_PORT = process.env.LOOP_CDP_PORT || "9222";
const CDP_URL = `http://localhost:${CDP_PORT}`;
const APP_ROOT = fileURLToPath(new URL(".", import.meta.url)); // package root (has main.js)
const require = createRequire(import.meta.url);

// Is Loop Browser already up on the local CDP port?
export async function isBrowserUp() {
  try {
    const r = await fetch(CDP_URL + "/json/version");
    return r.ok;
  } catch {
    return false;
  }
}

// Launch Loop Browser DETACHED (background) — the caller returns immediately and
// the app keeps running, so no terminal (or Claude Code session) gets stuck
// attached to it. Quitting = close the window (no Ctrl+C needed).
export function launchDetached() {
  let electron;
  try {
    electron = require("electron"); // the Electron binary path
  } catch {
    throw new Error("Electron not found. Install with: npm i -g loop-browser");
  }
  maybeRebrand(); // keep the macOS Dock/menu identity as "Loop Browser" on EVERY launch
  const child = spawn(electron, [APP_ROOT], { detached: true, stdio: "ignore" });
  child.unref();
}

// macOS only, dev/source runs only. The Dock reads the Electron.app bundle's
// identity, which `app.setName()` can't override, and the LaunchServices cache
// flaps back to "Electron" (shared `com.github.Electron` id) unless refreshed. The
// rebrand script patches the bundle (name + unique id + icon) and re-registers it;
// it's cached (keyed to Electron version + rebrand schema), so after the one-time
// heavy pass this is just a fast LS refresh. Only `npm start` ran it before — this
// makes EVERY `loop`/`instance.sh` launch run it too. Packaged builds have no
// scripts/ dir (it's a real "Loop Browser.app" already) → skipped.
function maybeRebrand() {
  if (process.platform !== "darwin") return;
  const script = path.join(APP_ROOT, "scripts", "rebrand-electron.mjs");
  if (!existsSync(script)) return;
  try {
    execFileSync(process.execPath, [script], {
      stdio: "ignore",
      timeout: 120000, // one-time heavy pass (codesign --deep) can take several seconds; cached after
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, // run as plain node even under the packaged shim
    });
  } catch {}
}

// Make sure the browser is running; if not, start it in the background and wait
// until CDP is ready. Returns true if we started it, false if it was already up.
export async function ensureBrowser({ timeoutMs = 30000 } = {}) {
  if (await isBrowserUp()) return false;
  launchDetached();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(400);
    if (await isBrowserUp()) return true;
  }
  throw new Error("Loop Browser didn't come up in time. Try `loop start`.");
}

// Where Electron stores this app's data (logins/cookies = "the key"), per OS.
export function profileDir() {
  if (process.env.LOOP_PROFILE_DIR) return path.resolve(process.env.LOOP_PROFILE_DIR);
  const name = "Loop Browser";
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Application Support", name);
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"), name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), name);
}

// Bounded recursive summary of a directory: { exists, files, bytes } (caps the
// walk so a big browser cache can't hang the privacy panel).
export function dirInfo(dir, { cap = 8000 } = {}) {
  if (!existsSync(dir)) return { exists: false, files: 0, bytes: 0, capped: false };
  let files = 0, bytes = 0, capped = false;
  const walk = (d) => {
    if (files >= cap) { capped = true; return; }
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files >= cap) { capped = true; return; }
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { files++; try { bytes += statSync(p).size; } catch {} }
    }
  };
  walk(dir);
  return { exists: true, files, bytes, capped };
}

export const fmtBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// Install the Loop skill into ~/.claude/skills/loop so Claude Code can drive Loop
// Browser. Order-independent: works whether Claude Code is installed yet or not.
export function installSkill() {
  const src = path.join(APP_ROOT, "skill", "loop");
  if (!existsSync(src)) return false;
  const dest = path.join(homedir(), ".claude", "skills", "loop");
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  return dest;
}

// Connect to the running browser — auto-starting it (detached) if it isn't up.
export async function connect({ autostart = true } = {}) {
  if (autostart) {
    try { await ensureBrowser(); } catch { /* fall through to the connect retries */ }
  }
  for (let i = 0; i < 30; i++) {
    try {
      return await chromium.connectOverCDP(CDP_URL);
    } catch {
      await sleep(400);
    }
  }
  throw new Error(`Could not reach Loop Browser on :${CDP_PORT}. Try \`loop start\`.`);
}

// REQUIREMENT 1 + 2: reuse the single real tab, never open new ones, keep it visible.
export async function activePage(browser) {
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  // Target a REAL content tab: not the root about:blank, not the glass toolbar.
  // NEVER create a page here. The old `?? ctx.newPage()` fallback silently spawned
  // an off-screen shell that main.js doesn't wrap in a tab — invisible, unreachable,
  // and they pile up (the "6 hidden shells" bug). main.js always keeps ≥1 real tab,
  // so a content page should always exist; if it doesn't, stop loudly rather than
  // birth something the human can't see or click.
  const content = pages.filter(
    (p) => !p.url().startsWith("about:") && !p.url().includes("/ui/toolbar.html")
  );
  if (!content.length) {
    throw new Error(
      "No visible content tab to drive. Open a page in Loop Browser (a real, clickable tab) and retry — the CLI never creates hidden pages."
    );
  }
  // Drive the tab you're LOOKING AT: main.js flags the active tab with
  // window.__loopActiveTab (true on front, false on the rest, re-asserted on each
  // navigation). So you can keep LinkedIn, WhatsApp, etc. open and `loop` acts on
  // the front one. Selection order handles the mid-navigation window too:
  //   1) explicit active (flag true)
  //   2) the tab NOT explicitly inactive (flag cleared by an in-flight nav, not yet false)
  //   3) first content tab (single-tab / cold start)
  const flags = await Promise.all(
    content.map((p) => p.evaluate(() => window.__loopActiveTab).catch(() => "err"))
  );
  let idx = flags.indexOf(true);
  if (idx < 0) idx = flags.findIndex((f) => f !== false && f !== "err");
  const page = content[idx < 0 ? 0 : idx];
  await page.bringToFront();
  // Native JS dialogs otherwise deadlock the page. The one we hit in practice is
  // the "Leave site? — unsaved changes" beforeunload when navigating away from a
  // composer with a draft → ACCEPT it (let navigation through). Dismiss anything
  // else rather than blind-confirm a destructive native confirm(). Attach once.
  if (!page.__loopDialogs) {
    page.__loopDialogs = true;
    page.on("dialog", (d) =>
      (d.type() === "beforeunload" ? d.accept() : d.dismiss()).catch(() => {})
    );
  }
  return { page, tabCount: pages.length, contentCount: content.length };
}

// Pick a tab by URL WITHOUT stealing focus — the key to running two automations on two tabs at once.
// activePage() bringToFront()s (every caller fights over the front tab); pageFor() leaves focus alone,
// so a background WhatsApp cron and a foreground LinkedIn cook coexist. Background tabs are READABLE and
// driveable via in-page dispatch (el.click) + keyboard — but NOT via locator.click() (actionability fails
// on a hidden WebContentsView). Use bgClick/bgType below for background interaction.
export async function pageFor(browser, pattern, { front = false } = {}) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const page = browser.contexts()[0].pages()
    .find((p) => re.test(p.url()) && !p.url().includes("/ui/toolbar.html"));
  if (!page) throw new Error(`pageFor: no open tab matching ${re} — open it in Loop Browser first`);
  if (front) await page.bringToFront();
  if (!page.__loopDialogs) {
    page.__loopDialogs = true;
    page.on("dialog", (d) => (d.type() === "beforeunload" ? d.accept() : d.dismiss()).catch(() => {}));
  }
  return page;
}
// Background-safe click: dispatch the DOM click on the element a locator resolves to. Works on a
// non-fronted tab where locator.click() times out on actionability. Pass a Playwright locator.
export async function bgClick(locator) { await locator.evaluate((el) => el.click()); }
// Background-safe type: focus the element, clear it, then type via CDP keyboard (works unfronted).
export async function bgType(page, locator, text) {
  await locator.evaluate((el) => el.focus());
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  if (text) await page.keyboard.type(String(text), { delay: 40 });
}

// Draw a red box around the element BEFORE acting, so you SEE where it acts.
export async function highlight(locator) {
  const handle = await locator.elementHandle();
  if (!handle) return;
  await handle.evaluate((el) => {
    el.style.outline = "3px solid #ff2d55";
    el.style.outlineOffset = "2px";
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  await sleep(400);
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// SELF-HEAL Rung A (deterministic, no brain, free): when the exact label has
// drifted (e.g. "View all" → "View all (849 more)", or words reordered/renamed),
// scan the live page for the best element by WORD-OVERLAP and use it. Runs only
// after exact matching fails — a cheap recovery before we escalate to the brain.
// Tags the winner with data-loop-heal so we can hand back a normal locator.
// --- auto-capture: remember what a STALE target healed to, and reuse it as a fast-path
// candidate next run (no re-heal → skips the poll-then-fuzzy cost). Captures are gitignored
// (a target can be personal, e.g. a contact name) → site-memories/local/captured/<domain>.json.
const _capCache = new Map();
const _capDir = new URL("./site-memories/local/captured/", import.meta.url);
const _capPath = (domain) => new URL(`${encodeURIComponent(domain)}.json`, _capDir);
const _domainOf = (page) => { try { return new URL(page.url()).hostname.replace(/^www\./, ""); } catch { return "unknown"; } };
function loadCaptures(domain) {
  if (_capCache.has(domain)) return _capCache.get(domain);
  let data = {};
  try { data = JSON.parse(readFileSync(_capPath(domain), "utf8")); } catch {}
  _capCache.set(domain, data);
  return data;
}
function capturedName(page, target) {
  return loadCaptures(_domainOf(page))[target]?.resolved || null;
}
function saveCapture(page, kind, target, resolved, score) {
  if (!resolved || resolved === target) return;
  const domain = _domainOf(page);
  const data = loadCaptures(domain);
  data[target] = { kind, resolved, score: Math.round(score * 100) / 100, hits: (data[target]?.hits || 0) + 1, ts: new Date().toISOString() };
  try { mkdirSync(_capDir, { recursive: true }); writeFileSync(_capPath(domain), JSON.stringify(data, null, 2) + "\n"); } catch {}
}

async function healFind(page, target, sel, kind = "el") {
  const match = await page.evaluate(
    ({ target, sel }) => {
      const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
      const tWords = norm(target).split(" ").filter(Boolean);
      if (!tWords.length) return null;
      document.querySelectorAll("[data-loop-heal]").forEach((e) => e.removeAttribute("data-loop-heal"));
      let best = null, bestScore = 0, bestText = "";
      for (const el of document.querySelectorAll(sel)) {
        const name = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.textContent || "";
        const nWords = new Set(norm(name).split(" "));
        if (!nWords.size) continue;
        const hit = tWords.filter((w) => nWords.has(w)).length;
        const score = hit / tWords.length; // fraction of target words present
        if (score > bestScore) { bestScore = score; best = el; bestText = name.trim().slice(0, 80); }
      }
      if (best && bestScore >= 0.6) { best.setAttribute("data-loop-heal", "1"); return { score: bestScore, text: bestText }; }
      return null;
    },
    { target, sel }
  );
  if (!match) return null;
  console.log(`  ↻ self-healed: "${target}" → "${match.text}" (${Math.round(match.score * 100)}% word match)`);
  saveCapture(page, kind, target, match.text, match.score);
  console.log(`  ⓘ captured: next run tries "${match.text}" first for "${target}"`);
  return page.locator('[data-loop-heal="1"]').first();
}

// Reliable element finding by human label — tries several strategies in order,
// and POLLS until the element appears (default 25s). Slow/cold page loads (e.g.
// WhatsApp Web syncing) make the target show up late; waiting for it beats
// guessing a fixed sleep. If the exact label never appears, fall back to a
// deterministic word-overlap self-heal before giving up.
export async function findInput(page, label, { timeout = 25000 } = {}) {
  const re = new RegExp(escapeRegExp(label), "i");
  const cap = capturedName(page, label);                       // auto-capture fast path
  const capRe = cap && new RegExp(escapeRegExp(cap), "i");
  const deadline = Date.now() + timeout;
  do {
    const candidates = [
      ...(capRe ? [page.getByLabel(capRe), page.getByPlaceholder(capRe), page.getByRole("textbox", { name: capRe })] : []),
      page.getByLabel(re),
      page.getByPlaceholder(re),
      page.getByRole("searchbox"),
      page.getByRole("textbox", { name: re }),
      page.getByRole("textbox"),
    ];
    for (const c of candidates) {
      if (await c.first().count()) return c.first();
    }
    await sleep(500);
  } while (Date.now() < deadline);
  const healed = await healFind(page, label, '[role="textbox"],[role="searchbox"],input,[contenteditable="true"]', "input");
  if (healed) return healed;
  throw new Error(`No input matching "${label}" (waited ${timeout}ms)`);
}

export async function findClickable(page, text, { timeout = 25000 } = {}) {
  const re = new RegExp(escapeRegExp(text), "i");
  const cap = capturedName(page, text);                        // auto-capture fast path
  const capRe = cap && new RegExp(escapeRegExp(cap), "i");
  const deadline = Date.now() + timeout;
  do {
    const candidates = [
      ...(capRe ? [page.getByRole("button", { name: capRe }), page.getByRole("link", { name: capRe })] : []),
      page.getByRole("button", { name: re }),
      page.getByRole("link", { name: re }),
      page.getByText(re),
    ];
    for (const c of candidates) {
      if (await c.first().count()) return c.first();
    }
    await sleep(500);
  } while (Date.now() < deadline);
  const healed = await healFind(page, text, '[role="button"],[role="link"],button,a', "clickable");
  if (healed) return healed;
  throw new Error(`Nothing clickable matching "${text}" (waited ${timeout}ms)`);
}

// "Main match → mini match": open a search result (e.g. a WhatsApp chat) by name.
// Search the FULL name first; if no matching result appears, progressively shorten
// the search term (drop trailing words, down to the first name) until results show.
// Among whatever rows appear, click the one that best matches the FULL name by
// word-overlap — so it still picks the right person, and tolerates an extra or
// MISSPELLED middle name (e.g. "Aasim Naeem Siddiqui" → "Aasim Naseem Siddiqui").
export async function openChat(page, name, searchLabel = "Search or start a new chat") {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error("open-chat: empty name");
  const terms = []; // full name, then shrinking prefixes, ending at the first word
  for (let k = words.length; k >= 1; k--) terms.push(words.slice(0, k).join(" "));

  for (const term of terms) {
    const box = await findInput(page, searchLabel);
    await highlight(box);
    await box.click();
    await box.fill("");
    await box.pressSequentially(term, { delay: 80 });
    await sleep(1600); // let results render

    // Pick the visible result row that best matches the FULL name by word-overlap.
    const score = await page.evaluate((full) => {
      const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
      const tw = norm(full).split(" ").filter(Boolean);
      if (!tw.length) return null;
      document.querySelectorAll("[data-loop-open]").forEach((e) => e.removeAttribute("data-loop-open"));
      let best = null, bs = 0;
      for (const el of document.querySelectorAll('[role="row"],[role="listitem"],[role="option"],[role="gridcell"],[role="button"]')) {
        const nm = norm(el.getAttribute("aria-label") || el.textContent || "");
        if (!nm) continue;
        const set = new Set(nm.split(" "));
        const s = tw.filter((w) => set.has(w)).length / tw.length;
        if (s > bs) { bs = s; best = el; }
      }
      if (best && bs >= 0.5) { best.setAttribute("data-loop-open", "1"); return bs; }
      return null;
    }, name);

    if (score) {
      const el = page.locator('[data-loop-open="1"]').first();
      await highlight(el);
      await el.click();
      const mini = term === name ? "" : ` (mini match — searched "${term}")`;
      console.log(`  · open-chat "${name}" → ${Math.round(score * 100)}% match${mini}`);
      return;
    }
  }
  throw new Error(`open-chat: no result matching "${name}" (tried ${terms.length} search terms)`);
}

// ---- Recipe engine ----------------------------------------------------------
// Fill {placeholders} in a string from the ingredients map.
export function interpolate(str, vars) {
  if (typeof str !== "string") return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

// Execute ONE step against the page. This is the deterministic "bot" primitive —
// no LLM involved. Same function powers single CLI commands and saved recipes.
export async function runStep(page, step, vars = {}) {
  const v = (s) => interpolate(s, vars);
  switch (step.do) {
    case "open": {
      let url = v(step.url);
      // Accept bare domains (`loop open example.com`) — page.goto needs a scheme.
      if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "https://" + url;
      console.log(`  · open ${url}`);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      } catch (e) {
        // A "Leave site? — unsaved changes" beforeunload (e.g. an open composer
        // with a draft) makes page.goto throw ERR_ABORTED even though the dialog
        // handler accepts it. Drive the navigation client-side instead — there's
        // no goto promise to abort — then wait for the load.
        if (!/ERR_ABORTED/.test(e.message)) throw e;
        await page.evaluate((u) => { window.location.href = u; }, url);
        await page.waitForLoadState("domcontentloaded");
      }
      break;
    }
    case "fill": {
      const el = await findInput(page, v(step.target));
      const text = v(step.value);
      await highlight(el);
      await el.click();
      await el.fill("");
      // Human-like per-char pacing (deliberate, watchable). Scale the action
      // timeout to the text length so long captions don't trip Playwright's
      // 30s cap mid-type — a short default would silently break long posts.
      const delay = step.delay ?? 110;
      await el.pressSequentially(text, { delay, timeout: Math.max(30000, text.length * delay + 20000) });
      console.log(`  · fill "${v(step.target)}" = "${text}"`);
      break;
    }
    case "click": {
      const el = await findClickable(page, v(step.target));
      await highlight(el);
      await el.click();
      console.log(`  · click "${v(step.target)}"`);
      break;
    }
    case "open-chat":
      // Resilient contact open: full match → mini match (see openChat).
      await openChat(page, v(step.name), v(step.search || "Search or start a new chat"));
      break;
    case "press":
      await page.keyboard.press(step.key || "Enter");
      console.log(`  · press ${step.key || "Enter"}`);
      break;
    case "click-xy": {
      // VISION FALLBACK (gap #4): click at absolute page coordinates, for elements
      // NOT in the accessibility tree (canvas, image-only buttons). a11y/role-label
      // stays primary — this is the escape hatch the brain authors after LOOKING at
      // a screenshot (`loop shot`). No LLM in the hot path; the coords are baked in.
      const x = Number(step.x), y = Number(step.y);
      await page.mouse.move(x, y);
      await page.mouse.click(x, y);
      console.log(`  · click-xy (${x}, ${y})`);
      break;
    }
    case "wait":
      await page.waitForTimeout(step.ms || 1000);
      console.log(`  · wait ${step.ms || 1000}ms`);
      break;
    case "assert": {
      const found = await page
        .getByText(new RegExp(v(step.text), "i"))
        .first()
        .count();
      if (!found) throw new Error(`assert failed — "${v(step.text)}" not on page`);
      console.log(`  · assert "${v(step.text)}" ✓`);
      break;
    }
    case "read":
      console.log(`  = ${await page.title()} — ${page.url()}`);
      break;
    case "scrape-members": {
      // Specialized tool: harvest every member of the open WhatsApp
      // "Search members" modal into a CSV. The chef proved this by hand;
      // this is the written-down, deterministic version for the line cook.
      const group = v(step.group || "group");
      const outDir = v(step.outDir || ".");
      const { count, expected, undercooked, path } = await harvestMembers(page, { group, outDir });
      console.log(`  · scrape-members "${group}" → ${count}/${expected ?? "?"} members → ${path}`);
      if (undercooked) throw new Error(`undercooked — only ${count} of ${expected} members harvested`);
      break;
    }
    case "snapshot": {
      // The Head Chef's eyes: the page as an accessibility tree (role + name),
      // the exact vocabulary recipes target with. No pixels, pure structure.
      console.log(`= ${await page.title()} — ${page.url()}\n`);
      const tree = await page.locator("body").ariaSnapshot();
      console.log(tree);
      break;
    }
    case "extract": {
      // GENERIC harvest (any site, not just WhatsApp): for each element matching
      // `rows`, pull `fields` (text by default, or an attribute) into a CSV row.
      // fields: { colName: { sel?: "<css within row>", attr?: "href" } }
      const rowsSel = v(step.rows);
      const fields = step.fields || {};
      const data = await page.$$eval(
        rowsSel,
        (els, fields) =>
          els.map((el) => {
            const o = {};
            for (const [k, f] of Object.entries(fields)) {
              const t = f.sel ? el.querySelector(f.sel) : el;
              o[k] = t ? (f.attr ? t.getAttribute(f.attr) || "" : t.textContent.trim().replace(/\s+/g, " ")) : "";
            }
            return o;
          }),
        fields
      );
      const cols = Object.keys(fields);
      const esc = (val) => `"${String(val ?? "").replace(/"/g, '""')}"`;
      const csv = cols.join(",") + "\n" + data.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n") + "\n";
      const outDir = v(step.outDir || "./dishes");
      mkdirSync(outDir, { recursive: true });
      const path = `${outDir.replace(/\/$/, "")}/${v(step.name || "extract")}.csv`;
      writeFileSync(path, csv);
      console.log(`  · extract "${rowsSel}" → ${data.length} rows → ${path}`);
      if (step.min && data.length < step.min) throw new Error(`extract got ${data.length} rows, expected ≥ ${step.min}`);
      break;
    }
    default:
      throw new Error(`unknown step: ${JSON.stringify(step)}`);
  }
}

// ---- The Guardian: recovery ladder -----------------------------------------
// Rung 1 — retry with backoff (handles timing/transient flakiness, no LLM).
export async function withRetry(fn, { tries = 3, delay = 600 } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries) await sleep(delay * i);
    }
  }
  throw last;
}

// ---- Specialized harvest: WhatsApp group members → CSV -----------------------
// Assumes the centered "Search members" modal is open. Collects ONE record per
// member BUTTON (a row may carry both a "~display name" gridcell AND a "+number"
// gridcell for the same person — merging per button avoids double-counting and
// fills name+number together). Saved contacts show a name only; bare unsaved
// members show a number only. Human-paced scroll so it stays watchable.
const PHONE_RE = /^\+?\d[\d\s().-]{5,}\d$/;
const slugify = (s) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export async function harvestMembers(page, { group, outDir }) {
  // The member list lives in one of two places depending on group size:
  //  • BIG group  → a "View all (N more)" button opens a center MODAL with a
  //    tall virtualized list (must scroll its own scroller).
  //  • SMALL group → no modal; all members render in the right-side
  //    "Group info" (role=complementary) panel.
  // This resolver handles both, and opens the modal itself when present, so the
  // recipe doesn't need a separate "View all" click (which breaks on small groups).
  const modalScroller = () =>
    page.evaluateHandle(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
        /Search members/i.test(d.getAttribute("aria-label") || d.textContent || "")
      );
      if (!dlg) return null;
      let best = null, max = 0;
      for (const el of dlg.querySelectorAll("div")) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === "auto" || oy === "scroll") && el.scrollHeight > max) { max = el.scrollHeight; best = el; }
      }
      return best || dlg;
    });
  const hasEl = (h) => h.evaluate((el) => !!el).catch(() => false);

  let scrollHandle = await modalScroller();
  let path_kind = "modal";
  if (!(await hasEl(scrollHandle))) {
    // Try to open the full-list modal (big group). Short timeout — absent on small groups.
    try {
      const va = await findClickable(page, "View all", { timeout: 3000 });
      await va.click();
      await sleep(2000);
    } catch {}
    scrollHandle = await modalScroller();
    if (!(await hasEl(scrollHandle))) {
      // Small group: harvest the Group-info side panel directly.
      scrollHandle = await page.evaluateHandle(() => document.querySelector('[role="complementary"]'));
      path_kind = "panel";
      if (!(await hasEl(scrollHandle)))
        throw new Error("no member list found — open the group's info first (Profile details)");
    }
  }
  console.log(`  · harvest path: ${path_kind}`);

  // Read the live "N members" count so the dish can self-check for undercooking.
  const expected = await page.evaluate(() => {
    for (const el of document.querySelectorAll('h1,h2,h3,[role="heading"],[role="button"]')) {
      const m = (el.textContent || "").match(/^\s*([\d,]+)\s+members\s*$/i);
      if (m) return parseInt(m[1].replace(/,/g, ""), 10);
    }
    return null;
  });

  const order = [];
  const seen = new Set();
  // Strip a leading "~" (display-name marker) and a trailing "Group admin" role
  // tag (the side panel concatenates it onto the name, sometimes with no space),
  // and collapse whitespace. Keeps a contact's own name intact (e.g. "Rose Adhi Admin").
  const clean = (s) =>
    s.replace(/^~\s*/, "").replace(/\s*Group admin\s*$/i, "").replace(/\s+/g, " ").trim();
  const collect = async () => {
    const rows = await scrollHandle.evaluate((root) =>
      [...root.querySelectorAll('[role="button"]')]
        .filter((b) => b.querySelector('[role="gridcell"]'))
        .map((b) => [...b.querySelectorAll('[role="gridcell"]')].map((g) => g.textContent.trim()))
    );
    for (const cells of rows) {
      const phone = cells.find((c) => PHONE_RE.test(c)) || "";
      const name = clean(cells.find((c) => c && !PHONE_RE.test(c)) || "");
      const key = `${name}|${phone}`;
      if (key !== "|" && !seen.has(key)) {
        seen.add(key);
        order.push({ name, phone });
      }
    }
  };

  const rnd = (a, b) => a + Math.random() * (b - a);
  await scrollHandle.evaluate((el) => { el.scrollTop = 0; });
  await sleep(1200);
  await collect();
  let stable = 0;
  for (let i = 0; i < 1000; i++) {
    const before = order.length;
    await scrollHandle.evaluate((el) => { el.scrollTop += el.clientHeight * (0.45 + Math.random() * 0.15); });
    await sleep(rnd(900, 1700));
    await collect();
    if (order.length === before) {
      if (++stable >= 8) break;
    } else stable = 0;
  }

  const esc = (val) => `"${String(val).replace(/"/g, '""')}"`;
  const csv =
    "name,phone\n" +
    order.map((r) => [esc(r.name), esc(r.phone)].join(",")).join("\n") +
    "\n";
  mkdirSync(outDir, { recursive: true });
  const path = `${outDir.replace(/\/$/, "")}/${slugify(group)}-members.csv`;
  writeFileSync(path, csv);
  // Undercooked = collected well short of the live count (missed scrolling).
  const undercooked = expected != null && order.length < Math.floor(expected * 0.97);
  return { count: order.length, expected, undercooked, path };
}

// AUTHOR flow (gap #3 — live handling of novel pages): capture everything the
// Head Chef needs to WRITE a new recipe for whatever page is open — the goal, the
// live accessibility snapshot (the exact role/name vocabulary recipe steps target
// by), a screenshot, and url/title. The brain (Claude Code — the user's own
// subscription, no metered API) reads this brief and fills the recipe's steps.
// Same machinery as the heal incident report, pointed forward instead of at a break.
export async function captureAuthoringContext(page, { name, goal }) {
  const dir = new URL("./runs/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  let snapshot = "";
  try { snapshot = await page.locator("body").ariaSnapshot(); } catch {}
  const shot = new URL(`${name}-authoring.png`, dir).pathname;
  await page.screenshot({ path: shot, scale: "css", fullPage: false }).catch(() => {}); // css px → maps to click-xy
  const brief = {
    recipe: name,
    goal,
    url: page.url(),
    title: await page.title().catch(() => ""),
    screenshot: shot,
    accessibilitySnapshot: snapshot,
    note: "Head Chef: turn `goal` into recipe steps (open/fill/click/press/wait/assert/read/scrape-members) targeting the role/name labels seen in accessibilitySnapshot. Write them into recipes/<recipe>.json and set a version.",
  };
  const path = new URL(`${name}-authoring.json`, dir).pathname;
  writeFileSync(path, JSON.stringify(brief, null, 2));
  return path;
}

// When a step breaks, snapshot the screen so the human SEES exactly where.
export async function captureFailure(page, label) {
  const dir = new URL("./runs/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const path = new URL(`${label}.png`, dir).pathname;
  await page.screenshot({ path, scale: "css", fullPage: false }).catch(() => {}); // css px → maps to click-xy
  return path;
}

// SELF-HEAL Rung B: write a structured INCIDENT REPORT the Head Chef (the brain)
// can heal from — the failing step, the (interpolated) target it sought, the live
// page URL/title, the accessibility snapshot (the exact vocabulary recipes target
// by), and the screenshot. `loop heal <recipe>` reads this; the brain picks the
// right element from the snapshot and patches the recipe step. No metered LLM in
// the engine — the brain is Claude Code, invoked by the human.
export async function captureIncident(page, { recipe, stepIndex, step, vars = {}, error, shot }) {
  const dir = new URL("./runs/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  let snapshot = "";
  try { snapshot = await page.locator("body").ariaSnapshot(); } catch {}
  const target = step?.target ? interpolate(step.target, vars) : undefined;
  const incident = {
    recipe,
    failingStepIndex: stepIndex,
    step,
    targetSought: target,
    reason: error?.message,
    url: page.url(),
    title: await page.title().catch(() => ""),
    screenshot: shot,
    accessibilitySnapshot: snapshot,
    note: "Head Chef: find the element in accessibilitySnapshot that matches targetSought, then patch this step's target in recipes/<recipe>.json and bump the version.",
  };
  const path = new URL(`${recipe}-incident.json`, dir).pathname;
  writeFileSync(path, JSON.stringify(incident, null, 2));
  return path;
}
