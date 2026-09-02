// STEP 3 — CV prep for selected jobs (rubric >= 50 AND llm >= 50).
// The free model does the cheap part per job: pick the base CV variant and
// list the posting's literal keywords. The actual tailored HTML/PDF is quality
// work — run /tailor-cv in a Claude session per brief (briefs link everything).
// Output: data/cv-briefs/<company>-<slug>.md
//
// Knobs:
const MODEL = "opencode/mimo-v2.5-free";
const BATCH = 10;

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { openDb } from "../src/db.ts";
import { extract } from "../src/llm.ts";

process.chdir(new URL("..", import.meta.url).pathname);
try { process.loadEnvFile(".env"); } catch {}
process.env.LLM_LIGHT ??= `opencode run -m ${MODEL}`; // default only — your .env LLM_LIGHT wins

const VARIANTS = [
  "DevRel", "DX", "PMM", "Developer_Marketing", "Ecosystem_Marketing",
  "Growth_Marketing", "Marketing_Ops", "Field_Events", "GTM_Engineer",
] as const;

const Brief = z.object({
  variant: z.enum(VARIANTS),
  keywords: z.array(z.string()).max(15),
  title_phrase: z.string().max(80),
});
const EXAMPLE = { variant: "DevRel", keywords: ["developer advocacy", "technical content", "API"], title_phrase: "Developer Advocate" };

const db = openDb();
mkdirSync("data/cv-briefs", { recursive: true });
const jobs = db.prepare(
  `SELECT url, company, title, location, description, match_score, llm_score, llm_reason FROM jobs
   WHERE rejected IS NULL AND match_score >= 50 AND llm_score >= 50
   ORDER BY llm_score DESC LIMIT ?`,
).all(BATCH) as any[];

let written = 0;
for (const j of jobs) {
  const slug = `${j.company}-${j.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  const path = `data/cv-briefs/${slug}.md`;
  if (existsSync(path)) continue;
  let brief;
  try {
    brief = extract(Brief,
      `For this job posting: (1) pick the best-fitting CV base variant from ${VARIANTS.join(", ")}; (2) list up to 15 literal keyword phrases the posting uses that a CV should mirror (exact wording); (3) give the exact job title phrase to echo in the CV tagline.`,
      `JOB: ${j.title} @ ${j.company}\n${(j.description ?? "").slice(0, 1800)}`,
      { tier: "light", retries: 2, escalate: false, db, example: EXAMPLE });
  } catch { continue; }
  writeFileSync(path, `# ${j.company} — ${j.title}

- apply: ${j.url}
- scores: rubric ${j.match_score} · llm ${j.llm_score} (${j.llm_reason})
- location: ${j.location || "?"}
- base variant: **${brief.variant}** (~/Downloads/cv/Marketing-Roles or the standalone folders)
- title phrase for tagline: "${brief.title_phrase}"
- keywords to mirror (exact wording): ${brief.keywords.join(" · ")}

Next: in a Claude session run /tailor-cv with this file's contents (or the URL) to
produce the ATS-matched HTML+PDF in ~/Downloads/cv/tailored/.
`);
  written++;
}
console.log(`cv briefs written: ${written} (folder: data/cv-briefs/)`);
