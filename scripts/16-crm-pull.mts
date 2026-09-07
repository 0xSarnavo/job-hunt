// STEP 16 — absorb what YOU created directly in the CRM (+ New button).
//
// Detection: every pipeline write stamps `actor`; hand-created records have
// none. Each run this script:
//   - Companies → local companies table + dedupe cache (so nothing re-creates
//     them), and they enter the careers-check queue (ATS + live roles)
//   - People    → local people table; Persona Tier inferred from the title if
//     you left it blank
//   - Opportunities → local jobs table, scored against your profile
//     (Match Score filled in on the card)
// Absorbed records get actor='human' so they're pulled exactly once.

import { openDb } from "../src/db.ts";
import { loadProfile } from "../src/profile.ts";
import { score } from "../src/score.ts";
import { cachePut } from "../src/enrich.ts";
import { loadEnv } from "../src/env.ts";

process.chdir(new URL("..", import.meta.url).pathname);
loadEnv();
const db = openDb();
const profile = loadProfile();

const U = process.env.TWENTY_URL, K = process.env.TWENTY_API_KEY;
if (!U || !K) { console.log("no CRM configured — nothing to pull"); process.exit(0); }
const twenty = async (method: string, path: string, body?: unknown) => {
  await new Promise((r) => setTimeout(r, 700));
  try {
    const res = await fetch(`${U}/rest/${path}`, {
      method, headers: { Authorization: `Bearer ${K}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? res.json() : (console.error(`twenty ${method} ${path}: ${res.status}`), null);
  } catch (err) { console.error(`twenty ${method} ${path}: ${String(err).slice(0, 100)}`); return null; }
};

const handMade = async (obj: string) =>
  (await twenty("GET", `${obj}?filter=${encodeURIComponent('actor[is]:NULL')}&limit=200`))?.data?.[obj] ?? [];
const domainOf = (link?: string | null) =>
  link ? link.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "") || null : null;

// in-memory company id → name (for people/opportunity linkage)
const companyName = new Map<string, string>();
const nameOf = async (id: string | null): Promise<string | null> => {
  if (!id) return null;
  if (!companyName.has(id)) {
    const c = (await twenty("GET", `companies/${id}`))?.data?.company;
    companyName.set(id, c?.name ?? "?");
  }
  return companyName.get(id) ?? null;
};

// ---------- companies ----------
let compN = 0;
for (const c of await handMade("companies")) {
  const domain = domainOf(c.domainName?.primaryLinkUrl);
  db.prepare("INSERT OR IGNORE INTO companies (domain, name, source) VALUES (?, ?, 'crm-manual')")
    .run(domain ?? c.name.toLowerCase().replace(/[^a-z0-9]/g, ""), c.name);
  cachePut(db, `crm:company:${c.name.toLowerCase()}`, "twenty", { id: c.id });
  await twenty("PATCH", `companies/${c.id}`, { actor: "human" });
  companyName.set(c.id, c.name);
  compN++;
  console.log(`  company: ${c.name}${domain ? ` (${domain})` : ""} — queued for careers check`);
}

// ---------- people ----------
let peopleN = 0;
for (const p of await handMade("people")) {
  const name = `${p.name?.firstName ?? ""} ${p.name?.lastName ?? ""}`.trim().replace(/ -$/, "");
  if (!name) continue;
  const comp = await nameOf(p.companyId);
  const title = p.jobTitle ?? "";
  const persona = p.personaTier ??
    (/founder|co-founder|ceo|cto|chief/i.test(title) ? "FOUNDER" :
     /head|director|lead|vp|manager/i.test(title) ? "HIRING_MANAGER" :
     /recruit|talent/i.test(title) ? "RECRUITER" : "PEER");
  try {
    db.prepare("INSERT INTO people (company, name, title, persona_tier, linkedin, provenance) VALUES (?, ?, ?, ?, ?, ?)")
      .run(comp ?? "?", name, title, persona.toLowerCase(),
        p.linkedinLink?.primaryLinkUrl ?? null, JSON.stringify({ source: "crm-manual", at: new Date().toISOString() }));
  } catch { /* unique index — already known */ }
  await twenty("PATCH", `people/${p.id}`, { actor: "human", ...(p.personaTier ? {} : { personaTier: persona }) });
  peopleN++;
  console.log(`  person: ${name}${comp ? ` @ ${comp}` : ""} (${persona.toLowerCase()})`);
}

// ---------- opportunities ----------
let oppN = 0;
for (const o of await handMade("opportunities")) {
  const comp = (await nameOf(o.companyId)) ?? o.name?.split("—")[0]?.trim() ?? "?";
  const title = o.jobTitle ?? o.name ?? "?";
  const url = o.jobUrl || `manual:crm-${o.id}`;
  const v = score({ source: "crm-manual", company: comp, title, url, location: "", description: "" }, profile);
  db.prepare(`INSERT OR REPLACE INTO jobs (url, company, title, location, source, description, match_score, matched_at, rejected)
              VALUES (?, ?, ?, '', 'crm-manual', '', ?, datetime('now'), NULL)`)
    .run(url, comp, title, v.score);
  cachePut(db, `crm:opp:${url}`, "twenty", { id: o.id });
  await twenty("PATCH", `opportunities/${o.id}`, {
    actor: "human", ...(o.matchScore == null ? { matchScore: Math.round(v.score) } : {}), ...(o.jobUrl ? {} : { jobUrl: url }),
  });
  oppN++;
  console.log(`  role: ${title} @ ${comp} (rubric ${v.score})`);
}

console.log(`\nabsorbed from CRM: ${compN} companies, ${peopleN} people, ${oppN} roles. Add freely with + New — this runs every day.`);
