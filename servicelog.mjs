// servicelog.mjs — the Service Log, the Expediter's book: the canonical record of
// every dish cooked, categorized by dish name → entries by date ("what cooked when").
// Two jobs in one file: (1) the record of work, (2) the dedup guard so we never
// repeat a dish.
//
// PERSONAL DATA (who you messaged / posted about) — lives in dishes/ (gitignored).
// NEVER ships to git/npm/web. Owned by the Expediter (`loop serve`), but any cook
// — including the Head Chef cooking by hand — appends here so the book is complete.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

const LOG = path.join(process.cwd(), "dishes", "service-log.json");

export function logPath() { return LOG; }

export function readLog() {
  try { if (existsSync(LOG)) return JSON.parse(readFileSync(LOG, "utf8")); } catch (_) {}
  return {};
}

// Append one cooked-dish entry under its dish (recipe) name. `entry` carries
// { target, slug?, file?, status, note? }; `at` is stamped now unless provided.
export function recordDish(dish, entry) {
  const log = readLog();
  (log[dish] ||= []).push({ at: new Date().toISOString(), ...entry });
  mkdirSync(path.dirname(LOG), { recursive: true });
  writeFileSync(LOG, JSON.stringify(log, null, 2) + "\n");
  return LOG;
}

// The dedup guard: the set of already-SERVED values for a dish, by field
// (default the /in/ slug). The Expediter checks this before cooking.
export function servedSet(dish, field = "slug") {
  const log = readLog();
  return new Set(
    (log[dish] || []).filter((e) => e.status === "served").map((e) => e[field]).filter(Boolean)
  );
}
