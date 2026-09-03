// STEP 12 — the investor-program directory.
//
// 1. Seeds "Job Portal" + "Investor Portfolio" records in Twenty from
//    src/registry.ts (idempotent — upserts by slug/name).
// 2. Scrapes member-company lists: YC via the yc-oss directory mirror,
//    a16z via the JSON embedded in a16z.com/portfolio. FULL lists land in the
//    local portfolio_companies table.
// 3. Pushes the relevant slice to CRM Companies (batch API, linked to their
//    Investor Portfolio record): YC = active companies from PORTFOLIO_YC_SINCE (default 2021) onward,
//    a16z = active portfolio.
// 4. Refreshes counts on portal/portfolio records and writes
//    data/portfolio-companies.md — the full human-readable list.
//
// Knobs:
const YC_SINCE = Number(process.env.PORTFOLIO_YC_SINCE ?? 2021); // active YC companies from this batch year onward
const PUSH_MAX = Number(process.env.PORTFOLIO_PUSH_MAX ?? 500); // new CRM companies per run (resumes next run)

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { openDb } from "../src/db.ts";
import { extract } from "../src/llm.ts";
import { PORTALS, PORTFOLIOS } from "../src/registry.ts";
import { cacheGet, cachePut } from "../src/enrich.ts";
import { notePending } from "../src/notes.ts";

process.chdir(new URL("..", import.meta.url).pathname);
import { loadEnv } from "../src/env.ts";
loadEnv();
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
  // existing records: refresh the counter only — status/kind/URL may have been
  // edited in the CRM and user edits win
  if (id) await twenty("PATCH", `jobPortals/${id}`, { jobsIngested: jobs });
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

// Bangalore Startup Map — 880+ startups AND ~70 VC firms embedded as JSON in
// the Next.js flight payload of the homepage. Startups become portfolio
// companies; the VC firms become Investor Portfolio records (coffee-meeting
// targets — the map has their office area).
let blrVcs: any[] = [];
try {
  const res = await fetch("https://www.bangalorestartupmap.com/", {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    signal: AbortSignal.timeout(60_000),
  });
  const html = await res.text();
  // payload lives inside self.__next_f.push([1,"..."]) string literals — unescape them
  let flight = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g))
    flight += JSON.parse(m[1]!);
  const key = '"startups":[';
  const start = flight.indexOf(key);
  if (start === -1) throw new Error("startups payload not found — page layout changed");
  let depth = 0, close = -1, inStr = false;
  for (let i = start + key.length - 1; i < flight.length; i++) {
    const ch = flight[i];
    if (inStr) { if (ch === "\\") i++; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") { depth--; if (depth === 0) { close = i; break; } }
  }
  const entries = JSON.parse(flight.slice(start + key.length - 1, close + 1)) as any[];
  const startups = entries.filter((e) => e.kind === "startup" && e.name);
  blrVcs = entries.filter((e) => e.kind === "vc" && e.name);
  const tx = db.transaction((rows: any[]) => { for (const r of rows) upsert.run(r); });
  tx(startups.map((c) => ({
    program: "blr-map", name: c.name, domain: domainOf(c.website),
    batch: c.stage || null, status: "Active", url: c.website || null,
    one_liner: [c.sector, c.tagline?.slice(0, 150), c.area].filter(Boolean).join(" · ") || null,
  })));
  console.log(`blr-map: ${startups.length} startups (of ${entries.length} entries)`);
} catch (err) { console.error(`blr-map scrape failed: ${String(err).slice(0, 150)}`); }

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

// Bengaluru VC firms from the map → Investor Portfolio records (created once).
const portfolioByName = new Map(portfolioRecords.map((p: any) => [p.name, p]));
let vcAdded = 0;
for (const v of blrVcs) {
  if (portfolioByName.has(v.name) || cacheGet(db, `crm:blrvc:${v.name.toLowerCase()}`)) continue;
  const created = await twenty("POST", "investorPortfolios", {
    name: v.name, kind: "VC", scrapeStatus: "PLANNED", actor,
    notes: [`Bengaluru (${v.area ?? "?"})`, v.tagline, v.hsr_location].filter(Boolean).join(" · ").slice(0, 250),
    ...(v.website ? { portfolioUrl: { primaryLinkUrl: v.website, primaryLinkLabel: "Site" } } : {}),
  });
  const id = created?.data?.createInvestorPortfolio?.id;
  if (id) { cachePut(db, `crm:blrvc:${v.name.toLowerCase()}`, "twenty", { id }); vcAdded++; }
}
if (blrVcs.length) console.log(`blr-map VCs: ${vcAdded} new Investor Portfolio records (of ${blrVcs.length} on the map)`);

// ---------- 3b. portfolios YOU added in the CRM ----------
// A record with no `actor` was created by hand in the CRM (every pipeline write
// stamps actor): its Portfolio URL is fetched and companies extracted with the
// free model (best effort — clean directory pages work, heavy JS apps won't).
const registryNames = new Set(PORTFOLIOS.map((p) => p.name));
const userPortfolios: { name: string; url: string; slug: string }[] = portfolioRecords
  .filter((p: any) => !p.actor && !registryNames.has(p.name) && p.portfolioUrl?.primaryLinkUrl)
  .map((p: any) => ({ name: p.name as string, url: p.portfolioUrl.primaryLinkUrl as string,
                      slug: "crm-" + p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") }));
const DirCompanies = z.object({
  companies: z.array(z.object({ name: z.string(), website: z.string().nullable() })).max(40),
});
for (const up of userPortfolios) {
  let text = "";
  try {
    const res = await fetch(up.url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(45_000) });
    text = (await res.text()).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  } catch {}
  if (text.length < 500) {
    // JS-heavy page — one rendered fetch via TinyFish (free tier)
    try {
      const out = execFileSync("tinyfish", ["fetch", "content", "get", "--format", "markdown", up.url],
        { encoding: "utf8", timeout: 90_000, maxBuffer: 20_000_000 });
      text = JSON.parse(out)?.results?.[0]?.text ?? "";
    } catch {}
  }
  if (text.length < 500) { console.log(`${up.name}: page unreadable — skipped (try a more specific Portfolio URL)`); continue; }
  try {
    const parsed = extract(DirCompanies,
      `This is a VC/accelerator portfolio or startup directory page. Extract the listed COMPANIES (not the VC itself, not nav items): name + website URL when shown.`,
      text.slice(0, 9000),
      { tier: "light", retries: 2, escalate: false, db, example: { companies: [{ name: "Acme AI", website: "https://acme.ai" }] } });
    const tx = db.transaction((rows: any[]) => { for (const r of rows) upsert.run(r); });
    tx(parsed.companies.map((c) => ({
      program: up.slug, name: c.name, domain: domainOf(c.website),
      batch: null, status: "Active", url: c.website ?? null, one_liner: null,
    })));
    console.log(`${up.name} (CRM-added): ${parsed.companies.length} companies extracted`);
  } catch { console.log(`${up.name}: extraction failed — will retry next run`); }
}

const pushRows = [
  // user-added portfolios: everything extracted that has a domain
  ...(userPortfolios.length
    ? db.prepare(`SELECT * FROM portfolio_companies WHERE program IN (${userPortfolios.map(() => "?").join(",")}) AND domain IS NOT NULL`)
        .all(...userPortfolios.map((u) => u.slug))
    : []),
  ...db.prepare(`SELECT * FROM portfolio_companies WHERE program='yc' AND status='Active'
                 AND CAST(substr(batch,-4) AS INT) >= ?`).all(YC_SINCE),
  ...db.prepare(`SELECT * FROM portfolio_companies WHERE program='a16z' AND status LIKE '%Active%'`).all(),
  // Bangalore map: early-stage only (founder still reachable), needs a website
  ...db.prepare(`SELECT * FROM portfolio_companies WHERE program='blr-map'
                 AND lower(batch) IN ('pre-seed','seed','series a') AND domain IS NOT NULL`).all(),
] as any[];

const portfolioNameBySlug = new Map<string, string>([
  ...PORTFOLIOS.map((p) => [p.slug, p.name] as [string, string]),
  ...userPortfolios.map((u) => [u.slug, u.name] as [string, string]),
]);
const STAGE_MAP: Record<string, string> = {
  "pre-seed": "PRE_SEED", seed: "SEED", "series a": "SERIES_A",
  "series b": "SERIES_B", "series c": "SERIES_C_PLUS",
};
const stageOf = (r: any) =>
  r.program === "yc" ? "SEED" : STAGE_MAP[(r.batch ?? "").toLowerCase()] ?? "UNKNOWN";

let pushed = 0, linked = 0;
const queue: { row: any; body: any }[] = [];
for (const r of pushRows) {
  const compKey = `crm:company:${r.name.toLowerCase()}`;
  const linkKey = `crm:link:${r.program}:${r.name.toLowerCase()}`;
  if (cacheGet(db, linkKey)) continue; // already pushed+linked
  const portfolioId = portfolioIdByName.get(portfolioNameBySlug.get(r.program) ?? "");
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
      fundingStage: stageOf(r),
      fundingNote: [`${portfolioNameBySlug.get(r.program) ?? r.program}${r.batch ? ` · ${r.batch}` : ""}`, r.one_liner].filter(Boolean).join(" · ").slice(0, 250),
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
      if (id) { record(item, id); continue; }
      // duplicate name → the company already exists via another source: link it instead
      const existing = await twenty("GET",
        `companies?filter=${encodeURIComponent(`name[eq]:"${item.row.name.replaceAll('"', "")}"`)}&limit=1`);
      const dupId = existing?.data?.companies?.[0]?.id;
      if (dupId) {
        const ok = await twenty("PATCH", `companies/${dupId}`, { investorPortfolioId: item.body.investorPortfolioId });
        if (ok) { record(item, dupId); console.log(`  linked existing record for ${item.row.name}`); continue; }
      }
      console.error(`  skip ${item.row.name}: rejected individually`);
    }
  }
  console.log(`  pushed ${Math.min(i + 40, queue.length)}/${queue.length}`);
}

// ---------- 4. refresh counts + report ----------
const allPrograms = [...PORTFOLIOS.map((p) => ({ slug: p.slug, name: p.name })), ...userPortfolios];
for (const p of allPrograms) {
  const tracked = (db.prepare("SELECT count(*) n FROM portfolio_companies WHERE program = ?").get(p.slug) as any).n;
  const inCrm = (db.prepare("SELECT count(*) n FROM lookups WHERE key LIKE ?").get(`crm:link:${p.slug}:%`) as any).n;
  const id = portfolioIdByName.get(p.name);
  if (id && (tracked || inCrm)) await twenty("PATCH", `investorPortfolios/${id}`, { companiesTracked: tracked, companiesInCrm: inCrm });
}

let md = `# Investor portfolio companies\n\nGenerated ${new Date().toISOString().slice(0, 16)} by scripts/12-portfolios.mts.\nFull lists; the CRM holds the active/recent slice (see Investor Portfolios object).\n\n`;
for (const p of allPrograms) {
  const rows = db.prepare("SELECT * FROM portfolio_companies WHERE program = ? ORDER BY batch DESC, name").all(p.slug) as any[];
  if (!rows.length) continue;
  md += `\n## ${p.name} — ${rows.length} companies\n\n| company | batch/stage | status | site |\n|---|---|---|---|\n`;
  for (const r of rows) md += `| ${r.name} | ${r.batch ?? ""} | ${r.status ?? ""} | ${r.url ?? ""} |\n`;
}
writeFileSync("data/portfolio-companies.md", md);

console.log(`\nCRM: +${pushed} portfolio companies created, ${linked} existing linked. Full list: data/portfolio-companies.md`);

const unpushed = pushRows.filter((r) => !cacheGet(db, `crm:link:${r.program}:${r.name.toLowerCase()}`)).length;
notePending("12-portfolios", [
  `${unpushed} qualifying portfolio companies not yet in the CRM (cap PORTFOLIO_PUSH_MAX=${PUSH_MAX} per run; Twenty rate limit 100 req/min)`,
  `this run: +${pushed} created, ${linked} linked; tracked totals — ${allPrograms.map((p) => `${p.slug}:${(db.prepare("SELECT count(*) n FROM portfolio_companies WHERE program=?").get(p.slug) as any).n}`).join(", ")}`,
  unpushed > 0 ? "continues automatically on the next run" : "backlog clear",
]);
