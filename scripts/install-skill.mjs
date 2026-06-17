// Place the Loop skill into ~/.claude/skills/loop/ so any Claude Code becomes fluent in `loop`.
// This is what the product installer runs. ORDER-INDEPENDENT: it just writes the file — works
// whether Claude Code is installed yet or not (Claude Code scans this folder whenever it runs).
import { cpSync, mkdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import { fileURLToPath } from "url";

const src = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "skill", "loop");
const dest = path.join(homedir(), ".claude", "skills", "loop");

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

console.log(`✓ Loop skill installed → ${dest}`);
console.log("  Claude Code picks it up on its next start — even if it's installed later.");
