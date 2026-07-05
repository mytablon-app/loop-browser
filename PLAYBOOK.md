# The Cook's Playbook — field lessons, so you don't re-pay for them

> Every rule here was paid for with a real failure on a real site. The engine bakes many
> of them in (`lib.mjs` finders, the Guardian, mop); this file is for the **brain** — the
> LLM authoring or healing a recipe — and for humans debugging a cook. Read it before
> cooking an unfamiliar flow. It is generic: no personal data, applies to any site.

## Diagnosing a stuck cook (the ladder — LOOK before you theorize)

1. **`loop read` / `loop snapshot`** — what does the page *say* it is? (a11y tree = the truth recipes target).
2. **`loop frames`** — modals, editors, uploaders and payment widgets often render inside an **iframe** the top-frame snapshot doesn't include.
3. **`loop shot`** — web pixels. If the snapshot and the picture disagree, believe the picture.
4. **`loop shot-os`** — the #1 trap: **native OS dialogs (file pickers, confirms) are INVISIBLE to CDP.** Web tools show a healthy page while the whole app is frozen behind a picker. Close with `loop os-dismiss`, never by clicking blind.
5. **Probe the frozen DOM, don't re-run.** When a cook fails repeatedly, connect and `evaluate` small questions against the *stuck* page (is the panel open? does the field exist? what's the accessible name?). Blind re-runs on a live site repeat side effects and destroy the evidence.
6. Never experiment on a live surface. Reproduce on a scratch instance (`source scripts/instance.sh demo`) or a public page first.

## Targeting elements (where wrong-clicks come from)

- **Target by accessible name (role + label), never "first match".** A bare `[contenteditable]` / first `textbox` grab is how text ends up typed into a chat's **compose box** instead of a settings field — one Enter away from sending it to real people. The engine's `findInput` now refuses unnamed grabs; do the same in any custom probe.
- **Icon buttons take their name from a child node.** A raw `aria-label` attribute scan finds nothing and your script reports "not found" while the button sits on screen. Use role+name queries (`getByRole("button", { name })`), which read the *computed* accessible name.
- **Phantom off-screen duplicates are real.** SPAs keep dead copies of rows/buttons at negative coordinates; the first DOM match may be one. Filter to visible + on-screen before clicking (the engine's `clickRobust` does).
- **Shadow DOM hides buttons from `querySelectorAll`.** Role-based locators pierce open shadow roots; raw CSS queries don't. Prefer roles.
- **Buttons get renamed mid-flight** ("Add" → "Save" → "Done" in the same dialog, same month). Accept a small set (`/^(Save|Add|Done)$/`) for confirm buttons you must hit, and let the deterministic heal + capture absorb drift elsewhere.

## Verifying (where double-sends come from)

- **Verify on a POSITIVE signal** — the "Post successful" toast, the sent bubble, the new row — never on "the dialog disappeared" or "no error visible".
- **A failed verify is NOT proof of failure.** The action may have landed and only the check missed (late render, whitespace mismatch). **Check the live surface before re-running** — re-running an actually-successful send is how double-posts happen. Record the attempt either way.
- **Read back before committing an edit.** After typing into a rename/settings field, read the field's value and compare before clicking Save — stale text silently concatenates.
- Compare text whitespace-normalized; DOM readers collapse spaces and newlines.

## Outward actions (things that reach real people)

- **The human picks the targets.** "Send invites/messages" is never license to choose *who* or *how many* — surface the list and pause. Scarce budgets (invite credits, daily caps) are the owner's to spend.
- **Pace like a human**: one action at a time, randomized gaps, long break every few, hard stop on the platform's limit banner, a consecutive-failure breaker. Never blast a batch because the loop is cheap.
- **Escape is not a "close" key.** On many apps it closes the whole chat or discards the draft, not the modal. Close panels/modals by their named Back/X/Cancel button. (This is why `loop mop` never presses Escape.)
- Close every panel you open, **every iteration** — a leftover side-panel removes other controls from the DOM and breaks the *next* step in ways that look unrelated.

## Site physics (recurring SPA behaviors)

- **Uploads: never click the upload button.** It opens a native picker CDP can't see or close. Intercept the file chooser (persistent `page.on("filechooser")` handler — not a per-click `waitForEvent` race) or set the hidden `<input type=file>` directly.
- **Lazy-load lists don't rewind on demand.** Jumping `scrollTop=0` kills the loader; step up gently one screen at a time, bounded, and accept that deep history may simply not be reachable from the web client.
- **Wait on conditions, not clocks.** A fixed `sleep` is always wrong twice: too short on a slow day, wasted on a fast one. Poll for the element/text with a cap.
- **Type-ahead results render late and reflow.** After acting on one result, re-query the list — indexes shift.
- **A site's tab can silently die** and the instance sits on the home view; everything then "runs" against the wrong page and fails quietly. Entry points should guard with `ensureSiteTab`/`ensureWhatsApp` (the engine's wa verbs and a cron template already do).

## Authoring & healing flow (the brain's job)

1. **Recipe-first:** check `loop recipes` for an existing method before authoring; check the site's cuisine pack (`site-memories/<domain>.md`) before exploring.
2. `loop open` → `loop snapshot` → write steps that use the snapshot's **exact role/name vocabulary**. Placeholders (`{name}`) for every ingredient; no data baked in.
3. **Cook one step at a time while training** a new flow, observing each — never blast a full untested recipe at a live site.
4. **Write the recipe only after it worked live**, then version it. On a heal: patch the one failing step from `runs/<recipe>-incident.json`, bump `version`, re-run. Don't rebuild flows that broke at one step.
5. Trust is earned by repetition: a recipe **graduates** after N clean runs (`loop status`) — until then, watch it.

## Station hygiene

- One site ↔ one port ↔ one profile (`scripts/instance.sh <site>`); never point a second automation at a port already cooking, and never retarget a running instance to a different site.
- **Mop when you're done** (`loop mop`): close panels/modals, wipe scratch. A dirty station is the top cause of "worked yesterday, broke today".
- Anything personal — real names, ids, captured selectors, cooked output — lives in the gitignored `*/local/` dirs and `dishes/`/`runs/`. The repo carries **methods only**; the pre-commit guard enforces it, don't fight it.
