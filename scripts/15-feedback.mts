// STEP 15 — pull YOUR verdicts from the CRM and make the pipeline learn.
//
// In the CRM you can:
//   - move an Opportunity to CLOSED and/or write its Feedback Note
//     ("agency spam", "too senior", "consulting shop", ...)
//   - write a Feedback Note on a Company ("staffing firm", "not my domain")
//
// This script pulls both and applies them:
//   - the job is hard-rejected in SQLite (never resurfaces, never re-synced)
//   - a company with feedback loses pitch status and is skipped by 5-people
//   - recent reasons are quoted to the judge (2-llm-score) so similar roles
//     score lower from now on
//
// Runs before the judge in run-daily.sh so each day's scoring already knows
// yesterday's verdicts.

import { openDb } from "../src/db.ts";
import { loadEnv } from "../src/env.ts";

process.chdir(new URL("..", import.meta.url).pathname);
loadEnv();
const db = openDb();

const U = process.env.TWENTY_URL, K = process.env.TWENTY_API_KEY;
if (!U || !K) { console.log("no CRM configured — nothing to pull"); process.exit(0); }
const twenty = async (path: string) => {
  await new Promise((r) => setTimeout(r, 700));
  try {
    const res = await fetch(`${U}/rest/${path}`, {
      headers: { Authorization: `Bearer ${K}` }, signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? res.json() : (console.error(`twenty GET ${path}: ${res.status}`), null);
  } catch (err) { console.error(`twenty GET ${path}: ${String(err).slice(0, 100)}`); return null; }
};

const put = db.prepare(`
  INSERT INTO feedback (kind, ref, company, title, reason)
  VALUES (@kind, @ref, @company, @title, @reason)
  ON CONFLICT(kind, ref) DO UPDATE SET reason=excluded.reason, at=datetime('now')`);

// --- opportunities: CLOSED stage or a Feedback Note ---
let opps: any[] = [];
for (const filter of ["stage[eq]:CLOSED", "feedbackNote[is]:NOT_NULL"]) {
  const page = (await twenty(`opportunities?filter=${encodeURIComponent(filter)}&limit=200`))?.data?.opportunities ?? [];
  opps.push(...page);
}
const seen = new Set<string>();
let oppN = 0, jobN = 0;
for (const o of opps) {
  if (!o.jobUrl || seen.has(o.jobUrl)) continue;
  seen.add(o.jobUrl);
  const reason = (o.feedbackNote || "").trim() || "closed without reason";
  put.run({ kind: "opportunity", ref: o.jobUrl, company: o.name?.split("—")[0]?.trim() ?? null, title: o.jobTitle ?? null, reason });
  const r = db.prepare("UPDATE jobs SET rejected = ? WHERE url = ? AND (rejected IS NULL OR rejected LIKE 'user:%')")
    .run(`user: ${reason}`.slice(0, 120), o.jobUrl);
  oppN++; jobN += r.changes;
}

// --- companies with a Feedback Note ---
const comps = (await twenty(`companies?filter=${encodeURIComponent("feedbackNote[is]:NOT_NULL")}&limit=200`))?.data?.companies ?? [];
let compN = 0;
for (const c of comps) {
  const reason = (c.feedbackNote || "").trim();
  if (!reason) continue;
  put.run({ kind: "company", ref: c.name, company: c.name, title: null, reason });
  db.prepare("UPDATE companies SET pitch = 0 WHERE lower(name) = lower(?)").run(c.name);
  db.prepare("UPDATE jobs SET rejected = ? WHERE lower(company) = lower(?) AND rejected IS NULL")
    .run(`user: ${reason}`.slice(0, 120), c.name);
  compN++;
}

const total = (db.prepare("SELECT count(*) n FROM feedback").get() as any).n;
console.log(`feedback pulled: ${oppN} opportunities (${jobN} jobs hard-rejected), ${compN} companies. ${total} verdicts on file — the judge quotes the recent ones.`);
