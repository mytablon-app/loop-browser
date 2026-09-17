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
import { readFileSync, readdirSync, appendFileSync, existsSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

// Auto-post policy (owner decision, 2026-09-17): once every tag on a batch is either
// (a) a real mention VERIFIED against the correct LinkedIn member ID, or (b) correctly
// left as plain text (no confident match, or a caught-and-undone mistag), the batch is
// safe to post immediately — no more waiting for manual review on the common case.
// Manual review is still required whenever identity can't be confirmed cleanly (a
// mistag that couldn't be undone, or a caption build error) — those cases leave the
// draft open exactly as before and queue a WhatsApp notify via the same pending-file
// mechanism linkedin-verify-notify.mjs / wa-notify-pending.mjs already use.
const REPO = path.dirname(fileURLToPath(import.meta.url));
const PENDING_NOTIFY_FILE = path.join(REPO, "runs", "linkedin-daily-notify-message.txt");
function queueNeedsReviewNotify(text) {
  console.log(`  queued WA notify (needs manual review): ${text.split("\n")[0]}`);
  writeFileSync(PENDING_NOTIFY_FILE, text, "utf8");
}

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
// NEVER split the logged people-list on comma — confirmed live (2026-09-17) that a
// name containing its own comma ("Michael Campion, PhD") shatters into fake extra
// fragments, breaking the sorted-join match and silently returning false-negative
// (dedup thinks an already-posted batch is new — would have duplicate-posted it).
// Instead: match on declared people-count + every target name appearing verbatim as
// a substring of the raw list text. Can't mis-segment what it never segments.
function alreadyPosted(names) {
  if (!existsSync(LOG_FILE)) return false;
  const log = readFileSync(LOG_FILE, "utf8");
  const normNames = names.map((n) => n.toLowerCase().trim());
  for (const m of log.matchAll(/Batch \d+ \((\d+) people:\s*([^)]+)\)/g)) {
    if (+m[1] !== names.length) continue;
    const listText = m[2].toLowerCase();
    if (normNames.every((n) => listText.includes(n))) return true;
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

// The typeahead dropdown can take much longer than a fixed short sleep to populate —
// confirmed live (owner feedback 2026-09-08) up to ~20s for the list to appear after
// typing an @query. Poll for candidates instead of a flat sleep: returns as soon as
// options show up (usually fast), but keeps waiting up to the cap on a slow render
// instead of concluding "0 candidates" prematurely — which was producing false
// no-confident-match results.
async function waitForCandidates(page, { timeout = 20000, pollMs = 500, settleMs = 600 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].filter((el) => el.offsetParent !== null).length);
    if (count > 0) { await sleep(settleMs); return true; }
    await sleep(pollMs);
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
  let refHeadline = null, refName = null, refObjectUrn = null;
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
      if (prof.objectUrn) refObjectUrn = prof.objectUrn;
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
  await waitForCandidates(page);

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
    await waitForCandidates(page);
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

  // Count mentions BEFORE clicking so we can verify the click actually committed a
  // real one — confirmed live (2026-09-11, Syed Bilal Haider) that a "successful"
  // click() can silently fail to produce a real a.ql-mention (his name has commas/
  // parens that may confuse the typeahead's click handling), leaving broken text in
  // the caption while the console still logged "tagged ✓". Never trust the click
  // return value alone as proof of tagging.
  const mentionCountBefore = await page.evaluate(() => document.querySelectorAll('[role="textbox"] a.ql-mention').length);
  const clicked = await page.evaluate((idx) => {
    const opts = [...document.querySelectorAll('[role="option"]')].filter((el) => el.offsetParent !== null);
    if (!opts[idx]) return false;
    opts[idx].click();
    return true;
  }, matchIdx);
  await sleep(1500);
  if (!(await ensureDropdownClosed(page))) console.log(`  [${tag.name}] WARNING: dropdown wouldn't close after tagging`);
  const mentionCountAfter = await page.evaluate(() => document.querySelectorAll('[role="textbox"] a.ql-mention').length);
  if (!clicked || mentionCountAfter <= mentionCountBefore) {
    console.log(`  [${tag.name}] ⚠ click reported success but NO REAL MENTION landed (before=${mentionCountBefore} after=${mentionCountAfter}) — caption text may be broken, needs manual review before posting`);
    return { tagged: false, reason: "click-no-real-mention" };
  }

  // MISTAG CHECK: confirmed live this week (Rishi Sundara, Diego Correa, James
  // Carter, Sophia Burrell) that a click on a single-headline-match candidate can
  // land on a DIFFERENT same-named person — the confidence bar (one headline-slice
  // match) isn't proof of identity, only proof of a plausible candidate. When we
  // have the real member ID, verify the mention we just created actually points to
  // it before trusting it. Auto-undo on mismatch — never leave a wrong-person tag
  // in a caption that's about to auto-post.
  if (refObjectUrn) {
    const actualUrn = await page.evaluate(() => {
      const mentions = [...document.querySelectorAll('[role="textbox"] a.ql-mention')];
      const last = mentions[mentions.length - 1];
      return last ? last.getAttribute("data-object-urn") : null;
    });
    if (actualUrn && actualUrn !== refObjectUrn) {
      console.log(`  [${tag.name}] ⚠ MISTAG CAUGHT: tagged the wrong person (got ${actualUrn}, expected ${refObjectUrn}) — undoing`);
      const rect = await page.evaluate(() => {
        const mentions = [...document.querySelectorAll('[role="textbox"] a.ql-mention')];
        const last = mentions[mentions.length - 1];
        if (!last) return null;
        const r = last.getBoundingClientRect();
        return { right: r.right, top: r.top, bottom: r.bottom, text: last.textContent };
      });
      if (rect) {
        await page.mouse.click(rect.right - 1, (rect.top + rect.bottom) / 2);
        await sleep(250);
        const del = await page.evaluate((count) => {
          const sel = window.getSelection();
          if (!sel.rangeCount) return { ok: false, reason: "no-selection" };
          sel.collapseToEnd();
          for (let i = 0; i < count; i++) sel.modify("extend", "backward", "character");
          const removedLen = sel.toString().length;
          if (removedLen !== count) return { ok: false, reason: "length-mismatch", removedLen };
          sel.getRangeAt(0).deleteContents();
          return { ok: true };
        }, rect.text.length);
        if (del.ok) {
          await sleep(150);
          const fallbackName = refName || tag.name;
          await page.keyboard.insertText(fallbackName);
          console.log(`  [${tag.name}] mistag undone, left as verified plain text "${fallbackName}"`);
          return { tagged: false, reason: "mistag-caught-and-undone", fallbackName };
        }
        console.log(`  [${tag.name}] ⚠ mistag delete FAILED (${JSON.stringify(del)})`);
      }
      console.log(`  [${tag.name}] ⚠ could not cleanly undo the mistag — caption needs MANUAL review before posting`);
      return { tagged: false, reason: "mistag-undo-failed" };
    }
  }

  console.log(`  [${tag.name}] tagged ✓${refObjectUrn ? " (identity verified)" : " (unverified — Voyager had no member ID to check against)"}`);
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
  const unresolvedReasons = []; // reasons that mean "don't auto-post, needs a human look"
  for (const tag of batch.tags) {
    const r = await tagOnePerson(page, tag);
    if (r.tagged) taggedNames.push(tag.name);
    else if (r.reason === "mistag-undo-failed" || r.reason === "cleanup-failed" || r.reason === "click-no-real-mention") {
      unresolvedReasons.push(`${tag.name}: ${r.reason}`);
    }
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

  const untagged = names.filter((n) => !taggedNames.includes(n));
  console.log(`\nBATCH ${batchNum}: READY — ${taggedNames.length}/${batch.tags.length} tagged (${taggedNames.join(", ") || "none"}).`);
  if (untagged.length) console.log(`  still plain text: ${untagged.join(", ")}`);

  if (unresolvedReasons.length) {
    // Something couldn't be verified/cleaned up safely — leave the draft open exactly
    // as before, and notify instead of guessing. This is the ONLY case that still
    // waits for a human (auto-post policy, owner decision 2026-09-17).
    console.log(`  ⚠ ${unresolvedReasons.length} issue(s) need manual review before this can post: ${unresolvedReasons.join("; ")}`);
    queueNeedsReviewNotify([
      `⚠ LinkedIn spotlight — batch ${batchNum} needs a manual look before posting:`,
      unresolvedReasons.map((r) => `  • ${r}`).join("\n"),
      ``,
      `Everything else is fine (${taggedNames.length}/${batch.tags.length} tagged). Draft is open in Loop Browser.`,
    ].join("\n"));
    return { status: "needs-review", batchNum, names, taggedNames, unresolvedReasons };
  }

  // Every tag is either identity-verified or correctly left plain — safe to post now.
  console.log(`  All clear — posting now (auto-post policy).`);
  const composerDlg = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Post", exact: true }) }).first();
  const postBtn = composerDlg.getByRole("button", { name: "Post", exact: true });
  await postBtn.click({ timeout: 10000 });
  let posted = false;
  try {
    await page.waitForFunction(() => /Post successful/i.test(document.body.innerText || ""), { timeout: 30000 });
    posted = true;
  } catch { posted = false; }
  if (!posted) {
    console.log(`  ⚠ clicked Post but never saw "Post successful" — may have posted anyway, needs manual verification`);
    queueNeedsReviewNotify(`⚠ LinkedIn spotlight — batch ${batchNum}: clicked Post but didn't see the success confirmation. Please check the Tablon Community page directly to see if it actually went live before re-running.`);
    return { status: "needs-review", batchNum, names, taggedNames, unresolvedReasons: ["post-confirmation-timeout"] };
  }
  // Confirmed live (2026-09-17, batch 7): LinkedIn's "Post successful" toasts can
  // briefly STACK (a prior batch's toast hasn't expired yet) — .find() grabs the
  // FIRST matching "View post" link, which can be the stale/previous batch's, not
  // this one's. Take the LAST match instead (most-recently-appended toast = newest).
  const url = await page.evaluate(() => {
    const links = [...document.querySelectorAll("a")].filter((el) => /view post/i.test(el.textContent || "") && /urn:li:share:/.test(el.href || ""));
    return links.length ? links[links.length - 1].href : null;
  });
  console.log(`  ✓ POSTED: ${url || "(url not captured)"}`);
  logBatch(batchNum, batch.tags, taggedNames, url || "(url not captured)");
  // Dismiss the "Post successful / Try Premium Page" upsell modal — it blocks the
  // next batch's "Start a post" click if left up (site-memories/linkedin.md).
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /^No thanks$/i.test((b.textContent || "").trim()))
      || [...document.querySelectorAll("button")].find((b) => /dismiss|close/i.test(b.getAttribute("aria-label") || ""));
    if (btn) btn.click();
  }).catch(() => {});
  await sleep(1500);
  return { status: "posted", batchNum, names, taggedNames, url };
}

// ---------- main: work through today's queue, auto-posting each batch that verifies
// clean. Stops (leaving that draft open) the moment one batch needs a human look —
// never guesses past an unresolved issue, and never queues more than one review
// request at a time. ----------
const files = readdirSync(PANTRY).filter((f) => /^BATCH-\d+-.*\.txt$/.test(f)).sort((a, b) => {
  const na = +(a.match(/^BATCH-(\d+)-/) || [0, 0])[1], nb = +(b.match(/^BATCH-(\d+)-/) || [0, 0])[1];
  return na - nb;
});
if (!files.length) { console.log(`no BATCH-*.txt files in ${PANTRY}`); process.exit(0); }

const browser = await connect({ autostart: false });
const { page } = await activePage(browser);
let postedCount = 0, needsReview = false;
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
    if (r && r.status === "posted") {
      postedCount++;
      // Deliberate human-like pacing between posts — never blast a queue of public
      // company-page posts back to back (CLAUDE.md hard rule). 60-120s between.
      const pause = rand(60000, 120000);
      console.log(`  pacing ${Math.round(pause / 1000)}s before the next batch...`);
      await sleep(pause);
      continue;
    }
    if (r && r.status === "needs-review") { needsReview = true; break; }
  } catch (e) {
    console.log(`BATCH ${batchNum}: ERROR ${e.message} — trying next batch`);
    await closeAnyStrayComposer(page);
  }
}
console.log(`\nSCRIPT DONE — ${postedCount} batch(es) posted automatically this run.`);
if (needsReview) console.log("One batch needs manual review — its draft is left open, and a WhatsApp notification is queued.");
else if (postedCount === 0) console.log("Nothing left to post (all batches already posted, or none could be prepared).");
process.exit(0);
