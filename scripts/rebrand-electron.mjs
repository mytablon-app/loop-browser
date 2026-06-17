// Dev rebrand: rename the bundled Electron.app to "Loop Browser" + swap its icon,
// so the macOS menu bar / dock show our name instead of "Electron".
// Runs as `prestart` before every `npm start`. (node_modules is reinstalled-safe:
// this re-applies each launch. The real packaged app uses electron-builder's productName.)

import { execSync } from "child_process";
import { existsSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const root = fileURLToPath(new URL("..", import.meta.url));
const app = path.join(root, "node_modules", "electron", "dist", "Electron.app");
const plist = path.join(app, "Contents", "Info.plist");
const icns = path.join(root, "assets", "loop.icns");
const NAME = "Loop Browser";

// LaunchServices re-register — refreshes the Dock NAME. Cheap (~100ms), so run it
// EVERY launch even when the heavy rebrand is cached: `electron .` direct-execs the
// binary, and after rebuilds churn the LS cache the Dock otherwise falls back to the
// "Electron" binary name. (Icon cache / killall Dock stays one-time, below.)
const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/" +
  "LaunchServices.framework/Versions/A/Support/lsregister";
const reregister = () => { try { execSync(`"${lsregister}" -f "${app}"`, { stdio: "ignore" }); } catch {} };

if (!existsSync(app)) {
  console.error("rebrand: Electron.app not found (run npm install) — skipping");
  process.exit(0);
}

// Rebranding (esp. `codesign --deep` over ~150MB) is slow but only needs to run
// ONCE per Electron install. Cache a marker keyed to the Electron version; if it
// matches, skip everything so `npm start` boots fast. `npm install` replaces
// node_modules → marker vanishes → rebrand re-runs automatically.
const marker = path.join(app, ".loop-rebranded");
let electronVer = "?";
try {
  electronVer = JSON.parse(
    readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8")
  ).version;
} catch {}
if (existsSync(marker) && readFileSync(marker, "utf8").trim() === electronVer) {
  reregister(); // keep the Dock name fresh on every launch
  console.log(`✓ Electron already branded "${NAME}" (v${electronVer}) — skipping`);
  process.exit(0);
}

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

// swap the app icon (dock / Finder) to the Loop icon
try {
  const dest = path.join(app, "Contents", "Resources", "electron.icns");
  if (existsSync(icns) && existsSync(dest)) copyFileSync(icns, dest);
} catch {}

// Make the bundle launch Loop Browser when opened STANDALONE (Dock/Finder click,
// after a full quit) instead of Electron's default welcome screen. Electron runs
// Contents/Resources/app when no app path is passed on the CLI — point it at our
// real main.js. `npm start` (electron .) passes "." so it's unaffected; only the
// no-arg launch falls through to this shim.
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

// Force macOS to re-read the patched name + icon. `lsregister -f` re-registers;
// restarting the Dock drops its in-memory ICON cache (one-time, on rebrand only —
// the name refresh happens every launch via reregister() above).
reregister();
try { execSync("killall Dock", { stdio: "ignore" }); } catch {}

// Stamp the marker so subsequent launches skip this whole step.
try { writeFileSync(marker, electronVer); } catch {}

console.log(`✓ rebranded Electron → "${NAME}" (v${electronVer})`);
