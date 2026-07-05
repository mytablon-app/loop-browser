// stats.mjs — the graduation ledger. Per-recipe run/heal counts that decide when a
// recipe has "GRADUATED" to fully deterministic: N consecutive successful runs with
// ZERO heals. A graduated recipe never auto-invites the brain — any break is a
// regression, not a routine heal, so the engine stops writing incident/authoring
// artifacts for it (LLM reliance hits zero). Version-scoped: patching a recipe (a new
// `version`) restarts probation, because the method text changed.
//
// A "heal" = the deterministic self-heal (healFind) firing during a run. The first heal
// captures the corrected selector, so the NEXT run resolves on the fast path with no
// heal — that begins the clean streak toward graduation.
//
// OPERATIONAL/PERSONAL — lives in dishes/ (gitignored, like the Service Log). Never ships.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

const STATS = path.join(process.cwd(), "dishes", "recipe-stats.json");

// How many consecutive clean runs earn graduation. Env override, else 5 — above the
// default retry count (3) so luck can't graduate a recipe, below 10 so an active recipe
// graduates within days. A recipe can override with a "graduateAfter" field.
export const GRADUATE_N = Math.max(1, Number(process.env.LOOP_GRADUATE_N) || 5);

export function statsPath() { return STATS; }

export function readStats() {
  try { if (existsSync(STATS)) return JSON.parse(readFileSync(STATS, "utf8")); } catch (_) {}
  return {};
}

function writeStats(s) {
  mkdirSync(path.dirname(STATS), { recursive: true });
  writeFileSync(STATS, JSON.stringify(s, null, 2) + "\n");
}

const V = (v) => v || "0.0.0";
const fresh = (version) => ({
  version: V(version), runs: 0, cleanStreak: 0, heals: 0,
  lastHealAt: null, lastRunAt: null, graduated: false, graduatedAt: null,
});

// Record one COMPLETED run. `clean` = no heal fired during the run. Resets to a fresh
// record when the recipe's version changed (an edit = a new method = re-probation).
// Returns the updated entry plus { justGraduated, n }.
export function recordRun(name, version, { clean, n = GRADUATE_N } = {}) {
  const s = readStats();
  let e = s[name];
  if (!e || e.version !== V(version)) e = fresh(version);
  const wasGrad = e.graduated;
  e.runs += 1;
  e.lastRunAt = new Date().toISOString();
  if (clean) {
    e.cleanStreak += 1;
  } else {
    e.cleanStreak = 0;
    e.heals += 1;
    e.lastHealAt = e.lastRunAt;
    e.graduated = false;
    e.graduatedAt = null;
  }
  if (!e.graduated && e.cleanStreak >= n) { e.graduated = true; e.graduatedAt = e.lastRunAt; }
  s[name] = e;
  writeStats(s);
  return { ...e, justGraduated: e.graduated && !wasGrad, n };
}

// Is this recipe (at this exact version) graduated?
export function isGraduated(name, version) {
  const e = readStats()[name];
  return !!(e && e.version === V(version) && e.graduated);
}

// Send a recipe back to probation (clears graduated + clean streak). Called on ANY break,
// and by `loop reopen` — the deliberate human act to re-enable brain heals after a change.
export function reopenStats(name) {
  const s = readStats();
  const e = s[name];
  if (!e) return false;
  e.cleanStreak = 0;
  e.graduated = false;
  e.graduatedAt = null;
  s[name] = e;
  writeStats(s);
  return true;
}
