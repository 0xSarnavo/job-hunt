// STEP 5 — company employee finding (run after fetch/score/sync).
// For each top selected company: find the right humans via TinyFish Search
// (free), tier them by persona, draft a LinkedIn connect note (≤300 chars —
// LinkedIn's real cap) + a ≤150-word DM for after acceptance, push to CRM.
//
// CREDIT GUARDS (in order): people already in SQLite → skip company;
// crm:people:<company> marker in lookups → skip; search results cached forever.
//
// Knobs:
const COMPANIES_PER_RUN = Number(process.env.PEOPLE_PER_RUN ?? 5); // TinyFish search: 500/hr free — 2 per company
const MODEL = "opencode/mimo-v2.5-free";

import { execFileSync } from "node:child_process";
import { z } from "zod";
import { openDb } from "../src/db.ts";
import { extract } from "../src/llm.ts";
import { loadProfile } from "../src/profile.ts";
import { track } from "../src/usage.ts";

process.chdir(new URL("..", import.meta.url).pathname);
import { loadEnv } from "../src/env.ts";
loadEnv();
process.env.LLM_LIGHT ??= `opencode run -m ${MODEL}`; // default only — your .env LLM_LIGHT wins
const actor = process.env.JOBHUNT_ACTOR || "cron";
const db = openDb();
const profile = loadProfile();

const U = process.env.TWENTY_URL!, K = process.env.TWENTY_API_KEY!;
const twenty = async (method: string, path: string, body?: unknown) => {
  await new Promise((r) => setTimeout(r, 700));
  const res = await fetch(`${U}/rest/${path}`, {
    method, headers: { Authorization: `Bearer ${K}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok ? res.json() : (console.error(`twenty ${path}: ${res.status}`), null);
};

// TinyFish first (free), Firecrawl on failure (2 credits/10 results — worth it
// when the free tier is down). Cached forever either way; failures return "".
function search(q: string): string {
  const key = `tfsearch:${q}`;
  const hit = db.prepare("SELECT result FROM lookups WHERE key = ?").get(key) as any;
  if (hit) return hit.result;
  let out = "", provider = "tinyfish-search";
  try {
    out = execFileSync("tinyfish", ["search", "query", q], { encoding: "utf8", timeout: 60_000 });
  } catch {
    try {
      out = execFileSync("firecrawl", ["search", q, "--limit", "8"], { encoding: "utf8", timeout: 90_000 });
      provider = "firecrawl";
    } catch { return ""; }
  }
  db.prepare("INSERT OR REPLACE INTO lookups (key, provider, result, cost) VALUES (?, ?, ?, ?)")
    .run(key, provider, out, provider === "firecrawl" ? 1 : 0);
  return out;
}

const People = z.object({
  people: z.array(z.object({
    name: z.string(),
    title: z.string(),
    linkedin_url: z.string(),
  })).max(6),
});
const Msgs = z.object({
  connect_note: z.string().max(295),
  dm: z.string().max(1100), // ≈150 words
});

const tier = (t: string) =>
  /founder|co-founder|ceo|cto|chief/i.test(t) ? "founder" :
  /head|director|lead|vp|manager/i.test(t) ? "hiring_manager" :
  /recruit|talent/i.test(t) ? "recruiter" : "peer";

// Staffing/aggregator intermediaries — their postings belong to hidden real
// employers, so people-finding there is wasted effort.
const AGGREGATORS = new Set(["jobgether", "jobs via dice", "cybercoders", "hays", "randstad", "adecco"]);

// Fiber people-search — the primary source: profile pulls are FREE (10k/month,
// only contact reveals cost credits; our email waterfall replaces those).
// Falls back to web search + LLM extraction when Fiber has nothing.
const TITLE_TERMS = ["founder", "ceo", "cto", "marketing", "growth", "developer relations", "developer advocate", "talent"];
async function fiberPeople(company: string, domain: string | null): Promise<{ name: string; title: string; linkedin_url: string }[]> {
  const fiberKey = process.env.FIBER_API_KEY;
  if (!fiberKey) return [];
  const cacheKey = `fiber:people:${company.toLowerCase()}`;
  const hit = db.prepare("SELECT result FROM lookups WHERE key = ?").get(cacheKey) as any;
  if (hit) return JSON.parse(hit.result);
  let people: { name: string; title: string; linkedin_url: string }[] = [];
  try {
    track("fiber");
    const res = await fetch("https://api.fiber.ai/v1/people-search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: fiberKey, pageSize: 6,
        currentCompanies: [domain ? { domain } : { name: company }],
        searchParams: { jobTitleV3: { anyOf: TITLE_TERMS.map((t) => ({ type: "plain", term: t })) } },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) { console.error(`  fiber: ${res.status} ${(await res.text()).slice(0, 120)}`); return []; }
    const body = (await res.json()) as any;
    people = (body?.output?.data ?? [])
      .map((p: any) => ({
        name: p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" "),
        title: (p.experiences?.find((e: any) => e.is_current)?.title ?? p.headline ?? "").slice(0, 120),
        linkedin_url: p.url ?? (p.primary_slug ? `https://linkedin.com/in/${p.primary_slug}` : ""),
      }))
      .filter((p: any) => p.name && /linkedin\.com\/in\//i.test(p.linkedin_url));
    db.prepare("INSERT OR REPLACE INTO lookups (key, provider, result, cost) VALUES (?, 'fiber', ?, 0)")
      .run(cacheKey, JSON.stringify(people));
  } catch (err) { console.error(`  fiber: ${String(err).slice(0, 100)}`); }
  return people;
}

// pitch targets first (fewer, higher intent), then top selected job companies
const seen = new Set<string>();
const companies = ([
  ...db.prepare(`
    SELECT name company, 'GTM / Generalist Marketer (proactive pitch)' title
    FROM companies WHERE pitch = 1`).all(),
  ...db.prepare(`
    SELECT DISTINCT company, title FROM jobs
    WHERE rejected IS NULL AND match_score >= 50 AND llm_score >= 50
    ORDER BY llm_score DESC`).all(),
] as any[])
  .filter((c) => { const k = c.company.toLowerCase(); if (seen.has(k) || AGGREGATORS.has(k)) return false; seen.add(k); return true; })
  .filter((c) => !(db.prepare("SELECT 1 FROM feedback WHERE kind='company' AND lower(ref)=lower(?)").get(c.company))) // you said no
  .filter((c) => !(db.prepare("SELECT 1 FROM people WHERE lower(company)=lower(?) LIMIT 1").get(c.company)))
  .filter((c) => !(db.prepare("SELECT 1 FROM lookups WHERE key = ?").get(`crm:people:${c.company.toLowerCase()}`)))
  .slice(0, COMPANIES_PER_RUN);

console.log(`finding people at ${companies.length} companies: ${companies.map((c) => c.company).join(", ")}`);

for (const c of companies) {
  const domain = (db.prepare(
    `SELECT domain FROM companies WHERE lower(name)=lower(?) AND domain LIKE '%.%'
     UNION SELECT domain FROM portfolio_companies WHERE lower(name)=lower(?) AND domain IS NOT NULL LIMIT 1`,
  ).get(c.company, c.company) as any)?.domain ?? null;

  // rung 1: Fiber (free, structured). rung 2: web search + LLM extraction.
  let found = { people: await fiberPeople(c.company, domain) };
  if (found.people.length) console.log(`  ${c.company}: ${found.people.length} via fiber`);
  else {
    const raw =
      search(`site:linkedin.com/in "${c.company}" founder OR CTO OR "developer relations" OR "head of marketing" OR "head of growth"`) +
      "\n" + search(`site:linkedin.com/in "${c.company}" devrel OR "developer advocate" OR "product marketing"`);
    if (raw.trim().length < 50) { console.log(`  ${c.company}: search unavailable, will retry next run`); continue; }
    try {
      found = extract(People,
        `From these search results, extract real people who currently work at "${c.company}" (the company hiring for "${c.title}"). Only people, only this company, linkedin_url must be a linkedin.com/in/ URL.`,
        raw.slice(0, 6000),
        { tier: "light", retries: 2, escalate: false, db, example: { people: [{ name: "Jane Doe", title: "Head of Developer Relations", linkedin_url: "https://linkedin.com/in/janedoe" }] } });
    } catch { console.log(`  ${c.company}: people extraction failed`); continue; }
  }

  // quote the value — company names with commas/colons break Twenty's filter grammar otherwise
  const compRow = await twenty("GET", `companies?filter=${encodeURIComponent(`name[eq]:"${c.company.replaceAll('"', "")}"`)}&limit=1`);
  const companyId = compRow?.data?.companies?.[0]?.id;

  let added = 0;
  for (const p of found.people) {
    if (!/linkedin\.com\/in\//i.test(p.linkedin_url)) continue;
    const persona = tier(p.title);
    let msgs = { connect_note: "", dm: "" };
    try {
      msgs = extract(Msgs,
        `Write for the candidate below: (1) connect_note — a LinkedIn connection note UNDER 290 CHARACTERS to ${p.name} (${p.title} at ${c.company}), referencing the "${c.title}" opening, warm and specific, no flattery; (2) dm — a message under 150 words for after they accept, one concrete proof point, one clear ask.\nCandidate: ${profile.proof_points.slice(0, 4).join("; ")}. Available immediately.`,
        `Person: ${p.name}, ${p.title} @ ${c.company}. Opening: ${c.title}.`,
        { tier: "light", retries: 2, escalate: false, db, example: { connect_note: "Hi Jane — saw the DevRel opening at Acme. I onboarded 7,000+ devs in my last role and would love to connect.", dm: "Thanks for connecting! ..." } });
    } catch {}
    try {
      db.prepare("INSERT INTO people (company, name, title, persona_tier, linkedin, provenance) VALUES (?, ?, ?, ?, ?, ?)")
        .run(c.company, p.name, p.title, persona, p.linkedin_url, JSON.stringify({ source: "tinyfish-search", at: new Date().toISOString() }));
    } catch { continue; } // unique index: already known
    const created = await twenty("POST", "people", {
      name: { firstName: p.name.split(" ")[0], lastName: p.name.split(" ").slice(1).join(" ") || "-" },
      jobTitle: p.title,
      linkedinLink: { primaryLinkUrl: p.linkedin_url },
      personaTier: persona.toUpperCase(),
      fetchEmail: "NO",
      linkedinNote: msgs.connect_note,
      dmDraft: msgs.dm,
      actor,
      ...(companyId ? { companyId } : {}),
    });
    if (created) added++;
  }
  db.prepare("INSERT OR REPLACE INTO lookups (key, provider, result, cost) VALUES (?, 'people-run', ?, 0)")
    .run(`crm:people:${c.company.toLowerCase()}`, JSON.stringify({ added, at: new Date().toISOString() }));
  console.log(`  ${c.company}: ${added} people added to CRM`);
}
console.log("\nNext: in Twenty, set Fetch Email = YES on the people you pick; then run 6-emails.mts");
