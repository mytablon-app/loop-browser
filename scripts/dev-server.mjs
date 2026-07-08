// Local dev server: serves site/ AND a working /api/downloads counter.
// A plain static server can't run the Vercel function, so this proves the counter
// end-to-end locally (file-backed count). Production uses site/api/downloads.js on
// Vercel + Upstash; this is the dev equivalent. Run: node scripts/dev-server.mjs
import { createServer } from "http";
import { readFile } from "fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { extname, join, normalize } from "path";
import { fileURLToPath } from "url";

const ROOT = fileURLToPath(new URL("../site/", import.meta.url));
const RUNS = fileURLToPath(new URL("../runs/", import.meta.url));
const COUNT_FILE = join(RUNS, "download-count.json");
mkdirSync(RUNS, { recursive: true });
const getCount = () => { try { return JSON.parse(readFileSync(COUNT_FILE, "utf8")).count || 0; } catch { return 0; } };
const setCount = (c) => writeFileSync(COUNT_FILE, JSON.stringify({ count: c }));

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon" };
const PORT = process.env.PORT || 8099;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/downloads") {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") { const c = getCount() + 1; setCount(c); return res.end(JSON.stringify({ count: c })); }
    return res.end(JSON.stringify({ count: getCount() }));
  }
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  else if (!extname(p)) p += ".html";           // clean URLs: /marketing → marketing.html
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end("forbidden"); }
  try {
    const data = await readFile(file);
    res.setHeader("content-type", TYPES[extname(file)] || "application/octet-stream");
    res.end(data);
  } catch { res.statusCode = 404; res.end("not found"); }
}).listen(PORT, () => console.log(`Loop site + live counter → http://localhost:${PORT}`));
