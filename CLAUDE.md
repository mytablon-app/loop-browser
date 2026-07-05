# CLAUDE.md

Guides Claude Code in this repo — **self-contained: everything you need to operate Loop is here + `site-memories/<domain>.md`** (per-restaurant cooking knowledge, loaded only when cooking that site). **Keep it tight — it loads every turn; do not grow it with narrative.** Each contributor's `~/.claude` auto-memory is private and per-user — **not** required to operate, and don't assume teammates share yours.

# Loop Browser

A **visible glass Electron browser commanded from a CLI** to automate any website. It reads the page's accessibility tree (code, not pixels), finds elements, and acts — while you watch. Frequent tasks are saved as **recipes** that replay deterministically with **no LLM in the hot path**; the LLM only *authors* or *heals* a recipe.

## The lane (narrow on purpose — superb at one thing, not a general assistant)
Loop **authors, runs, or heals a recipe that drives the visible browser to cook one dish in one restaurant (site).** The LLM appears only to author/heal — **never in a running cook.**
- **Always:** target by role/label/text; record cooked dishes to the Service Log; tidy up after a cook; verify before declaring done.
- **Ask first:** anything destructive/irreversible/mass-send; outward-facing content (posts, DMs); changing account settings.
- **Never:** type credentials (only the human logs in); blast batches without pacing; bypass a platform throttle; ship personal data.
- **Out of lane** (general research, unrelated features) → take the smallest in-lane action or stop & ask. Don't wander.

### Loop Mode vs Owner Mode (two states — ANNOUNCE every flip; this section is the full spec)
- **🔒 Loop Mode ON** — blinders on, cooking one dish. Micro-memory = ONLY this site's cuisine pack + this dish; nothing else loaded or considered. **The browser instance binds the site** (multi-instance model under Run/dev): a session driving the WhatsApp instance does ONLY WhatsApp (loads only `site-memories/whatsapp.md`); LinkedIn is a *different* instance/session — cross-site means a different session, never a wider context. Off-dish → don't improvise; stop and hand back (fail-fast beats wandering). **Always mop** as the closing step — TWO parts: (1) **the browser station** — close any dialog/**modal** left open (web *or* native, e.g. a "success" popup), and leave the page on a clean view; (2) **scratch files** — drafts, screenshots, `.txt`/`.err` dumps. Keep tools/data/logs. **Write all scratch to `runs/scratch/`** (ad-hoc shots: `loop shot scratch/<name>`). **Mopping is harness-enforced at halt, not memory-dependent:** the **Stop hook** (`.claude/settings.json`, per-machine) always wipes `runs/scratch/`, and when the session has `LOOP_CDP_PORT` bound (the instance.sh launch) it also runs **`loop mop`** — which closes web side-panels/modals by accessible name (never Escape), then **health-checks the station and prints PASS/⚠** ("is all ok" at halt). `loop mop` is also a first-class command you can run anytime; it's scoped to `LOOP_CDP_PORT` so it never touches another terminal's instance, self-times-out, and wipes scratch even with the browser down. Native OS dialogs still need a manual `loop os-dismiss` (invisible to CDP). Each contributor adds the hook locally; collabs without it just `loop mop` by hand.
- **🧑 Human factor (the moment a cook touches real people — invites, DMs, posts, mass-sends):** being told to *do* X is NOT license to choose the targets/scope *for* the human. Before any send that reaches real people, **surface the who/the list and pause for the owner's call** — never auto-execute to the max or blast the first N the UI happens to load. Scarce resources especially (limited invite credits, daily caps): the human decides *who* and *how many*. These go out from the owner's name/page — pace human-like, keep it personal, never bot-blast. (Lesson: spent all 48 LinkedIn invite credits on whoever rendered first, with no owner input on who.)
- **🔓 Owner Mode (OFF)** — strategy, research, design, build, discuss. Full context + general tools.
- **Switch ON** to execute a named dish (cook/run/serve/send X, a recipe, a batch); **OFF** to think/plan/build/discuss or when a cook hits something out of lane. Owner can force it: **"loop mode on/off."** Open every cooking turn with `🔒 Loop Mode ON (memory: <pack> + <dish>)`, else `🔓 Owner Mode`.
- **⚡ Decisive test — 2 seconds, then commit** (not "am I in the browser"): request names **site + action verb + bounded object** ("send X to Y", "scrape Z", a recipe) → **🔒 ON**; contains *why/how/should/plan/build/compare* or anything unnamed/open-ended → **🔓 OFF**; **still weighing? that IS the answer → OFF** — deliberation is wide-context work (Loop = quick-but-narrow, Owner = slow-but-wide). Mis-picks self-correct cheaply: a wrong ON hands back at the first open question; a wrong OFF flips ON the moment one dish crystallizes. Read-only counts as ON ("read group X → study"). Building a tool = OFF; running/verifying it = ON (announce the flip).
- **Realize ON:** known recipe → `loop run`/`serve`; brain needed → delegate to `loop-cook` subagent. In-chat blinders = fallback (can't be hard-enforced inside Claude Code).

## Kitchen vocabulary (canonical)
- **Recipe** = `recipes/<name>.json` — fixed steps = the method. **Ingredients** = data gathered at cook time (never baked in). **Dish** = the cooked output/automation.
- **Line Cook** = `loop run`/`loop serve` — deterministic, no LLM, ~99% of work. **Head Chef / Brain** = the LLM — authors/heals only, off the hot path (the moat). **Owner** = the human (holds the key).
- **Porter** (`porter.mjs`) = gathers ingredients off the hot path (files, Voyager, messages). **Expediter** (`loop serve`) = picks next ticket, dedups, keeps the **Service Log**, verifies. **Sous Chef** = Guardian (retry → self-heal → incident → stop). **Mopper** = tidy-up (task = "mop"; ex-Plongeur).
- **Service Log** = `dishes/service-log.json` — every dish cooked, keyed by dish→date; record of work + dedup guard; personal → gitignored.
- (The terms above are the whole working vocabulary; the extended restaurant analogy is optional flavor, not needed to operate.)

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
- `wa.mjs` — WhatsApp primitives + verbs (reusable WA logic, shipped). `cook-linkedin.mjs` / `cook-connect.mjs` — bespoke LinkedIn drivers (NOT shipped — repo-local).
- `porter.mjs` (ingredient gathering) · `servicelog.mjs` (the Service Log).
- `ui/` — `home.html`, `toolbar.html`, `preload.js` (the glass UI).
- `recipes/` — saved recipes (`*.json`). `recipes/local/` = private (gitignored).
- `bin/launch.mjs` — the `loop-browser` / `npx loop-browser` bin: starts the desktop app in the **background** and returns (terminal/session stays free). `setup` arg installs the skill first.
- `bin/loop` + `bin/loop.cmd` — packaged-app CLI shim: runs bundled `cli.mjs` via the app's own Electron (`ELECTRON_RUN_AS_NODE`), so no system Node/repo needed. First launch (`maybeInstallCli()`) offers PATH install.
- `skill/loop/SKILL.md` — Claude Code skill teaching `loop`; `scripts/install-skill.mjs` installs it. · `site/` — landing page. · `scripts/` — dev tooling. · `HOW-IT-WORKS.md` — the kitchen-metaphor explainer.

## Engine internals & gotchas (the CLI↔browser marriage)
The CLI speaks **CDP** to `localhost:9222` via Playwright `connectOverCDP`. Non-obvious wirings — touch carefully:
- **`main.js` loads `about:blank` into the root window** on purpose — without it the root CDP target never initializes and `connectOverCDP` hangs. Don't remove.
- **`activePage()` skips `about:*` and `/ui/toolbar.html`** so the CLI drives the **content** view, not the glass toolbar.
- **`app.userAgentFallback` forced to clean Chrome UA** — UA-sniffing sites (WhatsApp, etc.) reject the default Electron UA. Keep it Chrome-shaped.
- **`findInput`/`findClickable` poll then self-heal** (`healFind`): exact role/label, then deterministic fuzzy word-overlap — the free "rung 1" before any LLM. On a heal they **auto-capture** `target→resolved` (gitignored per-domain JSON) and try that first next run — so the heal cost is paid once.
- **Native OS dialogs are INVISIBLE to CDP — the #1 "stuck and can't see why" trap.** `loop shot`/`snapshot` see only the web page; a file picker / OS confirm sits *outside* it. **Diagnosis ladder:** (1) DOM — `read`/`snapshot`; (2) `loop shot` (web pixels); (3) **`loop shot-os`** (OS screenshot, LB frontmost — catches native dialogs). **Close** a native modal with **`loop os-dismiss`**. **Avoid** opening one on upload → intercept the chooser: `Promise.all([page.waitForEvent("filechooser"), <trigger>])` → `fc.setFiles(path)` (never `mouse.click` an upload button).
- **No test suite.** Verify = run a recipe live and watch; `node cli.mjs <verb>` is the smoke test.

## CLI
`open <url>` · `fill "<label>" "<text>"` · `click "<text>"` · `press <Key>` · `read` · `snapshot` (a11y tree = the brain's eyes) · `frames` (iframe snapshots — modals inside iframes) · `shot [name]` (web screenshot) · `click-xy <x> <y>` (vision fallback) · `shot-os [name]` (**OS** screenshot — native dialogs; alias `os-shot`) · `os-dismiss [n]` (close native modal; alias `os-escape`) · `mop` (Mopper: close web panels/modals + wipe `runs/scratch/` + health-check; scoped to `LOOP_CDP_PORT`) · `strays [kill]` (alias `kill-strays`: find/close leftover browsers on unregistered CDP ports — the phantom "3rd window"; kills Loop procs only, never a registered site or non-Loop process) · `author <name> "<goal>"` · `scrape-members "<group>"` · `run <recipe> key=value …` · `serve <recipe> [pantry=<dir>] [force=1]` (Expediter: next ticket → dedup/ledger → cook) · `recipes` (alias `flows`; shows graduation progress) · `status [recipe]` / `reopen <recipe>` (**graduation ledger**: a recipe/driver GRADUATES after 5 clean runs, `LOOP_GRADUATE_N` or recipe `graduateAfter` to tune — then the engine stops auto-writing brain briefs; a break = REGRESSION + auto-reopen; `reopen` = deliberate re-probation) · WA verbs `wa-open/wa-send/read-chat/wa-chats/wa-unread` · `setup` · `start` · `privacy`.
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
- **Read `PLAYBOOK.md` first for any unfamiliar flow** — the shipped field lessons (diagnosis ladder, targeting, verify-positive, uploads, pacing); it exists so cooks don't re-pay for known failures.
- **Author:** `loop open` → `loop snapshot` (read real labels) → write `recipes/<name>.json` → `loop run` to test. (`loop author` scaffolds + captures a brief.) Read the site's cuisine pack first.
- **Heal:** on a break the Guardian writes `runs/<recipe>-incident.json` (failing step + live a11y snapshot). Find the element there, patch that step's `target`, bump `version`, re-run.

## The git boundary (CRITICAL)
- **Ships:** engine (`main/cli/lib/ui` + `porter`/`servicelog`/`wa`), `recipes/*.json` (method only), **`site-memories/*.md` (generic site MODELS — how a public site works; scrubbed of personal data)**, `skill/`, `site/`, docs.
- **Never ships (gitignored):** the login profile (OS app-data dir, or `~/.loop-profiles/<site>/` via `instance.sh`; legacy `.loop-profile/`) = the key, `dishes/` (incl. `service-log.json` — work record), `runs/`, `recipes/local/` + **`site-memories/local/`** (our specifics: companyId, paths, account state, real names), `.claude/`, DMG/EXE. *Recipe + site-model travel; meal, pantry, key, our specifics stay home.* `grep` for personal data before committing.
- **HARD RULE — no secret/private data ever ships** (passwords, tokens, keys, sessions, private recipes). 5 layers, never weaken: **pre-commit guard** (`.githooks/pre-commit` → `check-no-secrets.mjs --staged`, auto-installed by `npm install` via the `prepare` script; scans ALL staged files incl. emails//Users/-paths/phones + the gitignored local denylist `site-memories/local/private-terms.txt` — put YOUR real names/ids there) → `.gitignore` → npm `files` allowlist (`recipes/*.json`, NEVER `recipes/`) → `.npmignore` → publish guard (`prepublishOnly`). Real leaks were caught at both the publish AND commit layers.
- **Packaging-completeness guard** (separate gate): `scripts/check-bundled-imports.mjs` (`npm run check:bundle`) verifies every local `./` import reachable from the bundled entry points is shipped by BOTH npm `files` AND electron-builder `build.files` — else the packaged/published `loop` crashes `ERR_MODULE_NOT_FOUND`. Runs on `prepublishOnly` + every `dist`/`pack` build (a real gap shipped a broken CLI in 0.0.5).

## Hard rules
- **Only the human logs in** — never type credentials. If logged out, stop & ask.
- **Stop & ask** on uncertainty or anything destructive/irreversible (delete, pay, mass-send).
- **Human-like & watchable:** deliberate pacing; cook one step at a time, observing each — never blast batches or reopen the app in a loop.
- (Per-platform operating rules — e.g. LinkedIn connection-request throttle/health — live in that site's cuisine pack.)

## Run / dev
- `npm start` — launch Loop Browser (CDP :9222); not required (`loop` auto-launches) but the dev way. **`prestart` runs `scripts/rebrand-electron.mjs`** first — renames the Electron binary/.app so the Dock shows "Loop Browser", not "Electron" (don't rename the executable itself — that flips `app.isPackaged` and fires the CLI-install prompt).
- `node cli.mjs <args>` (or `loop …` after `npm link`). · `npm run site` — landing site + counter at :8099. · `npm run dist` / `dist:win` — mac DMG / Windows EXE (full installer/signing flow: `BUILDING.md`, `SIGNING.md`).
- **Multiple browsers at once — one site ↔ one CDP port ↔ one stable login profile (no intersection):** each instance = `LOOP_CDP_PORT` (default 9222) + `LOOP_PROFILE_DIR` (the login lives in that profile). The **same account can't run twice** (WhatsApp is single-session); same-account automations share that one instance and take turns. **The instance registry makes this automatic — `scripts/instances.mjs` (persisted at `~/.loop-profiles/instances.json`, per-machine, never committed; the FILE is the only source of truth — NOTHING site→port is hardcoded):** the FIRST time a site opens it auto-picks the next FREE port (first-come from `$LOOP_PORT_BASE`, default 9222; skips any port reserved by another site OR currently listening, even unregistered ones — the actual number is irrelevant) and REMEMBERS it. A port is then **reserved to that site for life** — even after the instance is shut down — so re-opening reuses its port + profile (**no relaunch, no relogin/reverify**) and a *different* new site never lands on it. Override only on purpose: `source scripts/instance.sh <site> <port>` (force a port) or `node scripts/instances.mjs forget <site>` (release the reservation; login profile kept). Interactive: **`source scripts/instance.sh <site>`** resolves via the registry, exports the env, and starts (or reuses) that instance; any NEW site (`source scripts/instance.sh notion`) just works. See/audit the map with **`node scripts/instances.mjs list`**. Crons set `LOOP_CDP_PORT`/`LOOP_PROFILE_DIR` directly in the launchd plist (read them from `instances.mjs list`). This is what makes Loop Mode's per-site narrowing concrete (the instance = the site). ⚠ Without a set port, a bare `loop` defaults to :9222 and **attaches to whatever's there** — so open new sites through `instance.sh`, not by retargeting a running instance.

## Distribution (repo-first)
- **Front door = `git clone` only:** `git clone … → npm install → npm link → loop setup`. README + website lead with clone; do NOT advertise `npx` / `npm i -g` / a download. The repo is canonical — the living method library (`git pull` for the latest; PR fixes back). 4 collaborators → 4× leak risk: **grep for personal data before every commit** (the git boundary above).
- **Clone is the ONLY install path (not npm)** — a published npm package is a *frozen snapshot* that can't `git pull` new recipes/cuisine packs or take heals back, so it **loses the living memory** (the whole value). Don't advertise or cut npm releases. Post-clone `npm install`/`npm link`/`npm run dist` are repo operations (deps/PATH/build), NOT npm-as-distribution — those stay.
- **`electron` in `peerDependencies`** (electron-builder forbids it in `dependencies`); npm 7+ auto-installs. Don't move it.

> Per-recipe + per-cuisine notes live in `recipes/` + `site-memories/` (this repo, shared by all contributors). Project history/strategy lives in each contributor's private `~/.claude` auto-memory — not required to operate Loop.
