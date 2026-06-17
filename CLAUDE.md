# Loop Browser

A **visible glass Electron browser you command from a CLI** to automate any website. It reads the
page's accessibility tree (code, not pixels), finds elements, and acts — while you watch. Frequent
tasks are saved as **recipes** that replay deterministically with **no LLM in the hot path**; the
LLM only shows up to *author* or *heal* a recipe.

## The kitchen model (canonical — keep all copy/code consistent with this)
- **Kitchen** = Loop Browser (the Electron app) + the engine.
- **Recipe** = a saved flow `recipes/<name>.json` — fixed steps. The *method*.
- **Ingredients** = your data, passed at cook time (`group="…"`). Never baked into the recipe.
- **Dish** = the cooked output (e.g. a CSV) = an automation.
- **Line Cook** = running a recipe (`loop run`) — deterministic, fast, **no LLM**. ~99% of the work.
- **Head Chef** = the **`loop` CLI** (the chef who cooks).
- **Brain / wisdom** = the **LLM (Claude Code)** — authors a new recipe or heals a broken one. Twice only.
- **Guardian** = on a break: retry → screenshot → incident report → stop safely. Never guesses.
- **Owner** = the human. Holds the key — **only the human logs in.**

## Layout
- `main.js` — Electron main: frameless glass window (platform-aware: macOS vibrancy / Windows acrylic), maximised, exposes **CDP on `localhost:9222`**.
- `cli.mjs` — the `loop` CLI: connects over CDP, runs single commands + recipes (Guardian-wrapped).
- `lib.mjs` — engine core: `connect`/`activePage`, `findInput`/`findClickable` (poll + deterministic self-heal), `runStep` primitives, `harvestMembers`, `captureIncident`/`captureAuthoringContext`.
- `ui/` — `home.html`, `toolbar.html`, `preload.js` (the glass UI).
- `recipes/` — saved recipes (`*.json`). `recipes/local/` = private (gitignored).
- `skill/loop/SKILL.md` — Claude Code skill that teaches `loop`; `scripts/install-skill.mjs` drops it into `~/.claude/skills/`.
- `site/` — static landing page (+ `api/downloads.js` = Vercel download counter).
- `scripts/` — `rebrand-electron` (dev), `gen-icon`, `install-skill`, `dev-server` (serves site + live counter).

## CLI
`loop open <url>` · `fill "<label>" "<text>"` · `click "<text>"` · `press <Key>` · `read` · `snapshot`
(page as role/name tree — the brain's eyes) · `shot [name]` (screenshot for vision fallback) ·
`click-xy <x> <y>` (vision fallback click) · `author <name> "<goal>"` · `scrape-members "<group>"` ·
`run <recipe> key=value …` · `recipes` (list). The app must be running; `loop` finds it on the fixed local port.

## Recipe format
```json
{ "name":"slug", "title":"short heading", "description":"what it does", "version":"1.0.0",
  "ingredients": { "group":"<placeholder>", "outDir":"./dishes" },
  "steps": [ { "do":"open","url":"…" }, { "do":"fill","target":"<label>","value":"{group}" } ] }
```
Step verbs: `open · fill · click · press · wait · assert · read · snapshot · extract · click-xy · scrape-members`.
**Target by role/label/text, never coordinates** (`click-xy` = vision fallback only). Use `{placeholders}` for ingredients.

## Authoring & healing (the brain's two jobs)
- **Author:** `loop open` → `loop snapshot` (read the real role/name labels) → write `recipes/<name>.json` → `loop run` to test. (`loop author` captures a brief + scaffolds the file.)
- **Heal:** on a break the Guardian writes `runs/<recipe>-incident.json` (failing step + live a11y snapshot). Find the element there, patch that step's `target` in `recipes/<name>.json`, bump `version`, re-run.

## The git boundary (CRITICAL)
- **Ships:** engine (`main/cli/lib/ui`), `recipes/` (method only — placeholder ingredients, **no personal data**), `skill/`, `site/`, docs.
- **Never ships (gitignored):** `.loop-profile/` (login = the key), `dishes/` + `*-members.csv` (output), `runs/` (screenshots), `.claude/`, the DMG/EXE. *The recipe travels; the meal, the pantry, and the key stay home.* `grep` for personal data before committing.

## Hard rules
- **Only the human logs in** — never type credentials. If logged out, stop and ask.
- **Stop & ask** on uncertainty or anything destructive/irreversible (delete, pay, mass-send).
- **Human-like & watchable:** deliberate pacing; run/train the cook **one step at a time, observing each** — never blast batches or reopen the app in a loop.

## Run / dev
- `npm start` — launch Loop Browser (CDP :9222). Required for `loop` to connect.
- `node cli.mjs <args>` (or `loop …` after `npm link`).
- `npm run site` — serve the landing site **with a working download counter** at :8099.
- `npm run dist` — build the macOS DMG. `npm run install-skill` — install the Loop skill.

## Product direction (planned, not built)
Closed/proprietary app (sealed engine via Electron fuses + signing) but **unlimited usage** (any site/dish, no throttle); cross-platform (mac DMG + win EXE from one codebase via CI); a **recipe ecosystem** (official + user-authored, shareable because recipes are method-only).

> Full history, decisions, and per-recipe notes live in the auto-memory (`MEMORY.md` index).
