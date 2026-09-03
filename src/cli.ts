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
const bar = (done: number, total: number): string => {
  done = Math.min(done, total);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const filled = Math.round((pct / 100) * 30);
  return `[${"█".repeat(filled)}${"░".repeat(30 - filled)}] ${String(pct).padStart(3)}%  ${done}/${total}`;
};

async function runStatus(): Promise<void> {
  const db = openDb();

  console.log("\nprogress — done vs left:");
  const one = (sql: string) => (db.prepare(sql).get() as any).n ?? 0;
  const rows: [string, number, number][] = [
    ["judge (llm score)",
      one("SELECT sum(llm_score IS NOT NULL) n FROM jobs WHERE rejected IS NULL AND match_score>=50"),
      one("SELECT count(*) n FROM jobs WHERE rejected IS NULL AND match_score>=50")],
    ["careers 1st-check",
      one("SELECT count(*) n FROM lookups WHERE key LIKE 'careers-check:%'"),
      one(`SELECT count(*) n FROM portfolio_companies pc WHERE pc.domain IS NOT NULL
           AND EXISTS (SELECT 1 FROM lookups WHERE key='crm:link:'||pc.program||':'||lower(pc.name))`)],
    ["board re-scans (7d)",
      one("SELECT count(*) n FROM lookups WHERE key LIKE 'board-scan:%' AND json_extract(result,'$.at') > datetime('now','-7 days')"),
      one(`SELECT count(*) n FROM companies WHERE ats IN ('greenhouse','lever','ashby','workable','smartrecruiters') AND ats_token IS NOT NULL`)],
    ["people coverage",
      one("SELECT count(DISTINCT lower(company)) n FROM people"),
      one(`SELECT count(*) n FROM (SELECT name FROM companies WHERE pitch=1
           UNION SELECT DISTINCT company FROM jobs WHERE rejected IS NULL AND match_score>=50 AND llm_score>=50)`)],
    ["backfill feeds done",
      one("SELECT count(*) n FROM lookups WHERE key LIKE 'backfill:cursor:%' AND result LIKE '%done%'"),
      9],
    ["portfolio → CRM",
      one("SELECT count(*) n FROM lookups WHERE key LIKE 'crm:link:%'"),
      one(`SELECT count(*) n FROM portfolio_companies WHERE
           (program='yc' AND status='Active' AND lower(batch) IN ('fall 2026','summer 2026','spring 2026','winter 2026'))
           OR (program='a16z' AND status LIKE '%Active%')
           OR (program='blr-map' AND lower(batch) IN ('pre-seed','seed','series a') AND domain IS NOT NULL)`)],
  ];
  for (const [name, done, total] of rows) console.log(`  ${name.padEnd(20)} ${bar(done, total)}`);

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

// ---------- add: guided forms for manual entries ----------
const twentyRest = async (method: string, path: string, body?: unknown): Promise<any | null> => {
  const U = process.env.TWENTY_URL, K = process.env.TWENTY_API_KEY;
  if (!U || !K) return null;
  await new Promise((r) => setTimeout(r, 700));
  try {
    const res = await fetch(`${U}/rest/${path}`, {
      method, headers: { Authorization: `Bearer ${K}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? res.json() : (console.error(`  crm ${method} ${path}: ${res.status}`), null);
  } catch (e) { console.error(`  crm: ${String(e).slice(0, 80)}`); return null; }
};

async function pickCompany(rl: readline.Interface): Promise<{ id: string | null; name: string; domain: string | null } | null> {
  const q = (await rl.question("company (type to search): ")).trim();
  if (!q) return null;
  const hits = (await twentyRest("GET",
    `companies?filter=${encodeURIComponent(`name[ilike]:"%${q.replaceAll('"', "")}%"`)}&limit=8`))?.data?.companies ?? [];
  if (hits.length) {
    hits.forEach((c: any, i: number) => console.log(`  ${i + 1}) ${c.name}${c.domainName?.primaryLinkUrl ? `  (${c.domainName.primaryLinkUrl})` : ""}`));
    console.log(`  n) new company "${q}"`);
    const pick = (await rl.question("pick [1-8/n]: ")).trim();
    const idx = parseInt(pick, 10);
    if (idx >= 1 && idx <= hits.length) {
      const c = hits[idx - 1];
      return { id: c.id, name: c.name, domain: c.domainName?.primaryLinkUrl?.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "") || null };
    }
  } else console.log(`  no CRM match for "${q}" — creating new`);
  const domain = (await rl.question("company website/domain (optional): ")).trim()
    .replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "") || null;
  const created = await twentyRest("POST", "companies", {
    name: q, actor: "human", signalSource: "manual",
    ...(domain ? { domainName: { primaryLinkUrl: `https://${domain}` } } : {}),
  });
  const id = created?.data?.createCompany?.id ?? null;
  if (id) {
    const db = openDb();
    db.prepare("INSERT OR IGNORE INTO companies (domain, name, source) VALUES (?, ?, 'manual')")
      .run(domain ?? q.toLowerCase().replace(/[^a-z0-9]/g, ""), q);
    db.prepare("INSERT OR REPLACE INTO lookups (key, provider, result, cost) VALUES (?, 'twenty', ?, 0)")
      .run(`crm:company:${q.toLowerCase()}`, JSON.stringify({ id }));
    console.log(`  + company created: ${q}`);
  }
  return { id, name: q, domain };
}

async function runAddPerson(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nLog a connection — everything lands in the CRM + local DB.\n");
  const comp = await pickCompany(rl);
  if (!comp) { rl.close(); return; }
  const name = (await rl.question("person's name: ")).trim();
  if (!name) { rl.close(); return; }
  const title = (await rl.question("their position/title: ")).trim();
  const linkedin = (await rl.question("linkedin URL (optional): ")).trim();
  console.log("how did you reach out?  1) not yet  2) connect request sent  3) messaged  4) they replied");
  const how = (await rl.question("pick [1-4]: ")).trim();
  const stage = ({ "1": "QUEUED", "2": "CONNECTED", "3": "TOUCH_1", "4": "REPLIED" } as Record<string, string>)[how] ?? "QUEUED";
  const note = (await rl.question("note for yourself (optional): ")).trim();
  rl.close();

  const persona =
    /founder|co-founder|ceo|cto|chief/i.test(title) ? "FOUNDER" :
    /head|director|lead|vp|manager/i.test(title) ? "HIRING_MANAGER" :
    /recruit|talent/i.test(title) ? "RECRUITER" : "PEER";
  const created = await twentyRest("POST", "people", {
    name: { firstName: name.split(" ")[0], lastName: name.split(" ").slice(1).join(" ") || "-" },
    jobTitle: title, personaTier: persona, outreachStage: stage, fetchEmail: "NO", actor: "human",
    ...(linkedin ? { linkedinLink: { primaryLinkUrl: linkedin } } : {}),
    ...(stage !== "QUEUED" ? { lastTouchAt: new Date().toISOString() } : {}),
    ...(note ? { dmDraft: note } : {}),
    ...(comp.id ? { companyId: comp.id } : {}),
  });
  try {
    openDb().prepare("INSERT INTO people (company, name, title, persona_tier, linkedin, provenance) VALUES (?, ?, ?, ?, ?, ?)")
      .run(comp.name, name, title, persona.toLowerCase(), linkedin || null, JSON.stringify({ source: "manual", at: new Date().toISOString() }));
  } catch { /* already known locally */ }
  console.log(created ? `\n✓ ${name} @ ${comp.name} added (${stage.toLowerCase().replace("_", " ")}).` : "\n✗ CRM write failed — check `jobhunt check`.");
}

async function runAddRole(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nLog a role you found — scored, stored, and put on the kanban.\n");
  const comp = await pickCompany(rl);
  if (!comp) { rl.close(); return; }
  const title = (await rl.question("role title: ")).trim();
  if (!title) { rl.close(); return; }
  const url = (await rl.question("job URL (optional): ")).trim()
    || `manual:${comp.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const location = (await rl.question("location (optional): ")).trim();
  console.log("where is it?  1) just found it  2) already applied  3) interviewing");
  const st = (await rl.question("pick [1-3]: ")).trim();
  const stage = ({ "1": "QUEUED", "2": "APPLIED", "3": "INTERVIEWING" } as Record<string, string>)[st] ?? "QUEUED";
  rl.close();

  const profile = loadProfile();
  const v = score({ source: "manual", company: comp.name, title, url, location, description: "" }, profile);
  const db = openDb();
  db.prepare(`INSERT OR REPLACE INTO jobs (url, company, title, location, source, description, match_score, matched_at, rejected)
              VALUES (?, ?, ?, ?, 'manual', '', ?, datetime('now'), NULL)`)
    .run(url, comp.name, title, location, v.score);
  const opp = await twentyRest("POST", "opportunities", {
    name: `${comp.name} — ${title}`.slice(0, 250), stage, jobTitle: title, jobUrl: url,
    matchScore: Math.round(v.score), actor: "human",
    ...(comp.id ? { companyId: comp.id } : {}),
  });
  const oppId = opp?.data?.createOpportunity?.id;
  if (oppId)
    db.prepare("INSERT OR REPLACE INTO lookups (key, provider, result, cost) VALUES (?, 'twenty', ?, 0)")
      .run(`crm:opp:${url}`, JSON.stringify({ id: oppId }));
  console.log(oppId
    ? `\n✓ ${title} @ ${comp.name} on the kanban (${stage}, rubric score ${v.score}).`
    : "\n✗ CRM write failed — the role is stored locally; sync will retry.");
}

async function runAdd(what?: string): Promise<void> {
  let choice = what;
  if (!choice) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("\nadd what?  1) person (a connection)  2) role (a job you found)");
    const pick = (await rl.question("pick [1-2]: ")).trim();
    rl.close();
    choice = pick === "2" ? "role" : "person";
  }
  if (/^r/i.test(choice)) await runAddRole();
  else await runAddPerson();
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
  6) add      log something manually: a connection or a role you found
`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pick = (await rl.question("pick [1-6]: ")).trim();
  rl.close();
  const map: Record<string, () => Promise<void> | void> = {
    "1": runSetup, "2": async () => { await runCheck(); },
    "3": () => { spawnSync("bash", ["scripts/run-daily.sh"], { stdio: "inherit" }); },
    "4": () => { runScript("scripts/5-people.mts", { PEOPLE_PER_RUN: "20" }); },
    "5": runStatus,
    "6": () => runAdd(),
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
program.command("add [what]").description("log a connection or a role by hand: `add person` / `add role` (guided)")
  .action(async (what?: string) => { await runAdd(what); });

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
