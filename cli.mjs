#!/usr/bin/env node
// Loop Browser — the CLI ↔ Browser command engine.
//
// Single deterministic commands:
//   loop open  <url>
//   loop fill  "<label>" "<text>"
//   loop click "<text>"
//   loop press <Key>
//   loop read
//
// Saved Recipes (run like a bot — NO LLM in the hot path):
//   loop run <recipe-name> key=value key2="value 2"
//   loop recipes                    (list saved recipes)

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { connect, activePage, runStep, withRetry, captureFailure, captureIncident, captureAuthoringContext, harvestMembers, ensureBrowser, isBrowserUp, installSkill, profileDir, dirInfo, fmtBytes, sleep } from "./lib.mjs";
import { pickNextTicket, slugOf } from "./porter.mjs";
import { recordDish, servedSet, logPath as serviceLogPath } from "./servicelog.mjs";

const RECIPES_DIR = new URL("./recipes/", import.meta.url);
const LOCAL_DIR = new URL("./recipes/local/", import.meta.url);
const [cmd, ...rest] = process.argv.slice(2);

const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url))).version;
const cmpVer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
// Once-a-day, TTY-only nudge so `loop`/npm users know a newer version exists. Cache-backed
// (instant on cache hit), 1.5s network budget when stale, stderr only — never pollutes recipe stdout.
async function maybeNudge() {
  if (!process.stderr.isTTY) return;
  try {
    const cacheFile = path.join((await import("os")).homedir(), ".loop-update.json");
    let cache = {}; try { cache = JSON.parse(readFileSync(cacheFile, "utf8")); } catch {}
    if (!cache.ts || Date.now() - cache.ts > 864e5) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500);
        const r = await fetch("https://registry.npmjs.org/loop-browser/latest", { signal: ctl.signal });
        clearTimeout(t);
        cache = { ts: Date.now(), latest: (await r.json()).version };
        writeFileSync(cacheFile, JSON.stringify(cache));
      } catch {}
    }
    if (cache.latest && cmpVer(cache.latest, VERSION) > 0)
      process.stderr.write(`\n  ⟳ loop-browser ${cache.latest} available — update: npm i -g loop-browser@latest\n\n`);
  } catch {}
}
await maybeNudge();

// Resolve a recipe by name — private (recipes/local) wins over shipped (recipes/),
// so a personal overlay (real URLs, pantry paths) shadows a method-only template.
function resolveRecipe(name) {
  const local = new URL(`${name}.json`, LOCAL_DIR);
  const url = existsSync(local) ? local : new URL(`${name}.json`, RECIPES_DIR);
  return JSON.parse(readFileSync(url));
}

// Run a recipe's steps under the Guardian (retry → incident → stop). Shared by
// `run` (one dish, ingredients on the CLI) and `serve` (ingredients from a ticket).
async function runRecipe(page, recipe, vars, name) {
  console.log(`▶ running recipe "${recipe.name}" (${recipe.steps.length} steps, no LLM)`);
  for (const [i, step] of recipe.steps.entries()) {
    try {
      await withRetry(() => runStep(page, step, vars), { tries: step.tries ?? 3 });
    } catch (e) {
      const shot = await captureFailure(page, `${name}-fail-step${i + 1}`);
      const incident = await captureIncident(page, { recipe: name, stepIndex: i, step, vars, error: e, shot });
      console.error(`\n✗ step ${i + 1}/${recipe.steps.length} (${step.do}) BROKE after retries`);
      console.error(`  reason   : ${e.message}`);
      console.error(`  url      : ${page.url()}`);
      console.error(`  📸 shot  : ${shot}`);
      console.error(`  📋 report: ${incident}`);
      console.error(`  recovery ladder:`);
      console.error(`    • heal     → Head Chef reads the report ↑ and patches the recipe, then re-run`);
      console.error(`    • takeover → finish this step in the visible window, then resume`);
      console.error(`    • abort    → stop safely (nothing destructive attempted)`);
      process.exitCode = 1;
      return false;
    }
  }
  console.log(`✓ recipe "${recipe.name}" complete`);
  return true;
}

// "loop recipes" doesn't need the browser (alias: "flows" for muscle memory)
if (cmd === "recipes" || cmd === "flows") {
  const files = readdirSync(RECIPES_DIR).filter((f) => f.endsWith(".json"));
  console.log("recipes:");
  for (const f of files) {
    const recipe = JSON.parse(readFileSync(new URL(f, RECIPES_DIR)));
    console.log(`  • ${recipe.name.padEnd(24)} ${recipe.title || recipe.description || ""}`);
  }
  process.exit(0);
}

// "loop privacy" — show exactly what Loop stores locally + the no-upload guarantee.
if (cmd === "privacy" || cmd === "data") {
  const e = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
  const dim = (s) => e(2, s), b = (s) => e(1, s), grn = (s) => e(32, s), cyn = (s) => e(36, s);
  const pkg = fileURLToPath(new URL(".", import.meta.url));
  const items = [
    { k: "🔑 Login & sessions (the key)", dir: profileDir(), note: "cookies/sessions for sites you're signed into — only you ever see them" },
    { k: "🍽️  Dishes (your output)", dir: path.join(process.cwd(), "dishes"), note: "cooked results (CSVs, etc.) — gitignored, never shared" },
    { k: "📋 Private recipes", dir: path.join(pkg, "recipes", "local"), note: "recipes you keep to yourself — never published" },
    { k: "🩺 Diagnostics (fallback only)", dir: path.join(pkg, "runs"), note: "screenshots/incident reports — created only when a run BREAKS or you use the vision fallback (loop shot)" },
  ];
  console.log("\n" + b("🔒 Loop Browser — Privacy"));
  console.log(dim("   Everything below lives ONLY on this machine. Loop never uploads it.\n"));
  for (const it of items) {
    const info = dirInfo(it.dir);
    const status = info.exists
      ? grn(`${info.files}${info.capped ? "+" : ""} file${info.files === 1 ? "" : "s"} · ${fmtBytes(info.bytes)}`)
      : dim("none yet");
    console.log(`   ${b(it.k)}   ${status}`);
    console.log(`     ${dim(it.dir)}`);
    console.log(`     ${dim("└ " + it.note)}`);
  }
  console.log("\n   " + b("Network"));
  console.log(dim(`     • Only localhost:${process.env.LOOP_CDP_PORT || "9222"} (CLI ↔ your browser) and the sites YOU drive,`));
  console.log(dim("       inside YOUR logged-in session."));
  console.log(dim("     • No telemetry · no accounts · no cloud · nothing phones home.\n"));
  console.log(cyn("   The recipe travels; the meal, the pantry, and the key stay home.") + "\n");
  process.exit(0);
}

// "loop setup" — install the Claude skill + start the browser (background). One-time.
if (cmd === "setup") {
  const dest = installSkill();
  if (dest) console.log(`✓ Claude Code skill installed → ${dest}`);
  process.stdout.write("· starting Loop Browser… ");
  await ensureBrowser();
  console.log("ready.");
  console.log("✓ You're set up. Loop Browser runs in the background — now just talk to Claude Code.");
  process.exit(0);
}

// "loop start" — start the browser in the BACKGROUND and return (keep working).
if (cmd === "start" || cmd === "up") {
  if (await isBrowserUp()) {
    console.log(`✓ Loop Browser is already running (listening on :${process.env.LOOP_CDP_PORT || "9222"}).`);
  } else {
    process.stdout.write("· starting Loop Browser… ");
    await ensureBrowser();
    console.log("ready.");
    console.log("✓ Loop Browser is running in the background. Keep working — drive it with `loop …`.");
  }
  process.exit(0);
}

// "loop shot-os" — OS-LEVEL screenshot. CDP/Playwright (`loop shot`) only see the
// web page; NATIVE dialogs (macOS/Windows file pickers, OS confirms) live outside
// the web content and are INVISIBLE to it. This captures the real screen — bring
// Loop Browser frontmost so its window + any modal dialog show, then screencapture.
// Use this the moment a native dialog might be involved (file upload, OS prompt).
if (cmd === "shot-os" || cmd === "os-shot") {
  const name = rest[0] || "os-screen";
  const dir = new URL("./runs/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const out = new URL(`${name}.png`, dir).pathname;
  if (process.platform === "darwin") {
    for (const proc of ["Loop Browser", "Electron"]) {
      try { execSync(`osascript -e 'tell application "System Events" to set frontmost of process "${proc}" to true'`, { stdio: "ignore" }); break; } catch {}
    }
    try { execSync("sleep 0.6"); } catch {}
    execSync(`screencapture -x ${JSON.stringify(out)}`);
  } else if (process.platform === "win32") {
    // PowerShell full-screen grab (native dialogs included).
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object Drawing.Bitmap $b.Width,$b.Height; $g=[Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size); $bmp.Save('${out.replace(/\\/g, "\\\\")}')`;
    execSync(`powershell -NoProfile -Command "${ps}"`);
  } else {
    console.error("shot-os: native-screen capture not wired for this platform");
    process.exit(1);
  }
  console.log(`  · os-shot → ${out}`);
  console.log(`    (captures NATIVE dialogs that 'loop shot'/'snapshot' cannot — Read this PNG)`);
  process.exit(0);
}

// "loop os-dismiss [n]" — close a NATIVE modal (file picker, OS confirm) that lives
// OUTSIDE the web page and so can't be closed via CDP. Brings Loop Browser frontmost
// then sends Escape (= Cancel for file dialogs) n times (default 1). Pair with
// `loop shot-os` to confirm it actually closed.
if (cmd === "os-dismiss" || cmd === "os-escape") {
  const n = Math.max(1, parseInt(rest[0], 10) || 1);
  if (process.platform === "darwin") {
    for (const proc of ["Loop Browser", "Electron"]) {
      try { execSync(`osascript -e 'tell application "System Events" to set frontmost of process "${proc}" to true'`, { stdio: "ignore" }); break; } catch {}
    }
    for (let i = 0; i < n; i++) {
      try { execSync(`osascript -e 'tell application "System Events" to key code 53'`, { stdio: "ignore" }); } catch {}
    }
  } else if (process.platform === "win32") {
    try { execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ESC}')"`, { stdio: "ignore" }); } catch {}
  } else {
    console.error("os-dismiss: not wired for this platform");
    process.exit(1);
  }
  console.log(`  · os-dismiss → sent Escape ×${n} (confirm with: loop shot-os)`);
  process.exit(0);
}

// "loop mop" — the Mopper as a first-class command, so a cook ALWAYS ends clean without
// relying on memory. TWO parts + a health check: (1) browser station — close any open web
// side-panel/modal by ACCESSIBLE NAME (Close/Back), NEVER Escape (Escape can close the whole
// chat, not just a modal); (2) scratch — wipe runs/scratch/. Then verify the station is OK and
// print PASS/WARN. Safe + idempotent: with the browser down it still wipes scratch and reports.
// Scoped to LOOP_CDP_PORT (this session's instance only). Self-timeout so it can never hang a hook.
if (cmd === "mop") {
  const watchdog = setTimeout(() => { console.log("⚠ mop: timed out — exiting"); process.exit(1); }, 20000);
  watchdog.unref?.();
  const rep = { scratch: false, panels: 0, station: "browser-down", warn: [] };
  // (1) scratch — always, even with the browser down.
  try {
    const sd = new URL("./runs/scratch/", import.meta.url);
    mkdirSync(sd, { recursive: true });
    for (const f of readdirSync(sd)) rmSync(new URL(f, sd), { recursive: true, force: true });
    rep.scratch = true;
  } catch (e) { rep.warn.push("scratch: " + e.message); }
  // (2) browser station — only if reachable (never auto-launch just to mop).
  if (await isBrowserUp().catch(() => false)) {
    try {
      const browser = await connect({ autostart: false });
      const { page } = await activePage(browser);
      for (let k = 0; k < 4; k++) {                          // close up to 4 nested panels/modals
        const loc = page.getByRole("button", { name: /^(Close|Back)$/ });
        if (await loc.count().catch(() => 0)) {
          await loc.first().evaluate((el) => el.click()).catch(() => {});
          rep.panels++; await sleep(400);
        } else break;
      }
      const url = page.url() || "";
      rep.station = (!url || /^about:/.test(url)) ? "blank" : "clean";
      if (rep.station === "blank") rep.warn.push("active page is blank/about:");
    } catch (e) { rep.station = "error"; rep.warn.push("station: " + e.message.split("\n")[0]); }
  }
  clearTimeout(watchdog);
  const ok = rep.scratch && rep.station !== "error" && rep.station !== "blank";
  console.log(`  · mop → scratch ${rep.scratch ? "cleared" : "FAILED"} · panels closed ${rep.panels} · station ${rep.station}`);
  if (rep.warn.length) console.log("    ⚠ " + rep.warn.join(" · "));
  console.log(ok ? "✓ all clean" : "⚠ mop finished with warnings (see above)");
  process.exit(ok ? 0 : 1);
}

const browser = await connect();
const { page, contentCount } = await activePage(browser);
console.log(`· driving the active tab · ${contentCount} tab${contentCount === 1 ? "" : "s"} open`);

try {
  switch (cmd) {
    case "open": {
      // `loop open <url> new` → open a NEW tab (keeps your other sites open) via
      // main.js's popup→newTab path; plain `loop open <url>` navigates the active tab.
      const wantNew = rest.includes("new") || rest.includes("--new");
      const raw = rest.find((r) => r !== "new" && r !== "--new") || "";
      if (wantNew) {
        const url = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
        const ctx = browser.contexts()[0];
        const before = new Set(ctx.pages());
        await page.evaluate((u) => window.open(u, "_blank"), url);
        let opened = null;                       // poll for the real new tab — don't claim success blindly
        for (let i = 0; i < 20 && !opened; i++) { await sleep(300); opened = ctx.pages().find((p) => !before.has(p)); }
        if (opened) {
          await opened.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
          console.log(`✓ opened in a NEW tab: ${opened.url() || url} — other tabs stay open.`);
        } else {
          console.log(`⚠ new tab for ${url} didn't appear (popup blocked or rate-limited). Other tabs untouched.`);
          process.exitCode = 1;
        }
      } else {
        await runStep(page, { do: "open", url: raw });
      }
      break;
    }
    case "fill":
      await runStep(page, { do: "fill", target: rest[0], value: rest.slice(1).join(" ") });
      break;
    case "click":
      await runStep(page, { do: "click", target: rest.join(" ") });
      break;
    case "press":
      await runStep(page, { do: "press", key: rest[0] || "Enter" });
      break;
    case "read":
      await runStep(page, { do: "read" });
      break;
    case "snapshot":
      await runStep(page, { do: "snapshot" });
      break;
    case "shot": {
      // Vision fallback (gap #4): capture a screenshot the brain (Claude Code) can
      // LOOK at to read coordinates for elements absent from the accessibility tree.
      // scale:"css" → 1 PNG pixel = 1 CSS pixel, so coords read off the image map
      // DIRECTLY to `click-xy` (which uses CSS pixels). Without this, Retina/2× DPR
      // would put every vision click in the wrong place.
      const dir = new URL("./runs/", import.meta.url);
      mkdirSync(dir, { recursive: true });
      const shotPath = new URL(`${rest[0] || "shot"}.png`, dir).pathname;
      await page.screenshot({ path: shotPath, scale: "css", fullPage: false });
      const vp = page.viewportSize();
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      console.log(`  · shot → ${shotPath}`);
      if (vp) console.log(`    coords are CSS px · image is ${vp.width}×${vp.height} (dpr ${dpr}); read x,y off it and pass to: loop click-xy x y`);
      break;
    }
    case "click-xy":
      await runStep(page, { do: "click-xy", x: rest[0], y: rest[1] });
      break;
    case "author": {
      // Gap #3: author a recipe for the CURRENT page. Capture the brief; scaffold
      // an empty recipe; the Head Chef (Claude Code) then writes the steps.
      const name = rest[0];
      const goal = rest.slice(1).join(" ");
      if (!name) throw new Error('usage: loop author <recipe-name> "<goal>"');
      const brief = await captureAuthoringContext(page, { name, goal });
      const recipePath = new URL(`${name}.json`, RECIPES_DIR);
      if (!existsSync(recipePath)) {
        writeFileSync(
          recipePath,
          JSON.stringify({ name, version: "0.1.0", description: goal, ingredients: {}, steps: [] }, null, 2) + "\n"
        );
        console.log(`  · scaffolded recipes/${name}.json (empty steps)`);
      } else {
        console.log(`  · recipes/${name}.json already exists — leaving it`);
      }
      console.log(`  · authoring brief → ${brief}`);
      console.log(`  → Head Chef: read the brief, then write the steps into recipes/${name}.json`);
      break;
    }
    case "scrape-members": {
      // Harvest the currently-open group's members (size-agnostic: modal or panel).
      const group = rest[0] || "group";
      const outDir = rest[1] || "./dishes";
      const { count, expected, undercooked, path } = await harvestMembers(page, { group, outDir });
      console.log(`  · scrape-members "${group}" → ${count}/${expected ?? "?"} members → ${path}`);
      if (undercooked) console.error(`  ⚠ undercooked: only ${count} of ${expected}`);
      break;
    }

    case "run": {
      const name = rest[0];
      if (!name) throw new Error("usage: loop run <recipe-name> key=value ...");
      const recipe = resolveRecipe(name);

      // ingredients: defaults from the recipe, overridden by key=value args
      const vars = { ...(recipe.ingredients || recipe.inputs || {}) };
      for (const a of rest.slice(1)) {
        const i = a.indexOf("=");
        if (i > 0) vars[a.slice(0, i)] = a.slice(i + 1);
      }
      await runRecipe(page, recipe, vars, name);
      break;
    }

    case "serve": {
      // SERVICE LAYER — the Head Chef working the shift. Reads a pantry of ticket
      // .txt files, picks the next un-served one, hands its fields to the recipe as
      // ingredients, then ledgers the outcome (the ledger is also the dedup guard).
      // The recipe stays a dumb method; nothing about folders/tickets lives in it.
      const name = rest[0];
      if (!name) throw new Error("usage: loop serve <recipe-name> [pantry=<dir>] [force=1]");
      const recipe = resolveRecipe(name);
      const t = recipe.ticket;
      if (!t) throw new Error(`recipe "${name}" has no "ticket" block — serve needs a pantry mapping`);

      const opts = {};
      for (const a of rest.slice(1)) { const i = a.indexOf("="); if (i > 0) opts[a.slice(0, i)] = a.slice(i + 1); }
      const force = opts.force === "1" || opts.force === "true";

      // The ticket rail (pantry), {TODAY}-stamped.
      const today = new Date().toISOString().slice(0, 10);
      const pantry = (opts.pantry || t.pantry || "./pantry").replace(/\{TODAY\}/g, today);
      if (!existsSync(pantry)) throw new Error(`pantry not found: ${pantry}`);

      // Dedup against the Service Log (the Expediter's book) — by /in/ slug.
      const done = force ? new Set() : servedSet(name, "slug");

      // The Porter gathers the next un-served ticket's ingredients (off the hot path).
      const ticket = pickNextTicket(pantry, done);
      if (!ticket) {
        console.log(`✓ pantry drained — every ticket already served`);
        console.log(`  ${pantry}`);
        break;
      }

      // Hand the Porter's ingredients to the cook under the recipe's ingredient names.
      const vars = { ...(recipe.ingredients || {}), caption: ticket.caption, image: ticket.image, tagUrl: ticket.url, name: ticket.name };

      console.log(`🍽  serving "${ticket.file}"  ·  ${done.size} already served  ·  ${pantry}`);
      if (ticket.name) console.log(`   • ${ticket.name}`);

      const ok = await runRecipe(page, recipe, vars, name);

      // Record in the Service Log — record of work AND dedup guard.
      recordDish(name, { target: ticket.name || null, slug: ticket.slug, file: ticket.file, status: ok ? "served" : "failed" });
      console.log(`  ↳ logged: ${ticket.name || ticket.file} = ${ok ? "served" : "failed"}  (${serviceLogPath()})`);
      break;
    }

    default:
      console.log(
        "commands: open <url> | fill <label> <text> | click <text> | press <key> | read | snapshot\n" +
          "          shot [name] | click-xy <x> <y> | shot-os [name] | os-dismiss [n] | mop\n" +
          "          scrape-members <group> | run <recipe> key=value ... | serve <recipe> [pantry=<dir>] [force=1]\n" +
          "          recipes | author <name> \"<goal>\" | setup | start | privacy"
      );
  }
  if (!process.exitCode) console.log("✓ done — look at the window.");
} finally {
  await browser.close();
}
