---
name: loop
description: >-
  Drive Loop Browser — a visible glass desktop browser commanded from the CLI — to automate
  any website. Use when the user wants to automate a web task, "cook a dish", run/author/heal a
  Loop recipe, scrape a page, fill a form, or says "loop", "loop browser", "run the recipe",
  "automate this site". The `loop` CLI connects to the running Loop Browser over a local port;
  you read the page's accessibility tree (code, not pixels), find elements, and act — while the
  user watches.
---

# Loop Browser

Loop Browser is a real, **visible** glass browser you command from the terminal with the `loop`
CLI. The window is Chromium and exposes a local CDP port; `loop` connects to it automatically
(no port config). **You never launch it manually** — any `loop` command **auto-starts** Loop
Browser in the background if it isn't already running, then drives it; it stays open afterward.
So just run the command you need (e.g. `loop open …`) and the window appears. To start it
explicitly without acting, use `loop start` (background, returns immediately).

If the `loop` command itself isn't found, the user hasn't installed it — tell them to run
`npm i -g loop-browser` then `loop setup` (installs this skill + starts the browser). That's the
whole setup; after it, they just talk to you.

## The kitchen model (how to think about this)
- **Recipe** = a saved recipe (`recipes/<name>.json`) — fixed steps targeting elements by role/label/text.
- **Line Cook** = running a recipe (`loop run`). Deterministic, fast, **no LLM** — this is ~99% of work.
- **Head Chef** = the `loop` CLI (the chef who cooks). **YOU (Claude/the LLM) are its brain & wisdom** — you show up only to **author** a new recipe or **heal** a broken one.
- **Guardian** = on a break the run stops, screenshots, and writes an incident report. Never guesses.
- **The Owner** = the human. Only they log in (the "key"). You cook *inside* their session but never
  handle credentials, and never do destructive/irreversible actions without asking.

## Commands
- `loop open <url>` — navigate the active tab.
- `loop snapshot` — **your eyes**: the page as an accessibility tree (role + name). Run this BEFORE
  authoring steps or clicking into something unfamiliar — recipe targets use this exact vocabulary.
- `loop read` — current title + URL.
- `loop fill "<label>" "<text>"` — type into a field (matched by label/placeholder/role; types char-by-char).
- `loop click "<text>"` — click by role/label/visible text. Finders auto-wait + self-heal on minor drift.
- `loop press <Key>` — e.g. `Enter`, `Escape`, `PageDown`.
- `loop shot [name]` — screenshot to `runs/<name>.png` (coords are CSS px). Vision fallback for elements
  NOT in the accessibility tree (canvas, image-only buttons): look at the PNG, read coords, then…
- `loop click-xy <x> <y>` — click at coordinates (the vision fallback action).
- `loop recipes` — list saved recipes.
- `loop privacy` — show what Loop stores locally (login profile, dishes, runs, private recipes) + the no-upload guarantee. Use when the user asks "what data do you keep?" / "is my data safe?".
- `loop run <recipe> key=value …` — run a saved recipe with ingredients. Deterministic, no LLM.
- `loop author <name> "<goal>"` — capture an authoring brief (`runs/<name>-authoring.json`: the page's
  accessibility snapshot + goal) and scaffold `recipes/<name>.json`. THEN you write the steps (see below).
- `loop scrape-members "<group>" [outDir]` — (WhatsApp-specific) harvest the open group's members → CSV.

## Authoring a recipe (your main job, as the brain)
0. If a cuisine pack exists for the site (`site-memories/<domain>.md`), read it FIRST — it holds the known selectors/flow/quirks so you don't re-explore. That + the dish is your only context; don't carry unrelated memory into a cook.
1. `loop open <url>` to the starting page, then `loop snapshot` to see the real role/name labels.
2. (Optional) `loop author <name> "<goal>"` to capture a brief + scaffold the file.
3. Write `recipes/<name>.json`:
   ```json
   {
     "name": "<name>",
     "version": "1.0.0",
     "description": "<what it does>",
     "ingredients": { "outDir": "./dishes" },
     "steps": [
       { "do": "open",  "url": "https://…" },
       { "do": "wait",  "ms": 2000 },
       { "do": "fill",  "target": "<label>", "value": "{someInput}" },
       { "do": "click", "target": "<role/label/text>" },
       { "do": "extract", "rows": "<css>", "fields": { "col": { "sel": "<css>", "attr": "href" } }, "name": "<name>", "outDir": "{outDir}", "min": 1 }
     ]
   }
   ```
   Step verbs: `open · fill · click · press · wait · assert · read · snapshot · extract · click-xy · scrape-members`.
   Target by **role/label/text**, never pixel coordinates (use `click-xy` only as a vision fallback).
   Use `{placeholders}` for ingredients; pass them at run time as `key=value`.
4. Test with `loop run <name> …` and iterate until it's clean.

## Healing a broken recipe
When `loop run` hits a real break, the Guardian stops and writes **`runs/<recipe>-incident.json`**
(failing step, the target it sought, the reason, the live accessibility snapshot, a screenshot).
To heal: read that incident file, find the element in `accessibilitySnapshot` that now matches the
intent, **edit the failing step's `target` in `recipes/<recipe>.json`**, bump the `version`, and re-run.
(There is no `loop heal` command — healing IS you editing the recipe from the incident report.)

## Hard rules
- The app must be running; `loop` connects to it on a fixed local port — never ask the user for a port.
- Targets by role/label/text. Keep the worked tab visible; the user watches.
- **Only the human logs in.** Never type credentials. If a site is logged out, stop and ask them to sign in.
- On uncertainty or anything destructive/irreversible (delete, pay, send to many people) — **stop and ask the human first.**
- A recipe (the method) is shareable and contains no personal data. The cooked output ("dish") and the
  login session stay on the user's machine — never commit or upload them.
