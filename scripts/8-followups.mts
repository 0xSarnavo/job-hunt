// STEP 8 — follow-up drafting (PLAN §8: single follow-up at T+7, then stop).
// Finds opportunities YOU moved to SENT that have sat ≥ WAIT_DAYS with no
// reply (i.e., still in SENT), drafts the follow-up email, and creates a
// due-now task. NOTHING IS SENT AUTOMATICALLY — you send from your Gmail.
//
// Knobs:
const WAIT_DAYS = 7;
const DRAFT_TIER: "light" | "heavy" = "heavy";
const MODEL = "opencode/mimo-v2.5-free";

import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { openDb } from "../src/db.ts";
import { extract } from "../src/llm.ts";
import { loadProfile } from "../src/profile.ts";
import { cacheGet, cachePut } from "../src/enrich.ts";

process.chdir(new URL("..", import.meta.url).pathname);
try { process.loadEnvFile(".env"); } catch {}
process.env.LLM_LIGHT = `opencode run -m ${MODEL}`;
const db = openDb();
const profile = loadProfile();
mkdirSync("email-drafts", { recursive: true });

const U = process.env.TWENTY_URL!, K = process.env.TWENTY_API_KEY!;
const twenty = async (method: string, path: string, body?: unknown) => {
  await new Promise((r) => setTimeout(r, 700));
  const res = await fetch(`${U}/rest/${path}`, {
    method, headers: { Authorization: `Bearer ${K}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok ? res.json() : null;
};

const sent = (await twenty("GET", `opportunities?filter=stage[eq]:SENT&limit=60`))?.data?.opportunities ?? [];
const due = sent.filter((o: any) => Date.parse(o.updatedAt) < Date.now() - WAIT_DAYS * 86_400_000);
console.log(`${sent.length} in SENT, ${due.length} sitting ≥${WAIT_DAYS}d → drafting follow-ups`);

const Draft = z.object({ subject: z.string().max(80), body: z.string().max(1200) });
for (const o of due) {
  const guard = `followup:${o.id}`;
  if (cacheGet(db, guard)) continue; // one follow-up per opportunity, ever (PLAN §8)
  let draft: z.infer<typeof Draft> | null = null;
  try {
    draft = extract(Draft,
      `Write a SHORT follow-up email (under 120 words) for an application/outreach sent ${WAIT_DAYS}+ days ago with no reply. Reference the original topic, add ONE new piece of value (a proof point not used before), one soft ask. No guilt-tripping, no "just bumping this".\nCandidate proof points: ${profile.proof_points.join("; ")}`,
      `Opportunity: ${o.name}. Role: ${o.jobTitle ?? "?"}. Job URL: ${o.jobUrl ?? ""}`,
      { tier: DRAFT_TIER, retries: 1, escalate: false, db });
  } catch { continue; }
  const slug = (o.name ?? o.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  writeFileSync(`email-drafts/followup-${slug}.md`,
    `# FOLLOW-UP — ${o.name}\n\nSubject: ${draft.subject}\n\n${draft.body}\n\n(after sending: move the card to REPLIED when they answer, or CLOSED after this — one follow-up only)\n`);
  const task = await twenty("POST", "tasks", {
    title: `Send follow-up: ${o.name}`,
    dueAt: new Date().toISOString(),
    status: "TODO",
  });
  const taskId = task?.data?.createTask?.id;
  if (taskId) await twenty("POST", "taskTargets", { taskId, opportunityId: o.id });
  cachePut(db, guard, "followup", { at: new Date().toISOString() });
  console.log(`  drafted: followup-${slug}.md + task created`);
}
if (!due.length) console.log("nothing due — good");
