import { Command } from "commander";
import { loadProfile } from "./profile.ts";
import { openDb } from "./db.ts";
import { ingest, reportRun } from "./ingest.ts";
import { score } from "./score.ts";
import { resolve } from "./resolver.ts";
import { fetchBoard, type AtsKind } from "./sources/ats.ts";
import { remotive, remoteok, arbeitnow, weworkremotely, hnWhoIsHiring } from "./sources/feeds.ts";
import { adzuna, jooble } from "./sources/apis.ts";
import { syncToCrm } from "./sync.ts";
import type { JobSource } from "./sources/source.ts";
import type { Posting } from "./types.ts";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env yet — keyless sources still work
}

const SOURCES: JobSource[] = [remotive, remoteok, arbeitnow, weworkremotely, hnWhoIsHiring, adzuna, jooble];

const program = new Command("jobhunt");
const todo = (verb: string) => () => console.log(`${verb}: not implemented yet (see docs/TOOLING.md build order)`);

program
  .command("signal")
  .description("pull new postings from all sources, score, and store")
  .action(async () => {
    const profile = loadProfile();
    const db = openDb();
    for (const src of SOURCES) {
      try {
        const postings = await src.fetchPostings(profile);
        reportRun(db, src.name, ingest(db, postings, profile));
      } catch (err) {
        console.error(`${src.name}: FAILED ${String(err).slice(0, 120)}`);
      }
    }
    const top = db.prepare(
      "SELECT match_score s, company, title FROM jobs WHERE rejected IS NULL ORDER BY match_score DESC LIMIT 10",
    ).all() as any[];
    console.log("\ntop matches:");
    for (const t of top) console.log(`  ${String(t.s).padStart(3)}  ${t.company} — ${t.title}`);
  });

program
  .command("resolve <company> [domain]")
  .description("detect which ATS a company uses and list its live matching roles")
  .action(async (company: string, domain?: string) => {
    const profile = loadProfile();
    const db = openDb();
    const r = await resolve(company, domain, db);
    console.log(`${company}: ats=${r.ats}${r.token ? ` token=${r.token}` : ""} (rung ${r.rung}${r.detail ? `, ${r.detail}` : ""})`);
    if (r.token && r.ats !== "other" && r.ats !== "none_found") {
      const postings = await fetchBoard(r.ats as AtsKind, r.token, company);
      console.log(`${postings.length} live roles:`);
      for (const p of postings) {
        const v = score(p, profile);
        if (!v.reject && v.score >= 30) console.log(`  ${String(v.score).padStart(3)}  ${p.title}  (${p.location || "?"})`);
      }
      ingest(db, postings, profile);
    }
  });

program
  .command("match")
  .description("re-score all stored jobs against the current profile.yaml")
  .action(() => {
    const profile = loadProfile();
    const db = openDb();
    const rows = db.prepare("SELECT url, company, title, location, posted_at, source, description FROM jobs").all() as any[];
    const upd = db.prepare("UPDATE jobs SET match_score = ?, rejected = ?, exp_required = ?, matched_at = datetime('now') WHERE url = ?");
    for (const r of rows) {
      const v = score({ ...r, description: r.description ?? "" }, profile);
      upd.run(v.score, v.reject, v.expRequired, r.url);
    }
    console.log(`re-scored ${rows.length} jobs`);
  });

program
  .command("sync")
  .description("push matched jobs (score ≥ 50) into Twenty CRM as QUEUED opportunities")
  .action(async () => {
    const db = openDb();
    const { pushed, skipped } = await syncToCrm(db);
    console.log(`crm sync: ${pushed} new opportunities, ${skipped} already synced`);
  });

program
  .command("status")
  .description("pipeline counts")
  .action(() => {
    const db = openDb();
    for (const t of ["companies", "jobs", "people", "touches", "applications", "lookups"]) {
      const { n } = db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number };
      console.log(`${t}: ${n}`);
    }
    const { alive } = db.prepare("SELECT count(*) alive FROM jobs WHERE rejected IS NULL AND match_score >= 50").get() as any;
    console.log(`jobs with score ≥ 50: ${alive}`);
    const rejects = db.prepare(
      "SELECT rejected, count(*) n FROM jobs WHERE rejected IS NOT NULL GROUP BY rejected ORDER BY n DESC",
    ).all() as any[];
    for (const r of rejects) console.log(`  rejected(${r.rejected}): ${r.n}`);
  });

program.command("people").description("find contacts for matched companies").action(todo("people"));
program.command("enrich").description("run the email waterfall").action(todo("enrich"));
program.command("queue").description("print the LinkedIn connect queue").action(todo("queue"));
program.command("poll").description("diff connections list for acceptances").action(todo("poll"));
program.command("draft").description("create Gmail drafts for warm/cold touches").action(todo("draft"));

program.parse();
