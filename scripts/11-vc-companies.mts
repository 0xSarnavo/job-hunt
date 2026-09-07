// STEP 11 — VC company lists, directly: latest YC batches from the yc-oss
// mirror of the official directory (free JSON, refreshed daily). ONLY ACTIVE
// companies kept. Stage comes from the batch (YC = seed by definition);
// Apollo org-enrich supplements funding details where it knows the domain.
// Each qualifying company: pitch=1 → 5-people finds LinkedIn contacts next.
//
// a16z newest investments arrive via 7-funded (news) — their portfolio page
// has no "latest" sort. YC is the volume source for fresh companies.
//
// Knobs:
const BATCHES = ["fall-2026", "summer-2026"]; // newest first; bad names are skipped
const MAX_NEW = Number(process.env.VC_COMPANIES_MAX ?? 12);
const TEAM_MIN = 2, TEAM_MAX = 50;

import { openDb } from "../src/db.ts";
import { apolloEnrich, cacheGet, cachePut } from "../src/enrich.ts";

process.chdir(new URL("..", import.meta.url).pathname);
import { loadEnv } from "../src/env.ts";
loadEnv();
const actor = process.env.JOBHUNT_ACTOR || "cron";
const db = openDb();

const U = process.env.TWENTY_URL!, K = process.env.TWENTY_API_KEY!;
const twenty = async (method: string, path: string, body?: unknown) => {
  await new Promise((r) => setTimeout(r, 700));
  const res = await fetch(`${U}/rest/${path}`, {
    method, headers: { Authorization: `Bearer ${K}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok ? res.json() : (console.error(`twenty ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`), null);
};

let added = 0;
outer:
for (const batch of BATCHES) {
  let companies: any[];
  try {
    const res = await fetch(`https://yc-oss.github.io/api/batches/${batch}.json`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) { console.log(`${batch}: not published yet`); continue; }
    companies = await res.json() as any[];
  } catch { continue; }
  console.log(`${batch}: ${companies.length} companies in directory`);

  for (const c of companies) {
    if (added >= MAX_NEW) break outer;
    if (c.status !== "Active") continue;                      // only the active ones
    const team = c.team_size ?? 0;
    if (team < TEAM_MIN || team > TEAM_MAX) continue;
    let domain: string | null = null;
    try { domain = c.website ? new URL(c.website).host.replace(/^www\./, "") : null; } catch {}
    if (!domain) continue;
    if (db.prepare("SELECT 1 FROM companies WHERE domain = ?").get(domain)) continue; // already known

    // stage from the batch itself; Apollo supplements when it knows them
    const org = await apolloEnrich(db, domain);
    const fundingNote = [
      `YC ${batch.replace("-", " ")}`,
      org?.funding_total ? `total ${org.funding_total}` : null,
      org?.funding_stage ?? null,
      c.one_liner?.slice(0, 120) ?? null,
    ].filter(Boolean).join(" · ");

    db.prepare(
      `INSERT INTO companies (domain, name, stage, funding, headcount, source, pitch)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(domain, c.name, org?.funding_stage ?? "seed (YC)", fundingNote, org?.headcount ?? team, `vc-list:yc-${batch}`);

    const compKey = `crm:company:${c.name.toLowerCase()}`;
    if (!cacheGet(db, compKey)) {
      const created = await twenty("POST", "companies", {
        name: c.name, actor, signalSource: `vc-list:yc-${batch}`,
        fundingStage: "SEED", fundingNote,
        headcount: org?.headcount ?? team,
        domainName: { primaryLinkUrl: `https://${domain}` },
        research: c.one_liner ?? "",
      });
      const id = created?.data?.createCompany?.id;
      if (id) {
        cachePut(db, compKey, "twenty", { id });
        const oppKey = `crm:opp:pitch:${domain}`;
        if (!cacheGet(db, oppKey)) {
          const opp = await twenty("POST", "opportunities", {
            name: `${c.name} — GTM/Marketing pitch (YC ${batch.split("-")[0]})`,
            stage: "QUEUED",
            jobTitle: "GTM / Generalist Marketer (proactive pitch)",
            jobUrl: c.website ?? `https://${domain}`,
            applyLink: { primaryLinkUrl: c.website ?? `https://${domain}`, primaryLinkLabel: "Site" },
            actor,
            companyId: id,
          });
          if (opp?.data?.createOpportunity?.id) cachePut(db, oppKey, "twenty", { id: opp.data.createOpportunity.id });
        }
      }
    }
    added++;
    console.log(`  +${c.name} (${domain}) — team ${team} — ${c.one_liner?.slice(0, 60) ?? ""}`);
  }
}
console.log(`\n${added} new active YC companies added as pitch targets. Next: 5-people finds their founders.`);
