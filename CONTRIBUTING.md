# Contributing to Loop Browser

The repo is the product: a **living method library**. `git pull` gets you everyone's
recipes and fixes; your PRs feed them back. Two things keep that safe at scale — the
**privacy boundary** and the **recipe review norm**. Read this before your first PR.

## The one hard rule: methods travel, data stays home

- **Ships:** the engine, `recipes/*.json` (steps with `{placeholders}` only), generic
  site models (`site-memories/<domain>.md`), docs.
- **Never ships:** logins/profiles, `dishes/` (cooked output + ledgers), `runs/`,
  `recipes/local/`, `site-memories/local/` — your real names, ids, paths, outreach copy.
- Enforced in layers: a **pre-commit guard** scans every staged file (installed
  automatically by `npm install`; add your own private terms to
  `site-memories/local/private-terms.txt` — it's gitignored). Don't bypass it with
  `--no-verify` unless you are certain.

## Contributing a recipe

1. **Name it `<site>.<name>.json`** — e.g. `github.star-repo.json`,
   `wikipedia.search.json`. One flat directory, so the site prefix is the namespace;
   collisions are merge conflicts, which is the point. (A few original recipes predate
   the convention — don't rename them: ledgers key on the name.)
2. **Include the metadata:**
   ```json
   {
     "name": "github.star-repo",
     "site": "github.com",
     "title": "Star a repository",
     "description": "…",
     "version": "1.0.0",
     "verifiedOn": "2026-07-05",
     "ingredients": { "repo": "<owner/name>" },
     "steps": [ … ]
   }
   ```
   `verifiedOn` = the date YOU last ran it clean against the live site. Bump `version`
   on any step change (graduation probation is version-scoped).
3. **Verify live before you PR.** A recipe that hasn't cooked isn't a method, it's a
   guess. Run it (`loop run <name>`), watch it, then commit.
4. **Method only**: every ingredient is a `{placeholder}` with a generic default
   (`"<companyId>"`, not a real one). No personal URLs, no outreach copy.

## Reviewing a recipe (maintainers + anyone who runs one)

**A recipe is executable code — review it like code.** Before merging or running a
community recipe, read every step and ask:

- Does any step act destructively (delete, pay, send, remove) without the surrounding
  flow making that the recipe's stated, obvious purpose?
- Do `open` URLs go anywhere other than the recipe's stated site? (An exfil-shaped
  `open` with data in the query string is the attack to look for.)
- Do `extract`/`outDir` paths stay inside the project (`./dishes`)?
- Outward actions (posts, DMs, invites): does the method respect pacing, and leave
  target-picking to the human?

The visible-browser design means a malicious recipe performs in front of the user —
but review is the layer that keeps it from getting that far.

## Contributing engine changes

- `npm test` must pass (the suite guards mis-send classes — heal refusals, named-only
  input binding, iframe/shadow behavior, upload interception). CI runs it on every PR.
- Keep the architecture: **no LLM in the hot path** (the brain authors/heals, never
  runs a cook), local-first, nothing phones home.
- New step verbs need: implementation in `runStep`, a test, and a line in SKILL.md +
  CLAUDE.md's verb list.
- macOS/Windows/Linux: don't assume macOS — gate platform-specific code (see
  `PLATFORMS.md` for what's mac-only today).

## Site models (`site-memories/<domain>.md`)

Ship the **generic model** — how the site's UI works (routes, roles/labels, quirks,
safety notes). Account state, real group/contact names, your history → the gitignored
`site-memories/local/` overlay. The whatsapp/linkedin packs show the split.
