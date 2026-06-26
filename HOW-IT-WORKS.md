# How Loop Works — the Kitchen Model

> New here? This is the mental model the whole project is built on. Read this once and the
> code, the CLI verbs, and the `CLAUDE.md` operating rules will all click into place.
> (`CLAUDE.md` is the terse always-on spec for the AI; **this** is the human-friendly tour.)

Loop Browser is a **visible glass browser you command from a CLI** to automate any website.
It reads the page's *accessibility tree* (the structured labels behind the pixels — buttons,
inputs, text), finds the right element by its role/label, and acts — while you watch it happen
in a real window.

The trick that makes it cheap, fast, and hard to copy: **the LLM is almost never running.**
We think of the whole system as a **professional kitchen**, and that analogy isn't decoration —
it maps one-to-one onto how the code is structured.

---

## The one idea: keep the chef out of the kitchen

In a restaurant, the **Head Chef** designs a dish once. After that, the **line cooks** make it
hundreds of times a night — fast, identical, no improvisation. The chef only comes back if a
dish breaks.

Loop works the same way:

- A **Recipe** is the written method — fixed steps, saved as a file.
- The **Line Cook** replays that recipe deterministically. **No LLM. No tokens. No guessing.**
- The **Head Chef (the LLM)** only shows up to *write* a new recipe or *heal* a broken one.

So ~99% of the work runs with zero AI in the loop. The intelligence is **frozen into the recipe
the first time** and reused forever. That's the moat: competitors re-ask an LLM to re-solve the
same task on every single run; we solved it once and saved the answer.

```
   Author once (Head Chef / LLM)  ──►  recipes/<name>.json  ──►  Run forever (Line Cook / no LLM)
```

---

## The kitchen vocabulary (canonical terms — used everywhere in the code & docs)

| Term | What it really is | Where it lives |
|------|-------------------|----------------|
| **Recipe** | The fixed steps = the method | `recipes/<name>.json` |
| **Ingredients** | Data gathered *at cook time* (names, messages) — never baked into the recipe | fetched live |
| **Dish** | The finished automation / output | what lands on the page |
| **Cuisine pack** | Everything known about one website (selectors, quirks, safety) | `site-memories/<domain>.md` |

When you hear "cook a dish in a restaurant," that means: **run a recipe on a website.**

---

## The brigade (who does what)

A real kitchen has a *brigade de cuisine* — a chain of roles. Loop fills these with code:

| Kitchen role | In Loop | Job |
|--------------|---------|-----|
| 🔑 **Owner** | The human (you) | Holds the login, directs, approves, tastes. Doesn't cook. |
| 👨‍🍳 **Head Chef / Brain** | The LLM | Designs a recipe **once**; heals it when it breaks. Off the hot path. |
| 🍳 **Line Cook** | `loop run` | Replays a recipe step-by-step, deterministic, no LLM. ~99% of work. |
| 📋 **Expediter** | `loop serve` | Picks the next ticket, dedupes, keeps the **Service Log**, verifies. |
| 🧺 **Porter** | `porter.mjs` | Gathers ingredients off the hot path (files, profiles, messages). |
| 🛟 **Sous Chef** | The Guardian | On a break: retry → self-heal → write an incident → stop. |
| 🧹 **Mopper** | `loop mop` | Tidies up after a cook: close stray modals, wipe scratch, health-check. |
| 🎩 **Maître d'** | `scripts/instances.mjs` | Keeps the reservation book: seats each restaurant at its permanent address (port) with its own keys (login), never double-books. |
| 🔥 **Stove** | `lib.mjs` | The engine: connect, find elements, run the step primitives. |

The **Service Log** (`dishes/service-log.json`) is the kitchen's ticket record — every dish
cooked, keyed by dish + date. It's both the work history and the **dedup guard** so the same
post never goes out twice. (It's personal data, so it's gitignored — it stays on your machine.)

---

## One kitchen, many restaurants

Loop is **one shared kitchen** (engine + brigade) that serves **many restaurants = websites**
(LinkedIn, WhatsApp, … any site). Each restaurant has its own **cuisine** — its recipe family
plus a knowledge pack at `site-memories/<domain>.md` describing how that site behaves.

This is why Loop scales: adding a new website only means writing a new cuisine pack and a few
recipes. The kitchen — the engine, the brigade, the no-LLM-in-the-hot-path design — is shared
across all of them.

### Running several restaurants at once

Each restaurant gets its own **premises and keys**: the **port** is the restaurant's permanent
street address (how a Line Cook walks into *that* kitchen and no other — the number itself is
meaningless, it just has to be stable), and the **login profile** is the keys and the safe for that
building. One site ↔ one address ↔ one set of keys.

That address is **reserved for life** — like a lease. Close LinkedIn for the night (shut the
instance down) and its address still belongs to LinkedIn; open WhatsApp and it gets its *own*
address down the street, never moving into LinkedIn's empty spot. The **Maître d'**
(`scripts/instances.mjs`) holds the reservation book that makes this happen — you don't manage
ports by hand:

```sh
source scripts/instance.sh linkedin    # remembered → :9222, reuses your login
source scripts/instance.sh whatsapp    # remembered → :9223
source scripts/instance.sh notion      # NEW site → auto-grabs the next free port, remembers it
node scripts/instances.mjs list        # see what's mapped to which port
```

The first time you open a site it grabs the next free port and **remembers it** (in
`~/.loop-profiles/instances.json`, which stays on your machine). Nothing is hardcoded — the port
number doesn't matter; what matters is that it's **reserved to that site for life.** Open the site
again and it **reuses the same port and login profile** — no relaunch, no re-login. Even if you
shut a site down, its port stays reserved, so opening a *different* site never reuses it. (Need to
change one? `node scripts/instances.mjs forget <site>` releases it.) That's why WhatsApp on one
instance and LinkedIn on another never step on each other.

---

## Two modes: Loop Mode vs Owner Mode

When the AI operates Loop, it's always in one of two states (and it announces every switch):

- 🔒 **Loop Mode** — *blinders on, cooking one dish.* It loads **only** that site's cuisine
  pack and the one dish in front of it — nothing else. Off-script? It stops and hands back
  rather than improvising. Always **mops** when done.
- 🔓 **Owner Mode** — *thinking, planning, building, discussing.* Full context, general tools.

Rule of thumb: **one defined task on one named site → Loop Mode. Open-ended work → Owner Mode.**
Building a tool is Owner Mode; running it is Loop Mode.

---

## The hard rules (safety — these never bend)

1. **Only the human logs in.** Loop never types credentials. Logged out → it stops and asks.
2. **Ask first** on anything destructive, irreversible, or mass-send (deletes, payments, bulk DMs).
3. **The human picks the targets.** Being told to "send invites" is *not* permission to choose
   *who* or *how many* — especially for scarce resources (invite credits, daily caps).
4. **Human-like pacing.** One step at a time, watchable. Never blast batches or hammer a platform.
5. **No private data ever ships.** Logins, the Service Log, real names, and private recipes stay
   on your machine (gitignored). The repo carries **methods only** — see the git boundary below.

---

## The git boundary (what's shared vs what stays home)

> **Recipe + site-model travel. The meal, the pantry, the key, and your specifics stay home.**

- **Ships (public repo):** the engine, recipes (`recipes/*.json` — method only), the generic
  cuisine packs (`site-memories/*.md` — how a public site works, scrubbed of personal data),
  docs, the skill, the landing site.
- **Never ships (gitignored):** your login profile (`.loop-profile/`), the Service Log and
  dishes (`dishes/`), run artifacts (`runs/`), and your private overlays
  (`recipes/local/`, `site-memories/local/` — real URLs, company IDs, account state, real names).

There are **four layers** enforcing this (`.gitignore` → npm allowlist → `.npmignore` →
a publish guard that blocks the release if it smells a secret). **Before every commit, grep for
personal data** — with multiple collaborators, that's everyone's job.

---

## A cook, start to finish (putting it together)

Here's what actually happens when Loop posts a daily welcome spotlight:

1. **Expediter** (`loop serve` / a driver) picks the next un-served member from the pantry and
   checks the **Service Log** so nobody gets posted twice.
2. **Porter** fetches that person's live details (their real name, headline).
3. **Line Cook** replays the recipe on the visible browser: open composer → upload the card →
   tag the person → write the caption → publish.
4. **Sous Chef** (Guardian) watches; if a step breaks it retries, then self-heals, then stops.
5. The result is recorded to the **Service Log**, and the **Mopper** tidies the station.

No LLM ran in steps 1–5. The Head Chef only gets called if step 3's recipe needs *authoring* or
*healing*. That's Loop.

---

## Where to go next

- **`README.md`** — install and first run.
- **`CLAUDE.md`** — the precise operating spec (written for the AI, but the source of truth on rules).
- **`recipes/`** — the saved methods. Open one; the JSON reads like a checklist.
- **`site-memories/<domain>.md`** — the cuisine pack for each site.
- **`loop recipes`** — list everything the kitchen already knows how to cook.

Welcome to the kitchen. 👨‍🍳
