// STEP 12 — the investor-program directory.
//
// 1. Seeds "Job Portal" + "Investor Portfolio" records in Twenty from
//    src/registry.ts (idempotent — upserts by slug/name).
// 2. Scrapes member-company lists: YC via the yc-oss directory mirror,
//    a16z via the JSON embedded in a16z.com/portfolio. FULL lists land in the
//    local portfolio_companies table.
// 3. Pushes the relevant slice to CRM Companies (batch API, linked to their
//    Investor Portfolio record): YC = active companies of PORTFOLIO_YC_BATCHES,
//    a16z = active portfolio.
// 4. Refreshes counts on portal/portfolio records and writes
//    data/portfolio-companies.md — the full human-readable list.
//
// Knobs:
const YC_BATCHES = (process.env.PORTFOLIO_YC_BATCHES ?? "Fall 2026,Summer 2026,Spring 2026,Winter 2026")
  .split(",").map((s) => s.trim().toLowerCase());
const PUSH_MAX = Number(process.env.PORTFOLIO_PUSH_MAX ?? 500); // new CRM companies per run (resumes next run)

import { writeFileSync } from "node:fs";
import { openDb } from "../src/db.ts";
import { PORTALS, PORTFOLIOS } from "../src/registry.ts";
import { cacheGet, cachePut } from "../src/enrich.ts";

process.chdir(new URL("..", import.meta.url).pathname);
try { process.loadEnvFile(".env"); } catch {}
const actor = process.env.JOBHUNT_ACTOR || "cron";
const db = openDb();

const U = process.env.TWENTY_URL, K = process.env.TWENTY_API_KEY;
if (!U || !K) { console.error("TWENTY_URL / TWENTY_API_KEY missing — CRM sync skipped"); process.exit(1); }
const twenty = async (method: string, path: string, body?: unknown) => {
  await new Promise((r) => setTimeout(r, 700)); // Twenty limit: 100 req/min
  const res = await fetch(`${U}/rest/${path}`, {
    method, headers: { Authorization: `Bearer ${K}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  return res.ok ? res.json() : (console.error(`twenty ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`), null);
};

const domainOf = (site?: string | null) => {
  try { return site ? new URL(site).host.replace(/^www\./, "") : null; } catch { return null; }
};

// ---------- 1. seed Job Portal records ----------
const existingPortals = (await twenty("GET", "jobPortals?limit=100"))?.data?.jobPortals ?? [];
const portalByStub = new Map(existingPortals.map((p: any) => [p.sourceSlug, p.id]));
const jobCount = db.prepare("SELECT count(*) n FROM jobs WHERE source = ? OR source LIKE ? || ':%'");
for (const p of PORTALS) {
  const jobs = (jobCount.get(p.slug, p.slug) as any).n;
  const body = {
    name: p.name, sourceSlug: p.slug, kind: p.kind, status: p.status,
    whatItGives: p.gives, jobsIngested: jobs, actor,
    portalUrl: { primaryLinkUrl: p.url, primaryLinkLabel: p.name },
  };
  const id = portalByStub.get(p.slug);
  if (id) await twenty("PATCH", `jobPortals/${id}`, { jobsIngested: jobs, status: p.status });
  else await twenty("POST", "jobPortals", body);
}
console.log(`portals: ${PORTALS.length} seeded/updated`);

// ---------- 2. scrape portfolio member lists ----------
const upsert = db.prepare(`
  INSERT INTO portfolio_companies (program, name, domain, batch, status, url, one_liner)
  VALUES (@program, @name, @domain, @batch, @status, @url, @one_liner)
  ON CONFLICT(program, name) DO UPDATE SET
    domain=excluded.domain, batch=excluded.batch, status=excluded.status,
    url=excluded.url, one_liner=excluded.one_liner`);

// YC — the whole directory, every batch, from the yc-oss mirror (free JSON).
try {
  const res = await fetch("https://yc-oss.github.io/api/companies/all.json", { signal: AbortSignal.timeout(120_000) });
  const all = (await res.json()) as any[];
  const tx = db.transaction((rows: any[]) => { for (const r of rows) upsert.run(r); });
  tx(all.map((c) => ({
    program: "yc", name: c.name ?? "?", domain: domainOf(c.website),
    batch: c.batch ?? null, status: c.status ?? null, url: c.website ?? null,
    one_liner: c.one_liner?.slice(0, 300) ?? null,
  })));
  console.log(`yc: ${all.length} companies in directory`);
} catch (err) { console.error(`yc scrape failed: ${String(err).slice(0, 150)}`); }

// a16z — portfolio page embeds the full list as HTML-entity-encoded JSON.
try {
  const res = await fetch("https://a16z.com/portfolio/", {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    signal: AbortSignal.timeout(60_000),
  });
  const html = await res.text();
  const decoded = html
    .replaceAll("&quot;", '"').replaceAll("&amp;", "&")
    .replaceAll("&#039;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
  // several '[{"id"' arrays exist on the page (widgets etc.) — bracket-match each
  // (nested arrays like socials:[{...}] rule out indexOf) and keep the biggest
  const closeOf = (start: number): number => {
    let depth = 0, inStr = false;
    for (let i = start; i < decoded.length; i++) {
      const ch = decoded[i];
      if (inStr) { if (ch === "\\") i++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") { depth--; if (depth === 0) return i; }
    }
    return -1;
  };
  let companies: any[] = [];
  for (let start = decoded.indexOf('[{"id"'); start !== -1; start = decoded.indexOf('[{"id"', start + 1)) {
    const close = closeOf(start);
    if (close === -1) continue;
    try {
      const arr = JSON.parse(decoded.slice(start, close + 1)) as any[];
      // several big arrays exist (logo grid vs company data) — we want the one with names
      if (arr[0]?.name && arr.length > companies.length) companies = arr;
    } catch {}
  }
  if (companies.length < 50) throw new Error(`portfolio JSON not found (largest candidate: ${companies.length}) — page layout changed`);
  const tx = db.transaction((rows: any[]) => { for (const r of rows) upsert.run(r); });
  const list = (v: unknown) => Array.isArray(v) ? v.join("/") : typeof v === "string" ? v : "";
  tx(companies.map((c) => ({
    program: "a16z", name: c.name ?? c.post_title ?? "?", domain: domainOf(c.company_url || c.url),
    batch: list(c.stages) || null,
    status: c.status ?? c.tag ?? null, url: c.company_url || c.url || null,
    one_liner: [list(c.focus_areas).replaceAll("/", ", "), c.description?.slice(0, 200)].filter(Boolean).join(" · ") || null,
  })));
  console.log(`a16z: ${companies.length} companies in portfolio`);
} catch (err) { console.error(`a16z scrape failed: ${String(err).slice(0, 150)}`); }

// ---------- 3. push the relevant slice to CRM Companies ----------
const portfolioRecords = (await twenty("GET", "investorPortfolios?limit=100"))?.data?.investorPortfolios ?? [];
const portfolioIdByName = new Map(portfolioRecords.map((p: any) => [p.name, p.id]));
for (const p of PORTFOLIOS) {
  if (portfolioIdByName.has(p.name)) continue;
  const created = await twenty("POST", "investorPortfolios", {
    name: p.name, kind: p.kind, scrapeStatus: p.scrape, notes: p.notes, actor,
    portfolioUrl: { primaryLinkUrl: p.portfolioUrl, primaryLinkLabel: "Portfolio" },
    ...(p.jobsBoardUrl ? { jobsBoardUrl: { primaryLinkUrl: p.jobsBoardUrl, primaryLinkLabel: "Jobs" } } : {}),
  });
  const id = created?.data?.createInvestorPortfolio?.id;
  if (id) portfolioIdByName.set(p.name, id);
}
console.log(`portfolios: ${PORTFOLIOS.length} programs in CRM`);

const pushRows = [
  ...db.prepare(`SELECT * FROM portfolio_companies WHERE program='yc' AND status='Active'`).all()
    .filter((r: any) => YC_BATCHES.includes((r.batch ?? "").toLowerCase())),
  ...db.prepare(`SELECT * FROM portfolio_companies WHERE program='a16z' AND status LIKE '%Active%'`).all(),
] as any[];

let pushed = 0, linked = 0;
const queue: { row: any; body: any }[] = [];
for (const r of pushRows) {
  const compKey = `crm:company:${r.name.toLowerCase()}`;
  const linkKey = `crm:link:${r.program}:${r.name.toLowerCase()}`;
  if (cacheGet(db, linkKey)) continue; // already pushed+linked
  const portfolioId = portfolioIdByName.get(r.program === "yc" ? "Y Combinator" : "Andreessen Horowitz (a16z)");
  if (!portfolioId) continue; // portfolio record missing — don't create unlinked companies
  const cachedId = cacheGet(db, compKey)?.id;
  if (cachedId) {
    // company already in CRM from another flow — just link it to the program
    const ok = await twenty("PATCH", `companies/${cachedId}`, { investorPortfolioId: portfolioId });
    if (ok) { cachePut(db, linkKey, "twenty", { id: cachedId }); linked++; }
    continue;
  }
  queue.push({
    row: r,
    body: {
      name: r.name, actor, signalSource: `portfolio:${r.program}`,
      fundingStage: r.program === "yc" ? "SEED" : "UNKNOWN",
      fundingNote: [r.program === "yc" ? `YC ${r.batch}` : `a16z${r.batch ? ` · ${r.batch}` : ""}`, r.one_liner].filter(Boolean).join(" · ").slice(0, 250),
      research: r.one_liner ?? "",
      ...(r.domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(r.domain)
        ? { domainName: { primaryLinkUrl: `https://${r.domain}` } } : {}),
      investorPortfolioId: portfolioId,
    },
  });
  if (queue.length >= PUSH_MAX) break;
}

const record = (item: { row: any }, id: string) => {
  cachePut(db, `crm:company:${item.row.name.toLowerCase()}`, "twenty", { id });
  cachePut(db, `crm:link:${item.row.program}:${item.row.name.toLowerCase()}`, "twenty", { id });
  pushed++;
};
for (let i = 0; i < queue.length; i += 40) {
  const chunk = queue.slice(i, i + 40);
  const created = await twenty("POST", "batch/companies", chunk.map((c) => c.body));
  const records: any[] = created?.data?.createCompanies ?? [];
  if (records.length) {
    for (const rec of records) {
      const item = chunk.find((c) => c.row.name === rec.name);
      if (item) record(item, rec.id);
    }
  } else {
    // whole batch rejected (one bad row is enough) — retry one by one so the rest land
    for (const item of chunk) {
      const one = await twenty("POST", "companies", item.body);
      const id = one?.data?.createCompany?.id;
      if (id) record(item, id);
      else console.error(`  skip ${item.row.name}: rejected individually`);
    }
  }
  console.log(`  pushed ${Math.min(i + 40, queue.length)}/${queue.length}`);
}

// ---------- 4. refresh counts + report ----------
for (const p of PORTFOLIOS) {
  const tracked = (db.prepare("SELECT count(*) n FROM portfolio_companies WHERE program = ?").get(p.slug) as any).n;
  const inCrm = (db.prepare("SELECT count(*) n FROM lookups WHERE key LIKE ?").get(`crm:link:${p.slug}:%`) as any).n;
  const id = portfolioIdByName.get(p.name);
  if (id && (tracked || inCrm)) await twenty("PATCH", `investorPortfolios/${id}`, { companiesTracked: tracked, companiesInCrm: inCrm });
}

let md = `# Investor portfolio companies\n\nGenerated ${new Date().toISOString().slice(0, 16)} by scripts/12-portfolios.mts.\nFull lists; the CRM holds the active/recent slice (see Investor Portfolios object).\n\n`;
for (const p of PORTFOLIOS) {
  const rows = db.prepare("SELECT * FROM portfolio_companies WHERE program = ? ORDER BY batch DESC, name").all(p.slug) as any[];
  if (!rows.length) continue;
  md += `\n## ${p.name} — ${rows.length} companies\n\n| company | batch/stage | status | site |\n|---|---|---|---|\n`;
  for (const r of rows) md += `| ${r.name} | ${r.batch ?? ""} | ${r.status ?? ""} | ${r.url ?? ""} |\n`;
}
writeFileSync("data/portfolio-companies.md", md);

console.log(`\nCRM: +${pushed} portfolio companies created, ${linked} existing linked. Full list: data/portfolio-companies.md`);
