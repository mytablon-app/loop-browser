#!/usr/bin/env node
// Publish + commit guard — refuses to ship anything private or secret.
//
// TWO MODES:
//   (default)  publish guard: runs as `prepublishOnly`, scans the npm-pack file set.
//   --staged   COMMIT guard: runs from .githooks/pre-commit, scans every STAGED file
//              (the git path is the primary distribution channel — clone-only — and
//              git-tracked files OUTSIDE the npm allowlist were previously unguarded).
//              Adds personal-data patterns (emails, absolute home paths, phone-like
//              numbers) and an optional LOCAL denylist of owner-specific terms:
//              site-memories/local/private-terms.txt (gitignored — one term per line,
//              case-insensitive; real names/ids live THERE, never in this public file).
//
// Blocks on: login profiles, cooked dishes, run screenshots, PRIVATE recipes
// (recipes/local/), env files — and any token / key / password baked into a
// shipped file. The recipe TRAVELS; the meal, the pantry, and the key stay home.
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const FORBIDDEN_PATHS = [
  [/(^|\/)\.loop-profile\//, "login profile (the key)"],
  [/(^|\/)dishes\//, "cooked dish (output)"],
  [/(^|\/)runs\//, "run screenshot"],
  [/(^|\/)recipes\/local\//, "PRIVATE recipe (recipes/local/)"],
  [/(^|\/)site-memories\/local\//, "PRIVATE cuisine pack (site-memories/local/)"],
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

// --staged mode only: personal-data patterns for public git files. Kept conservative
// to avoid false positives; owner-specific literals belong in the LOCAL denylist.
const PERSONAL_PATTERNS = [
  [/[a-zA-Z0-9._%+-]+@(?!(?:example|schema|w3|githubusercontent)\.)[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/, "email address"],
  [/(?:\/Users\/|\/home\/|C:\\+Users\\+)[a-zA-Z]/, "absolute home path"],
  [/\+\d{9,}/, "phone-like number"],
];
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|svg|woff2?|ttf|dmg|exe|zip|pdf|mp4)$/i;
const DENYLIST_FILE = "site-memories/local/private-terms.txt";

const STAGED = process.argv.includes("--staged");
const problems = [];

if (STAGED) {
  // Commit guard: scan the STAGED content (the index, not the worktree) of every staged file.
  let staged = [];
  try {
    staged = execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch (e) { console.error("commit guard: not a git repo?", e.message); process.exit(0); }
  const deny = existsSync(DENYLIST_FILE)
    ? readFileSync(DENYLIST_FILE, "utf8").split("\n").map((t) => t.trim()).filter((t) => t && !t.startsWith("#"))
    : [];
  for (const p of staged) {
    for (const [re, label] of FORBIDDEN_PATHS) if (re.test(p)) problems.push(`staging ${label}: ${p}`);
    if (BINARY_EXT.test(p)) continue;
    let content;
    try { content = execSync(`git show :"${p}"`, { encoding: "utf8", maxBuffer: 16e6 }); } catch { continue; }
    if (content.includes("\0")) continue;                                  // binary without a known extension
    for (const [re, label] of [...SECRET_PATTERNS, ...PERSONAL_PATTERNS])
      if (re.test(content)) problems.push(`${label} in staged ${p}  (match: "${String(content.match(re)[0]).slice(0, 40)}")`);
    for (const term of deny) {
      const i = content.toLowerCase().indexOf(term.toLowerCase());
      if (i >= 0) problems.push(`private term (local denylist) in staged ${p}`);
    }
  }
  if (problems.length) {
    console.error("\n⛔  COMMIT BLOCKED — private/secret content staged:\n");
    for (const x of problems) console.error("   • " + x);
    console.error("\nMove personal data to recipes/local/ / site-memories/local/ (gitignored), or\nadjust the file. Emergency bypass (be sure!): git commit --no-verify\n");
    process.exit(1);
  }
  console.log(`✓ commit guard: ${staged.length} staged file(s) clean.`);
  process.exit(0);
}

let files;
try {
  files = JSON.parse(execSync("npm pack --dry-run --json", { encoding: "utf8" }))[0].files.map((f) => f.path);
} catch (e) {
  console.error("publish guard: could not compute package contents —", e.message);
  process.exit(1);
}

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
