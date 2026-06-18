<!-- Loop Browser -->
<p align="center"><img src="assets/loop-icon.svg" width="96" alt="Loop Browser"></p>
<h1 align="center">Loop Browser</h1>
<p align="center">A glass desktop browser you <em>command from the CLI</em> — and watch it happen.</p>

---

Loop Browser is an **Electron** browser (glass UI, tabs, address bar, light/dark) that exposes a CDP port, so a small **CLI** can drive the active tab: read the page's accessibility tree (code, not pixels), find an element, and act — navigate, type, click. Frequent tasks get saved as **recipes** that replay like a bot, with **no LLM in the hot path**.

It's **site-agnostic** — the engine doesn't know or care which website it's driving. WhatsApp is just the first *cuisine*; new ones (LinkedIn, Eventbrite, internal tools…) are added as new recipes, not by changing the engine.

## The kitchen model

| Part | What it is | Ships to git? |
|---|---|---|
| 🔥 **Kitchen** (the browser + engine) | the visible Electron window + CLI runtime | ✅ yes |
| 📋 **Recipe** (a flow) | saved steps — the *method*, generic, no personal data | ✅ yes |
| 🧂 **Ingredients** | *your* data — group names, URLs — passed at cook time | ❌ never |
| 🍽️ **Dish** (output) | the cooked result (e.g. a CSV) | ❌ never |
| 🔑 **Key** (your login) | your session/cookies — only *you* log in | ❌ never |
| 🧑‍🍳 **Line Cook** | runs a perfected recipe again and again — fast, no LLM | |
| 👨‍🍳 **Head Chef** | shows up only to *write* a new recipe or *heal* a broken one | |
| 🚨 **Guardian** | retries, screenshots the failure, stops safely — never guesses | |

**The rule:** the *recipe travels, the meal doesn't.* You download the recipe; you bring your own ingredients and your own key to cook your own dish on your own machine.

## Quick start

One command sets everything up — installs the Claude Code skill and starts the browser:

```bash
npx loop-browser setup
```

Then you're done with the terminal — **just talk to Claude Code** ("scrape this group", "post this"). Claude starts/drives the browser for you; it runs in the **background** so nothing gets stuck attached to a terminal.

Prefer the `loop` command on your PATH (so you can drive it by hand too)?

```bash
npm i -g loop-browser && loop setup
```

Then any command auto-starts the browser if it isn't running:

```bash
loop start                 # just open the window (background, returns immediately)
loop open https://example.com
loop recipes
```

> On Windows this also sidesteps Smart App Control, which blocks the unsigned `.exe` installer.

Prefer the desktop app? Grab the installer at **[loop-browser.vercel.app](https://loop-browser.vercel.app)** (macOS `.dmg` / Windows `.exe`). Or clone and run from source:

```bash
npm install        # downloads Electron; first run only
npm start          # launches the Loop Browser window (CDP on :9222)
```

**First run — log in once (your key).** In the Loop Browser window, go to the site you want to automate and sign in normally — e.g. type `web.whatsapp.com` in the address bar and scan the QR with your phone. Your session is saved to a **local, gitignored** profile (`.loop-profile/`), so you stay logged in across launches. Nobody else ever sees it.

> Tip: `npm link` once, then use `loop …` anywhere instead of `node cli.mjs …`.

Drive the active tab from another terminal:

```bash
node cli.mjs open "https://example.com"
node cli.mjs snapshot          # see the page as the brain sees it (role + name)
node cli.mjs click "Learn more"
```

## Build a distributable app (for teammates)

```bash
npm run dist     # → build/dist/Loop Browser-<version>-arm64.dmg  (macOS)
```

Teammates open the DMG and drag **Loop Browser** to Applications. The build is **unsigned** (no Apple Developer ID), so on first launch macOS will warn — right-click the app → **Open** once to allow it (or sign + notarize with an Apple Developer ID for a clean install). The packaged app is the **browser**; the **CLI** (`loop run …`) still runs from this repo for now. Logins persist per-user in the app's local profile.

## Cooking a recipe (the bot — no LLM)

```bash
node cli.mjs recipes                                  # list available recipes
node cli.mjs run scrape-group-members group="My Group Name"
```

`group="My Group Name"` is your **ingredient** — passed at cook time, never stored. The **dish** lands in `./dishes/` (gitignored). For example, `scrape-group-members` harvests every member of a WhatsApp group into `dishes/<group>-members.csv` (`name,phone`), for any group size.

## Recipes

A recipe is a small JSON file in `recipes/`:

```json
{
  "name": "demo-search",
  "version": "1.0.0",
  "ingredients": { "term": "Playwright" },
  "steps": [
    { "do": "open",  "url": "https://en.wikipedia.org/wiki/Main_Page" },
    { "do": "fill",  "target": "search", "value": "{term}" },
    { "do": "press", "key": "Enter" }
  ]
}
```

Steps: `open` · `fill` · `click` · `press` · `wait` · `assert` · `read` · `snapshot` · `extract` (generic list→CSV) · `click-xy` (vision fallback), plus site-specific primitives (e.g. `scrape-members`).

CLI also has: `loop recipes` (list), `loop author <name> "<goal>"` (capture a page brief + scaffold a recipe for the Head Chef to fill), and `loop shot` (screenshot for the brain to read). When a run breaks, the Guardian writes `runs/<recipe>-incident.json` and the Head Chef heals it by editing the recipe. Targets use **role/label/text** (stable), never pixel coordinates. Element finders **wait** for the target to appear, so slow page loads don't break a run.

- **Ship templates** in `recipes/` — method only, placeholder ingredients, **no personal data**.
- **Keep private recipes** in `recipes/local/` (gitignored).
- Each recipe is **versioned**; when the Head Chef heals one, bump the version.

## 🔐 Your data & logins never leave your machine

Gitignored, always local: your login profile (`.loop-profile/`), cooked dishes (`dishes/`, `*-members.csv`), and failure screenshots (`runs/`). Loop Browser keeps the *tool and recipes* — never your sessions, ingredients, or output.

## License

MIT
