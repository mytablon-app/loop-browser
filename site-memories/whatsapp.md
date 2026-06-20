# Cuisine: WhatsApp (web.whatsapp.com) — site model

> How WhatsApp Web works for cooking (selectors, routes, quirks). SHAREABLE method — no personal data.
> Mapped read-only (routes confirmed, destructive triggers NOT pulled). Your groups/contacts are never stored here.

## Site facts
- Logged-in session persists in the profile (**only the human logs in** via QR). On open it shows "Loading your chats [N%]" — **wait for sync** before acting (poll for `Search or start` / `New chat` / `Chat list`).
- Clean Chrome UA already set (main.js) so WhatsApp doesn't reject the browser.
- Left rail buttons: **Chats · Status · Channels · Communities · Settings · Profile · New chat · Menu**. Search box = textbox **"Search or start a new chat"**.

## Routes (how-to → page → element → action)
- **Send a message** → recipe `whatsapp-send` (`open-chat {name}` → fill "Type a message" → Enter). open-chat = full match → mini-match fallback.
- **Scrape group members → CSV** → `loop scrape-members "<group>"` (group info → Search members modal → harvest; big-group modal + small-group panel both handled).
- **Turn off notifications** → **Settings** → **"Notifications Messages, groups, sounds"** → toggle buttons **"Messages"** / **"Groups"** (also switches: "Show previews", "Outgoing sounds", "Background sync"). *Account-level change → confirm before toggling.*
- **Remove someone from a group** → open the group → **"Profile details"** (the header = group info) → **"Search members"** → click the member's button → menu: **"Make group admin" · "Remove" · "Contact info" · "Message <name>"** → click **"Remove"**. **Requires you to be Group admin** ("You Group admin" shown in members; else no Remove option). **DESTRUCTIVE → stop & ask before clicking Remove.**
- **Read a group's last N days → study + roster** → `node runs/wa-read.mjs <days> "<exact group name>"` (gitignored tool): exact-title open → scroll DOWN to true present → walk UP to the N-day cutoff → dumps `runs/wa-<slug>.json` (each msg: date+sender+pushname+text) + a per-sender roster. Dates parse as **US M/D/Y** on this account; sender roster keys by phone (unsaved) / name (saved).
- **Gatekeep join requests by country** (head-chef playbook, VERIFIED on US CA 2) → open the group **by EXACT title** (see gotcha) → click the top banner **"Review N requests to join"** → the **"Pending requests"** panel opens; each row = `<number> ~<pushname> [N groups in common] Approve Reject` (buttons carry `aria-label="Approve"`/`"Reject"`). **Rule:** the group's city/country in its name = the allowed dialing code (**US CA→+1, Dubai→+971, India→+91, Saudi→+966**). Read each number; **click `[aria-label=Reject]` for any number NOT matching** — *one click, no confirmation step*. Re-query rows after each reject (they reindex) and expect new requests to keep arriving. Deterministic rule + reversible (they can re-request) → OK to act without per-person asking once the country rule is given.

## Key elements
- Group info entry = button **"Profile details"** (the chat header).
- Members section: **"<N> members"**, **"Search members"**, **"Add member"**, and "You Group admin" if you're an admin.
- Member action menu (after clicking a member in Search members): **Make group admin / Remove / Contact info / Message**.

## Quirks / gotchas
- **Message DIRECTION (me vs them): read the sender, NOT CSS.** The old `message-in`/`message-out` classes are gone — bubbles now carry obfuscated atomic classes (`x1g5lz36`…) that churn every release. The durable signal is inside **`data-pre-plain-text`**: it embeds the sender, e.g. `[09:10, 5/14/2026] <You>: ` vs `[09:37, 5/14/2026] <Contact>: `. Parse the trailing `name:` → matches the account owner's name = outgoing, else incoming. (Used by `runs/wa-dm-read.mjs`/`wa-dm-batch.mjs`.)
- **DM readers** (gitignored, `runs/`): `wa-list.mjs` walks the chat list → DM-vs-group guess; `wa-dm-batch.mjs <N> <tag> "Title"…` reads many 1:1s with direction, **hard per-chat timeout** (no 30s hangs) + heartbeat line for an external Monitor. Use `openChat` (re-acquires the search box each call) — a single cached search-box locator goes stale after the first chat switch and every later open times out.
- Member list interleaves heavy media (members' shared images show as listitems) — filter those out when scanning for real member names.
- Member search field label is "Search contacts" / "Search members".
- **Near-identical group names → fuzzy `openChat` picks the WRONG one.** "Investors Founders Dubai 2" vs "…Dubai 20/30": word-overlap scoring ties (stray "2" tokens in previews/timestamps), first-in-DOM wins. **Open by EXACT title:** click `span[title="<exact name>"]`, then **assert `#main header span[dir=auto]` === the name** before doing anything. (Fixed in `runs/wa-read.mjs`.)
- **Do NOT press `Escape` while moderating** — it closes the open chat (not just the modal), dumping you back to the empty pane.
- The pinned **"You Are Invited" admin message has `role="dialog"`** — so `[role=dialog]` queries grab it, not a real modal. Scan the whole page for controls (e.g. `aria-label=Reject`), not just `[role=dialog]`.
- Pending-request count is **live** (1→2→3 while you work); the inline "~X requested to join. Click to review." messages are HISTORY — trust the top banner count + the "Pending requests" panel.

## Safety
- Remove member / leave group / mute / clear chat / delete = **destructive → stop & ask** (hard rule). Mapping a route ≠ executing it.
- Mass actions (bulk DM, bulk remove) = mass-send → human pacing + stop & ask.
