// EVAL — measure a free OpenCode model's judging quality on stored jobs, so
// model/prompt changes are decisions, not vibes. No fetching; reuses the DB.
//
//   npx tsx scripts/eval-llm.mts                      # default model, 12 jobs
//   npx tsx scripts/eval-llm.mts opencode/ling-3.0-flash-fin-free 20
//
// Reports: valid-output rate, mean |llm − rubric| on alive jobs, and how often
// the model agrees with rubric keep/drop at the 50 bar. Compare models by
// running this once per model. NOTE: bypasses the cache so each model answers fresh.

import { z } from "zod";
import { openDb } from "../src/db.ts";
import { loadProfile, profileBrief } from "../src/profile.ts";
import { extract } from "../src/llm.ts";

const MODEL = process.argv[2] ?? "opencode/mimo-v2.5-free";
const N = Number(process.argv[3] ?? 12);

process.chdir(new URL("..", import.meta.url).pathname);
try { process.loadEnvFile(".env"); } catch {}
process.env.LLM_LIGHT ??= `opencode run -m ${MODEL}`; // default only — your .env LLM_LIGHT wins

const Fit = z.object({ score: z.number().min(0).max(100), reason: z.string().max(200) });
const EXAMPLE = { score: 62, reason: "DevRel at AI devtools, remote-global, 3y ask vs 2.5y." };
const PROFILE = profileBrief(loadProfile());

const db = openDb();
// stratified: 1/3 high, 1/3 mid, 1/3 low-or-rejected
const third = Math.ceil(N / 3);
const sample = [
  ...db.prepare("SELECT * FROM jobs WHERE rejected IS NULL AND match_score >= 60 AND length(description) > 300 ORDER BY RANDOM() LIMIT ?").all(third),
  ...db.prepare("SELECT * FROM jobs WHERE rejected IS NULL AND match_score BETWEEN 35 AND 59 AND length(description) > 300 ORDER BY RANDOM() LIMIT ?").all(third),
  ...db.prepare("SELECT * FROM jobs WHERE (rejected IS NOT NULL OR match_score < 35) AND length(description) > 300 ORDER BY RANDOM() LIMIT ?").all(third),
] as any[];

let valid = 0, absErr = 0, agree = 0, aliveCount = 0;
const t0 = Date.now();
for (const j of sample) {
  let v;
  try {
    v = extract(Fit,
      `Score this job 0-100 for the candidate. Judge role fit, seniority vs experience, location eligibility, and domain.\n${PROFILE}`,
      `JOB: ${j.title} @ ${j.company} (${j.location})\n${(j.description ?? "").slice(0, 1800)}`,
      { tier: "light", retries: 1, escalate: false, example: EXAMPLE }); // no db → no cache
  } catch { console.log(`  FAIL  ${j.company} — ${j.title}`); continue; }
  valid++;
  const rubric = j.rejected ? 0 : j.match_score;
  if (!j.rejected) { absErr += Math.abs(v.score - rubric); aliveCount++; }
  const bothKeep = v.score >= 50 && !j.rejected && j.match_score >= 50;
  const bothDrop = v.score < 50 && (j.rejected || j.match_score < 50);
  if (bothKeep || bothDrop) agree++;
  console.log(`  llm:${String(v.score).padStart(3)} rubric:${String(rubric).padStart(3)}${j.rejected ? `(${j.rejected})` : ""}  ${j.company} — ${j.title.slice(0, 50)}`);
}
console.log(`\nmodel: ${MODEL}`);
console.log(`valid output: ${valid}/${sample.length} (${Math.round((valid / sample.length) * 100)}%)`);
console.log(`keep/drop agreement vs rubric@50: ${agree}/${valid}`);
if (aliveCount) console.log(`mean |llm−rubric| on alive jobs: ${Math.round(absErr / aliveCount)}`);
console.log(`avg seconds/job: ${Math.round((Date.now() - t0) / 1000 / sample.length)}`);
