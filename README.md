<!-- Loop Browser -->
<p align="center"><img src="assets/loop-icon.svg" width="96" alt="Loop Browser"></p>
<h1 align="center">Loop Browser</h1>
<p align="center">A glass desktop browser you <em>command from the CLI</em> — and watch it happen.</p>

---

Loop Browser is an **Electron** browser (glass UI, tabs, address bar, light/dark) that exposes a CDP port, so a small **CLI** can drive the active tab: read the page's accessibility tree (code, not pixels), find an element, and act — navigate, type, click. Frequent tasks get saved as **recipes** that replay like a bot, with no LLM in the hot path.

## The kitchen model

| Part | What it is |
|---|---|
| 🔥 **Kitchen** (the browser) | the visible Electron window + CLI runtime |
| 🧂 **Ingredients** (inputs) | values that change each run (`text=`, `to=`) |
| 📋 **Recipe** (flow) | the saved steps — what to do 1st, 2nd, 3rd |
| 🧑‍🍳 **Line Cook** (the bot) | runs a perfected recipe again and again — fast, no LLM |
| 👨‍🍳 **Head Chef** (the brain) | shows up only to *write* a new recipe or *fix* a broken one |
| 🚨 **Guardian** | retries, screenshots the failure, stops safely — never guesses |
| 🔑 **You** (the Owner) | hold the keys (only you log in), own the menu, the final word |

## Quick start

```bash
npm install
npm start          # launches the Loop Browser window (CDP on :9222)
```

In another terminal, drive the active tab:

```bash
node cli.mjs open "https://example.com"
node cli.mjs snapshot          # see the page as the brain sees it (role + name)
node cli.mjs click "Learn more"
```

Run a saved recipe (the bot — no LLM):

```bash
node cli.mjs flows                          # list recipes
node cli.mjs run demo-search term="hello"   # run one with ingredients
```

> Tip: `npm link` lets you use `loop ...` anywhere instead of `node cli.mjs ...`.

## Recipes

A recipe is a small JSON file in `flows/`:

```json
{
  "name": "demo-search",
  "inputs": { "term": "Playwright" },
  "steps": [
    { "do": "open",  "url": "https://en.wikipedia.org/wiki/Main_Page" },
    { "do": "fill",  "target": "search", "value": "{term}" },
    { "do": "press", "key": "Enter" }
  ]
}
```

Steps: `open` · `fill` · `click` · `press` · `wait` · `assert` · `read` · `snapshot`.
Targets use **role/label/text** (stable), never pixel coordinates. Keep personal recipes in `flows/local/` (gitignored).

## 🔐 Your logins never leave your machine

Your session/cookies live in a local profile folder that is **gitignored** (`.loop-profile/`). Log in once (e.g. WhatsApp Web), and you stay logged in across launches. Failure screenshots (`runs/`) are gitignored too. Loop Browser keeps the *tool and recipes* — never your sessions.

## License

MIT
