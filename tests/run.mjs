#!/usr/bin/env node
// Loop Browser test suite — zero framework, plain node, exits 1 on any FAIL.
// Covers the engine behaviors that guard against MIS-SENDS and silent breakage:
// deterministic self-heal (word-overlap, substring rescue, ambiguity refusal),
// named-only input binding (the wrong-field/compose-box class), iframe + shadow-DOM
// find/heal, upload chooser-interception, wait-for, and the graduation ledger.
// Run: `npm test` (needs a Playwright chromium — CI installs it; locally the repo's
// node_modules usually has one via playwright).
import { createRequire } from "module";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Isolate the graduation ledger BEFORE importing stats.mjs (path is bound at import).
const tmpDishes = mkdtempSync(path.join(tmpdir(), "loop-test-dishes-"));
process.env.LOOP_DISHES_DIR = tmpDishes;

const require = createRequire(import.meta.url);
const lib = await import("../lib.mjs");
const stats = await import("../stats.mjs");
lib.setCaptureSkip(true); // never write capture files from tests

let pass = 0, fail = 0;
const T = (name, ok, note = "") => {
  console.log(`  ${ok ? "✓" : "✗ FAIL"}  ${name}${note ? `  (${note})` : ""}`);
  ok ? pass++ : fail++;
};

// ---------- graduation ledger (no browser) ----------
{
  const R = "test-recipe", V = "1.0.0";
  let g;
  for (let i = 1; i <= 5; i++) g = stats.recordRun(R, V, { clean: true });
  T("stats: graduates at 5 clean runs", g.graduated && g.justGraduated);
  g = stats.recordRun(R, V, { clean: false });
  T("stats: a heal resets streak + un-graduates", g.cleanStreak === 0 && g.heals === 1 && !g.graduated);
  g = stats.recordRun(R, "1.1.0", { clean: true });
  T("stats: version bump re-probates", g.runs === 1 && g.cleanStreak === 1);
  for (let i = 0; i < 4; i++) g = stats.recordRun(R, "1.1.0", { clean: true });
  T("stats: re-graduates on new version", stats.isGraduated(R, "1.1.0"));
  stats.reopenStats(R);
  T("stats: reopen sends back to probation", !stats.isGraduated(R, "1.1.0"));
}

// ---------- browser suites ----------
let chromium;
try { ({ chromium } = require("playwright")); }
catch { try { ({ chromium } = require("playwright-core")); } catch { console.error("no playwright — install it to run the browser suites"); process.exit(1); } }
const b = await chromium.launch();
const pg = await b.newPage();
const aria = (el) => el.getAttribute("aria-label");

// heal: substring rescue (unambiguous rename)
await pg.setContent(`<button aria-label="Send">S</button>`);
try { const el = await lib.findClickable(pg, "Send message", { timeout: 1500 }); T("heal: substring rescue", (await aria(el)) === "Send"); }
catch { T("heal: substring rescue", false); }

// heal: ambiguity → give up (never click the wrong thing)
await pg.setContent(`<button aria-label="Send">S</button><button aria-label="Message">M</button>`);
try { await lib.findClickable(pg, "Send message", { timeout: 1500 }); T("heal: ambiguity refused", false); }
catch { T("heal: ambiguity refused", true); }

// exact match untouched
await pg.setContent(`<button aria-label="Connect">C</button>`);
try { const el = await lib.findClickable(pg, "Connect", { timeout: 1500 }); T("find: exact match", (await aria(el)) === "Connect"); }
catch { T("find: exact match", false); }

// heal: word-overlap drift
await pg.setContent(`<button aria-label="View all (849 more)">V</button>`);
try { const el = await lib.findClickable(pg, "View all", { timeout: 1500 }); T("heal: word-overlap drift", /View all/.test(await aria(el))); }
catch { T("heal: word-overlap drift", false); }

// heal: unrelated → give up
await pg.setContent(`<button aria-label="Cancel">X</button>`);
try { await lib.findClickable(pg, "Delete account", { timeout: 1200 }); T("heal: unrelated refused", false); }
catch { T("heal: unrelated refused", true); }

// findInput: NEVER instantly grab an unnamed textbox (the compose-box near-miss)
await pg.setContent(`<div role="textbox" contenteditable="true">compose</div><div role="textbox" aria-label="Message notes">n</div>`);
try { await lib.findInput(pg, "Group subject", { timeout: 2000 }); T("input: wrong-grab refused", false); }
catch { T("input: wrong-grab refused", true); }

// findInput: waits for the late-appearing NAMED field
await pg.setContent(`<div role="textbox" contenteditable="true">compose</div>`);
pg.evaluate(() => setTimeout(() => { const d = document.createElement("div"); d.setAttribute("role", "textbox"); d.setAttribute("aria-label", "Group subject"); d.contentEditable = "true"; document.body.appendChild(d); }, 1000));
try { const el = await lib.findInput(pg, "Group subject", { timeout: 6000 }); T("input: waits for named field", (await aria(el)) === "Group subject"); }
catch { T("input: waits for named field", false); }

// findInput: single unnamed input = loud last resort
await pg.setContent(`<input type="text">`);
try { await lib.findInput(pg, "Search", { timeout: 1500 }); T("input: single-unnamed last resort", true); }
catch { T("input: single-unnamed last resort", false); }

// iframe: find + heal inside a content iframe
await pg.route("https://t.example/**", (r) => {
  const u = new URL(r.request().url());
  if (u.pathname === "/frame") return r.fulfill({ contentType: "text/html", body: `<button aria-label="Reply to all">R</button><button aria-label="Submit order">S</button>` });
  return r.fulfill({ contentType: "text/html", body: `<p>host</p><iframe src="https://t.example/frame"></iframe>` });
});
await pg.goto("https://t.example/");
await pg.waitForTimeout(400);
try { const el = await lib.findClickable(pg, "Submit order", { timeout: 4000 }); T("iframe: find", (await aria(el)) === "Submit order"); }
catch { T("iframe: find", false); }
try { const el = await lib.findClickable(pg, "Reply all", { timeout: 2500 }); T("iframe: heal", (await aria(el)) === "Reply to all"); }
catch { T("iframe: heal", false); }

// shadow DOM: heal pierces open shadow roots
await pg.setContent(`<div id="host"></div><script>const r=document.getElementById("host").attachShadow({mode:"open"});r.innerHTML='<button aria-label="Reply to all">R</button>';</script>`);
await pg.waitForTimeout(200);
try { const el = await lib.findClickable(pg, "Reply all", { timeout: 2500 }); T("shadow: heal", (await aria(el)) === "Reply to all"); }
catch { T("shadow: heal", false); }

// upload: chooser interception (no native picker)
const tf = path.join(tmpDishes, "upload.txt");
writeFileSync(tf, "hello");
await pg.setContent(`<input type="file" id="f" style="display:none"><button aria-label="Add photo" onclick="document.getElementById('f').click()">A</button><div id="out"></div><script>document.getElementById("f").addEventListener("change",e=>{document.getElementById("out").textContent="got:"+e.target.files[0].name});</script>`);
try {
  const r = await lib.uploadFile(pg, "Add photo", tf);
  await pg.waitForTimeout(300);
  T("upload: chooser intercepted", r.via === "chooser" && (await pg.locator("#out").innerText()).includes("upload.txt"));
} catch { T("upload: chooser intercepted", false); }

// upload: hidden-input fallback (button opens no chooser)
await pg.setContent(`<input type="file" id="f2" style="display:none"><button aria-label="Attach">A</button>`);
try { const r = await lib.uploadFile(pg, "Attach", tf); T("upload: input fallback", r.via === "input"); }
catch { T("upload: input fallback", false); }

// wait-for: positive signal + timeout
await pg.setContent(`<div id="x"></div><script>setTimeout(()=>{document.getElementById("x").textContent="Post successful"},700)</script>`);
try { await lib.runStep(pg, { do: "wait-for", text: "Post successful", ms: 5000 }); T("wait-for: late text", true); }
catch { T("wait-for: late text", false); }
try { await lib.runStep(pg, { do: "wait-for", text: "Never appears", ms: 1000 }); T("wait-for: times out", false); }
catch { T("wait-for: times out", true); }

// withRetry: noRetry honored (non-idempotent protection)
{
  let n = 0;
  try { await lib.withRetry(() => { n++; const e = new Error("acted"); e.noRetry = true; throw e; }, { tries: 3, delay: 1 }); } catch {}
  T("retry: noRetry = exactly 1 call", n === 1);
}

await b.close();
rmSync(tmpDishes, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
