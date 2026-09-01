// STEP 1 — daily fetch: latest jobs from every platform, scored and stored.
// Incremental by design: the jobs.url primary key skips what's already stored,
// so rerunning only adds what's new since the last pull.
//
// Knobs (edit freely):
const KNOBS = {
  ARBEITNOW_PAGES: "2", // newest-first API pages
  ADZUNA_QUERIES: "6",  // 1 API call per role title (free budget ~1,000/mo)
  JOOBLE_QUERIES: "2",  // BUDGET: 500 requests TOTAL on current grant; "0" pauses
  VC_QUERIES: "4",      // role titles searched per VC board (each ≈ 40s: render + free-LLM parse)
};
const SKIP: string[] = []; // e.g. ["jooble"] to skip a source today

import { loadProfile } from "../src/profile.ts";
import { openDb } from "../src/db.ts";
import { ingest, reportRun } from "../src/ingest.ts";
import { remotive, remoteok, arbeitnow, weworkremotely, hnWhoIsHiring } from "../src/sources/feeds.ts";
import { adzuna, jooble } from "../src/sources/apis.ts";
import { makeVcSource } from "../src/sources/vc.ts";

process.chdir(new URL("..", import.meta.url).pathname);
try { process.loadEnvFile(".env"); } catch {}
Object.assign(process.env, KNOBS);

const profile = loadProfile();
const db = openDb();
for (const src of [remotive, remoteok, arbeitnow, weworkremotely, hnWhoIsHiring, adzuna, jooble, makeVcSource(db)]) {
  if (SKIP.includes(src.name)) { console.log(`${src.name}: skipped`); continue; }
  try {
    reportRun(db, src.name, ingest(db, await src.fetchPostings(profile), profile));
  } catch (err) {
    console.error(`${src.name}: FAILED ${String(err).slice(0, 150)}`);
  }
}
const { n } = db.prepare("SELECT count(*) n FROM jobs WHERE rejected IS NULL AND match_score >= 50 AND llm_score IS NULL").get() as any;
console.log(`\n${n} matched jobs waiting for step 2 (llm scoring)`);
