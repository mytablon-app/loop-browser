// Dev rebrand: turn the bundled Electron.app into a real "Loop Browser.app" so the
// macOS Dock / menu bar / Finder all show our name instead of "Electron".
// (The packaged app uses electron-builder's productName; this is for source runs.)
//
// Patching the Info.plist alone isn't enough: when the Dock's cache is stale it
// falls back to the .app FOLDER name ("Electron"), so this also renames the bundle
// folder to "Loop Browser.app" and repoints electron's path.txt. The EXECUTABLE is
// deliberately left named "Electron" — Electron derives app.isPackaged from the exe
// basename (!= "electron" ⇒ packaged), so renaming it flips dev into packaged mode
// (which wrongly fired the CLI-install prompt). Runs on every launch via lib.mjs
// maybeRebrand(); the heavy pass is cached behind a version+schema marker.

import { execSync } from "child_process";
import { existsSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const root = fileURLToPath(new URL("..", import.meta.url));
const NAME = "Loop Browser";
// Unique bundle id — stock Electron uses `com.github.Electron`, shared by every other
// dev-Electron on the machine, so LaunchServices keeps resolving the name to "Electron".
const BUNDLE_ID = "com.mytablon.loopbrowser";
// Bump to force a re-apply over an existing marker. v4 = rename the .app FOLDER only
// (NOT the executable — renaming it flips app.isPackaged true; v3 did this by mistake,
// so v4 also undoes any prior exe rename).
const REBRAND_SCHEMA = "4";

const dist = path.join(root, "node_modules", "electron", "dist");
const OLD_APP = path.join(dist, "Electron.app");
const APP_DIR = path.join(dist, `${NAME}.app`);                          // "Loop Browser.app"
const pathTxt = path.join(root, "node_modules", "electron", "path.txt"); // require("electron") reads this
const icns = path.join(root, "assets", "loop.icns");

// Operate on whichever bundle is present — already renamed, or still stock Electron.app.
let app = existsSync(APP_DIR) ? APP_DIR : OLD_APP;
let plist = path.join(app, "Contents", "Info.plist");
const markerPath = () => path.join(app, ".loop-rebranded");

// LaunchServices re-register — refreshes the Dock NAME on every launch (cheap ~100ms);
// the LS cache otherwise flaps back to the old name after churn.
const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/" +
  "LaunchServices.framework/Versions/A/Support/lsregister";
const reregister = () => { try { execSync(`"${lsregister}" -f "${app}"`, { stdio: "ignore" }); } catch {} };

if (!existsSync(app)) {
  console.error("rebrand: Electron bundle not found (run npm install) — skipping");
  process.exit(0);
}

// Cache the heavy pass (codesign --deep over ~150MB) behind a marker keyed to the
// Electron version + rebrand schema. `npm install` replaces node_modules → marker
// vanishes → rebrand re-runs automatically on the next launch.
let electronVer = "?";
try {
  electronVer = JSON.parse(
    readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8")
  ).version;
} catch {}
const want = `${electronVer}#${REBRAND_SCHEMA}`;
if (existsSync(markerPath()) && readFileSync(markerPath(), "utf8").trim() === want) {
  reregister(); // keep the Dock name fresh on every launch
  console.log(`✓ Electron already branded "${NAME}" (v${electronVer}) — skipping`);
  process.exit(0);
}

// --- Rename the .app FOLDER only (the Dock's name fallback). Leave the executable
// named "Electron" so app.isPackaged stays false in dev; undo any prior exe rename. ---
if (app === OLD_APP) {
  try { renameSync(OLD_APP, APP_DIR); app = APP_DIR; plist = path.join(app, "Contents", "Info.plist"); }
  catch (e) { console.error("rebrand: rename .app failed —", e.message); }
}
try {
  const macos = path.join(app, "Contents", "MacOS");
  const orig = path.join(macos, "Electron"), renamed = path.join(macos, NAME);
  if (existsSync(renamed) && !existsSync(orig)) renameSync(renamed, orig); // undo v3's exe rename
} catch {}
// repoint electron's path.txt at the renamed FOLDER (exe name unchanged) so require resolves
try { writeFileSync(pathTxt, `${NAME}.app/Contents/MacOS/Electron`); } catch {}

function plistSet(key, value) {
  try {
    execSync(`/usr/libexec/PlistBuddy -c 'Set :${key} ${value}' "${plist}"`, { stdio: "ignore" });
  } catch {
    try {
      execSync(`/usr/libexec/PlistBuddy -c 'Add :${key} string ${value}' "${plist}"`, { stdio: "ignore" });
    } catch {}
  }
}

plistSet("CFBundleName", NAME);
plistSet("CFBundleDisplayName", NAME);
plistSet("CFBundleIdentifier", BUNDLE_ID);  // unique id → no LaunchServices collision with stock Electron
plistSet("CFBundleExecutable", "Electron"); // keep the real binary name → app.isPackaged stays false in dev

// swap the app icon (dock / Finder) to the Loop icon
try {
  const dest = path.join(app, "Contents", "Resources", "electron.icns");
  if (existsSync(icns) && existsSync(dest)) copyFileSync(icns, dest);
} catch {}

// Make the bundle launch Loop Browser when opened STANDALONE (Dock/Finder click,
// after a full quit) instead of Electron's default welcome screen.
try {
  const shim = path.join(app, "Contents", "Resources", "app");
  mkdirSync(shim, { recursive: true });
  writeFileSync(path.join(shim, "package.json"), JSON.stringify({ name: "loop-browser", main: "main.js" }));
  writeFileSync(path.join(shim, "main.js"), `require(${JSON.stringify(path.join(root, "main.js"))});\n`);
} catch {}

// re-sign ad-hoc so macOS still launches the modified bundle
try {
  execSync(`codesign --force --deep --sign - "${app}"`, { stdio: "ignore" });
} catch {}

// Force macOS to re-read the patched name + icon, then restart the Dock to drop its
// in-memory tile-name/icon cache (one-time, on rebrand only).
reregister();
try { execSync("killall Dock", { stdio: "ignore" }); } catch {}

// Stamp the marker (inside the now-renamed bundle) so subsequent launches skip this.
try { writeFileSync(markerPath(), want); } catch {}

console.log(`✓ rebranded Electron → "${NAME}.app" (v${electronVer})`);
