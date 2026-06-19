// Shared core: connect to the persistent visible browser + watchable helpers.
// Every command reuses ONE tab and brings it to the front before acting.

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, cpSync, existsSync, statSync, readdirSync } from "fs";
import { spawn } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { homedir } from "os";
import path from "path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CDP_URL = "http://localhost:9222";
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
  const child = spawn(electron, [APP_ROOT], { detached: true, stdio: "ignore" });
  child.unref();
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
  throw new Error("Could not reach Loop Browser on :9222. Try `loop start`.");
}

// REQUIREMENT 1 + 2: reuse the single real tab, never open new ones, keep it visible.
export async function activePage(browser) {
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  // target the CONTENT view: not blank, not the Loop glass toolbar
  const page =
    pages.find(
      (p) => !p.url().startsWith("about:") && !p.url().includes("/ui/toolbar.html")
    ) ??
    pages.find((p) => !p.url().startsWith("about:")) ??
    pages[0] ??
    (await ctx.newPage());
  await page.bringToFront();
  return { page, tabCount: pages.length };
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
async function healFind(page, target, sel) {
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
  return page.locator('[data-loop-heal="1"]').first();
}

// Reliable element finding by human label — tries several strategies in order,
// and POLLS until the element appears (default 25s). Slow/cold page loads (e.g.
// WhatsApp Web syncing) make the target show up late; waiting for it beats
// guessing a fixed sleep. If the exact label never appears, fall back to a
// deterministic word-overlap self-heal before giving up.
export async function findInput(page, label, { timeout = 25000 } = {}) {
  const re = new RegExp(escapeRegExp(label), "i");
  const deadline = Date.now() + timeout;
  do {
    const candidates = [
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
  const healed = await healFind(page, label, '[role="textbox"],[role="searchbox"],input,[contenteditable="true"]');
  if (healed) return healed;
  throw new Error(`No input matching "${label}" (waited ${timeout}ms)`);
}

export async function findClickable(page, text, { timeout = 25000 } = {}) {
  const re = new RegExp(escapeRegExp(text), "i");
  const deadline = Date.now() + timeout;
  do {
    const candidates = [
      page.getByRole("button", { name: re }),
      page.getByRole("link", { name: re }),
      page.getByText(re),
    ];
    for (const c of candidates) {
      if (await c.first().count()) return c.first();
    }
    await sleep(500);
  } while (Date.now() < deadline);
  const healed = await healFind(page, text, '[role="button"],[role="link"],button,a');
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
    case "open":
      console.log(`  · open ${v(step.url)}`);
      await page.goto(v(step.url), { waitUntil: "domcontentloaded" });
      break;
    case "fill": {
      const el = await findInput(page, v(step.target));
      await highlight(el);
      await el.click();
      await el.fill("");
      await el.pressSequentially(v(step.value), { delay: 110 });
      console.log(`  · fill "${v(step.target)}" = "${v(step.value)}"`);
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
