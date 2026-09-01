import type Database from "better-sqlite3";
import { score } from "./score.ts";
import type { Posting, Profile } from "./types.ts";

// Shared ingestion: score → dedupe → store. Used by the CLI and by every
// per-source daily script in scripts/fetch/. INSERT OR IGNORE on the url PK
// makes every run incremental — old data is skipped, only new rows count.

export interface IngestResult {
  fetched: number;
  added: number;
  rejected: number;
  newestAdded?: string;
}

export function ingest(db: Database.Database, postings: Posting[], profile: Profile): IngestResult {
  const insertJob = db.prepare(
    `INSERT INTO jobs (url, company, title, location, posted_at, source, description, exp_required, match_score, matched_at, rejected)
     VALUES (@url, @company, @title, @location, @posted_at, @source, @description, @exp, @score, datetime('now'), @reject)
     ON CONFLICT(url) DO NOTHING`,
  );
  const insertCompany = db.prepare(
    `INSERT INTO companies (domain, name, source) VALUES (?, ?, ?) ON CONFLICT(domain) DO NOTHING`,
  );
  const dupCheck = db.prepare("SELECT 1 FROM jobs WHERE lower(company) = ? AND lower(title) = ? LIMIT 1");
  let added = 0, rejected = 0;
  let newestAdded: string | undefined;
  const seen = new Set<string>(); // cross-source dedupe within a run: company+title
  for (const p of postings) {
    const dedupeKey = `${p.company}::${p.title}`.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    // cross-RUN dedupe: same role already stored under a different URL/board
    if (dupCheck.get(p.company.toLowerCase(), p.title.toLowerCase())) continue;
    const v = score(p, profile);
    const res = insertJob.run({
      url: p.url, company: p.company, title: p.title, location: p.location ?? "",
      posted_at: p.posted_at ?? null, source: p.source,
      description: (p.description ?? "").slice(0, 4000),
      exp: v.expRequired, score: v.score, reject: v.reject,
    });
    if (res.changes > 0) {
      added++;
      if (v.reject) rejected++;
      else insertCompany.run(p.company.toLowerCase().replace(/[^a-z0-9]/g, ""), p.company, p.source);
      if (p.posted_at && (!newestAdded || p.posted_at > newestAdded)) newestAdded = p.posted_at;
    }
  }
  return { fetched: postings.length, added, rejected, newestAdded };
}

export function reportRun(db: Database.Database, source: string, r: IngestResult): void {
  db.prepare("INSERT OR REPLACE INTO lookups (key, provider, result, cost) VALUES (?, 'fetch-run', ?, 0)")
    .run(`lastrun:${source}`, JSON.stringify({ at: new Date().toISOString(), ...r }));
  console.log(
    `${source.padEnd(16)} fetched ${String(r.fetched).padStart(4)}  new ${String(r.added).padStart(4)}` +
    `  rejected ${String(r.rejected).padStart(3)}${r.newestAdded ? `  newest ${r.newestAdded.slice(0, 10)}` : ""}`,
  );
}
