// Shared core: connect to the persistent visible browser + watchable helpers.
// Every command reuses ONE tab and brings it to the front before acting.

import { chromium } from "playwright";
import { mkdirSync } from "fs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CDP_URL = "http://localhost:9222";

export async function connect() {
  for (let i = 0; i < 20; i++) {
    try {
      return await chromium.connectOverCDP(CDP_URL);
    } catch {
      await sleep(400);
    }
  }
  throw new Error("No browser running. Start it with:  npm run serve");
}

// REQUIREMENT 1 + 2: reuse the single real tab, never open new ones, keep it visible.
export async function activePage(browser) {
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page =
    pages.find((p) => !p.url().startsWith("about:")) ?? pages[0] ?? (await ctx.newPage());
  await page.bringToFront();
  return { page, tabCount: pages.length };
}

// Draw a red box around the element BEFORE acting, so you SEE where it acts.
export async function highlight(locator) {
  const handle = await locator.elementHandle();
  if (!handle) return;
  await handle.evaluate((el) => {
    el.style.outline = "3px solid #ff2d55";
    el.style.outlineOffset = "2px";
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  await sleep(400);
}

// Reliable element finding by human label — tries several strategies in order.
export async function findInput(page, label) {
  const re = new RegExp(label, "i");
  const candidates = [
    page.getByLabel(re),
    page.getByPlaceholder(re),
    page.getByRole("searchbox"),
    page.getByRole("textbox", { name: re }),
    page.locator(`input[name="${label}"]`),
    page.getByRole("textbox"),
  ];
  for (const c of candidates) {
    if (await c.first().count()) return c.first();
  }
  throw new Error(`No input matching "${label}"`);
}

export async function findClickable(page, text) {
  const re = new RegExp(text, "i");
  const candidates = [
    page.getByRole("button", { name: re }),
    page.getByRole("link", { name: re }),
    page.getByText(re),
  ];
  for (const c of candidates) {
    if (await c.first().count()) return c.first();
  }
  throw new Error(`Nothing clickable matching "${text}"`);
}

// ---- Flow engine -----------------------------------------------------------
// Fill {placeholders} in a string from the inputs map.
export function interpolate(str, vars) {
  if (typeof str !== "string") return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

// Execute ONE step against the page. This is the deterministic "bot" primitive —
// no LLM involved. Same function powers single CLI commands and saved Flows.
export async function runStep(page, step, vars = {}) {
  const v = (s) => interpolate(s, vars);
  switch (step.do) {
    case "open":
      console.log(`  · open ${v(step.url)}`);
      await page.goto(v(step.url), { waitUntil: "domcontentloaded" });
      break;
    case "fill": {
      const el = await findInput(page, v(step.target));
      await highlight(el);
      await el.click();
      await el.fill("");
      await el.pressSequentially(v(step.value), { delay: 110 });
      console.log(`  · fill "${v(step.target)}" = "${v(step.value)}"`);
      break;
    }
    case "click": {
      const el = await findClickable(page, v(step.target));
      await highlight(el);
      await el.click();
      console.log(`  · click "${v(step.target)}"`);
      break;
    }
    case "press":
      await page.keyboard.press(step.key || "Enter");
      console.log(`  · press ${step.key || "Enter"}`);
      break;
    case "wait":
      await page.waitForTimeout(step.ms || 1000);
      console.log(`  · wait ${step.ms || 1000}ms`);
      break;
    case "assert": {
      const found = await page
        .getByText(new RegExp(v(step.text), "i"))
        .first()
        .count();
      if (!found) throw new Error(`assert failed — "${v(step.text)}" not on page`);
      console.log(`  · assert "${v(step.text)}" ✓`);
      break;
    }
    case "read":
      console.log(`  = ${await page.title()} — ${page.url()}`);
      break;
    case "snapshot": {
      // The Head Chef's eyes: the page as an accessibility tree (role + name),
      // the exact vocabulary recipes target with. No pixels, pure structure.
      console.log(`= ${await page.title()} — ${page.url()}\n`);
      const tree = await page.locator("body").ariaSnapshot();
      console.log(tree);
      break;
    }
    default:
      throw new Error(`unknown step: ${JSON.stringify(step)}`);
  }
}

// ---- The Guardian: recovery ladder -----------------------------------------
// Rung 1 — retry with backoff (handles timing/transient flakiness, no LLM).
export async function withRetry(fn, { tries = 3, delay = 600 } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries) await sleep(delay * i);
    }
  }
  throw last;
}

// When a step breaks, snapshot the screen so the human SEES exactly where.
export async function captureFailure(page, label) {
  const dir = new URL("./runs/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const path = new URL(`${label}.png`, dir).pathname;
  await page.screenshot({ path, fullPage: false }).catch(() => {});
  return path;
}
