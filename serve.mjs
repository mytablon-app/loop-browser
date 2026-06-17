// Persistent visible browser session.
// Launches a headed Chromium with a CDP port so command scripts can attach
// and drive THIS SAME window repeatedly. Stays open until you kill it.

import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: false,
  args: ["--remote-debugging-port=9222", "--start-maximized"],
});
const context = browser.contexts()[0] ?? (await browser.newContext({ viewport: null }));
const page = context.pages()[0] ?? (await context.newPage());

const HOME = new URL("./public/home.html", import.meta.url).href;
await page.goto(HOME);
await page.bringToFront(); // keep the working tab visible/focused
console.log("READY — Loop Browser is up on http://localhost:9222");
console.log('Send commands with:  npm run cli -- open "<url>"   (or: node cli.mjs ...)');

// stay alive forever (until the process is killed)
await new Promise(() => {});
