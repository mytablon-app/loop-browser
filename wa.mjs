// WhatsApp primitives — the reusable WA line-cook moves, with the guardrails folded in
// so they're never re-authored (and never re-learned). SHIPPABLE method, no personal data.
//
// What's baked in (each one a lesson paid for in blood — see site-memories/whatsapp.md):
//  · openChatExact   — open by EXACT span[title] + ASSERT the header before acting
//                      (fuzzy openChat picks the wrong near-identical chat).
//  · direction       — from the durable signals (delivery TICKS + data-pre-plain-text sender),
//                      NOT the churning message-in/out classes. No owner name hardcoded.
//  · sendMessage     — VERIFY the bubble landed; never claim "sent" blindly.
//  · readRecent      — gentle, BOUNDED scroll-up (WA Web won't lazy-load deep history; a
//                      scrollTop=0 jump kills the loader — so we step up one screen, capped).
//  · withLock        — participate in the runs/wa-<port>.lock convention so these primitives
//                      are first-class lock citizens (ad-hoc scripts that skipped it collided
//                      with the crons). Holds "reply" so gatekeep defers its next run.
import { connect, activePage, findInput, sleep } from "./lib.mjs";
import { readFileSync, writeFileSync, unlinkSync, statSync } from "fs";

const SEARCH = "Search or start a new chat";

// ---- the shared instance lock (matches runs/wa-gatekeep.mjs convention) --------------------
const lockPath = () => new URL(`./runs/wa-${process.env.LOOP_CDP_PORT || "9222"}.lock`, import.meta.url);
export const lockHolder = () => { try { return readFileSync(lockPath(), "utf8").trim().split(/\s+/)[0]; } catch { return ""; } };
export const lockAgeMs  = () => { try { return Date.now() - statSync(lockPath()).mtimeMs; } catch { return Infinity; } };
export const setLock    = (who) => { try { writeFileSync(lockPath(), `${who} ${Date.now()}`); } catch {} };
export const clearLock  = () => { try { unlinkSync(lockPath()); } catch {} };
// Run fn while holding the lock as `who` (default "reply" = a live human-style conversation,
// which gatekeep stands down for). Always releases, even on throw.
export async function withLock(who, fn) {
  setLock(who);
  try { return await fn(); }
  finally { setLock("free"); }   // leave a "free" marker (not delete) so crons read a clean state
}

// ---- date / direction parsing --------------------------------------------------------------
// pre-plain-text renders as US M/D/Y on this account: "[11:29 am, 6/20/2026] Sender: "
export function parsePre(pre) {
  const m = String(pre || "").match(/\[(\d{1,2}):(\d{2})(?:\s*([ap]m))?,\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\]/i);
  if (!m) return null;
  let [, hh, mm, ap, a, b, yyyy] = m;
  hh = +hh; mm = +mm;
  if (ap) { ap = ap.toLowerCase(); if (ap === "pm" && hh < 12) hh += 12; if (ap === "am" && hh === 12) hh = 0; }
  let mon = +a, day = +b;             // default M/D/Y
  if (a > 12) { day = +a; mon = +b; } // …unless the first field can't be a month → D/M/Y
  return { date: new Date(+yyyy, mon - 1, day, hh, mm), sender: pre.slice(m[0].length).replace(/:\s*$/, "").trim() };
}

// Grab the rendered message rows with DIRECTION — from the durable bubble signals, NOT the
// churning message-in/out classes and NO hardcoded owner name (this module ships):
//   · data-icon="tail-out" → outgoing, "tail-in" → incoming (the bubble-tail graphic)
//   · grouped messages drop the tail, so outgoing also = a delivery-status aria
//     ("Delivered"/"Read"/"Sent"/"Pending") which ONLY your own bubbles carry.
// Walk UP a bounded few ancestors, lowest-first, so we read THIS bubble's signal not a neighbor's.
const grab = (page) => page.$$eval("[data-pre-plain-text]", (els) =>
  els.map((el) => {
    let node = el, dir = "";
    for (let i = 0; i < 7 && node && !dir; i++) {
      if (node.querySelector) {
        if (node.querySelector('[data-icon="tail-out"]')) dir = "me";
        else if (node.querySelector('[data-icon="tail-in"]')) dir = "them";
        else if ([...node.querySelectorAll("[aria-label]")].some((a) =>
          /^\s*(delivered|read|sent|pending)\s*$/i.test(a.getAttribute("aria-label") || ""))) dir = "me";
      }
      node = node.parentElement;
    }
    const texts = el.querySelectorAll(".selectable-text");
    const body = (texts.length ? texts[texts.length - 1] : el).innerText.replace(/\s+/g, " ").trim();
    return { pre: el.getAttribute("data-pre-plain-text"), text: body, dir };
  })
);

function classify(rows, owner) {
  const ownerRe = owner ? (owner instanceof RegExp ? owner : new RegExp(owner, "i")) : null;
  return rows.map((r) => {
    const p = parsePre(r.pre);
    // trust the bubble signal; only if it's ambiguous, fall back to an optional owner-name match
    const dir = r.dir || (ownerRe && p && ownerRe.test(p.sender) ? "me" : "them");
    return { date: p?.date || null, sender: p?.sender || "", dir, text: r.text };
  });
}

// ---- core primitives -----------------------------------------------------------------------

// Open a chat by EXACT title and ASSERT the header matches before returning. Throws on
// missing or wrong chat — this is the guardrail that stops you cooking the wrong conversation.
export async function openChatExact(page, title) {
  if (!title) throw new Error("openChatExact: empty title");
  const box = await findInput(page, SEARCH);
  await box.click(); await box.fill(""); await box.pressSequentially(title, { delay: 60 });
  await sleep(1800);
  const exact = page.locator(`span[title="${title.replace(/"/g, '\\"')}"]`).first();
  if (!(await exact.count())) throw new Error(`openChatExact: no chat titled exactly "${title}"`);
  await exact.click();
  await sleep(2200);
  const header = (await page.$eval("#main header span[dir=auto]", (e) => e.innerText).catch(() => "?")).trim();
  if (header !== title) throw new Error(`openChatExact: opened WRONG chat — wanted "${title}", got "${header}"`);
  return header;
}

// Read the recent messages of a chat WITH direction. Opens exact first. If `n` exceeds what's
// rendered, steps gently up one screen at a time (BOUNDED) to load a little more — WA Web will
// not lazy-load deep history, so don't promise months here (use mobile Export-chat for that).
export async function readRecent(page, title, n = 15, { owner } = {}) {
  await openChatExact(page, title);
  const count = () => page.$$eval("[data-pre-plain-text]", (e) => e.length);
  let stale = 0;
  while ((await count()) < n && stale < 6) {
    const before = await count();
    await page.evaluate(() => {
      let el = document.querySelector("[data-pre-plain-text]");
      while (el && el !== document.body) {
        const s = getComputedStyle(el);
        if ((s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight) break;
        el = el.parentElement;
      }
      if (el) el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight * 0.8);  // GENTLE step up
    });
    await sleep(1400);
    stale = (await count()) > before ? 0 : stale + 1;
  }
  const rows = classify(await grab(page), owner).filter((m) => m.date);
  return { title, count: rows.length, messages: rows.slice(-n) };
}

// Send a message to a chat and VERIFY it landed (last bubble is ours + matches the text).
// Refuses empty text. Returns { ok, at } — never claims success blindly.
export async function sendMessage(page, title, text) {
  if (!text || !text.trim()) throw new Error("sendMessage: empty text");
  await openChatExact(page, title);
  const input = await findInput(page, "Type a message");
  await input.click();
  await input.pressSequentially(text, { delay: 35 });
  await sleep(400);
  await page.keyboard.press("Enter");
  await sleep(1500);
  const rows = classify(await grab(page), null);
  const last = rows[rows.length - 1];
  const ok = !!last && last.dir === "me" && last.text.trim() === text.trim();
  return { ok, at: last?.date || null, lastBubble: last?.text || "" };
}

// List the chat-list rows: title, last-message preview, unread count. No chat needs to be open.
export async function listChats(page, limit = 40) {
  const rows = await page.evaluate((lim) => {
    const pane = document.querySelector('#pane-side, [aria-label="Chat list"]');
    if (!pane) return [];
    const out = [];
    // chat-list rows are role="row" (NOT listitem); first span[title]=name, last=preview
    for (const li of pane.querySelectorAll('[role="row"]')) {
      const title = li.querySelector("span[title]")?.getAttribute("title") || "";
      if (!title) continue;
      // unread badge: an aria-label like "N unread message(s)" on a span in the row
      let unread = 0;
      for (const s of li.querySelectorAll("span[aria-label]")) {
        const m = (s.getAttribute("aria-label") || "").match(/(\d+)\s+unread/i);
        if (m) { unread = +m[1]; break; }
      }
      // last-message preview = the row's last text span (best-effort)
      const spans = [...li.querySelectorAll("span[title]")];
      const preview = spans.length > 1 ? (spans[spans.length - 1].getAttribute("title") || "") : "";
      out.push({ title, unread, preview });
      if (out.length >= lim) break;
    }
    return out;
  }, limit);
  return rows;
}

// Just the chats with unread messages.
export async function unreadChats(page) {
  return (await listChats(page)).filter((c) => c.unread > 0);
}

// Convenience: connect + grab the active content page (the WA tab) in one call.
export async function waPage() {
  const browser = await connect({ autostart: false });
  const { page } = await activePage(browser);
  return { browser, page };
}
