#!/usr/bin/env node
// scripts/instances.mjs — the Kitchen's instance registry.
//
// THE RULE: one restaurant (site) ↔ one CDP port ↔ one stable login profile.
// • First time a site opens → auto-pick the next FREE port and REMEMBER it.
// • Re-open a known site → hand back the SAME port + profile, so the running
//   instance is reused (no relaunch) and the login persists (no relogin/reverify).
// • A brand-new site never collides with a port already taken by another site
//   or already listening.
//
// Persisted at $LOOP_PROFILE_BASE/instances.json (default ~/.loop-profiles/) —
// per-machine, OUTSIDE the repo, so it never ships and never leaks.
//
// Usage:
//   node scripts/instances.mjs resolve <site> [port]   # prints shell exports for `eval`
//   node scripts/instances.mjs list                    # show every known site + status

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import net from "net";

const BASE = process.env.LOOP_PROFILE_BASE || path.join(homedir(), ".loop-profiles");
const REGISTRY = path.join(BASE, "instances.json");
const BASE_PORT = 9222, MAX_PORT = 9322;

// Aliases → canonical site key.
const ALIASES = { li: "linkedin", wa: "whatsapp" };
const canon = (s) => ALIASES[(s || "").toLowerCase()] || (s || "").toLowerCase();
const labelFor = (site) => (site === "linkedin" ? "li" : site === "whatsapp" ? "wa" : site);

// Seeds so EXISTING logins are never disturbed: LinkedIn's login lives in the
// DEFAULT Electron userData (where it was first signed in); WhatsApp in its own dir.
const seeds = () => ({
  linkedin: { port: 9222, profileDir: path.join(homedir(), "Library", "Application Support", "Loop Browser") },
  whatsapp: { port: 9223, profileDir: path.join(BASE, "whatsapp") },
});

function load() {
  let reg = {};
  if (existsSync(REGISTRY)) { try { reg = JSON.parse(readFileSync(REGISTRY, "utf8")); } catch {} }
  for (const [k, v] of Object.entries(seeds())) if (!reg[k]) reg[k] = v; // merge, never overwrite
  return reg;
}
function save(reg) {
  mkdirSync(BASE, { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
}

// Is something listening on this TCP port right now?
function portUp(port, timeout = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    let done = false;
    const finish = (up) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(up); };
    sock.setTimeout(timeout);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

// Lowest port not reserved by another site AND not already listening.
async function nextFreePort(reg) {
  const taken = new Set(Object.values(reg).map((v) => v.port));
  for (let p = BASE_PORT; p <= MAX_PORT; p++) {
    if (taken.has(p)) continue;
    if (await portUp(p)) continue;
    return p;
  }
  throw new Error(`no free port in ${BASE_PORT}-${MAX_PORT}`);
}

async function resolve(siteRaw, portArg) {
  const site = canon(siteRaw);
  if (!site) throw new Error("site required");
  const reg = load();
  let entry = reg[site];
  if (!entry) { entry = { port: await nextFreePort(reg), profileDir: path.join(BASE, site) }; reg[site] = entry; }
  if (portArg) entry.port = Number(portArg);            // explicit override, if given
  reg[site] = entry; save(reg);                          // persist (incl. seed-merge)
  return { site, port: entry.port, profileDir: entry.profileDir, label: labelFor(site), running: await portUp(entry.port) };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const [cmd, arg, portArg] = process.argv.slice(2);
if (cmd === "resolve") {
  const r = await resolve(arg, portArg);
  console.log(`export LOOP_CDP_PORT=${shq(r.port)}`);
  console.log(`export LOOP_PROFILE_DIR=${shq(r.profileDir)}`);
  console.log(`export LOOP_LABEL=${shq("loop-browser-" + r.label)}`);
  console.log(`LOOP_SITE=${shq(r.site)}`);
  console.log(`LOOP_RUNNING=${shq(r.running ? "1" : "0")}`);
} else if (cmd === "list" || !cmd) {
  const reg = load();
  const rows = [];
  for (const [site, v] of Object.entries(reg)) rows.push({ site, port: v.port, up: await portUp(v.port), profileDir: v.profileDir });
  rows.sort((a, b) => a.port - b.port);
  console.log("  SITE          PORT    STATUS    PROFILE");
  for (const r of rows) console.log(`  ${r.site.padEnd(12)}  :${r.port}   ${r.up ? "● up  " : "○ down"}    ${r.profileDir}`);
  console.log(`\n  registry: ${REGISTRY}`);
} else {
  console.error("usage: instances.mjs resolve <site> [port] | list");
  process.exit(1);
}
