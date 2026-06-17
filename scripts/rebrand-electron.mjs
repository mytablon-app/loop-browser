// Dev rebrand: rename the bundled Electron.app to "Loop Browser" + swap its icon,
// so the macOS menu bar / dock show our name instead of "Electron".
// Runs as `prestart` before every `npm start`. (node_modules is reinstalled-safe:
// this re-applies each launch. The real packaged app uses electron-builder's productName.)

import { execSync } from "child_process";
import { existsSync, copyFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const root = fileURLToPath(new URL("..", import.meta.url));
const app = path.join(root, "node_modules", "electron", "dist", "Electron.app");
const plist = path.join(app, "Contents", "Info.plist");
const icns = path.join(root, "assets", "loop.icns");
const NAME = "Loop Browser";

if (!existsSync(app)) {
  console.error("rebrand: Electron.app not found (run npm install) — skipping");
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

// re-sign ad-hoc so macOS still launches the modified bundle
try {
  execSync(`codesign --force --deep --sign - "${app}"`, { stdio: "ignore" });
} catch {}

console.log(`✓ rebranded Electron → "${NAME}"`);
