# Building & shipping the installers

Loop Browser ships as a desktop app per OS, hosted on **GitHub Releases**. The website
(`site/index.html`) points its download buttons at the *latest* release's assets, using
**fixed asset names** so the site never needs editing per release:

| OS      | Build host        | Command            | Output (`build/dist/`)     | Release asset name        |
| ------- | ----------------- | ------------------ | -------------------------- | ------------------------- |
| macOS   | a Mac             | `npm run dist`     | `Loop-Browser-mac.dmg`     | `Loop-Browser-mac.dmg`    |
| Windows | a Windows machine | `npm run dist:win` | `Loop-Browser-win.exe`     | `Loop-Browser-win.exe`    |

> The asset names are pinned by `build.*.artifactName` in `package.json`. **Don't rename the
> uploaded assets** — the site URL is `…/releases/latest/download/Loop-Browser-mac.dmg` (and `-win.exe`).
> A binary must never be committed to git (`build/` is gitignored) — it only lives on the Release.

## macOS build (on a Mac)
```sh
npm install
npm run dist          # → build/dist/Loop-Browser-mac.dmg  (universal: Apple Silicon + Intel)
```
Unsigned beta — first launch needs right-click → **Open**.

## Windows build (on a Windows machine) — for the Windows collaborator
You need **Node 18+** and Git. electron-builder converts `assets/loop-dock-icon.png` (512px) to a
Windows `.ico` automatically, so no extra icon work is needed.
```sh
git clone https://github.com/mytablon-app/loop-browser.git
cd loop-browser
npm install
npm run dist:win      # → build/dist/Loop-Browser-win.exe  (NSIS installer, x64)
```
Unsigned beta — on the **SmartScreen** prompt, click **More info → Run anyway**.

> ⚠️ **Smart App Control (SAC) blocks unsigned apps with NO override** (no "Run anyway" — just
> "Okay" / "Get apps from the Store"). SAC is on by default on some fresh Windows 11 clean installs.
> Turning SAC off is **irreversible** (needs a Windows reinstall to re-enable) — don't do that to test.
> The real fix is code-signing: see **SIGNING.md** (Azure Trusted Signing). To test an unsigned build,
> use a Windows machine/VM that doesn't have SAC enabled.

### The `loop` CLI on Windows
The whole product is the `loop` command, and the Windows build ships it too:
1. **`bin/loop.cmd`** — the Windows shim. Runs the bundled CLI via the app's own Electron-as-Node
   (`ELECTRON_RUN_AS_NODE=1 "<install>\Loop Browser.exe" cli.mjs %*`), so the user needs neither a
   separate Node install nor the repo. Mirrors the POSIX `bin/loop`. Bundled via `build.files` (`bin/**/*`).
2. **`maybeInstallCli()` (`main.js`)** now has a Windows branch: on first launch it offers a one-line
   PowerShell command that appends the bundled `…\resources\app\bin` dir to the **user** PATH (no admin,
   persistent, no `setx` truncation). `loop` then resolves to `loop.cmd` via `PATHEXT`. As on macOS,
   nothing changes automatically — the user runs the copied command, then opens a new terminal.

Verify the `.exe` launches the browser + CDP (`localhost:9222`), then in a fresh terminal confirm
`loop recipes` and a live `loop run …` against the running app.

## Cutting a Release (host the assets)
1. Create a GitHub Release (tag e.g. `v0.0.1`), **not** a draft/prerelease (so `latest` resolves).
2. Upload `Loop-Browser-mac.dmg` and/or `Loop-Browser-win.exe` as assets, names exactly as above.
3. The live site's buttons pick them up immediately — no redeploy needed.

With `gh` installed:
```sh
gh release create v0.0.1 \
  "build/dist/Loop-Browser-mac.dmg" \
  "build/dist/Loop-Browser-win.exe" \
  --title "Loop Browser v0.0.1 (beta)" --notes "First public beta."
```
