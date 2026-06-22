// porter.mjs — the Porter: gathers & arranges ingredients off the hot path, then
// hands a complete set to the cook. This module is the *file-picking* Porter:
// given a pantry folder of ticket .txt files, it picks the next un-served one and
// parses it into ingredients.
//
// Ported faithfully from agent-loop's linkedin-company-poster (parseTxt +
// getNextProfile) — proven across 600+ posts. One adaptation to fit our role
// split: the Porter does NOT own the dedup ledger. Service passes in the set of
// already-served slugs; the Porter only gathers. (In agent-loop these were welded
// together; here the pass/Service ledgers, the Porter fetches.)

import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";

// /in/<slug> → stable identity for dedup (ported).
export function slugOf(url) {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/in\/([^/?&#\s]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// Parse one ticket .txt → ingredients (ported: same field regexes agent-loop uses;
// CAPTION runs until TAGGING or EOF so it stays multiline).
export function parseTxt(content) {
  const url = content.match(/LINKEDIN URL:\s*(https?:\/\/\S+)/i);
  const name = content.match(/NAME:\s*(.+)/i);
  const caption = content.match(/CAPTION:\s*([\s\S]+?)(?=TAGGING:|$)/i);
  return {
    url: url ? url[1].trim() : null,
    name: name ? name[1].trim() : null,
    caption: caption ? caption[1].trim() : null,
  };
}

// Voyager profile fetch (ported from agent-loop's fetchVoyagerProfile) — Porter
// prep that gathers the person's authoritative display name + headline, used to
// type the tag search and disambiguate namesakes. MUST run on a clean page before
// the composer opens (Voyager 403s from composer state).
//
// Adaptation: agent-loop read the CSRF token from a separate bridge on :3847
// (reading the session cookie out of the Electron partition). LB drives the live
// LinkedIn page, so we read the CSRF straight from the page's own JSESSIONID
// cookie inside the page context — no bridge. The fetch runs in-page so the
// session cookies are sent automatically.
export async function fetchProfile(page, profileUrl) {
  const slug = slugOf(profileUrl);
  if (!slug) return { error: "no-slug" };
  return await page.evaluate(async (slug) => {
    const m = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
    const csrf = m ? m[1] : null;
    if (!csrf) return { error: "no-csrf-cookie" };
    const fetchOnce = () => fetch(
      `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${slug}`,
      { credentials: "include", headers: {
        "Accept": "application/vnd.linkedin.normalized+json+2.1",
        "csrf-token": csrf,
        "x-restli-protocol-version": "2.0.0",
        "x-li-lang": "en_US",
      } }
    );
    try {
      let r = await fetchOnce();
      if (r.status === 429 || r.status === 503) { await new Promise((s) => setTimeout(s, 3000)); r = await fetchOnce(); }
      if (!r.ok) return { error: `http-${r.status}` };
      const j = await r.json();
      const p = (j?.included || []).find((x) => x.headline !== undefined);
      if (!p) return { error: "no-profile-in-response" };
      return { name: `${p.firstName || ""} ${p.lastName || ""}`.trim() || null, headline: p.headline || null };
    } catch (e) { return { error: String(e.message || e) }; }
  }, slug);
}

// Pick the next ticket to cook (ported getNextProfile):
//   • .txt files only, skip the 00-* batch index, sorted (stable order)
//   • skip a file with no LINKEDIN URL (this is also what drops the _REPORT/_SKIPPED files)
//   • skip anything already served (slug in doneSlugs)
// Returns a ready ingredient set, or null when the pantry is drained.
export function pickNextTicket(folder, done = new Set()) {
  const files = readdirSync(folder)
    .filter((f) => f.endsWith(".txt") && !f.startsWith("00-"))
    .sort();
  for (const file of files) {
    const parsed = parseTxt(readFileSync(path.join(folder, file), "utf8"));
    if (!parsed.url) continue;
    const slug = slugOf(parsed.url);
    // Dedup by slug AND by file. A ticket whose URL isn't a /in/ profile (e.g. a /company/ page) has
    // slug=null — without the file check it could never be marked done and would re-post forever.
    if ((slug && done.has(slug)) || done.has(file)) continue;
    const img = path.join(folder, file.replace(".txt", ".jpg"));
    return {
      file,
      name: parsed.name,
      url: parsed.url,
      slug,
      caption: parsed.caption || "",
      image: existsSync(img) ? img : null,
    };
  }
  return null;
}
