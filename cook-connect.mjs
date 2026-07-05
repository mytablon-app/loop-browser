// cook-connect.mjs — LinkedIn restaurant, "connect to UAE investors" dish.
// Ported from agent-loop's linkedin-connector + linkedin-send-connect:
//   search (keywords + UAE geoUrn + 2nd-degree) → harvest connectable rows →
//   open each PROFILE (note requires the profile-page modal, not search-row) →
//   Connect (action bar / More menu) → Add a note → type → Send → verify.
// Safety: weekly-limit hard-stop, human pacing, consec-fail breaker, Service-Log
// dedup, account-is-priority guard. Usage: node cook-connect.mjs [maxSends]
import { connect, activePage, runStep } from "./lib.mjs";
import { servedSet, recordDish, readLog, logPath } from "./servicelog.mjs";
import { recordRun } from "./stats.mjs";
import { readFileSync } from "fs";

const DISH = "linkedin-connect";
const DRIVER_VERSION = "1.0.0";   // bump when the method changes (resets graduation probation)
// Run params overridable by env so the committed driver stays generic (no personal
// specifics): CONNECT_KEYWORDS=founder, CONNECT_NOTELESS=1 (skip the note → faster),
// CONNECT_NOTE="your own invite text" (REQUIRED for noted invites — no shipped default;
// outward copy is the owner's voice, never baked into a public file).
const KEYWORDS = process.env.CONNECT_KEYWORDS || "investor";
const NOTELESS = !!process.env.CONNECT_NOTELESS;
const GEO_UAE = "%5B%22104305776%22%5D";       // ["104305776"] = United Arab Emirates
const NETWORK_2ND = "%5B%22S%22%5D";            // ["S"] = 2nd degree
const NOTE = process.env.CONNECT_NOTE || "";
if (!NOTELESS && !NOTE) {
  console.error("✗ set CONNECT_NOTE=\"your invite text\" (or CONNECT_NOTELESS=1 to send without a note) — the driver ships no default outreach copy.");
  process.exit(1);
}

// ── THE HUMAN PICKS THE TARGETS (hard rule, enforced in code — invites are scarce). ──
// Either hand the driver an owner-picked list (CONNECT_LIST=<file>, one profile URL or
// slug per line — only those get invited), or explicitly acknowledge auto-harvest with
// CONNECT_AUTO=1. No silent default: "send invites" is not license to choose WHO.
const LIST_FILE = process.env.CONNECT_LIST || "";
const AUTO_OK = process.env.CONNECT_AUTO === "1";
let LIST = null;
if (LIST_FILE) {
  LIST = new Set(readFileSync(LIST_FILE, "utf8").split("\n")
    .map((l) => ((l.match(/\/in\/([^/?#\s]+)/i) || [])[1] || l.trim()).toLowerCase())
    .filter(Boolean));
  console.log(`[connect] owner list: ${LIST.size} target(s) from ${LIST_FILE}`);
} else if (!AUTO_OK) {
  console.error("✗ pick the targets: CONNECT_LIST=<file of profile URLs/slugs> (owner-picked), or CONNECT_AUTO=1 to explicitly allow harvesting whoever search returns.");
  process.exit(1);
}

const MAX = parseInt(process.argv[2] || "25", 10);          // per-run cap (was 100 — invites are scarce)
// Daily ledger cap: count today's sends in the Service Log so several runs in one
// day can't stack past the owner's ~25/day account-health budget.
const DAILY_CAP = parseInt(process.env.CONNECT_DAILY_CAP || "25", 10);
const today = new Date().toISOString().slice(0, 10);
const sentToday = (readLog()[DISH] || []).filter((e) => e.status === "served" && String(e.at || "").startsWith(today)).length;
if (sentToday >= DAILY_CAP) {
  console.error(`■ DAILY CAP: ${sentToday}/${DAILY_CAP} invites already sent today (service log) — not sending more. Override: CONNECT_DAILY_CAP.`);
  process.exit(0);
}
const BUDGET = Math.min(MAX, DAILY_CAP - sentToday);   // this run's true send budget
if (sentToday) console.log(`[connect] ${sentToday} already sent today → budget ${BUDGET} (daily cap ${DAILY_CAP})`);
const MAX_PAGES = 12;
const MAX_CONSEC_FAILS = 3;
const LONG_BREAK_EVERY = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

const searchUrl = (p) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(KEYWORDS)}&network=${NETWORK_2ND}&geoUrn=${GEO_UAE}&origin=FACETED_SEARCH${p > 1 ? `&page=${p}` : ""}`;
const LIMIT_RE = /weekly invitation limit|reached.+weekly.+invitation|you've used your weekly|no longer send personalized|out of invitations/i;

async function pageHitLimit(page) {
  return page.evaluate((re) => new RegExp(re, "i").test(document.body.innerText || ""), LIMIT_RE.source).catch(() => false);
}

// Harvest connectable candidates on the current search page: rows with an
// "Invite X to connect" anchor that are NOT 1st-degree. Returns [{name,url}].
async function harvest(page) {
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 600 + Math.random() * 300); await sleep(rnd(700, 1300)); }
  return page.evaluate(() => {
    const out = [];
    const findRow = (a) => { let el = a; for (let i = 0; i < 8 && el; i++) { if (el.tagName === "LI") return el; if (el.getBoundingClientRect && el.getBoundingClientRect().width > 400) return el; el = el.parentElement; } return a.parentElement; };
    for (const a of document.querySelectorAll('a[aria-label*="to connect" i], button[aria-label*="to connect" i]')) {
      const lbl = a.getAttribute("aria-label") || "";
      const name = lbl.replace(/^Invite\s+/i, "").replace(/\s+to connect.*$/i, "").trim();
      if (!name) continue;
      const row = findRow(a);
      if (row && /[·•]\s*1st\b/i.test(row.innerText || "")) continue; // skip 1st-degree
      let url = "";
      if (row) { const pa = row.querySelector('a[href*="/in/"]'); if (pa) url = pa.href.split("?")[0].replace(/\/$/, ""); }
      if (url) out.push({ name, url });
    }
    return out;
  }).catch(() => []);
}

const slugOf = (u) => ((u || "").match(/\/in\/([^/?#]+)/i) || [])[1]?.toLowerCase() || null;

// Open the profile and send a connect invite WITH our note. Returns a state string.
async function connectWithNote(page, url, name) {
  await runStep(page, { do: "open", url: url + "/" });
  await sleep(rnd(2500, 4000));
  if (!(await page.url()).includes("linkedin.com")) throw Object.assign(new Error("navigated off linkedin"), { interrupt: true });
  if (await pageHitLimit(page)) return "weekly-limit";

  const profileName = await page.evaluate(() => (document.title.match(/^(.+?)\s*\|\s*LinkedIn/) || [])[1]?.trim() || null).catch(() => null);
  const who = profileName || name;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const isPending = () => page.evaluate((nm) => [...document.querySelectorAll("button,a")].some((el) => { const a = (el.getAttribute("aria-label") || "").toLowerCase(); return a.includes(nm.toLowerCase()) && /pending|withdraw/.test(a); }), who).catch(() => false);
  if (await isPending()) return "pending";
  const connected = await page.evaluate(() => /\b1st\s+degree\s+connection\b|·\s*1st\b/i.test((document.querySelector("main")?.innerText || "").slice(0, 600)) || !!document.querySelector('[aria-label*="Remove connection" i]')).catch(() => false);
  if (connected) return "connected";

  // Find the real Connect control: visible action-bar anchor (y>60), else More menu.
  let connect = null;
  const cands = page.locator(`a[aria-label="Invite ${who} to connect"], button[aria-label="Invite ${who} to connect"]`);
  for (let i = 0, n = await cands.count(); i < n; i++) {
    const c = cands.nth(i);
    if (!(await c.isVisible({ timeout: 400 }).catch(() => false))) continue;
    const box = await c.boundingBox().catch(() => null);
    if (!box || box.y < 60) continue;
    connect = c; break;
  }
  if (!connect) {
    const opened = await page.evaluate(() => { const b = [...document.querySelectorAll("main button")].filter((x) => /^more$/i.test((x.innerText || "").trim()) && x.getBoundingClientRect().y > 50)[0]; if (b) { b.click(); return true; } return false; }).catch(() => false);
    if (opened) { await sleep(rnd(900, 1500)); const m = page.locator(`[role="menu"] [aria-label="Invite ${who} to connect"]`).first(); if (await m.isVisible({ timeout: 2500 }).catch(() => false)) connect = m; }
  }
  if (!connect) return "follow-only";

  await connect.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  await sleep(rnd(500, 1000));
  await connect.click();
  await sleep(rnd(1500, 2500));
  if (await pageHitLimit(page)) return "weekly-limit";
  if (await isPending()) return "sent"; // inline send (no modal) — note not possible, still sent

  // Email-gate: LinkedIn demands the recipient's email to connect = extra security
  // OR they ignored/declined a prior invite. NOT sendable — close, skip, never enter
  // an email. (This was the 100% cause of the UAE "unconfirmed" — nothing actually sent.)
  const needsEmail = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]'); if (!d) return false;
    if (d.querySelector('input[type="email"]')) return true;
    const t = (d.innerText || "").toLowerCase();
    return /enter.{0,20}email|email address|add.{0,12}email|verify.{0,20}email/.test(t);
  }).catch(() => false);
  if (needsEmail) { await page.keyboard.press("Escape").catch(() => {}); return "needs-email"; }

  if (NOTELESS) {
    // Note-less: take the "Send without a note" path straight away.
    const sw = page.getByRole("button", { name: /send without a note/i }).first();
    if (await sw.isVisible({ timeout: 3000 }).catch(() => false)) { await sw.click(); await sleep(rnd(1500, 2500)); }
    else if (!(await isPending())) { await page.keyboard.press("Escape").catch(() => {}); return "no-modal"; }
  } else {
    // Add-a-note modal flow
    const addNote = page.getByRole("button", { name: /add a note/i }).first();
    if (await addNote.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addNote.click(); await sleep(rnd(800, 1400));
      const ta = page.locator('textarea#custom-message, textarea[name="message"], textarea[aria-label*="note" i]').first();
      if (await ta.isVisible({ timeout: 3000 }).catch(() => false)) { await ta.fill(NOTE); await sleep(rnd(600, 1200)); }
      const send = page.getByRole("button", { name: /^send$/i }).first();
      if (await send.isVisible({ timeout: 2000 }).catch(() => false)) { await send.click(); await sleep(rnd(1500, 2500)); }
    } else {
      const sw = page.getByRole("button", { name: /send without a note/i }).first();
      if (await sw.isVisible({ timeout: 2000 }).catch(() => false)) { await sw.click(); await sleep(rnd(1500, 2500)); } // fallback
      else if (!(await isPending())) { await page.keyboard.press("Escape").catch(() => {}); return "no-modal"; }
    }
  }
  // verify
  const toast = await page.evaluate(() => /invitation sent|sent invitation|your invitation/i.test(document.body.innerText || "")).catch(() => false);
  if (toast || await isPending()) return "sent";
  return "unconfirmed";
}

const b = await connect();
let sent = 0, consec = 0, attempts = 0, dry = 0, emailGates = 0;
const seen = new Set();
console.log(`[connect] target ${MAX} · ${KEYWORDS} · UAE · 2nd-degree · ${NOTELESS ? "NOTE-LESS" : "WITH note"}`);

outer: for (let pg = 1; pg <= MAX_PAGES && sent < MAX; pg++) {
  let page;
  try { ({ page } = await activePage(b)); await runStep(page, { do: "open", url: searchUrl(pg) }); await sleep(rnd(4000, 6000)); } catch (e) { console.error("search nav failed:", e.message.slice(0, 80)); break; }
  if (await pageHitLimit(page)) { console.error("\n■ WEEKLY LIMIT at search — stopping"); recordDish(DISH, { target: null, status: "limit-hit" }); break; }   // (an explicit at:undefined used to CLOBBER the timestamp recordDish stamps)
  const cands = (await harvest(page)).filter((c) => { const s = slugOf(c.url); return s && !seen.has(s); });
  console.log(`[connect] page ${pg}: ${cands.length} fresh connectable rows`);
  const done = servedSet(DISH, "slug");

  for (const c of cands) {
    if (sent >= BUDGET) break outer;
    const slug = slugOf(c.url); seen.add(slug);
    if (done.has(slug)) continue; // already invited (our log)
    if (LIST && !LIST.has(slug)) continue; // owner-picked list mode: only invite who the human chose
    attempts++;
    page.__loopHealed = false;             // graduation signal, reset per invite
    let state;
    try { state = await connectWithNote(page, c.url, c.name); }
    catch (e) {
      if (e.interrupt) { console.error(`\n⚠ INTERRUPTION (${e.message}) — human/external took over. Stopping (human priority).`); recordDish(DISH, { target: c.name, slug, status: "interrupted", note: e.message }); break outer; }
      consec++; console.error(`✗ FAIL ${c.name}: ${e.message.slice(0, 100)}`);
      recordDish(DISH, { target: c.name, slug, status: "failed", error: e.message.slice(0, 100) });
      if (consec >= MAX_CONSEC_FAILS) { console.error(`\n■ STOPPED — ${consec} consecutive fails`); break outer; }
      await sleep(rnd(8000, 12000)); continue;
    }
    if (state === "weekly-limit") { console.error(`\n■ WEEKLY LIMIT (at ${c.name}) — stopping, account is priority`); recordDish(DISH, { target: c.name, slug, status: "limit-hit" }); break outer; }
    if (state === "sent") { sent++; consec = 0; dry = 0; recordDish(DISH, { target: c.name, slug, url: c.url, status: "served", note: "connect+note" }); recordRun(DISH, DRIVER_VERSION, { clean: !page.__loopHealed }); console.log(`✓ SENT [${sent}/${BUDGET}]: ${c.name}`); }
    else { recordDish(DISH, { target: c.name, slug, url: c.url, status: "skipped", state }); dry++; if (state === "needs-email") emailGates++; console.log(`↷ skip (${state}): ${c.name}`); }
    // Low-yield / throttle backoff: too many email-gates or a long dry streak means
    // the connectable pool is saturated / the account is throttled → STOP and WAIT.
    if (emailGates >= 3 || dry >= 8) { console.error(`\n■ POOL SATURATED / THROTTLED (emailGates=${emailGates}, dry=${dry}) — stopping; wait for pending invites to clear before more.`); recordDish(DISH, { target: null, status: "paused-low-yield", note: `emailGates=${emailGates} dry=${dry}` }); break outer; }
    // pace
    if (sent > 0 && sent % LONG_BREAK_EVERY === 0) { const s = rnd(60000, 100000); console.log(`☕ break ${Math.round(s / 1000)}s`); await sleep(s); }
    else await sleep(rnd(25000, 50000));
  }
}
console.log(`\n[connect] DONE — sent ${sent}, attempts ${attempts}. Log: ${logPath()}`);
await b.close();
