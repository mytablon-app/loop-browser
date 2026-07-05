# Platform support — the honest matrix

Loop is developed and battle-tested on **macOS**. Everything below is labeled truthfully:

- **TESTED** — used in real cooks, regularly.
- **WIRED** — code exists and should work; not exercised recently. Reports/PRs welcome.
- **BEST-EFFORT** — a sensible fallback that degrades with a clear error, not silently.
- **MAC-ONLY** — skipped or unavailable elsewhere, by design.

| Capability | macOS | Windows | Linux |
|---|---|---|---|
| Engine + CLI (`loop …`, recipes, heal, graduation) | TESTED | WIRED | WIRED |
| Desktop app (`npm start` / `loop start`) | TESTED | WIRED (`dist:win` builds an installer) | WIRED (dev-run via `npm start`) |
| Login profiles per site (`profileDir`) | TESTED | WIRED (`%APPDATA%`) | WIRED (`~/.config`) |
| `loop shot-os` (native-dialog screenshot) | TESTED (`screencapture`) | WIRED (PowerShell screen grab) | BEST-EFFORT (`gnome-screenshot` → `import` → `scrot`) |
| `loop os-dismiss` (close native dialog) | TESTED (System Events Escape) | WIRED (SendKeys Escape) | BEST-EFFORT (`xdotool`, install it) |
| `scripts/instance.sh` (multi-instance helper) | TESTED (bash/zsh) | Use **Git Bash**, or set `LOOP_CDP_PORT` + `LOOP_PROFILE_DIR` manually | TESTED-equivalent (bash) |
| Pre-commit privacy guard | TESTED | WIRED (Git for Windows runs sh hooks) | WIRED |
| Dock/app rebrand (`prestart`) | TESTED | MAC-ONLY (auto-skipped; window title is correct anyway) | MAC-ONLY (auto-skipped) |
| Scheduled cooks (crons) | TESTED (launchd; set `LOOP_CDP_PORT`/`LOOP_PROFILE_DIR` in the plist) | Use **Task Scheduler** with the same env vars | Use **systemd timers**/cron with the same env vars |

## Notes for non-mac contributors

- **Nothing about the core loop is mac-specific**: CDP, Playwright, recipes, the heal
  ladder, graduation, the privacy guards — all plain Node + Electron.
- The two OS-level verbs (`shot-os`, `os-dismiss`) exist because **native dialogs are
  invisible to CDP** on every OS — each platform just needs its own "screenshot the
  screen" and "send Escape" primitives. If yours misbehaves, that's a small, welcome PR.
- If you verify a WIRED row on your platform, PR the label up to TESTED with a note.
