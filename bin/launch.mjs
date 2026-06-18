#!/usr/bin/env node
// `loop-browser` / `npx loop-browser` — start the Loop Browser desktop app.
//
// Starts it in the BACKGROUND and returns right away, so your terminal (or your
// Claude Code session) stays free to keep working. The app keeps running until
// you close its window — no Ctrl+C, nothing to get stuck attached to.
//
//   npx loop-browser          start the app (background)
//   npx loop-browser setup    install the Claude Code skill, then start
//
// (The packaged-app shims bin/loop + bin/loop.cmd are a different thing — they run
//  the CLI inside an INSTALLED build. This launcher starts the app from npm.)
import { ensureBrowser, isBrowserUp, installSkill } from "../lib.mjs";

const arg = (process.argv[2] || "").toLowerCase();

if (arg === "setup") {
  const dest = installSkill();
  if (dest) console.log(`✓ Claude Code skill installed → ${dest}`);
}

if (await isBrowserUp()) {
  console.log("✓ Loop Browser is already running (listening on :9222).");
} else {
  process.stdout.write("· starting Loop Browser… ");
  await ensureBrowser();
  console.log("ready.");
  console.log("✓ Loop Browser is running in the background (listening on :9222).");
}
console.log("  It stays open — keep working. Quit by closing its window.");
if (arg === "setup") console.log("  You're set up — now just talk to Claude Code; it drives the browser for you.");
process.exit(0);
