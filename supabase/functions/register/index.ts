// register — public lead capture for loop-browser.com/marketing ("human-free
// marketing"). Inserts the registration into public.registrations (service role,
// which bypasses the table's locked RLS) and emails a notification via Resend.
// Deployed with --no-verify-jwt so the static marketing form can call it directly.
//
// NO secrets or addresses are hardcoded here (keeps this safe for the public repo):
// everything comes from function env — RESEND_API_KEY, REGISTER_FROM, REGISTER_TO
// (set via `supabase secrets set`). SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are
// auto-injected into every Edge Function by the Supabase runtime.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("REGISTER_ALLOW_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clean = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const URL_RE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;
const E164_RE = /^\+[1-9]\d{7,14}$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  let p: Record<string, unknown>;
  try { p = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  // Honeypot: a hidden field real users never see. Bots fill it → silently accept
  // and drop (return ok so the bot gets no signal), never touching the DB or email.
  if (clean(p.company_website) || clean(p.hp)) return json({ ok: true });

  const name = clean(p.name, 120);
  const email = clean(p.email, 200).toLowerCase();
  let whatsapp = clean(p.whatsapp, 40).replace(/[^\d+]/g, "");
  let website = clean(p.website, 200);
  const source = clean(p.source, 60) || "loop-marketing";
  const interest = clean(p.interest, 60) || "human-free-marketing";
  if (!name) return json({ error: "Please enter your name." }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: "Please enter a valid email." }, 400);
  if (!E164_RE.test(whatsapp)) return json({ error: "Please enter a valid WhatsApp number in international format." }, 400);
  if (!URL_RE.test(website)) return json({ error: "Please enter a valid website." }, 400);
  if (!/^https?:\/\//i.test(website)) website = "https://" + website;

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  const user_agent = clean(req.headers.get("user-agent"), 400);
  const ip = clean((req.headers.get("x-forwarded-for") || "").split(",")[0], 64) || clean(req.headers.get("x-real-ip"), 64);
  const { error: dbErr } = await admin.from("registrations").insert({
    name, email, whatsapp, website, source, interest, user_agent, ip,
  });
  if (dbErr) { console.error("insert error:", dbErr); return json({ error: "Could not save your details. Please try again." }, 500); }

  // Notify on every new registration — best effort. The saved row is the source of
  // truth, so an email hiccup never fails the registration.
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("REGISTER_FROM");
  const to = Deno.env.get("REGISTER_TO");
  if (RESEND_API_KEY && from && to) {
    const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }) + " (Dubai)";
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0e1a2c">
<h2 style="margin:0 0 14px">New registration — human-free marketing</h2>
<p style="margin:0 0 5px"><b>Name:</b> ${esc(name)}</p>
<p style="margin:0 0 5px"><b>Email:</b> ${esc(email)}</p>
<p style="margin:0 0 5px"><b>WhatsApp:</b> ${esc(whatsapp)}</p>
<p style="margin:0 0 5px"><b>Website:</b> ${esc(website)}</p>
<p style="margin:0 0 5px"><b>Interest:</b> ${esc(interest)}</p>
<p style="margin:0 0 5px"><b>Source:</b> ${esc(source)}</p>
<p style="margin:0 0 5px"><b>IP:</b> ${esc(ip)}</p>
<p style="margin:14px 0 0;color:#5b6880;font-size:13px">${esc(when)}</p>
</div>`;
    const text = `New registration — human-free marketing\n\nName: ${name}\nEmail: ${email}\nWhatsApp: ${whatsapp}\nWebsite: ${website}\nInterest: ${interest}\nSource: ${source}\nIP: ${ip}\n${when}`;
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, reply_to: email, subject: `New registration — ${name}`, html, text }),
      });
      if (!r.ok) console.error("resend error:", await r.text());
    } catch (e) { console.error("resend threw:", e); }
  }

  return json({ ok: true });
});
