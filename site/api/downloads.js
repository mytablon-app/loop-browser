// Real, persisted download counter — Vercel Serverless Function.
// GET  /api/downloads  → { count }            (current total)
// POST /api/downloads  → { count }            (increment, return new total)
//
// Storage = Upstash Redis over its REST API (no npm dependency — just fetch).
// SETUP AT DEPLOY:
//   1. Add an Upstash Redis store (Vercel dashboard → Storage / Marketplace → Upstash).
//   2. It sets env vars UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN automatically.
//   3. Done — the hero pill starts showing real numbers.
// Until those env vars exist (e.g. local dev), this returns { count: null } and the
// site quietly shows "—" instead of a fake number.

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(...cmd) {
  const res = await fetch(`${URL}/${cmd.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const data = await res.json();
  return data.result;
}

export default async function handler(req, res) {
  if (!URL || !TOKEN) return res.status(200).json({ count: null }); // not provisioned yet
  try {
    if (req.method === "POST") {
      const total = await redis("INCR", "downloads:total");
      return res.status(200).json({ count: Number(total) });
    }
    const total = await redis("GET", "downloads:total");
    return res.status(200).json({ count: Number(total) || 0 });
  } catch (e) {
    return res.status(200).json({ count: null });
  }
}
