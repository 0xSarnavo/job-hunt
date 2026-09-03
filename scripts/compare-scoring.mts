// Three-judge comparison on ALREADY-STORED jobs (no fetching):
// deterministic rubric vs free OpenCode model vs claude -p.
process.chdir(new URL("..", import.meta.url).pathname);
const { loadEnv } = await import("../src/env.ts");
loadEnv();
process.env.LLM_LIGHT ??= "opencode run -m opencode/mimo-v2.5-free";
const { openDb } = await import("../src/db.ts");
const { extract } = await import("../src/llm.ts");
const { loadProfile, profileBrief } = await import("../src/profile.ts");
const { z } = await import("zod");

const db = openDb();
const jobs = db.prepare(`
  SELECT company, title, location, description, exp_required, match_score, rejected FROM jobs
  WHERE description != '' AND length(description) > 300
  ORDER BY CASE
    WHEN rejected IS NULL AND match_score >= 65 THEN 0
    WHEN rejected IS NULL AND match_score BETWEEN 40 AND 64 THEN 1
    WHEN rejected IS NULL AND match_score < 40 THEN 2
    ELSE 3 END, RANDOM()
`).all() as any[];
// stratified pick: 3 high, 2 mid, 1 low, 2 rejected
const pick = [
  ...jobs.filter(j => !j.rejected && j.match_score >= 65).slice(0, 3),
  ...jobs.filter(j => !j.rejected && j.match_score >= 40 && j.match_score < 65).slice(0, 2),
  ...jobs.filter(j => !j.rejected && j.match_score < 40).slice(0, 1),
  ...jobs.filter(j => j.rejected).slice(0, 2),
];

const Fit = z.object({
  score: z.number().min(0).max(100),
  exp_years_required: z.number().nullable(),
  reason: z.string().max(200),
});

const PROFILE = profileBrief(loadProfile());

for (const j of pick) {
  const input = `JOB: ${j.title} @ ${j.company} (${j.location})\n${j.description.slice(0, 1800)}`;
  const task = `Score this job 0-100 for the candidate below. Also extract years of experience required (null if unstated).\n${PROFILE}`;
  let light: any = null, heavy: any = null;
  try { light = extract(Fit, task, input, { tier: "light", retries: 1, escalate: false }); } catch (e) { light = { score: -1, reason: String(e).slice(0, 60) }; }
  try { heavy = extract(Fit, task, input, { tier: "heavy", retries: 1, escalate: false }); } catch (e) { heavy = { score: -1, reason: String(e).slice(0, 60) }; }
  console.log(`\n### ${j.company} — ${j.title} [${j.location || "?"}]`);
  console.log(`rubric: ${j.rejected ? `REJECT(${j.rejected})` : j.match_score} | exp:${j.exp_required ?? "-"}`);
  console.log(`mimo  : ${light.score} | exp:${light.exp_years_required ?? "-"} | ${light.reason}`);
  console.log(`claude: ${heavy.score} | exp:${heavy.exp_years_required ?? "-"} | ${heavy.reason}`);
}
