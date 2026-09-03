// STEP 8 — the 3-touch outreach ladder (nothing sends itself; you send from Gmail).
//
//   touch 1 = your original send (you move the card to SENT)
//   touch 2 = follow-up drafted after WAIT_DAYS in SENT with no reply
//   touch 3 = last follow-up after another WAIT_DAYS
//   then    = card auto-moves to STOPPED — no more effort, no guilt pile
//
// Also: any card with Interview At set gets a prep task the day before.
// Move a card to REPLIED / INTERVIEWING yourself and the ladder leaves it alone.
//
// Knobs:
const WAIT_DAYS = 7;
const MAX_TOUCHES = 3;
const DRAFT_TIER: "light" | "heavy" = "heavy";
const MODEL = "opencode/mimo-v2.5-free";

import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { openDb } from "../src/db.ts";
import { extract } from "../src/llm.ts";
import { loadProfile } from "../src/profile.ts";
import { cacheGet, cachePut } from "../src/enrich.ts";
import { loadEnv } from "../src/env.ts";

process.chdir(new URL("..", import.meta.url).pathname);
loadEnv();
process.env.LLM_LIGHT ??= `opencode run -m ${MODEL}`; // default only — your .env LLM_LIGHT wins
const db = openDb();
const profile = loadProfile();
mkdirSync("data/email-drafts", { recursive: true });

const U = process.env.TWENTY_URL!, K = process.env.TWENTY_API_KEY!;
const twenty = async (method: string, path: string, body?: unknown) => {
  await new Promise((r) => setTimeout(r, 700));
  try {
    const res = await fetch(`${U}/rest/${path}`, {
      method, headers: { Authorization: `Bearer ${K}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? res.json() : (console.error(`twenty ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`), null);
  } catch (err) { console.error(`twenty ${method} ${path}: ${String(err).slice(0, 100)}`); return null; }
};

const Draft = z.object({ subject: z.string().max(80), body: z.string().max(1200) });

// ---------- the ladder: SENT cards sitting too long ----------
const sent = (await twenty("GET", `opportunities?filter=stage[eq]:SENT&limit=100`))?.data?.opportunities ?? [];
const due = sent.filter((o: any) => Date.parse(o.updatedAt) < Date.now() - WAIT_DAYS * 86_400_000);
console.log(`${sent.length} in SENT, ${due.length} sitting ≥${WAIT_DAYS}d`);

let drafted = 0, stopped = 0;
for (const o of due) {
  const touches = (o.touches ?? 1) as number; // card in SENT = at least the original send

  if (touches >= MAX_TOUCHES) {
    // ladder exhausted — stop cleanly instead of letting the card rot in SENT
    await twenty("PATCH", `opportunities/${o.id}`, { stage: "STOPPED" });
    stopped++;
    console.log(`  STOPPED after ${touches} touches: ${o.name}`);
    continue;
  }

  const guard = `followup:${o.id}:${touches}`; // one draft per rung
  if (cacheGet(db, guard)) continue;
  let draft: z.infer<typeof Draft> | null = null;
  try {
    draft = extract(Draft,
      `Write a SHORT follow-up email (under 120 words) — touch ${touches + 1} of ${MAX_TOUCHES} — for outreach sent ${WAIT_DAYS}+ days ago with no reply. Reference the original topic, add ONE new proof point not used before, one soft ask.${touches + 1 === MAX_TOUCHES ? " This is the LAST touch — close the loop politely (\"I'll stop here — door's open\")." : ""} No guilt-tripping, no "just bumping this".\nCandidate proof points: ${profile.proof_points.join("; ")}`,
      `Opportunity: ${o.name}. Role: ${o.jobTitle ?? "?"}. Job URL: ${o.jobUrl ?? ""}`,
      { tier: DRAFT_TIER, retries: 1, escalate: false, db });
  } catch { continue; }
  const slug = (o.name ?? o.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  writeFileSync(`data/email-drafts/followup-${touches + 1}-${slug}.md`,
    `# FOLLOW-UP ${touches + 1}/${MAX_TOUCHES} — ${o.name}\n\nSubject: ${draft.subject}\n\n${draft.body}\n\n(after sending: the card's Touches goes to ${touches + 1}; they reply → move to REPLIED; ladder stops itself after ${MAX_TOUCHES})\n`);
  await twenty("PATCH", `opportunities/${o.id}`, { touches: touches + 1 });
  const task = await twenty("POST", "tasks", {
    title: `Send follow-up ${touches + 1}/${MAX_TOUCHES}: ${o.name}`,
    dueAt: new Date().toISOString(), status: "TODO",
  });
  const taskId = task?.data?.createTask?.id;
  if (taskId) await twenty("POST", "taskTargets", { taskId, opportunityId: o.id });
  cachePut(db, guard, "followup", { at: new Date().toISOString() });
  drafted++;
  console.log(`  drafted touch ${touches + 1}/${MAX_TOUCHES}: ${o.name}`);
}

// ---------- interview prep tasks ----------
const interviewing = (await twenty("GET",
  `opportunities?filter=${encodeURIComponent("interviewAt[is]:NOT_NULL")}&limit=100`))?.data?.opportunities ?? [];
let prepped = 0;
for (const o of interviewing) {
  const when = Date.parse(o.interviewAt);
  if (!Number.isFinite(when) || when < Date.now()) continue;
  const guard = `interview-prep:${o.id}:${o.interviewAt}`;
  if (cacheGet(db, guard)) continue;
  const task = await twenty("POST", "tasks", {
    title: `Prep interview: ${o.name} (${new Date(when).toLocaleString()})`,
    dueAt: new Date(when - 86_400_000).toISOString(), status: "TODO",
  });
  const taskId = task?.data?.createTask?.id;
  if (taskId) await twenty("POST", "taskTargets", { taskId, opportunityId: o.id });
  cachePut(db, guard, "interview-prep", { at: new Date().toISOString() });
  prepped++;
}

console.log(`\n${drafted} follow-ups drafted · ${stopped} cards auto-stopped · ${prepped} interview prep tasks. Drafts: data/email-drafts/`);
