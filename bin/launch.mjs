#!/usr/bin/env node
// loop-browser — launch the Loop Browser desktop app.
// This is the `npx loop-browser` / global-install entry point: it spawns the
// bundled Electron on this package, so a user needs no installer (.dmg/.exe) and
// — because the Electron binary is pulled by npm (no "Mark of the Web") — it
// runs even on Windows machines where Smart App Control blocks the downloaded .exe.
//
// (The packaged-app shims bin/loop + bin/loop.cmd are a different thing — they run
//  the CLI inside an INSTALLED build. This launcher starts the app from npm.)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

// The `electron` package's main export is the absolute path to the Electron binary.
const require = createRequire(import.meta.url);
const electron = require("electron");
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const child = spawn(electron, [appRoot, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 0));
