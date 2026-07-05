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
import { recordDish, readLog, logPath as serviceLogPath } from "./servicelog.mjs";
import { recordRun, isGraduated, reopenStats, readStats, GRADUATE_N } from "./stats.mjs";
import { openChatExact, readRecent, sendMessage, listChats, unreadChats, withLock } from "./wa.mjs";

const RECIPES_DIR = new URL("./recipes/", import.meta.url);
const LOCAL_DIR = new URL("./recipes/local/", import.meta.url);
const [cmd, ...rest] = process.argv.slice(2);

const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url))).version;
// Once-a-day, TTY-only nudge when the REPO is behind origin — clone is the only
// distribution channel (the repo is the living method library; the frozen npm package
// misses it, and `npm i -g` would break an `npm link` setup, so we never suggest it).
// Cache-backed (instant on cache hit), 1.5s network budget when stale, stderr only.
async function maybeNudge() {
  if (!process.stderr.isTTY) return;
  try {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const cacheFile = path.join((await import("os")).homedir(), ".loop-update.json");
    let cache = {}; try { cache = JSON.parse(readFileSync(cacheFile, "utf8")); } catch {}
    if (!cache.ts || Date.now() - cache.ts > 864e5) {
      try {
        const local = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
        const remote = (execSync("git ls-remote origin HEAD", { cwd: root, encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).split(/\s+/)[0] || "").trim();
        cache = { ts: Date.now(), behind: !!(local && remote && local !== remote) };
        writeFileSync(cacheFile, JSON.stringify(cache));
      } catch { cache = { ts: Date.now(), behind: false }; try { writeFileSync(cacheFile, JSON.stringify(cache)); } catch {} }
    }
    if (cache.behind)
      process.stderr.write(`\n  ⟳ the Loop repo has new recipes/fixes — update: git pull && npm install\n\n`);
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
  page.__loopHealed = false;                                              // graduation signal, reset per run
  const N = Number(recipe.graduateAfter) > 0 ? Number(recipe.graduateAfter) : GRADUATE_N;
  for (const [i, step] of recipe.steps.entries()) {
    try {
      await withRetry(() => runStep(page, step, vars), { tries: step.tries ?? 3 });
    } catch (e) {
      const wasGrad = isGraduated(name, recipe.version);
      reopenStats(name);                                                  // any break → back to probation
      // Evidence capture must never REPLACE the real step error — if the shot or the
      // incident write itself throws, log and continue with what we have.
      let shot = "(shot failed)";
      try { shot = await captureFailure(page, `${name}-fail-step${i + 1}`); }
      catch (ce) { console.error(`  (captureFailure failed: ${ce.message})`); }
      if (wasGrad) {
        // A graduated recipe breaking is a REGRESSION, not a routine heal — do NOT
        // auto-write a brain brief; require a deliberate re-run to re-invite the Head Chef.
        console.error(`\n✗ GRADUATED recipe "${recipe.name}" broke at step ${i + 1}/${recipe.steps.length} (${step.do}) — REGRESSION, not a routine heal`);
        console.error(`  reason   : ${e.message}`);
        console.error(`  url      : ${page.url()}`);
        console.error(`  📸 shot  : ${shot}`);
        console.error(`  reopened to probation · no incident written · nothing destructive attempted`);
        console.error(`  → if the site genuinely changed, re-run to capture a heal report for the Head Chef`);
        process.exitCode = 1;
        return false;
      }
      let incident = "(incident write failed)";
      try { incident = await captureIncident(page, { recipe: name, stepIndex: i, step, vars, error: e, shot }); }
      catch (ce) { console.error(`  (captureIncident failed: ${ce.message})`); }
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
  // Graduation ledger: count this completed run; clean = no heal fired during it.
  const g = recordRun(name, recipe.version, { clean: !page.__loopHealed, n: N });
  if (g.justGraduated)
    console.log(`🎓 "${recipe.name}" GRADUATED — ${g.cleanStreak} clean runs, no heals. The brain is now off this recipe; a break is a regression.`);
  else if (g.graduated)
    console.log(`   graduated ✓ · ${g.runs} runs`);
  else
    console.log(`   ${g.cleanStreak}/${N} clean runs to graduation${page.__loopHealed ? " · healed this run (streak reset)" : ""}`);
  return true;
}

// "loop recipes" doesn't need the browser (alias: "flows" for muscle memory)
if (cmd === "recipes" || cmd === "flows") {
  const files = readdirSync(RECIPES_DIR).filter((f) => f.endsWith(".json"));
  const stats = readStats();
  console.log("recipes:");
  for (const f of files) {
    const recipe = JSON.parse(readFileSync(new URL(f, RECIPES_DIR)));
    const e = stats[recipe.name];
    const N = Number(recipe.graduateAfter) > 0 ? Number(recipe.graduateAfter) : GRADUATE_N;
    let tag = "· never run";
    if (e && e.version === (recipe.version || "0.0.0"))
      tag = e.graduated
        ? `· graduated ✓ (${e.runs} runs, ${e.heals} heals)`
        : `· ${e.cleanStreak}/${N} to graduation (${e.runs} runs, ${e.heals} heals)`;
    else if (e) tag = "· edited → re-probation";
    const title = (recipe.title || recipe.description || "").slice(0, 34);
    console.log(`  • ${recipe.name.padEnd(24)} ${title.padEnd(36)} ${tag}`);
  }
  process.exit(0);
}

// "loop status [recipe]" — graduation/health ledger (no browser needed).
if (cmd === "status") {
  const stats = readStats();
  const names = rest[0] ? [rest[0]] : Object.keys(stats).sort();
  if (!names.length) { console.log("no recipe stats yet — run a recipe first."); process.exit(0); }
  console.log(`graduation status  (N=${GRADUATE_N}${process.env.LOOP_GRADUATE_N ? " via LOOP_GRADUATE_N" : ""}; a break or heal resets the streak)`);
  for (const nm of names) {
    const e = stats[nm];
    if (!e) { console.log(`  • ${nm.padEnd(24)} never run`); continue; }
    const state = e.graduated
      ? `graduated ✓ since ${(e.graduatedAt || "").slice(0, 10)}`
      : `probation · ${e.cleanStreak} clean in a row`;
    console.log(`  • ${nm.padEnd(24)} v${e.version} · ${e.runs} runs · ${e.heals} heals · ${state}`);
    if (e.lastHealAt) console.log(`      last heal: ${e.lastHealAt.slice(0, 19).replace("T", " ")}`);
  }
  process.exit(0);
}

// "loop reopen <recipe>" — deliberately send a graduated recipe back to probation
// (re-enables brain heal reports on the next break, e.g. after the site changed).
if (cmd === "reopen") {
  const nm = rest[0];
  if (!nm) { console.error("usage: loop reopen <recipe-name>"); process.exit(1); }
  const ok = reopenStats(nm);
  console.log(ok
    ? `↺ "${nm}" reopened — back to probation; the next break will capture a heal report.`
    : `no stats for "${nm}" yet (never run?)`);
  process.exit(0);
}

// "loop strays [kill]" (alias "kill-strays") — find/close leftover unregistered browsers
// (the phantom "3rd window": closing the window doesn't quit the app on macOS). No browser needed.
if (cmd === "strays" || cmd === "kill-strays") {
  const script = fileURLToPath(new URL("./scripts/instances.mjs", import.meta.url));
  const kill = cmd === "kill-strays" || (rest[0] || "").toLowerCase() === "kill";
  try { execSync(`node ${JSON.stringify(script)} strays${kill ? " kill" : ""}`, { stdio: "inherit" }); }
  catch { process.exitCode = 1; }
  process.exit(process.exitCode || 0);
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
    case "frames": {
      // Diagnostic: where does a modal live? Lists every frame, flags which holds a
      // dialog + its content size — so "the modal is in iframe [2]" is one glance.
      // (If NO frame shows the modal, it's a NATIVE OS dialog → use shot-os / filechooser.)
      const frames = page.frames();
      console.log(`  · ${frames.length} frame(s):`);
      for (const [i, f] of frames.entries()) {
        const main = f === page.mainFrame() ? " (main)" : "";
        let chars = 0, dialog = false;
        try { chars = await f.locator("body").evaluate((b) => b.innerText.length).catch(() => 0); } catch {}
        try { dialog = (await f.locator('[role="dialog"], dialog, [aria-modal="true"]').first().count()) > 0; } catch {}
        console.log(`    [${i}]${main}${dialog ? " ▣ dialog" : ""}  ${(f.url() || "about:blank").slice(0, 90)}  (${chars} chars)`);
      }
      console.log(`  → read one with: loop snapshot   (now includes iframes)`);
      break;
    }
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

    // ---- WhatsApp primitives (wa.mjs) — fast task pickup, guardrails baked in.
    // All hold the "reply" lock for the duration so they're first-class lock citizens
    // (gatekeep defers; no silent collision with the crons).
    case "wa-open": {                 // loop wa-open "Exact Chat Title"
      const title = rest.join(" ");
      const name = await withLock("reply", () => openChatExact(page, title));
      console.log(`  · opened exactly: ${name}`);
      break;
    }
    case "read-chat":
    case "wa-read": {                 // loop read-chat "Title" [N]
      const nArg = Number(rest[rest.length - 1]);
      const hasN = Number.isFinite(nArg) && String(rest[rest.length - 1]).match(/^\d+$/);
      const n = hasN ? nArg : 15;
      const title = (hasN ? rest.slice(0, -1) : rest).join(" ");
      const { count, messages } = await withLock("reply", () =>
        readRecent(page, title, n, { owner: process.env.LOOP_WA_OWNER }));
      console.log(`  · ${title} — last ${messages.length} of ${count} loaded:`);
      for (const m of messages) {
        const t = m.date ? m.date.toISOString().slice(5, 16).replace("T", " ") : "?";
        console.log(`    [${t}] ${m.dir === "me" ? "ME  " : "THEM"}: ${m.text.slice(0, 240)}`);
      }
      break;
    }
    case "wa-send":
    case "send-wa": {                 // loop wa-send "Title" "message text"
      const title = rest[0];
      const text = rest.slice(1).join(" ");
      if (!title || !text) throw new Error('usage: loop wa-send "<chat title>" "<message>"');
      const { ok, lastBubble } = await withLock("reply", () => sendMessage(page, title, text));
      console.log(ok ? `  ✓ sent to ${title}: ${JSON.stringify(text)}`
                     : `  ⚠ send NOT verified — last bubble was ${JSON.stringify(lastBubble)}`);
      if (!ok) process.exitCode = 1;
      break;
    }
    case "wa-chats": {                // loop wa-chats [limit]
      const lim = Number(rest[0]) || 40;
      const chats = await withLock("reply", () => listChats(page, lim));
      for (const c of chats) console.log(`    ${c.unread ? "●"+String(c.unread).padEnd(2) : "   "} ${c.title}`);
      console.log(`  · ${chats.length} chats`);
      break;
    }
    case "wa-unread": {               // loop wa-unread
      const chats = await withLock("reply", () => unreadChats(page));
      if (!chats.length) console.log("  · no unread chats");
      for (const c of chats) console.log(`    ●${c.unread}  ${c.title}  —  ${c.preview.slice(0, 80)}`);
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

      // Dedup against the Service Log (the Expediter's book) — by slug AND file, over ALL
      // attempts (not just "served"): a "failed" that actually landed (the publish-confirm
      // false-negative) must NOT auto-re-post. Retrying a genuine failure is the human's
      // call: verify the feed, then force=1. Null-slug tickets (/company/ URLs) dedup by file.
      const done = new Set();
      if (!force)
        for (const e of readLog()[name] || []) { if (e.slug) done.add(e.slug); if (e.file) done.add(e.file); }

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
        "commands: open <url> | fill <label> <text> | click <text> | press <key> | read | snapshot | frames\n" +
          "          shot [name] | click-xy <x> <y> | shot-os [name] | os-dismiss [n] | mop | strays [kill]\n" +
          "          scrape-members <group> | run <recipe> key=value ... | serve <recipe> [pantry=<dir>] [force=1]\n" +
          "          recipes | status [recipe] | reopen <recipe> | author <name> \"<goal>\" | setup | start | privacy\n" +
          "          wa-open <title> | wa-send <title> <text> | read-chat <title> [n] | wa-chats | wa-unread"
      );
  }
  if (!process.exitCode) console.log("✓ done — look at the window.");
} finally {
  await browser.close();
}
