// STEP 4 — push matched jobs (rubric >= 50) to Twenty CRM as QUEUED
// opportunities with scores, apply link, posted date, and exp-ask mark.
import { openDb } from "../src/db.ts";
import { syncToCrm } from "../src/sync.ts";

process.chdir(new URL("..", import.meta.url).pathname);
try { process.loadEnvFile(".env"); } catch {}
process.env.JOBHUNT_ACTOR ||= "cron";
const { pushed, skipped } = await syncToCrm(openDb());
console.log(`crm sync: ${pushed} new opportunities, ${skipped} already synced`);
