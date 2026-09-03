// The one command to remember: `jobhunt` (menu) or `jobhunt <verb>`.
// Install once with `npm link` (or use `npx tsx src/cli.ts`).
//
//   setup   first-time: CV → drafted profile + short interview + checks
//   check   verify keys, CLIs, DB, CRM data model — with fixes suggested
//   daily   run today's whole pipeline (scripts/run-daily.sh)
//   people  find more people to reach (Fiber first, search fallback)
//   status  local + CRM counts, what's pending
// (advanced verbs from the early build — signal / resolve / match / sync — remain below)

import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline/promises";
import { Command } from "commander";
import { loadProfile } from "./profile.ts";
import { openDb, DB_PATH } from "./db.ts";
import { ingest, reportRun } from "./ingest.ts";
import { score } from "./score.ts";
import { resolve } from "./resolver.ts";
import { fetchBoard, type AtsKind } from "./sources/ats.ts";
import { remotive, remoteok, arbeitnow, weworkremotely, hnWhoIsHiring } from "./sources/feeds.ts";
import { adzuna, jooble } from "./sources/apis.ts";
import { syncToCrm } from "./sync.ts";
import type { JobSource } from "./sources/source.ts";

import { loadEnv } from "./env.ts";
loadEnv();

const SOURCES: JobSource[] = [remotive, remoteok, arbeitnow, weworkremotely, hnWhoIsHiring, adzuna, jooble];

const runScript = (script: string, env: Record<string, string> = {}) =>
  spawnSync("npx", ["tsx", script], { stdio: "inherit", env: { ...process.env, ...env } });

const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const warn = (msg: string) => console.log(`  ✗ ${msg}`);

// ---------- check ----------
async function runCheck(): Promise<boolean> {
  let healthy = true;
  console.log("\nkeys (.env) — a missing key only disables its own step:");
  const KEYS: [string, string][] = [
    ["TINYFISH_API_KEY", "rendered fetches + people search fallback"],
    ["ADZUNA_APP_KEY", "Adzuna jobs"], ["JOOBLE_API_KEY", "Jooble jobs"],
    ["APOLLO_API_KEY", "company enrichment (7-funded, 14-backfill)"],
    ["FIBER_API_KEY", "people profiles (free 10k/mo)"],
    ["HUNTER_API_KEY", "email waterfall"], ["PROSPEO_API_KEY", "email waterfall"],
    ["TWENTY_URL", "the CRM"], ["TWENTY_API_KEY", "the CRM"],
  ];
  for (const [k, what] of KEYS) (process.env[k] ? ok : warn)(`${k} — ${what}`);

  console.log("\nCLI tools — LLM steps fall back / skip when missing:");
  for (const [cmd, what] of [
    ["opencode", "free LLM tier (LLM_LIGHT)"], ["claude", "judgement tier (LLM_HEAVY)"],
    ["tinyfish", "rendered page fetches"], ["firecrawl", "search fallback"],
  ] as [string, string][]) {
    const found = spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
    (found ? ok : warn)(`${cmd} — ${what}`);
  }

  console.log("\nprofile + data:");
  if (existsSync("profile.yaml")) {
    try {
      const p = loadProfile();
      ok(`profile.yaml — ${p.role_titles.length} role titles, ${p.locations.length} locations`);
      if (!p.role_titles.length) { warn("no role_titles — scoring can't work; run `jobhunt setup`"); healthy = false; }
    } catch (e) { warn(`profile.yaml unreadable: ${String(e).slice(0, 80)}`); healthy = false; }
  } else { warn("profile.yaml missing — run `jobhunt setup`"); healthy = false; }
  try {
    const db = openDb();
    const jobs = (db.prepare("SELECT count(*) n FROM jobs").get() as any).n;
    ok(`SQLite ${DB_PATH} — ${jobs} jobs stored`);
  } catch (e) { warn(`SQLite: ${String(e).slice(0, 80)}`); healthy = false; }

  console.log("\nCRM (Twenty):");
  const U = process.env.TWENTY_URL, K = process.env.TWENTY_API_KEY;
  if (!U || !K) warn("not configured — pipeline still works, SQLite holds everything");
  else {
    try {
      let objects = 0;
      for (const o of ["companies", "people", "opportunities", "jobPortals", "investorPortfolios"]) {
        const res = await fetch(`${U}/rest/${o}?limit=1`, {
          headers: { Authorization: `Bearer ${K}` }, signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) { objects++; ok(`${o}: ${((await res.json()) as any)?.totalCount ?? "?"} records`); }
        else warn(`${o}: HTTP ${res.status}`);
      }
      if (objects < 5) { warn("data model incomplete — run `npm run setup-crm`"); healthy = false; }
      console.log(`  → CRM link: ${U} (also saved in data/LINKS.md)`);
    } catch (e) { warn(`unreachable: ${String(e).slice(0, 80)}`); healthy = false; }
  }
  console.log(healthy ? "\nall good — `jobhunt daily` is ready.\n" : "\nfix the ✗ items above (each is optional except profile.yaml).\n");
  return healthy;
}

// ---------- setup ----------
async function runSetup(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nFirst-time setup — your answers stay in gitignored local files.\n");

  if (existsSync("profile.yaml")) {
    const over = await rl.question("profile.yaml exists — overwrite? [y/N] ");
    if (!/^y/i.test(over)) { console.log("keeping existing profile."); rl.close(); await runCheck(); return; }
  }

  // 1. CV → drafted profile (LLM), if a CV and an LLM CLI are available
  let draft: Record<string, unknown> = {};
  const cvPath = (await rl.question("path to your CV (.html/.txt/.md, Enter to skip): ")).trim();
  if (cvPath && existsSync(cvPath.replace(/^~/, process.env.HOME ?? "~"))) {
    try {
      const raw = readFileSync(cvPath.replace(/^~/, process.env.HOME ?? "~"), "utf8")
        .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 9000);
      const { z } = await import("zod");
      const { extract } = await import("./llm.ts");
      const CvDraft = z.object({
        role_titles: z.array(z.string()).max(10),
        stack: z.array(z.string()).max(15),
        years: z.number().nullable(),
        domains: z.array(z.string()).max(8),
        proof_points: z.array(z.string()).max(8),
      });
      console.log("  reading CV with the LLM…");
      draft = extract(CvDraft,
        `From this CV, extract: role_titles the person should target (job-board searchable), their skill/tool stack, total years of experience, industry domains, and proof_points (concrete achievements with numbers, one line each).`,
        raw, { tier: "light", retries: 2, escalate: true, db: openDb() });
      console.log(`  drafted: ${(draft.role_titles as string[]).join(", ")}`);
    } catch (e) { console.log(`  CV parse failed (${String(e).slice(0, 80)}) — answer manually below.`); }
  }

  // 2. short interview for what a CV can't say
  const q = async (prompt: string, fallback: string): Promise<string> =>
    (await rl.question(`${prompt}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
  const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  const roles = csv(await q("target role titles (comma-separated)", (draft.role_titles as string[])?.join(", ") ?? ""));
  const stack = csv(await q("skills/stack keywords", (draft.stack as string[])?.join(", ") ?? ""));
  const years = await q("years of experience", String(draft.years ?? ""));
  const domains = csv(await q("target domains (e.g. ai, devtools, infra)", (draft.domains as string[])?.join(", ") ?? ""));
  const locations = csv(await q("ranked locations, best first (remote-global, <country>-remote, cities)", "remote-global"));
  const dealbreakers = csv(await q("dealbreakers (hard rejects, comma-separated)", ""));
  const comp = await q("comp floor (e.g. 'none' or '50000 USD')", "none");
  rl.close();

  const yaml = [
    "# Written by `jobhunt setup` — edit freely. Gitignored.",
    `role_titles: [${roles.map((r) => JSON.stringify(r)).join(", ")}]`,
    `stack: [${stack.map((r) => JSON.stringify(r)).join(", ")}]`,
    years ? `years: ${years}` : "years:",
    `domains: [${domains.map((r) => JSON.stringify(r)).join(", ")}]`,
    `locations: [${locations.map((r) => JSON.stringify(r)).join(", ")}]`,
    comp !== "none" && /\d/.test(comp)
      ? `comp_band: { min: ${comp.replace(/[^\d]/g, "")}, currency: ${JSON.stringify(comp.replace(/[\d\s]/g, "") || "USD")} }`
      : "comp_band:",
    `dealbreakers: [${dealbreakers.map((r) => JSON.stringify(r)).join(", ")}]`,
    `proof_points: [${((draft.proof_points as string[]) ?? []).map((r) => JSON.stringify(r)).join(", ")}]`,
    "max_posting_age_days: 60",
    "",
  ].join("\n");
  writeFileSync("profile.yaml", yaml);
  console.log("\nwrote profile.yaml — now verifying your setup:");
  await runCheck();
  console.log("next: `npm run setup-crm` (if the CRM check failed), then `jobhunt daily`.");
}

// ---------- status ----------
async function runStatus(): Promise<void> {
  const db = openDb();
  console.log("\nlocal (SQLite):");
  for (const t of ["jobs", "companies", "people", "portfolio_companies"]) {
    const { n } = db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number };
    console.log(`  ${t}: ${n}`);
  }
  const { alive } = db.prepare("SELECT count(*) alive FROM jobs WHERE rejected IS NULL AND match_score >= 50").get() as any;
  const { judged } = db.prepare("SELECT count(*) judged FROM jobs WHERE llm_score >= 50 AND match_score >= 50 AND rejected IS NULL").get() as any;
  console.log(`  matches (rubric ≥50): ${alive} · double-passed (judge ≥50 too): ${judged}`);

  const U = process.env.TWENTY_URL, K = process.env.TWENTY_API_KEY;
  if (U && K) {
    console.log("\nCRM:");
    for (const o of ["companies", "people", "opportunities", "jobPortals", "investorPortfolios"]) {
      try {
        const res = await fetch(`${U}/rest/${o}?limit=1`, { headers: { Authorization: `Bearer ${K}` }, signal: AbortSignal.timeout(15_000) });
        console.log(`  ${o}: ${res.ok ? ((await res.json()) as any)?.totalCount : `HTTP ${res.status}`}`);
      } catch { console.log(`  ${o}: unreachable`); }
    }
    console.log(`  → ${U}`);
  }
  if (existsSync("data/PENDING.md")) {
    console.log("\npending (data/PENDING.md):");
    for (const line of readFileSync("data/PENDING.md", "utf8").split("\n"))
      if (/^- /.test(line)) console.log(`  ${line}`);
  }
  console.log();
}

// ---------- menu ----------
async function menu(): Promise<void> {
  console.log(`
job-hunt — what do you want to do?

  1) setup    first-time: CV → profile interview + checks
  2) check    verify everything works (keys, CRM, CLIs, DB)
  3) daily    run today's full pipeline
  4) people   find more people to reach
  5) status   what's stored, what's in the CRM, what's pending
`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pick = (await rl.question("pick [1-5]: ")).trim();
  rl.close();
  const map: Record<string, () => Promise<void> | void> = {
    "1": runSetup, "2": async () => { await runCheck(); },
    "3": () => { spawnSync("bash", ["scripts/run-daily.sh"], { stdio: "inherit" }); },
    "4": () => { runScript("scripts/5-people.mts", { PEOPLE_PER_RUN: "20" }); },
    "5": runStatus,
  };
  if (map[pick]) await map[pick]!();
  else console.log("nothing picked — bye.");
}

// ---------- commander wiring ----------
const program = new Command("jobhunt");

program.command("setup").description("first-time setup: CV → profile interview + checks").action(runSetup);
program.command("check").description("verify keys, CLIs, DB, and the CRM data model").action(async () => { await runCheck(); });
program.command("daily").description("run today's whole pipeline (scripts/run-daily.sh)").action(() => {
  spawnSync("bash", ["scripts/run-daily.sh"], { stdio: "inherit" });
});
program.command("people").description("find people to reach (Fiber first, free)")
  .option("--max <n>", "companies this run", "20")
  .action((opts: { max: string }) => { runScript("scripts/5-people.mts", { PEOPLE_PER_RUN: opts.max }); });
program.command("status").description("local + CRM counts and pending work").action(runStatus);

// --- advanced verbs (the original building blocks) ---
program
  .command("signal")
  .description("(advanced) pull new postings from keyless+API sources, score, and store")
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
  });

program
  .command("resolve <company> [domain]")
  .description("(advanced) detect which ATS a company uses and list its live matching roles")
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
    }
  });

program
  .command("match")
  .description("(advanced) re-score all stored jobs against the current profile.yaml")
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
  .description("(advanced) push matched jobs into the CRM as QUEUED opportunities")
  .action(async () => {
    const db = openDb();
    const { pushed, skipped } = await syncToCrm(db);
    console.log(`crm sync: ${pushed} new opportunities, ${skipped} already synced`);
  });

if (process.argv.length <= 2) await menu();
else program.parse();
