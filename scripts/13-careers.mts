// STEP 13 — careers cross-check for portfolio companies.
//
// For companies that reached the CRM via an investor program (step 12), check
// their careers page: which ATS do they use, and are any LIVE roles a match?
//   resolve (4-rung ladder, cached) → fetch board → ingest+score → CRM sync.
// Side effects per company:
//   - CRM Company.ats set (Greenhouse/Lever/.../None found)
//   - discovered boards become Job Portal records (kind = Company Board) — a
//     personal, growing list of boards worth rechecking
//   - matching roles land as Opportunities via the normal sync
//
// Knobs:
const PER_RUN = Number(process.env.CAREERS_PER_RUN ?? 10); // resolver fetches cost time, not money

import { openDb } from "../src/db.ts";
import { resolve } from "../src/resolver.ts";
import { fetchBoard, type AtsKind } from "../src/sources/ats.ts";
import { ingest } from "../src/ingest.ts";
import { loadProfile } from "../src/profile.ts";
import { syncToCrm } from "../src/sync.ts";
import { cacheGet, cachePut } from "../src/enrich.ts";
import { notePending } from "../src/notes.ts";

process.chdir(new URL("..", import.meta.url).pathname);
try { process.loadEnvFile(".env"); } catch {}
const actor = process.env.JOBHUNT_ACTOR || "cron";
const db = openDb();
const profile = loadProfile();

const U = process.env.TWENTY_URL, K = process.env.TWENTY_API_KEY;
const twenty = async (method: string, path: string, body?: unknown) => {
  if (!U || !K) return null;
  await new Promise((r) => setTimeout(r, 700));
  const res = await fetch(`${U}/rest/${path}`, {
    method, headers: { Authorization: `Bearer ${K}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok ? res.json() : (console.error(`twenty ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`), null);
};

const BOARD_URL: Record<AtsKind, (t: string) => string> = {
  greenhouse: (t) => `https://boards.greenhouse.io/${t}`,
  lever: (t) => `https://jobs.lever.co/${t}`,
  ashby: (t) => `https://jobs.ashbyhq.com/${t}`,
  workable: (t) => `https://apply.workable.com/${t}`,
  smartrecruiters: (t) => `https://careers.smartrecruiters.com/${t}`,
};
const BIG5 = new Set(Object.keys(BOARD_URL));

// CRM-pushed portfolio companies, geography-fit first, never rechecked twice.
const rows = db.prepare(`
  SELECT * FROM portfolio_companies pc
  WHERE pc.domain IS NOT NULL
    AND EXISTS (SELECT 1 FROM lookups WHERE key = 'crm:link:' || pc.program || ':' || lower(pc.name))
    AND NOT EXISTS (SELECT 1 FROM lookups WHERE key = 'careers-check:' || pc.domain)
  ORDER BY CASE pc.program WHEN 'blr-map' THEN 0 WHEN 'yc' THEN 1 WHEN 'a16z' THEN 2 ELSE 3 END, pc.first_seen DESC
  LIMIT ?`).all(PER_RUN) as any[];

console.log(`careers-checking ${rows.length} companies: ${rows.map((r) => r.name).join(", ")}`);

let boards = 0, roles = 0, matches = 0;
for (const c of rows) {
  let r;
  try { r = await resolve(c.name, c.domain, db); }
  catch (err) { console.log(`  ${c.name}: resolver failed (${String(err).slice(0, 80)}) — will retry next run`); continue; }
  cachePut(db, `careers-check:${c.domain}`, "careers", { ats: r.ats, token: r.token ?? null, rung: r.rung });

  // reflect the ATS on the CRM company card
  const companyId = cacheGet(db, `crm:company:${c.name.toLowerCase()}`)?.id;
  if (companyId) await twenty("PATCH", `companies/${companyId}`, { ats: r.ats.toUpperCase() });

  if (!r.token || !BIG5.has(r.ats)) { console.log(`  ${c.name}: ${r.ats}${r.detail ? ` (${r.detail})` : ""}`); continue; }
  boards++;

  let postings: Awaited<ReturnType<typeof fetchBoard>> = [];
  try { postings = await fetchBoard(r.ats as AtsKind, r.token, c.name); } catch {}
  const res = ingest(db, postings, profile);
  const best = db.prepare(
    `SELECT count(*) n FROM jobs WHERE lower(company)=lower(?) AND rejected IS NULL AND match_score >= 50`,
  ).get(c.name) as any;
  roles += postings.length; matches += best.n;
  console.log(`  ${c.name}: ${r.ats}/${r.token} — ${postings.length} live roles, ${best.n} match (${res.added} new)`);

  // the discovered board becomes a personal Job Portal record (once)
  const portalKey = `crm:portal:company:${c.domain}`;
  if (!cacheGet(db, portalKey)) {
    const created = await twenty("POST", "jobPortals", {
      name: `${c.name} board`, kind: "COMPANY_BOARD", status: "ACTIVE",
      sourceSlug: `company:${c.domain}`, actor,
      whatItGives: `auto-discovered via ${c.program} careers check`,
      jobsIngested: postings.length,
      portalUrl: { primaryLinkUrl: BOARD_URL[r.ats as AtsKind](r.token), primaryLinkLabel: `${c.name} jobs` },
    });
    const id = created?.data?.createJobPortal?.id;
    if (id) cachePut(db, portalKey, "twenty", { id });
  }
}

// matched roles → Opportunities (same path as the daily sync)
const { pushed } = await syncToCrm(db);
console.log(`\n${boards} boards found · ${roles} live roles scanned · ${matches} total matches · ${pushed} new opportunities pushed`);

const remaining = (db.prepare(`
  SELECT count(*) n FROM portfolio_companies pc WHERE pc.domain IS NOT NULL
    AND EXISTS (SELECT 1 FROM lookups WHERE key = 'crm:link:' || pc.program || ':' || lower(pc.name))
    AND NOT EXISTS (SELECT 1 FROM lookups WHERE key = 'careers-check:' || pc.domain)`).get() as any).n;
notePending("13-careers", [
  `${remaining} portfolio companies not yet careers-checked (cap CAREERS_PER_RUN=${PER_RUN} per run — resolver rung 3 uses the TinyFish fetch quota, 1,000/day free)`,
  `this run: ${rows.length} checked, ${boards} boards found, ${matches} matching roles, ${pushed} opportunities pushed`,
  remaining > 0 ? "continues automatically on the next run-daily.sh (or run: npx tsx scripts/13-careers.mts)" : "backlog clear",
]);
