<!-- Loop Browser -->
<p align="center"><img src="assets/loop-icon.svg" width="96" alt="Loop Browser"></p>
<h1 align="center">Loop Browser</h1>
<p align="center">Command the web from your CLI — and <em>watch</em> it happen.</p>

---

Loop Browser is a CLI ↔ browser tool. You give a command, a **visible** browser window obeys: it reads the page's accessibility tree (code, not pixels), finds the element, and acts — navigate, type, click. Frequent tasks get saved as **recipes** that replay like a bot, with no LLM in the hot path.

## The kitchen model

| Part | What it is |
|---|---|
| 🔥 **Kitchen** (Engine) | the visible browser + CLI runtime (same for every task) |
| 🧂 **Ingredients** (inputs) | values that change each run (`text=`, `image=`) |
| 📋 **Recipe** (Flow) | the saved steps — what to do 1st, 2nd, 3rd |
| 🧑‍🍳 **Line Cook** (the bot) | runs a perfected recipe again and again — fast, no LLM |
| 👨‍🍳 **Head Chef** (the brain) | shows up only to *write* a new recipe or *fix* a broken one |
| 🚨 **Guardian** | retries, screenshots the failure, stops safely — never guesses |
| 🔑 **You** (the Owner) | hold the keys (only you log in), own the menu, and have the final word |

## Quick start

```bash
npm install
npx playwright install chromium
npm run serve            # opens a persistent, visible Loop Browser window
```

In another terminal, drive it:

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

> Tip: `npm link` lets you use `loop ...` from anywhere instead of `node cli.mjs ...`.

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
Targets use **role/label/text** (stable), never pixel coordinates.

- **Share** general recipes in `flows/` — they're the value others reuse.
- **Keep** your personal recipes in `flows/local/` — it's gitignored, so your company IDs / personal text never get published.

## 🔐 Your logins never leave your machine

When you enable a persistent login profile, your cookies and sessions live in a local folder that is **gitignored** (`.loop-profile/`, `user-data/`). Failure screenshots (`runs/`) are gitignored too, since they can show private pages. Loop Browser publishes the *tool and the recipes* — never your sessions.

## License

MIT
