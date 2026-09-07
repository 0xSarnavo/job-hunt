// STEP 14 — funding-news BACKFILL: walk each outlet's paged RSS archive
// (WordPress supports feed/?paged=N) back to BACKFILL_DAYS, and put the
// companies that qualify (funded, 5–50 headcount) through the same pitch path
// as 7-funded. Designed to chip away daily:
//   - per-feed cursor in lookups (backfill:cursor:<host>) — resumes where it left
//   - at most BACKFILL_PAGES archive pages walked per feed per run
//   - at most BACKFILL_ARTICLES articles LLM-processed per run (Apollo 600/day shared)
// When every cursor reads "done", the backlog is finished (see data/PENDING.md).
//
// Knobs:
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS ?? 730);
const PAGES_PER_FEED = Number(process.env.BACKFILL_PAGES ?? 5);
const MAX_ARTICLES = Number(process.env.BACKFILL_ARTICLES ?? 30);
const MODEL = "opencode/mimo-v2.5-free";

import Parser from "rss-parser";
import { z } from "zod";
import { openDb } from "../src/db.ts";
import { extract } from "../src/llm.ts";
import { companyDomain, apolloEnrich, cacheGet, cachePut } from "../src/enrich.ts";
import { notePending } from "../src/notes.ts";

process.chdir(new URL("..", import.meta.url).pathname);
import { loadEnv } from "../src/env.ts";
loadEnv();
process.env.LLM_LIGHT ??= `opencode run -m ${MODEL}`;
const actor = process.env.JOBHUNT_ACTOR || "cron";
const db = openDb();

const U = process.env.TWENTY_URL, K = process.env.TWENTY_API_KEY;
const twenty = async (method: string, path: string, body?: unknown) => {
  if (!U || !K) return null;
  await new Promise((r) => setTimeout(r, 700));
  try {
    const res = await fetch(`${U}/rest/${path}`, {
      method, headers: { Authorization: `Bearer ${K}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? res.json() : (console.error(`twenty ${method} ${path}: ${res.status}`), null);
  } catch (err) { console.error(`twenty ${method} ${path}: ${String(err).slice(0, 100)}`); return null; }
};

// same outlets as 7-funded; feeds that don't support ?paged= just end early
const FEEDS = [
  "https://www.finsmes.com/feed",
  "https://techcrunch.com/category/venture/feed/",
  "https://news.crunchbase.com/feed/",
  "https://entrackr.com/feed",
  "https://inc42.com/feed/",
  "https://sifted.eu/feed",
  "https://tech.eu/feed/",
  "https://www.eu-startups.com/feed/",
  "https://www.startupdaily.net/feed/",
];

const Funding = z.object({
  is_funding_news: z.boolean(),
  company: z.string().nullable(),
  amount: z.string().nullable(),
  round: z.string().nullable(),
});

const cutoff = Date.now() - BACKFILL_DAYS * 86_400_000;
const parser = new Parser({ timeout: 30_000 });
type Item = { title: string; link: string; snippet: string; host: string };
const backlog: Item[] = [];
let pagesWalked = 0;

// ---------- 1. walk archives (cheap — RSS only, no LLM) ----------
for (const feed of FEEDS) {
  const host = new URL(feed).host.replace(/^www\./, "");
  const curKey = `backfill:cursor:${host}`;
  const cur = cacheGet(db, curKey) ?? { page: 2 }; // page 1 is covered by 7-funded daily
  if (cur.page === "done") continue;
  let page = cur.page as number;
  for (let i = 0; i < PAGES_PER_FEED; i++, page++) {
    const sep = feed.includes("?") ? "&" : "?";
    let items;
    try { items = (await parser.parseURL(`${feed}${sep}paged=${page}`)).items ?? []; }
    catch { cachePut(db, curKey, "backfill", { page: "done", reason: `page ${page} unreachable` }); break; }
    if (!items.length) { cachePut(db, curKey, "backfill", { page: "done", reason: "no more pages" }); break; }
    pagesWalked++;
    const dates = items.map((it) => Date.parse(it.isoDate ?? it.pubDate ?? "")).filter(Number.isFinite);
    for (const it of items) {
      const when = Date.parse(it.isoDate ?? it.pubDate ?? "");
      if (Number.isFinite(when) && when < cutoff) continue;
      if (!/rais|fund|seed|series|round|backs|invest/i.test(it.title ?? "")) continue;
      if (cacheGet(db, `funded:${(it.link ?? it.title ?? "").slice(0, 120)}`)) continue; // already processed
      backlog.push({ title: it.title ?? "", link: it.link ?? "", snippet: (it.contentSnippet ?? "").slice(0, 500), host });
    }
    if (dates.length && Math.max(...dates) < cutoff) {
      cachePut(db, curKey, "backfill", { page: "done", reason: `reached ${BACKFILL_DAYS}d cutoff` });
      break;
    }
    cachePut(db, curKey, "backfill", { page: page + 1 });
  }
}
console.log(`walked ${pagesWalked} archive pages · ${backlog.length} unprocessed funding-looking articles found`);

// ---------- 2. process a bounded batch (LLM + Apollo) ----------
let processed = 0, qualified = 0;
for (const a of backlog.slice(0, MAX_ARTICLES)) {
  const key = `funded:${(a.link || a.title).slice(0, 120)}`;
  let f;
  try {
    f = extract(Funding,
      `Is this a startup funding announcement? If yes extract the funded company's name, amount, and round.`,
      `${a.title}\n${a.snippet}`,
      { tier: "light", retries: 1, escalate: false, db, example: { is_funding_news: true, company: "Runable", amount: "$21M", round: "Series A" } });
  } catch { continue; }
  cachePut(db, key, "funded-article", f);
  processed++;
  if (!f.is_funding_news || !f.company) continue;

  const domain = companyDomain(db, f.company);
  if (!domain) continue;
  const org = await apolloEnrich(db, domain);
  if (!org || org.headcount == null || org.headcount < 5 || org.headcount > 50) continue;
  qualified++;

  const fundingNote = `${f.amount ?? "?"} ${f.round ?? ""} · total ${org.funding_total ?? "?"} · ${org.industry ?? ""}`.trim();
  db.prepare(
    `INSERT INTO companies (domain, name, stage, funding, headcount, source, pitch)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(domain) DO UPDATE SET pitch=1, stage=excluded.stage, funding=excluded.funding, headcount=excluded.headcount`,
  ).run(domain, f.company, org.funding_stage, fundingNote, org.headcount, `backfill:${a.host}`);

  const compKey = `crm:company:${f.company.toLowerCase()}`;
  let companyId = cacheGet(db, compKey)?.id;
  if (!companyId) {
    const created = await twenty("POST", "companies", {
      name: f.company, actor, signalSource: `backfill:${a.host}`, fundingNote,
      headcount: org.headcount, domainName: { primaryLinkUrl: `https://${domain}` },
    });
    companyId = created?.data?.createCompany?.id;
    if (companyId) cachePut(db, compKey, "twenty", { id: companyId });
  }
  const oppKey = `crm:opp:pitch:${domain}`;
  if (companyId && !cacheGet(db, oppKey)) {
    const opp = await twenty("POST", "opportunities", {
      name: `${f.company} — GTM/Marketing pitch (backfill)`,
      stage: "QUEUED", jobTitle: "GTM / Generalist Marketer (proactive pitch)",
      jobUrl: `https://${domain}`, applyLink: { primaryLinkUrl: `https://${domain}`, primaryLinkLabel: "Site" },
      actor, companyId,
    });
    if (opp?.data?.createOpportunity?.id) cachePut(db, oppKey, "twenty", { id: opp.data.createOpportunity.id });
  }
  console.log(`  PITCH ${f.company} (${domain}) — ${org.headcount} people · ${fundingNote} · via ${a.host}`);
}

const cursors = FEEDS.map((f) => {
  const host = new URL(f).host.replace(/^www\./, "");
  const c = cacheGet(db, `backfill:cursor:${host}`);
  return `${host}: ${c?.page === "done" ? `done (${c.reason})` : `at page ${c?.page ?? 2}`}`;
});
notePending("14-backfill", [
  `${Math.max(backlog.length - MAX_ARTICLES, 0)} collected articles still unprocessed this round (cap BACKFILL_ARTICLES=${MAX_ARTICLES}/run — LLM + Apollo 600/day budget)`,
  `this run: ${pagesWalked} pages walked, ${processed} articles judged, ${qualified} pitch targets`,
  ...cursors,
]);
console.log(`\nbackfill: ${processed} articles → ${qualified} pitch targets. Cursor state in data/PENDING.md`);
