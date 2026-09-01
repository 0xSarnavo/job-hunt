// STEP 7 — the pitch run (motion B, proactive): recently funded companies at
// 5–50 headcount, funded within the last 3 years, pitched for GTM / generalist
// marketer roles even without a posted job. Founder still hires directly at
// this size (PLAN §4).
//
// Flow: funding RSS → free-model extraction → domain (TinyFish, free) →
// Apollo org-enrich (free 600/day) → filter headcount 5–50 & funding ≤3y →
// companies.pitch=1 + CRM company + a "GTM pitch" opportunity card.
// Then 5-people picks these companies up automatically; you mark Fetch Email
// in the CRM; 6-emails does the rest. Nothing is ever sent automatically.
//
// Knobs:
const MODEL = "opencode/mimo-v2.5-free";
const MAX_NEW_COMPANIES = Number(process.env.FUNDED_MAX ?? 8); // per run
const FEEDS = [
  "https://techcrunch.com/category/venture/feed/",
  "https://entrackr.com/feed",
];

import Parser from "rss-parser";
import { z } from "zod";
import { openDb } from "../src/db.ts";
import { extract } from "../src/llm.ts";
import { companyDomain, apolloEnrich, cacheGet, cachePut } from "../src/enrich.ts";
import { resolve } from "../src/resolver.ts";
import { fetchBoard, type AtsKind } from "../src/sources/ats.ts";
import { ingest } from "../src/ingest.ts";
import { loadProfile } from "../src/profile.ts";

process.chdir(new URL("..", import.meta.url).pathname);
try { process.loadEnvFile(".env"); } catch {}
process.env.LLM_LIGHT = `opencode run -m ${MODEL}`;
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
  return res.ok ? res.json() : null;
};

const Funding = z.object({
  is_funding_news: z.boolean(),
  company: z.string().nullable(),
  amount: z.string().nullable(),
  round: z.string().nullable(),
});

const parser = new Parser();
let candidates = 0, qualified = 0;
outer:
for (const feed of FEEDS) {
  const feedHost = new URL(feed).host.replace(/^www\./, ""); // marks WHERE a company came from
  let items;
  try { items = (await parser.parseURL(feed)).items ?? []; } catch { continue; }
  for (const item of items) {
    if (qualified >= MAX_NEW_COMPANIES) break outer;
    const key = `funded:${(item.link ?? item.title ?? "").slice(0, 120)}`;
    if (cacheGet(db, key)) continue; // article already processed — no credit twice
    if (!/rais|fund|seed|series|round|backs|invest/i.test(item.title ?? "")) { cachePut(db, key, "funded-skip", { skip: true }); continue; }

    let f;
    try {
      f = extract(Funding,
        `Is this a startup funding announcement? If yes extract the funded company's name, amount, and round.`,
        `${item.title}\n${(item.contentSnippet ?? "").slice(0, 500)}`,
        { tier: "light", retries: 1, escalate: false, db, example: { is_funding_news: true, company: "Runable", amount: "$21M", round: "Series A" } });
    } catch { continue; }
    cachePut(db, key, "funded-article", f);
    if (!f.is_funding_news || !f.company) continue;
    candidates++;

    const domain = companyDomain(db, f.company);
    if (!domain) continue;
    const org = await apolloEnrich(db, domain);
    if (!org) continue;

    const fundedRecently =
      (org.funding_date && Date.parse(org.funding_date) > Date.now() - 3 * 365 * 86_400_000) ||
      (!org.funding_date && f.round != null); // fresh news article = fresh round
    const sizeOk = org.headcount != null && org.headcount >= 5 && org.headcount <= 50;
    if (!fundedRecently || !sizeOk) {
      console.log(`  skip ${f.company}: headcount=${org.headcount} funded=${org.funding_date?.slice(0, 10) ?? "?"}`);
      continue;
    }
    qualified++;
    const fundingNote = `${f.amount ?? "?"} ${f.round ?? ""} · total ${org.funding_total ?? "?"} · ${org.industry ?? ""}`.trim();
    db.prepare(
      `INSERT INTO companies (domain, name, stage, funding, headcount, source, pitch)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(domain) DO UPDATE SET pitch=1, stage=excluded.stage, funding=excluded.funding, headcount=excluded.headcount, source=excluded.source`,
    ).run(domain, f.company, org.funding_stage, fundingNote, org.headcount, `funded:${feedHost}`);

    // Careers check: which ATS, any live roles? Good ones become scored jobs;
    // the pitch card links to the best role, else the careers page.
    let careersUrl = `https://${domain}/careers`;
    let pitchTitle = "GTM / Generalist Marketer (proactive pitch)";
    try {
      const r = await resolve(f.company, domain, db);
      if (r.token && ["greenhouse", "lever", "ashby", "workable", "smartrecruiters"].includes(r.ats)) {
        const postings = await fetchBoard(r.ats as AtsKind, r.token, f.company);
        ingest(db, postings, profile);
        const best = db.prepare(
          "SELECT title, url, match_score FROM jobs WHERE lower(company)=lower(?) AND rejected IS NULL ORDER BY match_score DESC LIMIT 1",
        ).get(f.company) as any;
        if (best) {
          careersUrl = best.url;
          pitchTitle = `${best.title} (live role, score ${Math.round(best.match_score)})`;
        }
        console.log(`    careers: ${r.ats}/${r.token}, ${postings.length} live roles${best ? `, best: ${best.title}` : ""}`);
      }
    } catch {}

    // CRM: company + a pitch opportunity card (kanban-visible, QUEUED)
    const compKey = `crm:company:${f.company.toLowerCase()}`;
    let companyId = cacheGet(db, compKey)?.id;
    if (!companyId) {
      const created = await twenty("POST", "companies", {
        name: f.company, actor, signalSource: `funded:${feedHost}`,
        fundingNote,
        employees: org.headcount,
        domainName: { primaryLinkUrl: `https://${domain}` },
      });
      companyId = created?.data?.createCompany?.id;
      if (companyId) cachePut(db, compKey, "twenty", { id: companyId });
    }
    const oppKey = `crm:opp:pitch:${domain}`;
    if (!cacheGet(db, oppKey)) {
      const opp = await twenty("POST", "opportunities", {
        name: `${f.company} — GTM/Marketing pitch`,
        stage: "QUEUED",
        jobTitle: pitchTitle,
        jobUrl: careersUrl,
        applyLink: { primaryLinkUrl: careersUrl, primaryLinkLabel: "Careers" },
        actor,
        ...(companyId ? { companyId } : {}),
      });
      if (opp?.data?.createOpportunity?.id) cachePut(db, oppKey, "twenty", { id: opp.data.createOpportunity.id });
    }
    console.log(`  PITCH ${f.company} (${domain}) — ${org.headcount} people, ${fundingNote}`);
  }
}
console.log(`\nfunding articles that qualified: ${qualified}/${candidates} candidates. Next: 5-people picks these up.`);
