// cook-linkedin-batch.mjs — deterministic driver for the Tablon LinkedIn BATCH
// spotlight format (6 people, one shared image, one shared caption, one post).
// No LLM in the hot path: matching is Voyager-headline-lookup + exact-substring
// match-or-skip, the exact method proven live on 2026-09-07 (BATCH-1: 3/6 tagged,
// 3/6 correctly left untagged — 2 ambiguous common names, 1 dead source URL).
// Usage: LOOP_PANTRY=/path/to/YYYY-MM-DD LOOP_LI_COMPANY_ID=<id> node cook-linkedin-batch.mjs
//
// Dedup is BATCH-LEVEL (same 6-person combo never posted twice), read from
// posted-log.txt — NOT per-person history. A person can legitimately appear in
// more than one batch on different days; only an identical 6-person batch repeats
// never (see linkedin-posts/INSTRUCTIONS.md).
import { connect, activePage } from "./lib.mjs";
import { fetchProfile, slugOf } from "./porter.mjs";
import { readFileSync, readdirSync, appendFileSync, existsSync } from "fs";
import path from "path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// insertText's CDP call was observed live to NOT reliably land before subsequent
// keyboard operations started — the caption's intro line ended up landing near the
// very END of the document instead of the start (confirmed via raw innerHTML: a
// mangled fragment of it, missing the first word, appeared after the hashtags).
// Verify the text actually appears where expected before moving on; retry if not.
async function verifiedInsertText(page, captionBox, text, expectedSubstring) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.keyboard.insertText(text);
    await sleep(900);
    const current = await captionBox.innerText();
    if (current.includes(expectedSubstring)) return true;
    console.log(`  verifiedInsertText: attempt ${attempt} — expected text not found yet, retrying`);
    await sleep(800);
  }
  return false;
}

const PANTRY = process.env.LOOP_PANTRY;
const COMPANY_ID = process.env.LOOP_LI_COMPANY_ID || "<companyId>";
const COMPANY_URL = `https://www.linkedin.com/company/${COMPANY_ID}/admin/page-posts/published/`;
if (!PANTRY || !existsSync(PANTRY)) { console.log(`no pantry ${PANTRY} — nothing to post`); process.exit(0); }
const LOG_FILE = path.join(path.dirname(PANTRY), "posted-log.txt");
const DATE = path.basename(PANTRY);

// ---------- parse a BATCH-N-DATE.txt ----------
// Format as of 2026-09-07 (2nd revision, same day): the caption carries NO @Name
// placeholders — tags are inserted live into the gap between the intro line and
// "Join Us:". The tag list gives "N. Name — personal LinkedIn: URL" only; anyone
// without a verifiable personal profile is simply omitted from the list entirely
// (no more company-page fallback URLs).
function parseBatchFile(content) {
  const imgMatch = content.match(/Image:\s*(\S+)/);
  const capMarkerMatch = content.match(/CAPTION \(copy exactly[^)]*\):/);
  const tagStart = content.indexOf("TAGGING —");
  if (!capMarkerMatch || tagStart === -1) return null;
  const capStart = capMarkerMatch.index + capMarkerMatch[0].length;
  const rawCaption = content.slice(capStart, tagStart).replace(/^\n+/, "").replace(/\n+$/, "\n");
  const joinIdx = rawCaption.indexOf("Join Us:");
  const intro = joinIdx === -1 ? rawCaption : rawCaption.slice(0, joinIdx);
  const rest = joinIdx === -1 ? "" : rawCaption.slice(joinIdx);
  const tagBlock = content.slice(tagStart);
  const tags = [...tagBlock.matchAll(/^\s*\d+\.\s*(.+?)\s*—\s*personal LinkedIn:\s*(\S+)/gim)]
    .map((m) => ({ name: m[1].trim(), url: m[2].trim() }));
  return { image: imgMatch ? imgMatch[1] : null, intro, rest, tags };
}

// ---------- batch-level dedup against posted-log.txt ----------
function alreadyPosted(names) {
  if (!existsSync(LOG_FILE)) return false;
  const log = readFileSync(LOG_FILE, "utf8");
  const key = names.map((n) => n.toLowerCase().trim()).sort().join("|");
  for (const m of log.matchAll(/Batch \d+ \(\d+ people:\s*([^)]+)\)/g)) {
    const those = m[1].split(",").map((s) => s.toLowerCase().trim()).sort().join("|");
    if (those === key) return true;
  }
  return false;
}

function logBatch(batchNum, tags, taggedNames, url) {
  const untagged = tags.filter((t) => !taggedNames.includes(t.name));
  const lines = [
    `DATE: ${DATE}`,
    `Batch ${batchNum} (${tags.length} people: ${tags.map((t) => t.name).join(", ")}) — ${url}`,
    taggedNames.length ? `  tagged: ${taggedNames.join(", ")}` : `  tagged: (none)`,
    untagged.length ? `  untagged: ${untagged.map((t) => t.name).join(", ")}` : `  untagged: (none)`,
    "---",
    "",
  ];
  appendFileSync(LOG_FILE, lines.join("\n"));
}

// ---------- image upload (ported from cook-linkedin.mjs, proven) ----------
async function findAddMedia(page) {
  return page.evaluate(() => {
    const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('[aria-label="Text editor for creating content"]'));
    if (!dlg) return null;
    const btns = [...dlg.querySelectorAll("button, [role=\"button\"]")];
    const b = btns.find((x) => /add a photo|add media|photo/i.test(x.getAttribute("aria-label") || x.textContent || ""));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });
}
async function imageRendered(page, timeout = 15000) {
  return page.waitForFunction(() => {
    const ok = (b) => /^(Alternative text|Edit background)$/i.test((b.textContent || b.getAttribute("aria-label") || "").trim());
    for (const b of document.querySelectorAll("button")) if (ok(b) && b.offsetParent !== null) return true;
    return false;
  }, { timeout }).then(() => true).catch(() => false);
}
let pendingUploadImage = null;
const armedPages = new WeakSet();
function armFileChooser(page) {
  if (armedPages.has(page)) return;
  armedPages.add(page);
  page.on("filechooser", async (fc) => {
    const img = pendingUploadImage;
    if (!img) return;
    pendingUploadImage = null;
    try { await fc.setFiles(img); } catch {}
  });
}
async function uploadPhoto(page, image) {
  await page.getByLabel(/Text editor for creating content/i).first().waitFor({ state: "visible", timeout: 12000 });
  armFileChooser(page);
  const coords = await findAddMedia(page);
  if (!coords) throw new Error("Add media button not found");
  pendingUploadImage = image;
  try {
    await page.mouse.click(coords.cx, coords.cy);
    await sleep(2500);
    if (!(await imageRendered(page))) throw new Error("upload: image did not render");
  } finally {
    pendingUploadImage = null;
  }
}

// ---------- advance image editor -> caption stage ----------
async function reachCaptionStage(page) {
  const dlg = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Editor", exact: true }) }).first();
  const postBtn = page.getByRole("button", { name: "Post", exact: true }).first();
  for (let i = 0; i < 6 && !(await postBtn.isVisible({ timeout: 1500 }).catch(() => false)); i++) {
    const nextBtn = dlg.getByRole("button", { name: "Next", exact: true }).first();
    if (await nextBtn.isVisible({ timeout: 1000 }).catch(() => false)) await nextBtn.click({ timeout: 5000 }).catch(() => {});
    await sleep(1800);
  }
  if (!(await postBtn.isVisible({ timeout: 3000 }).catch(() => false))) throw new Error("caption stage not reached");
}

// A stray typeahead dropdown left open from a PRIOR mention was proven live to
// intercept pointer events and corrupt the NEXT mention's search (confirmed: a
// leftover dropdown blocked a click outright; in the batch loop this is the likely
// cause of false "0 candidates" for people who are definitely real, findable
// LinkedIn members — a given personal URL is itself strong evidence of that).
// Verify the dropdown is actually gone, don't just assume a keypress closed it.
async function ensureDropdownClosed(page) {
  for (let i = 0; i < 5; i++) {
    const openCount = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].filter((el) => el.offsetParent !== null).length);
    if (openCount === 0) return true;
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(400);
  }
  return false;
}

// ---------- one @mention: type fresh at the current cursor, match-by-headline-or-skip ----------
// Confidence bar: exactly ONE candidate whose visible text contains a distinctive
// slice of the Voyager-fetched reference headline (or, lacking a headline, is the
// SOLE exact full-name match). Zero or multiple -> fall back to plain name text
// (never guess on a real person's public tag). Leaves the cursor ready for a
// newline before the next person — caller presses Enter after this returns.
async function tagOnePerson(page, tag) {
  if (!(await ensureDropdownClosed(page))) console.log(`  [${tag.name}] WARNING: a stray dropdown wouldn't close before this search started`);
  const slug = slugOf(tag.url);
  let refHeadline = null, refName = null;
  if (slug) {
    // Retry — confirmed live that a Voyager lookup can fail transiently deep into a
    // long session (many prior calls), silently falling back to weaker exact-name-only
    // matching, which fails whenever multiple same-named people exist (exactly what
    // happened to a person whose real headline WAS present and matchable).
    let prof = null;
    for (let attempt = 1; attempt <= 3 && (!prof || prof.error); attempt++) {
      if (attempt > 1) await sleep(1500);
      prof = await fetchProfile(page, tag.url).catch((e) => ({ error: String(e.message || e) }));
    }
    if (prof && !prof.error) {
      if (prof.headline) refHeadline = prof.headline;
      if (prof.name) refName = prof.name;
    } else console.log(`  [${tag.name}] Voyager lookup: ${prof && prof.error ? prof.error : "no data"} (after retries)`);
  } else {
    console.log(`  [${tag.name}] given URL has no /in/ slug — will match by exact full name only`);
  }
  // Search using LinkedIn's OWN name for this profile when we have it — the batch
  // file's name (from signup data) can differ from what's actually on their LinkedIn
  // profile (nicknames, middle names, transliteration), which would make the search
  // miss someone who is definitely findable. Voyager's name is what the typeahead
  // actually indexes against.
  const searchName = refName || tag.name;
  const matchName = (refName || tag.name).toLowerCase();

  // type progressively more of the name until the candidate list resolves to 1
  const words = searchName.split(/\s+/);
  let query = `@${words[0]}`;
  await page.keyboard.type(query, { delay: 60 });
  await sleep(2000);

  let matchIdx = -1, candidates = [];
  for (let extra = 1; extra <= words.length; extra++) {
    candidates = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].filter((el) => el.offsetParent !== null).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()));
    if (refHeadline) {
      const needle = refHeadline.slice(0, 30).toLowerCase();
      const hits = candidates.map((c, i) => (c.toLowerCase().includes(needle) ? i : -1)).filter((i) => i >= 0);
      if (hits.length === 1) { matchIdx = hits[0]; break; }
    } else {
      // no headline available: only accept a SOLE exact full-name match (against
      // whichever name we searched with)
      const hits = candidates.map((c, i) => (c.toLowerCase().startsWith(matchName) ? i : -1)).filter((i) => i >= 0);
      if (hits.length === 1) { matchIdx = hits[0]; break; }
    }
    // narrow the search with the next word of the name, if any left
    const nextWord = words[extra];
    if (!nextWord || query.includes(nextWord)) break;
    const add = ` ${nextWord}`;
    await page.keyboard.type(add, { delay: 60 });
    query += add;
    await sleep(1800);
  }

  if (matchIdx === -1) {
    console.log(`  [${tag.name}] no confident match (${candidates.length} candidates) — leaving as plain text`);
    if (!(await ensureDropdownClosed(page))) console.log(`  [${tag.name}] WARNING: dropdown wouldn't close before cleanup`);
    // Undo exactly what we typed via a verified Selection.modify() delete, not blind
    // Backspace keypresses — those were found to be silently swallowed/miscounted by
    // the mention-typeahead's own key handling (confirmed live: left "@Shunyu YaoShunyu
    // Yao" — the backspaces did nothing and insertText just appended). Selection-based
    // deletion bypasses the typeahead's keydown interception entirely.
    const del = await page.evaluate((count) => {
      const sel = window.getSelection();
      if (!sel.rangeCount) return { ok: false, reason: "no-selection" };
      sel.collapseToEnd();
      for (let i = 0; i < count; i++) sel.modify("extend", "backward", "character");
      const removedLen = sel.toString().length;
      if (removedLen !== count) return { ok: false, reason: "length-mismatch", removedLen };
      sel.getRangeAt(0).deleteContents();
      return { ok: true };
    }, query.length);
    if (!del.ok) {
      console.log(`  [${tag.name}] cleanup delete FAILED (${JSON.stringify(del)}) — caption may need manual review`);
      return { tagged: false, reason: "cleanup-failed" };
    }
    await sleep(200);
    // Prefer the Voyager-verified LinkedIn display name over the batch file's name —
    // confirmed live (2026-09-07 BATCH-10) that they can differ (signup/app data said
    // "Annie Byers", her actual LinkedIn name is "Annie B") and the untagged fallback
    // must still read correctly on the public post.
    const fallbackName = refName || tag.name;
    await page.keyboard.insertText(fallbackName);
    return { tagged: false, reason: "ambiguous", candidateCount: candidates.length, fallbackName };
  }

  const clicked = await page.evaluate((idx) => {
    const opts = [...document.querySelectorAll('[role="option"]')].filter((el) => el.offsetParent !== null);
    if (!opts[idx]) return false;
    opts[idx].click();
    return true;
  }, matchIdx);
  await sleep(1500);
  if (!clicked) return { tagged: false, reason: "click-failed" };
  if (!(await ensureDropdownClosed(page))) console.log(`  [${tag.name}] WARNING: dropdown wouldn't close after tagging`);
  console.log(`  [${tag.name}] tagged ✓`);
  return { tagged: true };
}

// ---------- defensive cleanup: a prior batch's failure can leave an open composer
// or a "Save as draft?" prompt sitting on top of it (confirmed live: a stuck batch's
// leftover draft blocks every subsequent batch's "Start a post" click). Discard any
// unpublished draft found so the next batch starts from a clean admin page. ----------
async function closeAnyStrayComposer(page) {
  const draftPrompt = await page.evaluate(() => !![...document.querySelectorAll("h2,h3,div")].find((el) => (el.textContent || "").trim() === "Save this post as a draft?"));
  if (draftPrompt) {
    const discarded = await page.evaluate(() => {
      const heading = [...document.querySelectorAll("h2,h3,div")].find((el) => (el.textContent || "").trim() === "Save this post as a draft?");
      const dlg = heading ? (heading.closest('[role="dialog"], [role="alertdialog"]') || heading.parentElement.parentElement) : null;
      const btn = dlg ? [...dlg.querySelectorAll("button")].find((b) => /^Discard$/i.test((b.textContent || "").trim())) : null;
      if (!btn) return false;
      btn.click();
      return true;
    });
    console.log(`  cleanup: discarded a stray draft-prompt (${discarded})`);
    await sleep(1500);
    return;
  }
  const composerOpen = await page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Post", exact: true }) }).first().isVisible({ timeout: 2000 }).catch(() => false);
  if (composerOpen) {
    console.log("  cleanup: closing a stray open composer");
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(1000);
    await closeAnyStrayComposer(page); // the Escape likely raised the draft prompt — handle it
  }
}

// ---------- post one batch end to end ----------
async function postBatch(page, batchFile, batchNum) {
  const content = readFileSync(batchFile, "utf8");
  const batch = parseBatchFile(content);
  if (!batch || !batch.image || !batch.intro || batch.tags.length === 0) {
    console.log(`BATCH ${batchNum}: could not parse ${batchFile} — skipping`);
    return;
  }
  const names = batch.tags.map((t) => t.name);
  if (alreadyPosted(names)) {
    console.log(`BATCH ${batchNum}: identical 6-person combo already posted — skipping (dedup)`);
    return;
  }
  console.log(`\n=== BATCH ${batchNum}: ${names.join(", ")} ===`);

  await closeAnyStrayComposer(page);
  if (!(await page.url()).includes(`/company/${COMPANY_ID}/admin/page-posts`)) {
    await page.goto(COMPANY_URL, { waitUntil: "domcontentloaded" });
    await sleep(4000);
  }
  await page.getByRole("button", { name: "Start a post", exact: true }).first().click({ timeout: 15000 });
  await sleep(3000);

  const imagePath = path.join(path.dirname(batchFile), batch.image);
  await uploadPhoto(page, imagePath);
  await reachCaptionStage(page);

  const composer = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Post", exact: true }) }).first();
  const captionBox = composer.locator('div.ql-editor[role="textbox"]').first();
  await captionBox.click({ timeout: 5000 });
  // Build the caption BACKWARDS from what you'd expect: tags + rest FIRST (into the
  // empty box, so ordering can't go wrong), then the intro is inserted LAST at a
  // Range explicitly placed at the very start of the document. This sidesteps a
  // confirmed live bug: inserting the intro first and typing @mentions afterward
  // let something in the tag loop corrupt/relocate it (it kept ending up mangled
  // at the very end, missing its first word) — inserting it last, at a precisely
  // controlled position, can't be disturbed by anything that comes after it.
  const taggedNames = [];
  for (const tag of batch.tags) {
    const r = await tagOnePerson(page, tag);
    if (r.tagged) taggedNames.push(tag.name);
    await page.keyboard.press("Enter");
    // Paced deliberately slow — rapid-fire @mention typeahead queries (6 back-to-back
    // in under a minute) were observed live to trip a silent LinkedIn throttle: every
    // candidate list came back empty for a whole batch right after a fast prior batch.
    await sleep(3000);
  }

  // One more Enter than the per-tag loop leaves: the source pantry file has a blank
  // line between the intro and "Join Us:" (confirmed live 2026-09-08 — the posted
  // caption was missing that gap because `rest` starts AT "Join Us:", not before it).
  await page.keyboard.press("Enter");
  await sleep(300);
  const restOk = await verifiedInsertText(page, captionBox, batch.rest, "Join Us:");
  if (!restOk) throw new Error("closing text (Join Us etc.) failed to land after 3 attempts — aborting this batch, nothing posted");

  const cursorAtStart = await page.evaluate(() => {
    const editor = document.querySelector('div.ql-editor[role="textbox"]');
    const first = editor.firstChild;
    if (!first) return false;
    const range = document.createRange();
    range.setStart(first, 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  });
  if (!cursorAtStart) throw new Error("could not place cursor at document start for the intro — aborting this batch, nothing posted");
  await sleep(300);
  const introOk = await verifiedInsertText(page, captionBox, batch.intro, batch.intro.trim().split("\n")[0]);
  if (!introOk) throw new Error("intro text failed to land after 3 attempts — aborting this batch, nothing posted");
  // verify it's actually AT THE START, not just present somewhere
  const finalText = await captionBox.innerText();
  if (!finalText.trim().startsWith(batch.intro.trim().split("\n")[0])) {
    throw new Error(`intro landed but NOT at the start of the caption — aborting, needs manual review. Current text starts: "${finalText.slice(0, 60)}"`);
  }

  // STOP HERE. Never auto-click Post — the owner reviews the prepared draft (image,
  // caption, tags) and clicks Post themselves. This script's job ends at "ready".
  console.log(`\nBATCH ${batchNum}: READY — ${taggedNames.length}/${batch.tags.length} tagged (${taggedNames.join(", ") || "none"}).`);
  const untagged = names.filter((n) => !taggedNames.includes(n));
  if (untagged.length) console.log(`  still plain text: ${untagged.join(", ")}`);
  console.log(`  Review the open draft and press Post yourself when ready.`);
  return { prepared: true, batchNum, names, taggedNames };
}

// ---------- main: prepare exactly ONE not-yet-posted batch, then stop ----------
const files = readdirSync(PANTRY).filter((f) => /^BATCH-\d+-.*\.txt$/.test(f)).sort((a, b) => {
  const na = +(a.match(/^BATCH-(\d+)-/) || [0, 0])[1], nb = +(b.match(/^BATCH-(\d+)-/) || [0, 0])[1];
  return na - nb;
});
if (!files.length) { console.log(`no BATCH-*.txt files in ${PANTRY}`); process.exit(0); }

const browser = await connect({ autostart: false });
const { page } = await activePage(browser);
let prepared = false;
for (const f of files) {
  const batchNum = +(f.match(/^BATCH-(\d+)-/) || [0, 0])[1];
  const content = readFileSync(path.join(PANTRY, f), "utf8");
  const parsed = parseBatchFile(content);
  if (parsed && parsed.tags.length && alreadyPosted(parsed.tags.map((t) => t.name))) {
    console.log(`BATCH ${batchNum}: already posted — skipping`);
    continue;
  }
  try {
    const r = await postBatch(page, path.join(PANTRY, f), batchNum);
    if (r && r.prepared) { prepared = true; break; }
  } catch (e) {
    console.log(`BATCH ${batchNum}: ERROR ${e.message} — trying next batch`);
    await closeAnyStrayComposer(page);
  }
}
if (!prepared) console.log("\nNo batch could be prepared (all posted, or all failed).");
console.log("\nSCRIPT DONE — the draft (if any) is left open in the browser for you to review and post.");
console.log("Note: this script does NOT log to posted-log.txt anymore — that only happens once YOU confirm the post is live.");
process.exit(0);
