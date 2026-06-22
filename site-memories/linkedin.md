# Cuisine: LinkedIn — site model

> How LinkedIn works for cooking (selectors, flows, quirks). SHAREABLE method — no personal data.
> Your specifics (companyId, pantry path, note copy, account state) live in `recipes/local/` (private), NOT here.

## Site facts
- Heavy **shadow DOM** composer — many controls aren't in the a11y tree; find via `page.evaluate` shadow-walk → coords → `mouse.click`.
- **Voyager API, CSRF from the page:** read `JSESSIONID` from `document.cookie` inside `page.evaluate` (no external bridge). Profile name+headline: `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=<slug>` (headline returns in the member's own language). Outbound invites (for connect dedup): `/voyager/api/voyagerRelationshipsDashSentInvitationViews?q=invitationType&...&invitationType=CONNECTION`.
- Clean Chrome UA is already set (main.js) so LinkedIn doesn't reject the browser.

## Flow: company spotlight post (image + caption + photo-tag)
Company admin posts URL: `linkedin.com/company/<companyId>/admin/page-posts/published/`. Steps:
1. open admin URL → **wait ~8s** (SPA settle, else "Start a post" times out "waiting for navigation").
2. click **"Start a post"** → composer; caption editor = textbox `Text editor for creating content`.
3. **photo:** find "Add media" (shadow), upload via **filechooser intercept** `Promise.all([page.waitForEvent("filechooser"), click])` → `fc.setFiles` (fallback: setInputFiles on `#media-editor-file-selector__file-input` + `os-dismiss` the native picker). Verify render = an "Alternative text"/"Edit background" button appears.
4. **tag:** `Tag` btn → click the face (largest dialog img, ~0.45/0.30) → type the real name → wait ~20s → match cascade (slug-in-html → name+headline-prefix → exact-name → headline-overlap → single) → click → `Add` (enabled = confirmed). **On no-match/abort MUST exit the tag panel** (click Back until media-editor "Next" is reachable) or the caption stage is never reached.
5. **Next** (shadow coords) → fill caption → **Post** (exact) → **verify on the POSITIVE signal: wait for the text "Post successful" to appear** (NOT "a dialog disappeared").
- Prefetch the Voyager name+headline on the CLEAN admin page BEFORE the composer opens (Voyager 403s from composer state).
- ⚠ **After every post LinkedIn shows a "Post successful / Try Premium Page" upsell MODAL** (a persistent `role="dialog"`). Two consequences, both bit hard once: (a) **verify must key on the "Post successful" text, never on a dialog vanishing** — the old "wait for `[role=dialog]` hidden" false-negatived every successful post as "failed"; (b) the modal **must be dismissed — click "No thanks"** (or the close X) — or it stays up and **blocks the next post** ("Start a post" unclickable → cascade of fake failures). The post itself succeeded; don't trust a verify that says otherwise — **screenshot (`shot-os`) to confirm ground truth.**
- ⚠ **Upload pops a NATIVE OS file-picker in Electron** (the `waitForEvent("filechooser")` intercept doesn't always catch it here). A stuck native dialog is invisible to CDP and freezes the page → **diagnose with `loop shot-os`, clear with `loop os-dismiss`.** Prefer `setInputFiles` on the hidden `#media-editor-file-selector__file-input` over any click that can open the OS picker.

## Flow: connect to people (with a note)
- Search: `linkedin.com/search/results/people/?keywords=<kw>&network=%5B%22S%22%5D&geoUrn=<urn>&origin=FACETED_SEARCH` (+`&page=N`). network: 2nd=`["S"]`, 3rd=`["O"]`. Public geoUrns: **UAE=104305776, India=102713980, USA=103644278**.
- Harvest rows with an "Invite X to connect" anchor; skip 1st-degree (`· 1st`). A **note REQUIRES the profile-page modal** (search-row send is note-less): open profile → Connect (action-bar anchor y>60, else More menu) → "Add a note" → textarea → Send.

## ⚠ Connection-request health (account-wide throttle — read it, don't fight it)
- **"add their email to connect" modal = NOT sendable** (recipient extra-security OR ignored/declined a prior invite) → close, skip, **never enter an email**.
- **Search full of pending/follow-only (low fresh yield, many pages for nothing) = pool saturated → STOP and WAIT** for acceptances.
- Email-gates + piled-up pending = LinkedIn **throttling the whole account**; it's **account-wide** (geo/keyword switch does NOT reset). Wait days. (Current per-account state lives in the run-log, not here.)

## General
- Posts/connects are mass-send & outward-facing → human pacing + the hard rules apply.
