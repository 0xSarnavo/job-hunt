import type Database from "better-sqlite3";
import { track } from "./usage.ts";

// One-way sync: SQLite (system of record) → Twenty (viewing layer).
// Matched jobs become opportunities on the QUEUED→CLOSED kanban with their
// match score. Idempotent via `lookups` keys — a job is pushed exactly once.

const MIN_SCORE = 50;

async function twenty(path: string, method: string, body?: unknown): Promise<any | null> {
  const url = process.env.TWENTY_URL, key = process.env.TWENTY_API_KEY;
  if (!url || !key) return null;
  await new Promise((r) => setTimeout(r, 700)); // Twenty limit: 100 req/min
  track("twenty-api");
  const res = await fetch(`${url}/rest/${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.error(`twenty ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  return res.json();
}

export async function syncToCrm(db: Database.Database): Promise<{ pushed: number; skipped: number }> {
  const actor = process.env.JOBHUNT_ACTOR || "unknown";
  const jobs = db.prepare(
    `SELECT url, company, title, location, posted_at, exp_required, llm_score, llm_reason, match_score, source FROM jobs
     WHERE rejected IS NULL AND match_score >= ?
       AND (llm_score IS NULL OR llm_score >= 50)  -- free-model judge gets a veto once it has judged
     ORDER BY match_score DESC`,
  ).all(MIN_SCORE) as any[];

  const cached = new Set(
    (db.prepare("SELECT key FROM lookups WHERE key LIKE 'crm:%'").all() as any[]).map((r) => r.key),
  );
  const companyIds = new Map<string, string>();
  let pushed = 0, skipped = 0;

  // Cards pushed before the judge ran have no LLM Score — backfill it once so
  // sorting/filtering by LLM Score covers every card.
  const judged = db.prepare(
    `SELECT url, llm_score, llm_reason FROM jobs
     WHERE llm_score IS NOT NULL AND llm_score >= 0
       AND EXISTS (SELECT 1 FROM lookups WHERE key = 'crm:opp:' || url)
       AND NOT EXISTS (SELECT 1 FROM lookups WHERE key = 'crm:oppscore:' || url)`,
  ).all() as any[];
  for (const j of judged) {
    const id = JSON.parse((db.prepare("SELECT result FROM lookups WHERE key = ?").get(`crm:opp:${j.url}`) as any).result).id;
    const ok = await twenty(`opportunities/${id}`, "PATCH", {
      llmScore: Math.round(j.llm_score), llmReason: (j.llm_reason ?? "").slice(0, 250),
    });
    if (ok) db.prepare("INSERT OR REPLACE INTO lookups (key, provider, result, cost) VALUES (?, 'twenty', '{}', 0)")
      .run(`crm:oppscore:${j.url}`);
  }
  if (judged.length) console.log(`backfilled LLM scores on ${judged.length} existing cards`);

  for (const j of jobs) {
    const jobKey = `crm:opp:${j.url}`;
    if (cached.has(jobKey)) { skipped++; continue; }

    let companyId = companyIds.get(j.company);
    if (!companyId) {
      const compKey = `crm:company:${j.company.toLowerCase()}`;
      const hit = db.prepare("SELECT result FROM lookups WHERE key = ?").get(compKey) as any;
      if (hit) companyId = JSON.parse(hit.result).id;
      else {
        const created = await twenty("companies", "POST", {
          name: j.company, actor, signalSource: j.source,
        });
        companyId = created?.data?.createCompany?.id;
        if (companyId)
          db.prepare("INSERT OR REPLACE INTO lookups (key, provider, result, cost) VALUES (?, 'twenty', ?, 0)")
            .run(compKey, JSON.stringify({ id: companyId }));
      }
      if (companyId) companyIds.set(j.company, companyId);
    }

    const opp = await twenty("opportunities", "POST", {
      name: `${j.company} — ${j.title}`.slice(0, 250),
      stage: "QUEUED",
      matchScore: Math.round(j.match_score),
      jobTitle: j.title.slice(0, 250),
      jobUrl: j.url,
      applyLink: { primaryLinkUrl: j.url, primaryLinkLabel: "Apply" },
      ...(j.posted_at ? { postedAt: new Date(j.posted_at).toISOString() } : {}),
      ...(j.exp_required > 3.5 ? { expAsk: `asks ${j.exp_required}y (above profile stretch)` } : {}),
      ...(j.llm_score != null && j.llm_score >= 0
        ? { llmScore: Math.round(j.llm_score), llmReason: (j.llm_reason ?? "").slice(0, 250) }
        : {}),
      actor,
      ...(companyId ? { companyId } : {}),
    });
    const oppId = opp?.data?.createOpportunity?.id;
    if (oppId) {
      db.prepare("INSERT OR REPLACE INTO lookups (key, provider, result, cost) VALUES (?, 'twenty', ?, 0)")
        .run(jobKey, JSON.stringify({ id: oppId }));
      pushed++;
    }
  }
  return { pushed, skipped };
}
