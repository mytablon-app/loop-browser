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
Unsigned beta — on the SmartScreen prompt, click **More info → Run anyway**.

### ⚠️ Known gap the Windows build must close: the `loop` CLI
The whole product is the `loop` command. On macOS the app installs it on first launch
(`maybeInstallCli()` in `main.js:233`) by symlinking the bundled `bin/loop` shim into
`/usr/local/bin`. **That path early-returns on non-darwin (`process.platform !== "darwin"`),
and `bin/loop` is a POSIX shell script.** So the Windows `.exe` currently installs and runs the
*browser*, but does **not** put `loop` on the user's PATH.

To ship a usable Windows build, add a Windows equivalent:
1. A `bin/loop.cmd` that runs the bundled CLI via the app's Electron-as-Node
   (`ELECTRON_RUN_AS_NODE=1 "<app>\Loop Browser.exe" cli.mjs %*`) — mirror what `bin/loop` does on macOS.
2. A Windows branch in `maybeInstallCli()` that adds that shim to the user's PATH (or drops it in a
   dir already on PATH), instead of the `/usr/local/bin` symlink.

Until that's in, verify the `.exe` at least launches the browser and CDP (`localhost:9222`), then
treat CLI-on-PATH as the follow-up before calling Windows "shipped" to end users.

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
