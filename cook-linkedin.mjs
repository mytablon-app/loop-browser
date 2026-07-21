// cook-linkedin.mjs — autonomous Line Cook + Expediter for the LinkedIn company
// spotlight. Cooks the next un-served ticket(s) end-to-end (Voyager prefetch →
// photo → tag → caption → post → verify), records each in the Service Log, paces
// like a human, and stops on repeated breaks. Usage: node cook-linkedin.mjs [maxPosts]
import { connect, activePage, runStep } from "./lib.mjs";
import { pickNextTicket, fetchProfile, slugOf } from "./porter.mjs";
import { servedSet, recordDish } from "./servicelog.mjs";
import { recordRun } from "./stats.mjs";

// Graduation ledger version for this DRIVER (recipes carry their own `version`;
// a bespoke driver is its own method). Bump when the METHOD changes — that resets
// the clean-run probation, exactly like editing a recipe.
const DRIVER_VERSION = "1.1.0";
import { execSync } from "child_process";
import { writeFileSync } from "fs";

const DISH = "linkedin-company-post";
// Configure via env (kept out of git — see the boundary rule on companyId/paths):
//   LOOP_PANTRY=/path/to/ticket-folder  LOOP_LI_COMPANY_ID=<your LinkedIn company id>
const PANTRY = process.env.LOOP_PANTRY || "./pantry";
const COMPANY_ID = process.env.LOOP_LI_COMPANY_ID || "<companyId>";
const COMPANY_URL = `https://www.linkedin.com/company/${COMPANY_ID}/admin/page-posts/published/`;
const MAX = parseInt(process.argv[2] || "99", 10);
const MAX_CONSEC_FAILS = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Interruption guard — the human (or an auto-process) is ALWAYS priority and we
// never override them. But before a consequential action (esp. the irreversible
// Post) we confirm nobody took over: the tab is still ours, still on LinkedIn.
// If it changed, we STOP and record it so we KNOW it happened — we don't barrel on.
class Interrupt extends Error { constructor(m) { super(m); this.name = "Interrupt"; } }
async function guard(page, startPage) {
  try { if (page.isClosed()) throw 0; } catch { throw new Interrupt("our tab was closed"); }
  let url = ""; try { url = await page.url(); } catch { throw new Interrupt("page became unreachable"); }
  if (!/linkedin\.com/.test(url)) throw new Interrupt(`navigated away → ${url.slice(0, 70)}`);
  if (startPage) { let cur; try { cur = (await activePage(b)).page; } catch {} if (cur && cur !== startPage) throw new Interrupt("active tab changed (human switched tabs)"); }
}

function escapeNativePicker() {
  try {
    for (const p of ["Loop Browser", "Electron"]) {
      try { execSync(`osascript -e 'tell application "System Events" to set frontmost of process "${p}" to true'`, { stdio: "ignore" }); break; } catch {}
    }
    execSync(`osascript -e 'tell application "System Events" to key code 53'`, { stdio: "ignore" });
  } catch {}
}

async function findAddMedia(page) {
  return page.evaluate(() => {
    function find(root) {
      for (const el of root.querySelectorAll("button")) {
        const al = (el.getAttribute("aria-label") || "").toLowerCase();
        if (el.offsetParent !== null && (al.includes("add media") || al.includes("add a photo") || al.includes("add photo"))) {
          const r = el.getBoundingClientRect();
          return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
        }
      }
      for (const el of root.querySelectorAll("*")) { if (el.shadowRoot) { const x = find(el.shadowRoot); if (x) return x; } }
      return null;
    }
    return find(document);
  }).catch(() => null);
}

// Did the media editor render (i.e. did our image land)? "Alternative text" /
// "Edit background" only exist once a photo is attached.
async function imageRendered(page, timeout = 15000) {
  return page.waitForFunction(() => {
    const ok = (b) => /^(Alternative text|Edit background)$/i.test((b.textContent || b.getAttribute("aria-label") || "").trim());
    function walk(root) { for (const b of root.querySelectorAll("button")) if (ok(b) && b.offsetParent !== null) return true; for (const el of root.querySelectorAll("*")) if (el.shadowRoot && walk(el.shadowRoot)) return true; return false; }
    return walk(document);
  }, { timeout }).then(() => true).catch(() => false);
}

// Persistent file-chooser interception — the fix for the recurring stranded native
// macOS picker. LinkedIn's composer pops the OS file dialog on an add-media click.
// The old per-click `waitForEvent("filechooser", {timeout:7000})` was a RACE: when
// the event didn't reach Playwright inside the window, the click had already opened
// the native dialog (invisible to CDP), and the osascript-Escape fallback didn't
// reliably close it → "millionth time" stuck picker. A page-level handler instead
// catches the chooser WHENEVER it fires (no window) and sets the file programmatically
// so the native dialog never shows. armFileChooser is idempotent per page.
let pendingUploadImage = null;
const armedPages = new WeakSet();
function armFileChooser(page) {
  if (armedPages.has(page)) return;
  armedPages.add(page);
  page.on("filechooser", async (fc) => {
    const img = pendingUploadImage;             // capture + consume once: a stray chooser
    if (!img) return;                           // (e.g. during the fallback window) can't
    pendingUploadImage = null;                  // reattach a stale file after this fires
    try { await fc.setFiles(img); } catch {}
  });
}

async function uploadPhoto(page, image) {
  await page.getByLabel(/Text editor for creating content/i).first().waitFor({ state: "visible", timeout: 12000 });
  armFileChooser(page);
  const coords = await findAddMedia(page);
  if (!coords) throw new Error("Add media button not found");
  // Open the upload window: the persistent handler fills any chooser this click
  // triggers — no per-click race. Belt-and-suspenders: if the chooser never reaches
  // Playwright (a true Electron-native dialog), set the hidden media input directly
  // and dismiss the stranded native picker.
  pendingUploadImage = image;
  try {
    await page.mouse.click(coords.cx, coords.cy);
    await sleep(2500);
    let rendered = await imageRendered(page);
    if (!rendered) {
      let ready = false;
      for (let w = 0; w < 16 && !ready; w++) { ready = await page.evaluate(() => !!document.getElementById("media-editor-file-selector__file-input")).catch(() => false); if (!ready) await sleep(500); }
      const h = ready ? await page.$("#media-editor-file-selector__file-input") : null;
      if (h) { await h.setInputFiles(image); rendered = await imageRendered(page); }
      escapeNativePicker();                     // clear any stranded native dialog
    }
    if (!rendered) throw new Error("upload: image did not render");
  } finally {
    pendingUploadImage = null;                  // close the upload window
  }
}

// Back out of the tag panel until the media editor's "Next" is reachable again —
// MUST run on any no-match/abort path or the composer is stranded in the tag panel
// and the caption stage is never reached (ported from agent-loop's exitTagPanel).
async function exitTagPanel(page) {
  const next = page.getByRole("button", { name: "Next" });
  for (let i = 0; i < 3; i++) {
    if (await next.isVisible({ timeout: 800 }).catch(() => false)) return;
    const back = page.locator('button[aria-label="Back"], button[aria-label="Go back"]').first();
    if (!await back.isVisible({ timeout: 1500 }).catch(() => false)) break;
    await back.click().catch(() => {});
    await sleep(1000);
  }
}

// HEAL (3-straggler hang): on ambiguous names the tag sub-panel lingers after a
// no-confident-match bail — an open candidate dropdown or an empty placed pin that
// overlaps "Next", so the editor never advances to the composer (text editor never
// appears → fill times out ~49s). Clear it WITHOUT Escape (Escape can discard the
// whole post): empty the search input (collapses the dropdown / empty pin), then
// click the tag sub-panel's Back arrow until the search box is gone.
async function clearTagRemnants(page) {
  for (let i = 0; i < 3; i++) {
    const search = page.locator('input[placeholder*="name" i], input[placeholder*="Type" i]').first();
    if (!await search.isVisible({ timeout: 800 }).catch(() => false)) return;
    await search.fill("").catch(() => {});
    await sleep(400);
    const back = page.locator('button[aria-label="Back"], button[aria-label="Go back"]').first();
    if (!await back.isVisible({ timeout: 800 }).catch(() => false)) return;
    await back.click().catch(() => {});
    await sleep(900);
  }
}

async function tagPerson(page, realName, headline, slug) {
  const tag = page.getByRole("button", { name: "Tag", exact: true }).first();
  if (!await tag.isVisible({ timeout: 12000 }).catch(() => false)) throw new Error("Tag button missing");
  await tag.click(); await sleep(1500);
  const box = await page.evaluate(() => { const imgs = [...document.querySelectorAll('[role="dialog"] img, img')].filter(i => i.offsetParent !== null && i.width > 150 && i.height > 150); if (!imgs.length) return null; imgs.sort((a, b) => b.width * b.height - a.width * a.height); const r = imgs[0].getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  if (box) { await page.mouse.click(box.x + box.w * 0.45, box.y + box.h * 0.30); await sleep(1500); }
  const search = page.locator('input[placeholder*="name" i], input[placeholder*="Type" i]').first();
  if (!await search.isVisible({ timeout: 5000 }).catch(() => false)) { await exitTagPanel(page); return false; }
  await search.focus().catch(() => {}); await sleep(200);
  await search.pressSequentially(realName, { delay: 80 });
  // POLL for the typeahead rows (same 20s cap as the old flat sleep, but a fast
  // typeahead no longer costs 20s per post) + a settle beat so names/headlines
  // finish rendering before we read them.
  const sel = '[role="option"], li[class*="result"], li[class*="selectable"]';
  const tagT0 = Date.now();
  while (Date.now() - tagT0 < 20000) {
    if (await page.locator(sel).count().catch(() => 0)) break;
    await sleep(500);
  }
  await sleep(1500);
  const results = await page.locator(sel).evaluateAll(els => els.map(el => ({ text: el.textContent || "", html: el.innerHTML || "" }))).catch(() => []);
  const texts = results.map(r => r.text), htmls = results.map(r => r.html);
  const norm = s => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const nn = norm(realName), nl = realName.toLowerCase();
  let idx = -1;
  if (slug) { const i = htmls.findIndex(h => h.includes(`/in/${slug}`)); if (i >= 0) idx = i; }
  if (idx === -1 && headline) { const hp = norm(headline).slice(0, 15); if (hp.length >= 10) { const h = []; texts.forEach((t, i) => { if (norm(t).includes(nn) && norm(t).includes(hp)) h.push(i); }); if (h.length === 1) idx = h[0]; } }
  if (idx === -1) { const ex = []; texts.forEach((t, i) => { const tn = norm(t); if (tn.startsWith(nn)) { const a = tn.slice(nn.length).trimStart(); if (!a || /^[^a-z]/.test(a)) ex.push(i); } }); if (ex.length === 1) idx = ex[0]; }
  if (idx === -1 && headline) { const hw = headline.toLowerCase().split(/\s+/).filter(w => w.length > 3); const mn = Math.min(Math.max(4, Math.ceil(hw.length * 0.25)), hw.length); for (let i = 0; i < texts.length; i++) { const t = texts[i].toLowerCase(); if (!t.includes(nl)) continue; if (hw.filter(w => t.includes(w)).length >= mn) { idx = i; break; } } }
  if (idx === -1 && texts.length === 1 && texts[0].toLowerCase().includes(nl)) idx = 0;
  if (idx === -1) { console.log("  [tag] no confident match — photo-only"); await search.fill("").catch(() => {}); await exitTagPanel(page); return false; }
  const cs = (htmls[idx].match(/\/in\/([a-z0-9\-]+)/i) || [])[1] || null;
  if (cs && slug && cs.toLowerCase() !== slug.toLowerCase()) { console.log("  [tag] slug mismatch — NOT tagging"); await exitTagPanel(page); return false; }
  await page.locator(sel).nth(idx).click(); await sleep(1200);
  // Commit the tag. LinkedIn rolled the confirm-button label "Add" → "Save" (also seen
  // as "Done") mid-2026 — accept whichever is present and click it the moment it's
  // enabled. Without committing, the person is selected (green chip) but the tag
  // sub-panel stays open OVER "Next", so the editor never advances to the composer and
  // the post times out (the ambiguous-name "straggler hang" — confirmed live).
  const confirmBtn = page.getByRole("button", { name: /^(Save|Add|Done)$/ });
  for (let attempt = 0; attempt < 10; attempt++) {
    const n = await confirmBtn.count().catch(() => 0);
    for (let k = 0; k < n; k++) {
      const b = confirmBtn.nth(k);
      if (await b.isEnabled({ timeout: 500 }).catch(() => false) && await b.isVisible().catch(() => false)) {
        await b.click().catch(() => {}); await sleep(1200); return true;
      }
    }
    await sleep(500);
  }
  await exitTagPanel(page); return false;
}

async function tidy(page) {
  for (let i = 0; i < 3; i++) {
    const open = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].some(d => d.querySelector('[aria-label="Text editor for creating content"]'))).catch(() => false);
    if (!open) break;
    const dis = page.getByRole("button", { name: "Dismiss" }).first();
    if (await dis.isVisible({ timeout: 1500 }).catch(() => false)) { await dis.click().catch(() => {}); await sleep(1000); }
    const disc = page.getByRole("button", { name: "Discard" }).first();
    if (await disc.isVisible({ timeout: 1500 }).catch(() => false)) { await disc.click().catch(() => {}); await sleep(1000); }
  }
}

async function cookOne(page, t) {
  const startPage = page; // pin our tab; if it changes mid-cook, that's a takeover
  await guard(page, startPage);
  // After a published post the composer closes and we're already on the posts page,
  // so only (re)navigate when we're NOT there (first cook, or after a failure-reset
  // to /feed/). Saves a full reload + settle per post.
  if (!(await page.url()).includes(`/company/${COMPANY_ID}/admin/page-posts`)) {
    await runStep(page, { do: "open", url: COMPANY_URL });
    await sleep(8000);
  }
  // Porter prefetch (clean page, before composer)
  const prof = await fetchProfile(page, t.url).catch(() => null);
  const realName = (prof && !prof.error && prof.name) ? prof.name : t.name;
  const headline = (prof && !prof.error) ? prof.headline : null;
  // open composer
  await runStep(page, { do: "click", target: "Start a post" });
  await sleep(3000);
  await uploadPhoto(page, t.image);
  // LOOP_LI_NOTAG=1 → skip photo-tagging entirely and post photo-only. Use it for
  // ambiguous-name tickets (many identical-name LinkedIn profiles) where (a) we can't
  // tag the right person safely anyway and (b) the tag flow leaves an incomplete pin
  // that blocks the editor from advancing past "Next". This is the SAME proven path
  // that succeeds for genuine no-match tickets — just chosen up front.
  const NOTAG = process.env.LOOP_LI_NOTAG === "1";
  let tagged = false;
  if (NOTAG) { console.log("  [tag] LOOP_LI_NOTAG=1 — photo-only, no tag attempted"); }
  else {
    tagged = await tagPerson(page, realName, headline, t.slug).catch((e) => { console.log("  [tag] err:", e.message.slice(0, 60)); return false; });
    await clearTagRemnants(page);  // drop any lingering tag dropdown/empty pin before advancing
  }
  // advance media editor → caption stage. CRITICAL: scope "Next" to the Editor MODAL.
  // The admin page BEHIND the modal also carries "Next"-ish targets, and a page-wide
  // match (or the old document-walking coordinate click) lands there — scrolling the
  // background while the modal's real "Next" sits untouched, so the composer is never
  // reached (observed live: "the page scrolls behind the modal and it goes dead").
  // The TEXT EDITOR appearing is the only true success signal.
  // Gate on the composer's "Post" button appearing — NOT on the text editor being
  // "visible". A stale/hidden text-editor node from the media-editor stage reports
  // visible and makes us skip "Next", then the fill clicks a dead element → 30s timeout
  // (the real straggler hang). "Post" exists ONLY at the composer stage: the image
  // editor has Next/Back, the tag sub-panel has Save. Click ONLY the modal's "Next".
  const dlg = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Editor", exact: true }) }).first();
  const postBtn = page.getByRole("button", { name: "Post", exact: true }).first();
  for (let i = 0; i < 6 && !(await postBtn.isVisible({ timeout: 1500 }).catch(() => false)); i++) {
    const nextBtn = dlg.getByRole("button", { name: "Next", exact: true }).first();
    if (await nextBtn.isVisible({ timeout: 1000 }).catch(() => false)) await nextBtn.click({ timeout: 5000 }).catch(() => {});
    await sleep(1800);
  }
  if (!await postBtn.isVisible({ timeout: 3000 }).catch(() => false)) throw new Error("caption stage not reached");
  // Fill the caption SCOPED to the composer dialog. The page-wide label "Text editor
  // for creating content" is NOT unique — every feed post below carries a comment box
  // with the identical label, so getByLabel(...).first() grabs a feed comment box and
  // the fill times out (broke 2026-07-17 once the feed loaded more posts). Scope to the
  // dialog that owns the "Post" button; the composer caption is its editable textbox
  // (placeholder "What do you want to talk about?"). No LLM — deterministic heal.
  const composer = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Post", exact: true }) }).first();
  const captionBox = composer.locator('div.ql-editor[role="textbox"], [role="textbox"][aria-placeholder*="talk about" i]').first();
  await captionBox.click({ timeout: 5000 });
  await captionBox.pressSequentially(t.caption, { delay: 6 });
  await sleep(1500);
  // GUARD before the irreversible Post: make sure a human/auto-process hasn't taken
  // over (navigated away, switched tabs, closed our tab). If so, abort — don't click.
  await guard(page, startPage);
  // publish + verify on LinkedIn's "Post successful." confirmation (NEW: LinkedIn now shows a
  // "Post successful / Try Premium Page" upsell modal after every post). That modal is the reliable
  // success signal — and it MUST be dismissed ("No thanks"), or it stays up and blocks the next post
  // (this is what false-negatived verify and caused the cascade of failures).
  const post = page.getByRole("button", { name: "Post", exact: true });
  await post.click();
  let ok = false;
  try {
    await page.waitForFunction(() => /Post successful/i.test(document.body.innerText || ""), { timeout: 30000 });
    ok = true;
  } catch { ok = false; }
  // dismiss the success/upsell modal so the next post can start cleanly
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /^No thanks$/i.test((b.textContent || "").trim()))
      || [...document.querySelectorAll("button")].find((b) => /dismiss|close/i.test(b.getAttribute("aria-label") || ""));
    if (btn) btn.click();
  }).catch(() => {});
  await sleep(1500);
  return { ok, tagged };
}

const b = await connect();
let posted = 0, consec = 0;
const attempted = new Set();
while (posted < MAX) {
  // Dedup on BOTH slug (historical entries) and file (always present — survives null slugs).
  // LOOP_LI_FORCE=1 → owner-requested repost: skip the Service Log dedup so an
  // already-served ticket can go out again (only `attempted` still guards this run).
  // Off by default; normal drains are unchanged. Pair with a one-item pantry.
  const FORCE = process.env.LOOP_LI_FORCE === "1";
  const done = FORCE
    ? new Set([...attempted])
    : new Set([...servedSet(DISH, "slug"), ...servedSet(DISH, "file"), ...attempted]);
  const t = pickNextTicket(PANTRY, done);
  if (!t) { console.log("\n✓ PANTRY DRAINED"); break; }
  attempted.add(t.file);              // file is always present; slug is null for company URLs
  if (t.slug) attempted.add(t.slug);
  console.log(`\n=== COOK ${posted + 1}: ${t.name} (${t.file}) ===`);
  let page;
  try {
    ({ page } = await activePage(b));
    page.__loopHealed = false;                       // graduation signal, reset per cook
    const { ok, tagged } = await cookOne(page, t);
    if (ok) {
      recordDish(DISH, { target: t.name, slug: t.slug, file: t.file, status: "served", tagged, note: "cooked by line-cook driver" });
      recordRun(DISH, DRIVER_VERSION, { clean: !page.__loopHealed });   // drivers graduate too
      posted++; consec = 0;
      console.log(`✓ PUBLISHED: ${t.name}${tagged ? " (tagged)" : " (photo-only)"}  [${posted}]`);
      await sleep(25000 + Math.random() * 20000); // human pace between posts
    } else {
      throw new Error("publish not confirmed");
    }
  } catch (e) {
    // Human/external took over — STOP immediately, record it, flag it. Don't tidy
    // or navigate (that would fight the human, who has priority). We only need to KNOW.
    if (e.name === "Interrupt") {
      const msg = `${new Date().toISOString()}  INTERRUPTED at "${t.name}" — ${e.message}`;
      console.error(`\n⚠ ${msg}\n  Human/external has the wheel — stopping the batch (human is priority). ${posted} posted before this.`);
      recordDish(DISH, { target: t.name, slug: t.slug, file: t.file, status: "interrupted", note: e.message });
      try { writeFileSync("runs/cook-interrupted.flag", msg + `\n  posted-this-run: ${posted}\n`); } catch {}
      break;
    }
    consec++;
    console.error(`✗ FAIL: ${t.name} — ${e.message.slice(0, 140)}`);
    recordDish(DISH, { target: t.name, slug: t.slug, file: t.file, status: "failed", error: e.message.slice(0, 140) });
    // Capture the stuck state, then just tidy the composer — stay on the posts page (no /feed/ bounce).
    escapeNativePicker(); // a failed upload may have stranded a CDP-invisible native picker — clear it first
    try { ({ page } = await activePage(b)); await page.screenshot({ path: `runs/scratch/cook-fail-${t.slug || posted}.png` }).catch(() => {}); await tidy(page); } catch {}
    if (consec >= MAX_CONSEC_FAILS) { console.error(`\n■ STOPPED — ${consec} consecutive fails`); break; }
    await sleep(10000);
  }
}
console.log(`\nDONE — published ${posted} this run.`);
await b.close();
