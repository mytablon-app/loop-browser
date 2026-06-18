#!/usr/bin/env node
// Publish guard — refuses to publish if anything private or secret would ship.
//
// Runs as `prepublishOnly`, so it gates BOTH a manual `npm publish` AND the CI
// Trusted-Publishing workflow. Belt-and-suspenders on top of the package.json
// "files" allowlist and .npmignore: even if those are misconfigured, this aborts
// the publish before a single byte leaves the machine.
//
// Blocks on: login profiles, cooked dishes, run screenshots, PRIVATE recipes
// (recipes/local/), env files — and any token / key / password baked into a
// shipped file. The recipe TRAVELS; the meal, the pantry, and the key stay home.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FORBIDDEN_PATHS = [
  [/(^|\/)\.loop-profile\//, "login profile (the key)"],
  [/(^|\/)dishes\//, "cooked dish (output)"],
  [/(^|\/)runs\//, "run screenshot"],
  [/(^|\/)recipes\/local\//, "PRIVATE recipe (recipes/local/)"],
  [/(^|\/)\.env(\.|$)/, ".env file"],
  [/(^|\/)\.claude\//, ".claude/"],
  [/\.local\.json$/, "*.local.json"],
];

const SECRET_PATTERNS = [
  [/ghp_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/npm_[A-Za-z0-9]{30,}/, "npm token"],
  [/sk-[A-Za-z0-9]{20,}/, "API secret key"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/, "private key"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/["'](?:authToken|password|client_secret|api[_-]?key)["']\s*[:=]\s*["'][^"'{}\s]{8,}["']/i, "hardcoded credential"],
];

let files;
try {
  files = JSON.parse(execSync("npm pack --dry-run --json", { encoding: "utf8" }))[0].files.map((f) => f.path);
} catch (e) {
  console.error("publish guard: could not compute package contents —", e.message);
  process.exit(1);
}

const problems = [];
for (const p of files) {
  for (const [re, label] of FORBIDDEN_PATHS) if (re.test(p)) problems.push(`would ship ${label}: ${p}`);
}
for (const p of files) {
  let content;
  try { content = readFileSync(p, "utf8"); } catch { continue; }
  for (const [re, label] of SECRET_PATTERNS) if (re.test(content)) problems.push(`${label} found in ${p}`);
}

if (problems.length) {
  console.error("\n⛔  PUBLISH BLOCKED — private/secret content detected:\n");
  for (const x of problems) console.error("   • " + x);
  console.error("\nNothing was published. Remove the above (move private recipes to recipes/local/) and retry.\n");
  process.exit(1);
}
console.log(`✓ publish guard: ${files.length} files checked, no secrets or private data.`);
