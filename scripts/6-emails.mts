// STEP 6 — emails for the people YOU marked in the CRM (Fetch Email = YES).
// Per person: cached? → pattern-guess + Reacher verify (free) → Hunter →
// Prospeo. Per company: research brief (what they do + what you can offer).
// Then a ≤300-word email draft saved to email-drafts/ and the CRM updated.
//
// CREDIT GUARDS: lookups cache first — a person is never looked up twice;
// vendors only run after the free rungs miss; only marked people cost anything.
//
// Knobs:
const MODEL = "opencode/mimo-v2.5-free";
const DRAFT_TIER: "light" | "heavy" = "heavy"; // the email a human reads — claude by default; set "light" to stay free

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { openDb } from "../src/db.ts";
import { extract } from "../src/llm.ts";
import { loadProfile } from "../src/profile.ts";

process.chdir(new URL("..", import.meta.url).pathname);
try { process.loadEnvFile(".env"); } catch {}
process.env.LLM_LIGHT = `opencode run -m ${MODEL}`;
const db = openDb();
const profile = loadProfile();
mkdirSync("email-drafts", { recursive: true });

const U = process.env.TWENTY_URL!, K = process.env.TWENTY_API_KEY!;
const twenty = async (method: string, path: string, body?: unknown) => {
  await new Promise((r) => setTimeout(r, 700));
  const res = await fetch(`${U}/rest/${path}`, {
    method, headers: { Authorization: `Bearer ${K}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok ? res.json() : null;
};

const cache = {
  get: (key: string) => (db.prepare("SELECT result FROM lookups WHERE key = ?").get(key) as any)?.result,
  put: (key: string, provider: string, result: unknown, cost = 0) =>
    db.prepare("INSERT OR REPLACE INTO lookups (key, provider, result, cost) VALUES (?, ?, ?, ?)")
      .run(key, provider, JSON.stringify(result), cost),
};

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    return res.ok ? res.json() : null;
  } catch { return null; }
}

// --- domain resolution (cached, free) ---
async function companyDomain(company: string): Promise<string | null> {
  const key = `domain:${company.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit).domain;
  let domain: string | null = null;
  try {
    const out = execFileSync("tinyfish", ["search", "query", `${company} official website`], { encoding: "utf8", timeout: 60_000 });
    const m = out.match(/https?:\/\/(?:www\.)?([a-z0-9-]+\.[a-z.]{2,10})\//i);
    if (m && !/linkedin|wikipedia|crunchbase|twitter|facebook/.test(m[1]!)) domain = m[1]!;
  } catch {}
  cache.put(key, "tinyfish-search", { domain });
  return domain;
}

// --- verification (free, self-hosted; degrades gracefully if not running) ---
async function verify(email: string): Promise<"valid" | "risky" | "invalid" | "unverified"> {
  const reacher = process.env.REACHER_URL;
  if (!reacher) return "unverified";
  try {
    const res = await fetch(`${reacher}/v0/check_email`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_email: email }), signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return "unverified";
    const d: any = await res.json();
    return d.is_reachable === "safe" ? "valid" : d.is_reachable === "risky" ? "risky" : d.is_reachable === "invalid" ? "invalid" : "unverified";
  } catch { return "unverified"; }
}

// --- the waterfall ---
async function findEmail(first: string, last: string, domain: string): Promise<{ email: string; status: string; provenance: string } | null> {
  const key = `email:${first}.${last}@${domain}`.toLowerCase();
  const hit = cache.get(key);
  if (hit) { const h = JSON.parse(hit); return h.email ? h : null; }

  // rung 0: pattern guess + free verification
  const f = first.toLowerCase(), l = last.toLowerCase();
  for (const guess of [`${f}.${l}`, `${f}`, `${f}${l}`, `${f[0]}${l}`]) {
    const email = `${guess}@${domain}`;
    const status = await verify(email);
    if (status === "valid") {
      const r = { email, status, provenance: `pattern+reacher ${new Date().toISOString().slice(0, 10)}` };
      cache.put(key, "pattern", r); return r;
    }
  }
  // rung 1: Hunter (50/mo)
  if (process.env.HUNTER_API_KEY) {
    const d = await getJson(`https://api.hunter.io/v2/email-finder?domain=${domain}&first_name=${first}&last_name=${last}&api_key=${process.env.HUNTER_API_KEY}`);
    if (d?.data?.email) {
      const r = { email: d.data.email, status: d.data.score > 80 ? "valid" : "risky", provenance: `hunter:${d.data.score} ${new Date().toISOString().slice(0, 10)}` };
      cache.put(key, "hunter", r, 1); return r;
    }
  }
  // rung 2: Prospeo (75/mo)
  if (process.env.PROSPEO_API_KEY) {
    try {
      const res = await fetch("https://api.prospeo.io/email-finder", {
        method: "POST", headers: { "Content-Type": "application/json", "X-KEY": process.env.PROSPEO_API_KEY },
        body: JSON.stringify({ first_name: first, last_name: last, company: domain }),
        signal: AbortSignal.timeout(20_000),
      });
      const d: any = res.ok ? await res.json() : null;
      if (d?.response?.email?.email || d?.email) {
        const email = d?.response?.email?.email ?? d.email;
        const r = { email, status: "risky", provenance: `prospeo ${new Date().toISOString().slice(0, 10)}` };
        cache.put(key, "prospeo", r, 1); return r;
      }
    } catch {}
  }
  cache.put(key, "waterfall-miss", { email: null });
  return null;
}

// --- research brief (free, cached per company) ---
const Research = z.object({ summary: z.string().max(700), angles: z.array(z.string()).max(3) });
async function research(company: string, domain: string | null): Promise<z.infer<typeof Research> | null> {
  const key = `research:${company.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  let page = "";
  if (domain) {
    try {
      const out = execFileSync("tinyfish", ["fetch", "content", "get", "--format", "markdown", `https://${domain}`], { encoding: "utf8", timeout: 90_000, maxBuffer: 20_000_000 });
      page = JSON.parse(out)?.results?.[0]?.text ?? "";
    } catch {}
  }
  if (page.length < 300) return null;
  try {
    const r = extract(Research,
      `Summarize what this company does (max 100 words), then give up to 3 concrete "angles": specific things this candidate could do for them, each tied to one proof point.\nCandidate proof points: ${profile.proof_points.join("; ")}`,
      page.slice(0, 6000),
      { tier: "light", retries: 2, escalate: false, db });
    cache.put(key, "research", r);
    return r;
  } catch { return null; }
}

// --- main: only the people YOU marked ---
const marked = (await twenty("GET", `people?filter=fetchEmail[eq]:YES&limit=50`))?.data?.people ?? [];
console.log(`${marked.length} people marked Fetch Email = YES`);

const Draft = z.object({ subject: z.string().max(80), body: z.string().max(2200) }); // ≈300 words
for (const p of marked) {
  const name = `${p.name?.firstName ?? ""} ${p.name?.lastName ?? ""}`.trim().replace(/ -$/, "");
  const comp = (await twenty("GET", `companies/${p.companyId}`))?.data?.company;
  const company = comp?.name ?? "?";
  console.log(`\n${name} @ ${company}`);

  const domain = await companyDomain(company);
  if (!domain) { await twenty("PATCH", `people/${p.id}`, { fetchEmail: "FAILED", emailProvenance: "no domain found" }); console.log("  no domain"); continue; }

  const [first, ...rest] = name.split(" ");
  const found = await findEmail(first!, rest.join(" ") || first!, domain);
  if (!found) { await twenty("PATCH", `people/${p.id}`, { fetchEmail: "FAILED", emailProvenance: "waterfall miss (cached — no credit wasted on retry)" }); console.log("  miss"); continue; }
  console.log(`  ${found.email} (${found.status}, ${found.provenance})`);

  db.prepare("UPDATE people SET email = ?, email_status = ?, provenance = json_patch(coalesce(provenance,'{}'), ?) WHERE lower(company)=lower(?) AND lower(name)=lower(?)")
    .run(found.email, found.status, JSON.stringify({ email: found.provenance }), company, name);

  const r = await research(company, domain);
  const job = db.prepare("SELECT title, url FROM jobs WHERE lower(company)=lower(?) AND rejected IS NULL ORDER BY llm_score DESC LIMIT 1").get(company) as any;
  let draft: z.infer<typeof Draft> | null = null;
  try {
    draft = extract(Draft,
      `Write a cold outreach email UNDER 300 WORDS from the candidate to ${name} (${p.jobTitle ?? "?"} at ${company}) about the "${job?.title ?? "open"}" role. Structure: one line why-them, one concrete angle from the research, 2 proof points max, availability (immediate), one clear ask (15-min call). Plain, direct, no flattery, no buzzwords.\nCandidate: ${profile.proof_points.slice(0, 5).join("; ")}\nResearch: ${r ? `${r.summary} Angles: ${r.angles.join(" | ")}` : "none"}`,
      `To: ${name}, ${p.jobTitle} @ ${company}. Role: ${job?.title} (${job?.url ?? ""})`,
      { tier: DRAFT_TIER, retries: 1, escalate: false, db });
  } catch {}

  const slug = `${company}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  writeFileSync(`email-drafts/${slug}.md`,
    `# ${name} <${found.email}> — ${company}\n\nrole: ${job?.title ?? "?"} (${job?.url ?? ""})\nstatus: ${found.status} · ${found.provenance}\n\n${r ? `## research\n${r.summary}\n\nangles: ${r.angles.join(" · ")}\n\n` : ""}## draft (${DRAFT_TIER})\nSubject: ${draft?.subject ?? "(draft failed — rerun or write manually)"}\n\n${draft?.body ?? ""}\n`);

  await twenty("PATCH", `people/${p.id}`, {
    emails: { primaryEmail: found.email },
    emailStatus: found.status.toUpperCase(),
    emailProvenance: found.provenance,
    fetchEmail: "DONE",
  });
  if (comp && r) await twenty("PATCH", `companies/${p.companyId}`, { research: `${r.summary}\nAngles: ${r.angles.join(" | ")}` });
}
console.log(`\ndrafts in email-drafts/ — skim, edit, then send (Gmail draft step comes later)`);
