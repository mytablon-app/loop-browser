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

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { connect, activePage, runStep, withRetry, captureFailure, captureIncident, captureAuthoringContext, harvestMembers, ensureBrowser, isBrowserUp, installSkill, profileDir, dirInfo, fmtBytes } from "./lib.mjs";

const RECIPES_DIR = new URL("./recipes/", import.meta.url);
const [cmd, ...rest] = process.argv.slice(2);

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
  console.log(dim("     • Only localhost:9222 (CLI ↔ your browser) and the sites YOU drive,"));
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
    console.log("✓ Loop Browser is already running (listening on :9222).");
  } else {
    process.stdout.write("· starting Loop Browser… ");
    await ensureBrowser();
    console.log("ready.");
    console.log("✓ Loop Browser is running in the background. Keep working — drive it with `loop …`.");
  }
  process.exit(0);
}

const browser = await connect();
const { page, tabCount } = await activePage(browser);
console.log(`· 1 tab (reuse-only, ${tabCount} total) · front-and-center`);

try {
  switch (cmd) {
    case "open":
      await runStep(page, { do: "open", url: rest[0] });
      break;
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
      const recipe = JSON.parse(readFileSync(new URL(`${name}.json`, RECIPES_DIR)));

      // ingredients: defaults from the recipe, overridden by key=value args
      const vars = { ...(recipe.ingredients || recipe.inputs || {}) };
      for (const a of rest.slice(1)) {
        const i = a.indexOf("=");
        if (i > 0) vars[a.slice(0, i)] = a.slice(i + 1);
      }

      console.log(`▶ running recipe "${recipe.name}" (${recipe.steps.length} steps, no LLM)`);
      let broke = false;
      for (const [i, step] of recipe.steps.entries()) {
        try {
          // Guardian rung 1: retry transient failures before declaring a break.
          await withRetry(() => runStep(page, step, vars), { tries: step.tries ?? 3 });
        } catch (e) {
          // Guardian: this step truly broke. Capture evidence + offer recovery.
          const shot = await captureFailure(page, `${name}-fail-step${i + 1}`);
          const incident = await captureIncident(page, {
            recipe: name, stepIndex: i, step, vars, error: e, shot,
          });
          console.error(`\n✗ step ${i + 1}/${recipe.steps.length} (${step.do}) BROKE after retries`);
          console.error(`  reason   : ${e.message}`);
          console.error(`  url      : ${page.url()}`);
          console.error(`  📸 shot  : ${shot}`);
          console.error(`  📋 report: ${incident}`);
          console.error(`  recovery ladder:`);
          console.error(`    • heal     → Head Chef reads the report ↑ and patches recipes/${name}.json, then re-run`);
          console.error(`    • takeover → finish this step in the visible window, then resume`);
          console.error(`    • abort    → stop safely (nothing destructive attempted)`);
          broke = true;
          process.exitCode = 1;
          break; // stop the recipe — never barrel on past a break
        }
      }
      if (!broke) console.log(`✓ recipe "${recipe.name}" complete`);
      break;
    }

    default:
      console.log(
        "commands: open <url> | fill <label> <text> | click <text> | press <key> | read | snapshot\n" +
          "          run <recipe> key=value ... | recipes | author <name> \"<goal>\"\n" +
          "          setup | start | privacy"
      );
  }
  if (!process.exitCode) console.log("✓ done — look at the window.");
} finally {
  await browser.close();
}
