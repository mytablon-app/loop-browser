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
// per-machine, OUTSIDE the repo, so it never ships and never leaks. NOTHING about
// which site gets which port is hardcoded: the FILE is the only source of truth.
// Ports are handed out first-come from the first free one (the actual number is
// irrelevant), and a port is reserved to its site FOR LIFE — even after that
// instance is shut down — until explicitly released/overridden.
//
// Usage:
//   node scripts/instances.mjs resolve <site> [port]   # prints shell exports for `eval`
//   node scripts/instances.mjs list                    # show every known site + status
//   node scripts/instances.mjs forget <site>           # release a site's reservation (force)
//
// Scan range starts at $LOOP_PORT_BASE (default 9222) — just a starting point, not a
// per-site assignment.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import net from "net";

const BASE = process.env.LOOP_PROFILE_BASE || path.join(homedir(), ".loop-profiles");
const REGISTRY = path.join(BASE, "instances.json");
const BASE_PORT = Number(process.env.LOOP_PORT_BASE) || 9222, MAX_PORT = BASE_PORT + 100;

// Aliases → canonical site key (typing convenience only — no port meaning).
const ALIASES = { li: "linkedin", wa: "whatsapp" };
const canon = (s) => ALIASES[(s || "").toLowerCase()] || (s || "").toLowerCase();

function load() {
  if (existsSync(REGISTRY)) { try { return JSON.parse(readFileSync(REGISTRY, "utf8")); } catch {} }
  return {};
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
  if (portArg) entry.port = Number(portArg);            // explicit override (force-change)
  reg[site] = entry; save(reg);                          // persist the reservation
  return { site, port: entry.port, profileDir: entry.profileDir, running: await portUp(entry.port) };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const [cmd, arg, portArg] = process.argv.slice(2);
if (cmd === "resolve") {
  const r = await resolve(arg, portArg);
  console.log(`export LOOP_CDP_PORT=${shq(r.port)}`);
  console.log(`export LOOP_PROFILE_DIR=${shq(r.profileDir)}`);
  console.log(`export LOOP_LABEL=${shq("loop-browser-" + r.site)}`);
  console.log(`LOOP_SITE=${shq(r.site)}`);
  console.log(`LOOP_RUNNING=${shq(r.running ? "1" : "0")}`);
} else if (cmd === "forget") {
  const site = canon(arg);
  const reg = load();
  if (!reg[site]) { console.error(`no reservation for '${site}'`); process.exit(1); }
  const freed = reg[site].port; delete reg[site]; save(reg);
  console.log(`released '${site}' (was :${freed}). Its login profile is kept; next open reassigns a port.`);
} else if (cmd === "list" || !cmd) {
  const reg = load();
  const rows = [];
  for (const [site, v] of Object.entries(reg)) rows.push({ site, port: v.port, up: await portUp(v.port), profileDir: v.profileDir });
  rows.sort((a, b) => a.port - b.port);
  console.log("  SITE          PORT    STATUS    PROFILE");
  for (const r of rows) console.log(`  ${r.site.padEnd(12)}  :${r.port}   ${r.up ? "● up  " : "○ down"}    ${r.profileDir}`);
  console.log(`\n  registry: ${REGISTRY}`);
} else {
  console.error("usage: instances.mjs resolve <site> [port] | list | forget <site>");
  process.exit(1);
}
