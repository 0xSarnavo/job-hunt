// STEP 2 — LLM second pass with the FREE OpenCode model: judge every new
// rubric-passed job, store llm_score + llm_reason. No escalation to claude —
// this step must stay free. Selection = rubric >= 50 AND llm >= 50.
//
// Knobs:
const MODEL = "opencode/mimo-v2.5-free"; // see `opencode models` for options
const BATCH = 30;        // jobs per run (~10s each on the free tier)
const MIN_RUBRIC = 40;   // don't spend model time below this

import { z } from "zod";
import { openDb } from "../src/db.ts";
import { extract } from "../src/llm.ts";

process.chdir(new URL("..", import.meta.url).pathname);
try { process.loadEnvFile(".env"); } catch {}
process.env.LLM_LIGHT = `opencode run -m ${MODEL}`;

const Fit = z.object({
  score: z.number().min(0).max(100),
  reason: z.string().max(200),
});
const EXAMPLE = { score: 62, reason: "DevRel role at AI devtools startup, remote-global, asks 3y vs 2.5y — strong fit." };

const PROFILE = `Candidate: 2.5 years (stretch 3). Target roles: developer advocate/relations, GTM engineer, growth engineer, product/developer/ecosystem/growth marketing, marketing ops, developer experience. Domains: AI, devtools, infra (web3-devtools ok, consumer crypto NO). Location: remote-global > india-remote > bengaluru > kolkata; US/EU-restricted remote or other onsite = unsuitable. Dealbreakers: memecoin/gambling, equity-only, pure performance/content/lead-gen marketing, recruiter/sales roles.`;

const db = openDb();
const jobs = db.prepare(
  `SELECT url, company, title, location, description FROM jobs
   WHERE rejected IS NULL AND match_score >= ? AND llm_score IS NULL
   ORDER BY match_score DESC LIMIT ?`,
).all(MIN_RUBRIC, BATCH) as any[];
const upd = db.prepare("UPDATE jobs SET llm_score = ?, llm_reason = ? WHERE url = ?");

let done = 0, failed = 0;
for (const j of jobs) {
  try {
    const v = extract(Fit,
      `Score this job 0-100 for the candidate. Judge role fit, seniority vs experience, location eligibility, and domain.\n${PROFILE}`,
      `JOB: ${j.title} @ ${j.company} (${j.location})\n${(j.description ?? "").slice(0, 1800)}`,
      { tier: "light", retries: 2, escalate: false, db, example: EXAMPLE });
    upd.run(v.score, v.reason, j.url);
    done++;
  } catch {
    upd.run(-1, "llm failed", j.url); // -1 = tried and failed; retryable via: UPDATE jobs SET llm_score=NULL WHERE llm_score=-1
    failed++;
  }
}
console.log(`llm-scored ${done}, failed ${failed} (of ${jobs.length} pending)`);
const selected = db.prepare(
  "SELECT match_score r, llm_score l, company, title FROM jobs WHERE rejected IS NULL AND match_score >= 50 AND llm_score >= 50 ORDER BY llm_score DESC LIMIT 12",
).all() as any[];
console.log(`\nSELECTED (rubric>=50 AND llm>=50): ${selected.length ? "" : "none yet"}`);
for (const s of selected) console.log(`  r${s.r} l${s.l}  ${s.company} — ${s.title}`);
