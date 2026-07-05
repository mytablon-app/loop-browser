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
//   node scripts/instances.mjs strays [kill]           # find (or kill) unregistered leftover browsers
//
// Scan range starts at $LOOP_PORT_BASE (default 9222) — just a starting point, not a
// per-site assignment.

import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";
import net from "net";
import { execSync } from "child_process";

const BASE = process.env.LOOP_PROFILE_BASE || path.join(homedir(), ".loop-profiles");
const REGISTRY = path.join(BASE, "instances.json");
const LOCK = REGISTRY + ".lock";
const BASE_PORT = Number(process.env.LOOP_PORT_BASE) || 9222, MAX_PORT = BASE_PORT + 100;

// Aliases → canonical site key (typing convenience only — no port meaning).
const ALIASES = { li: "linkedin", wa: "whatsapp" };
const canon = (s) => ALIASES[(s || "").toLowerCase()] || (s || "").toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load() {
  if (existsSync(REGISTRY)) { try { return JSON.parse(readFileSync(REGISTRY, "utf8")); } catch {} }
  return {};
}
function save(reg) {
  mkdirSync(BASE, { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
}

// Cross-process mutex around the read-modify-write critical section, so two NEW
// sites resolving at the same instant in two terminals can't both grab the same
// lowest free port (the file isn't otherwise locked; last save() would win). Uses
// an O_EXCL lockfile with a stale-lock breaker, so a crashed holder can't wedge it.
async function withLock(fn) {
  mkdirSync(BASE, { recursive: true });
  const start = Date.now();
  let fd;
  for (;;) {
    try { fd = openSync(LOCK, "wx"); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(LOCK).mtimeMs > 10000) { unlinkSync(LOCK); continue; } } catch {}
      if (Date.now() - start > 5000) throw new Error("registry busy (lock timeout)");
      await sleep(50);
    }
  }
  try { return await fn(); } finally { try { closeSync(fd); } catch {} try { unlinkSync(LOCK); } catch {} }
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

// PIDs listening on a TCP port (macOS/Linux lsof). Empty if lsof is absent or none.
function pidsForPort(port) {
  try {
    return [...new Set(execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, { encoding: "utf8" })
      .split(/\s+/).filter(Boolean))];
  } catch { return []; }
}
// The launching command for a PID (so we only ever kill a Loop Browser, never a random process).
function procCmd(pid) {
  try { return execSync(`ps -o command= -p ${pid}`, { encoding: "utf8" }).trim(); } catch { return ""; }
}
const isLoopProc = (pid) => /Loop Browser/.test(procCmd(pid));

// Scan the CDP range for anything LISTENING that isn't a registered site.
// A stray = an unregistered Loop Browser instance (leftover test/ad-hoc launch) — the
// classic "phantom 3rd window": closing the window doesn't quit the app on macOS.
async function findStrays() {
  const registered = new Set(Object.values(load()).map((v) => v.port));
  const strays = [];
  for (let p = BASE_PORT; p <= MAX_PORT; p++) {
    if (registered.has(p)) continue;              // never flag a real site's port
    if (!(await portUp(p))) continue;             // nothing here
    const pids = pidsForPort(p);
    strays.push({ port: p, pids, loop: pids.some(isLoopProc) });
  }
  return strays;
}

async function resolve(siteRaw, portArg) {
  const site = canon(siteRaw);
  if (!site) throw new Error("site required");
  const entry = await withLock(async () => {
    const reg = load();
    let e = reg[site];
    if (!e) e = { port: await nextFreePort(reg), profileDir: path.join(BASE, site) };
    if (portArg) e.port = Number(portArg);              // explicit override (force-change)
    reg[site] = e; save(reg);                            // persist the reservation
    return e;
  });
  return { site, port: entry.port, profileDir: entry.profileDir, running: await portUp(entry.port) };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const [cmd, arg, portArg] = process.argv.slice(2);
try {
  if (cmd === "resolve") {
    const r = await resolve(arg, portArg);
    console.log(`export LOOP_CDP_PORT=${shq(r.port)}`);
    console.log(`export LOOP_PROFILE_DIR=${shq(r.profileDir)}`);
    console.log(`export LOOP_LABEL=${shq("loop-browser-" + r.site)}`);
    console.log(`LOOP_SITE=${shq(r.site)}`);
    console.log(`LOOP_RUNNING=${shq(r.running ? "1" : "0")}`);
  } else if (cmd === "forget") {
    const site = canon(arg);
    const freed = await withLock(async () => {
      const reg = load();
      if (!reg[site]) return null;
      const f = reg[site].port; delete reg[site]; save(reg);
      return f;
    });
    if (freed == null) { console.error(`no reservation for '${site}'`); process.exit(1); }
    console.log(`released '${site}' (was :${freed}). Its login profile is kept; next open reassigns a port.`);
  } else if (cmd === "list" || !cmd) {
    const reg = load();
    const rows = [];
    for (const [site, v] of Object.entries(reg)) rows.push({ site, port: v.port, up: await portUp(v.port), profileDir: v.profileDir });
    rows.sort((a, b) => a.port - b.port);
    console.log("  SITE          PORT    STATUS    PROFILE");
    for (const r of rows) console.log(`  ${r.site.padEnd(12)}  :${r.port}   ${r.up ? "● up  " : "○ down"}    ${r.profileDir}`);
    console.log(`\n  registry: ${REGISTRY}`);
  } else if (cmd === "strays") {
    const doKill = (arg || "").toLowerCase() === "kill";
    const strays = await findStrays();
    if (!strays.length) { console.log("  no strays — every listening CDP port is a registered site ✓"); }
    else {
      console.log("  STRAY (unregistered) CDP ports:");
      for (const s of strays)
        console.log(`  :${s.port}   ${s.loop ? "Loop Browser" : "non-Loop process"}   pid ${s.pids.join(",") || "?"}`);
      const killable = strays.filter((s) => s.loop && s.pids.length);
      if (doKill) {
        let n = 0;
        for (const s of strays) {
          if (!s.loop) { console.log(`  skip :${s.port} — not a Loop Browser, leaving it alone`); continue; }
          for (const pid of s.pids) { try { process.kill(Number(pid)); n++; } catch {} }
          console.log(`  killed :${s.port} (pid ${s.pids.join(",")})`);
        }
        console.log(`\n  ${n} stray process(es) terminated.`);
      } else if (killable.length) {
        console.log(`\n  → run \`node scripts/instances.mjs strays kill\` to close the Loop strays (won't touch registered sites or non-Loop processes).`);
      }
    }
  } else {
    console.error("usage: instances.mjs resolve <site> [port] | list | forget <site> | strays [kill]");
    process.exit(1);
  }
} catch (e) {
  console.error("✗ " + (e?.message || e));   // clean one-line error (e.g. port exhaustion) instead of a raw stack
  process.exit(1);
}
