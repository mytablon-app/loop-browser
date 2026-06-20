# CLAUDE.md

Guides Claude Code in this repo. **Keep it tight — it loads every turn.** Lore (full brigade roster, restaurant/cuisine analogy, strategy) lives in auto-memory (`MEMORY.md`); per-restaurant cooking knowledge lives in `site-memories/<domain>.md` (loaded only when cooking that site). **Do not grow this file with narrative.**

# Loop Browser

A **visible glass Electron browser commanded from a CLI** to automate any website. It reads the page's accessibility tree (code, not pixels), finds elements, and acts — while you watch. Frequent tasks are saved as **recipes** that replay deterministically with **no LLM in the hot path**; the LLM only *authors* or *heals* a recipe.

## The lane (narrow on purpose — superb at one thing, not a general assistant)
Loop **authors, runs, or heals a recipe that drives the visible browser to cook one dish in one restaurant (site).** The LLM appears only to author/heal — **never in a running cook.**
- **Always:** target by role/label/text; record cooked dishes to the Service Log; tidy up after a cook; verify before declaring done.
- **Ask first:** anything destructive/irreversible/mass-send; outward-facing content (posts, DMs); changing account settings.
- **Never:** type credentials (only the human logs in); blast batches without pacing; bypass a platform throttle; ship personal data.
- **Out of lane** (general research, unrelated features) → take the smallest in-lane action or stop & ask. Don't wander.

### Loop Mode vs Owner Mode (two states — ANNOUNCE every flip; details → memory `owner-loop-mode`)
- **🔒 Loop Mode ON** — blinders on, cooking one dish. Micro-memory = ONLY this site's cuisine pack + this dish. Fast, no deliberation beyond the dish. Off-dish → don't improvise; stop and hand back to the owner (fail-fast beats wandering). **Always mop** (Mopper clears scratch/drafts) as the closing step before handing back.
- **🔓 Owner Mode (OFF)** — strategy, research, design, build, discuss. Full context + general tools.
- **Switch ON** to execute a named dish (cook/run/serve/send X, a recipe, a batch); **OFF** to think/plan/build/discuss or when a cook hits something out of lane. Owner can force it: **"loop mode on/off."** Open every cooking turn with `🔒 Loop Mode ON (memory: <pack> + <dish>)`, else `🔓 Owner Mode`.
- **Decisive test** (not "am I in the browser"): **is there ONE defined, bounded dish on ONE named site?** → ON (read-only counts — e.g. "read group X → study"). Open-ended exploration/research → OFF. Building a tool = OFF; running/verifying it = ON (announce the flip).
- **Realize ON:** known recipe → `loop run`/`serve`; brain needed → delegate to `loop-cook` subagent. In-chat blinders = fallback (can't be hard-enforced inside Claude Code).

## Kitchen vocabulary (canonical)
- **Recipe** = `recipes/<name>.json` — fixed steps = the method. **Ingredients** = data gathered at cook time (never baked in). **Dish** = the cooked output/automation.
- **Line Cook** = `loop run`/`loop serve` — deterministic, no LLM, ~99% of work. **Head Chef / Brain** = the LLM — authors/heals only, off the hot path (the moat). **Owner** = the human (holds the key).
- **Porter** (`porter.mjs`) = gathers ingredients off the hot path (files, Voyager, messages). **Expediter** (`loop serve`) = picks next ticket, dedups, keeps the **Service Log**, verifies. **Sous Chef** = Guardian (retry → self-heal → incident → stop). **Mopper** = tidy-up (task = "mop"; ex-Plongeur).
- **Service Log** = `dishes/service-log.json` — every dish cooked, keyed by dish→date; record of work + dedup guard; personal → gitignored.
- (Full roster + restaurant/cuisine analogy → memory `loop-kitchen-model-full`.)

## Cuisine packs (the cook's context — load ONLY when cooking that restaurant)
Per-restaurant knowledge (selectors, flow, quirks, account-health) lives in **`site-memories/<domain>.md`** — the **generic site MODEL ships** (no personal data); your specifics (companyId, paths, account state, real names) stay private in `site-memories/local/` / `recipes/local/`. **When cooking/authoring on a site, read its cuisine pack — that's your cuisine context, and nothing else cuisine-wise.** Keep the two memories apart: the owner/strategy context stays in the chat; a cook loads only its **cuisine pack + the dish**.
**Delegation rail (default — don't cook inline in the owner chat):**
- **Known recipe, no brain needed** → just `loop run`/`loop serve` (deterministic, zero LLM, zero memory).
- **Brain needed** (author / heal / drive a not-yet-recipe'd flow) → delegate to the **`loop-cook` subagent** (`.claude/agents/loop-cook.md`): a fresh, narrow context with bounded tools that reads ONLY the site's cuisine pack + the dish — never the owner chat. It cooks, tidies, records, and returns a tight summary.

Existing packs: `site-memories/linkedin.md`, `site-memories/whatsapp.md`. Bespoke drivers: `cook-linkedin.mjs`, `cook-connect.mjs`.
**Building packs (standing practice):** build/extend a pack for **multi-dish or quirky/behind-login** restaurants; keep it to the **map + cross-dish knowledge + quirks + safety** — NOT copies of recipe steps. Seed the route from prior knowledge, **verify live, capture the exact selectors.** Skip one-off public sites (the recipe alone suffices) — don't make packs that are double work. **Auto-capture is BUILT:** on a successful self-heal the engine records `target → resolved` to `site-memories/local/captured/<domain>.json` (gitignored) and tries it first next run — stale targets heal once, then never again.

## Layout
- `main.js` — Electron main: frameless glass window (macOS vibrancy / Windows acrylic), maximised, exposes **CDP on `localhost:9222`**.
- `cli.mjs` — the `loop` CLI: connects over CDP, runs single commands + recipes (Guardian-wrapped).
- `lib.mjs` — engine core: `connect`/`activePage`, `findInput`/`findClickable` (poll + deterministic self-heal), `runStep` primitives, `harvestMembers`, `captureIncident`/`captureAuthoringContext`.
- `porter.mjs` (ingredient gathering) · `servicelog.mjs` (the Service Log).
- `ui/` — `home.html`, `toolbar.html`, `preload.js` (the glass UI).
- `recipes/` — saved recipes (`*.json`). `recipes/local/` = private (gitignored).
- `bin/loop` + `bin/loop.cmd` — packaged-app CLI shim: runs bundled `cli.mjs` via the app's own Electron (`ELECTRON_RUN_AS_NODE`), so no system Node/repo needed. First launch (`maybeInstallCli()`) offers PATH install.
- `skill/loop/SKILL.md` — Claude Code skill teaching `loop`; `scripts/install-skill.mjs` installs it. · `site/` — landing page. · `scripts/` — dev tooling.

## Engine internals & gotchas (the CLI↔browser marriage)
The CLI speaks **CDP** to `localhost:9222` via Playwright `connectOverCDP`. Non-obvious wirings — touch carefully:
- **`main.js` loads `about:blank` into the root window** on purpose — without it the root CDP target never initializes and `connectOverCDP` hangs. Don't remove.
- **`activePage()` skips `about:*` and `/ui/toolbar.html`** so the CLI drives the **content** view, not the glass toolbar.
- **`app.userAgentFallback` forced to clean Chrome UA** — UA-sniffing sites (WhatsApp, etc.) reject the default Electron UA. Keep it Chrome-shaped.
- **`findInput`/`findClickable` poll then self-heal** (`healFind`): exact role/label, then deterministic fuzzy word-overlap — the free "rung 1" before any LLM. On a heal they **auto-capture** `target→resolved` (gitignored per-domain JSON) and try that first next run — so the heal cost is paid once.
- **Native OS dialogs are INVISIBLE to CDP — the #1 "stuck and can't see why" trap.** `loop shot`/`snapshot` see only the web page; a file picker / OS confirm sits *outside* it. **Diagnosis ladder:** (1) DOM — `read`/`snapshot`; (2) `loop shot` (web pixels); (3) **`loop shot-os`** (OS screenshot, LB frontmost — catches native dialogs). **Close** a native modal with **`loop os-dismiss`**. **Avoid** opening one on upload → intercept the chooser: `Promise.all([page.waitForEvent("filechooser"), <trigger>])` → `fc.setFiles(path)` (never `mouse.click` an upload button).
- **No test suite.** Verify = run a recipe live and watch; `node cli.mjs <verb>` is the smoke test.

## CLI
`open <url>` · `fill "<label>" "<text>"` · `click "<text>"` · `press <Key>` · `read` · `snapshot` (a11y tree = the brain's eyes) · `shot [name]` (web screenshot) · `click-xy <x> <y>` (vision fallback) · `shot-os [name]` (**OS** screenshot — native dialogs) · `os-dismiss [n]` (close native modal) · `author <name> "<goal>"` · `scrape-members "<group>"` · `run <recipe> key=value …` · `serve <recipe> [pantry=<dir>] [force=1]` (Expediter: next ticket → dedup/ledger → cook) · `recipes` · `setup` · `start` · `privacy`.
**Auto-launch:** any `loop` command auto-starts Loop Browser in the background if down (`ensureBrowser()`); no `npm start` needed. `loop start` launches and returns.

## Recipe format
```json
{ "name":"slug", "title":"short heading", "description":"what it does", "version":"1.0.0",
  "ingredients": { "group":"<placeholder>", "outDir":"./dishes" },
  "steps": [ { "do":"open","url":"…" }, { "do":"fill","target":"<label>","value":"{group}" } ] }
```
Step verbs: `open · fill · click · press · wait · assert · read · snapshot · extract · click-xy · scrape-members · open-chat`.
**Target by role/label/text, never coordinates** (`click-xy` = vision fallback only). Use `{placeholders}` for ingredients. `recipes/local/` = private overlay (real URLs/paths), shadows shipped templates; a `ticket` block + `loop serve` cooks from a pantry of tickets.

## Authoring & healing (the brain's two jobs)
- **Author:** `loop open` → `loop snapshot` (read real labels) → write `recipes/<name>.json` → `loop run` to test. (`loop author` scaffolds + captures a brief.) Read the site's cuisine pack first.
- **Heal:** on a break the Guardian writes `runs/<recipe>-incident.json` (failing step + live a11y snapshot). Find the element there, patch that step's `target`, bump `version`, re-run.

## The git boundary (CRITICAL)
- **Ships:** engine (`main/cli/lib/ui` + `porter`/`servicelog`), `recipes/*.json` (method only), **`site-memories/*.md` (generic site MODELS — how a public site works; scrubbed of personal data)**, `skill/`, `site/`, docs.
- **Never ships (gitignored):** `.loop-profile/` (login = the key), `dishes/` (incl. `service-log.json` — work record), `runs/`, `recipes/local/` + **`site-memories/local/`** (our specifics: companyId, paths, account state, real names), `.claude/`, DMG/EXE. *Recipe + site-model travel; meal, pantry, key, our specifics stay home.* `grep` for personal data before committing.
- **HARD RULE — no secret/private data ever ships** (passwords, tokens, keys, sessions, private recipes). 4 layers, never weaken: `.gitignore` → npm `files` allowlist (`recipes/*.json`, NEVER `recipes/`) → `.npmignore` → publish guard `scripts/check-no-secrets.mjs` (`prepublishOnly`, gates manual + CI). A real leak was caught here once.

## Hard rules
- **Only the human logs in** — never type credentials. If logged out, stop & ask.
- **Stop & ask** on uncertainty or anything destructive/irreversible (delete, pay, mass-send).
- **Human-like & watchable:** deliberate pacing; cook one step at a time, observing each — never blast batches or reopen the app in a loop.
- (Per-platform operating rules — e.g. LinkedIn connection-request throttle/health — live in that site's cuisine pack.)

## Run / dev
- `npm start` — launch Loop Browser (CDP :9222); not required (`loop` auto-launches) but the dev way.
- `node cli.mjs <args>` (or `loop …` after `npm link`). · `npm run site` — landing site + counter at :8099. · `npm run dist` / `dist:win` — mac DMG / Windows EXE.

## Distribution (SHIPPED — on npm)
- `loop-browser` published. Headline install = **`npx loop-browser setup`** (skill + start). `npm i -g loop-browser` puts `loop` on PATH.
- **`electron` in `peerDependencies`** (electron-builder forbids it in `dependencies`); npm 7+ auto-installs for npx. Don't move it.
- **Publishing is manual** (Trusted-Publishing CI fails — `id-token` not granted): bump version, `npm publish` with a bypass-2FA token. `prepublishOnly` guard runs either way.

> Full history, decisions, per-recipe + per-cuisine notes live in auto-memory (`MEMORY.md`) and `site-memories/`.
