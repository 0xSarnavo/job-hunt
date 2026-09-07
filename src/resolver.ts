import * as cheerio from "cheerio";
import type Database from "better-sqlite3";
import { get, getJson, getText } from "./http.ts";
import type { AtsKind } from "./sources/ats.ts";
import { track } from "./usage.ts";

// The detection ladder (TOOLING step 2, reshaped by the §0 reality check):
//   rung 1 — slug guesses against public board APIs, org-name VERIFIED
//   rung 2 — careers-page signature grep with token extraction
//   rung 3 — TinyFish Fetch rendered fallback for SPA careers pages
// Every result (including misses) is cached forever in `lookups`.

export interface Resolved {
  ats: AtsKind | "other" | "none_found";
  token?: string;
  rung: number;
  detail?: string;
}

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const similar = (a: string, b: string) => {
  const x = alnum(a), y = alnum(b);
  return x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x));
};

function slugGuesses(name: string): string[] {
  const words = name.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().split(/\s+/);
  return [...new Set([words.join(""), words.join("-"), words[0]!])].filter((s) => s.length > 2);
}

// Embed/link patterns that also yield the board token.
const TOKEN_PATTERNS: [AtsKind, RegExp][] = [
  ["greenhouse", /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9-]+)/i],
  ["greenhouse", /greenhouse\.io\/v1\/boards\/([a-z0-9-]+)/i],
  ["lever", /jobs\.(?:eu\.)?lever\.co\/([a-zA-Z0-9-]+)/i],
  ["ashby", /jobs\.ashbyhq\.com\/([a-zA-Z0-9-]+)/i],
  ["workable", /apply\.workable\.com\/([a-z0-9-]+)/i],
  ["smartrecruiters", /careers\.smartrecruiters\.com\/([a-zA-Z0-9]+)/i],
];

// Probe all four boards for one slug; prefer a board with live jobs — an empty
// board is only a fallback (n8n lesson: stale Workable account beat live Ashby).
async function probeSlug(name: string, slug: string): Promise<(Resolved & { jobs: number }) | null> {
  const candidates: (Resolved & { jobs: number })[] = [];
  const gh = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
  if (gh?.name && similar(gh.name, name)) {
    const jobs = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    candidates.push({ ats: "greenhouse", token: slug, rung: 1, detail: `org=${gh.name}`, jobs: jobs?.jobs?.length ?? 0 });
  }
  const wk = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}`);
  if (wk?.name && similar(wk.name, name))
    candidates.push({ ats: "workable", token: slug, rung: 1, detail: `org=${wk.name}`, jobs: wk?.jobs?.length ?? 0 });
  // Lever/Ashby responses carry no org name — only accept the full-name slug,
  // and only when the board actually has jobs (guards against collisions).
  if (slug === alnum(name)) {
    const lv = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (Array.isArray(lv) && lv.length > 0) candidates.push({ ats: "lever", token: slug, rung: 1, detail: `${lv.length} jobs`, jobs: lv.length });
    const ab = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    if (ab?.jobs?.length > 0) candidates.push({ ats: "ashby", token: slug, rung: 1, detail: `${ab.jobs.length} jobs`, jobs: ab.jobs.length });
  }
  return candidates.find((c) => c.jobs > 0) ?? candidates[0] ?? null;
}

function grepTokens(html: string): Resolved | null {
  for (const [ats, re] of TOKEN_PATTERNS) {
    const m = re.exec(html);
    if (m?.[1] && !["embed", "job", "jobs", "boards"].includes(m[1].toLowerCase()))
      return { ats, token: m[1], rung: 2 };
  }
  if (/zohorecruit|keka\.com|darwinbox|mynexthire|freshteam|recruitee|breezy\.hr|bamboohr|jobvite|dover\.com/i.test(html))
    return { ats: "other", rung: 2, detail: html.match(/zohorecruit|keka|darwinbox|mynexthire|freshteam|recruitee|breezy|bamboohr|jobvite|dover/i)?.[0] };
  return null;
}

async function careersHtml(domain: string, rendered: boolean): Promise<string> {
  const fetchPage = async (url: string): Promise<string> => {
    if (!rendered) return (await getText(url)) ?? "";
    try {
      track("tinyfish-fetch");
      const { execFileSync } = await import("node:child_process");
      const out = execFileSync("tinyfish", ["fetch", "content", "get", "--format", "html", url], {
        encoding: "utf8", timeout: 60_000, maxBuffer: 20_000_000,
      });
      return out;
    } catch { return ""; }
  };
  const home = await fetchPage(`https://${domain}`);
  const $ = cheerio.load(home || "<html></html>");
  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (/career|jobs|join|hiring|work-with/i.test(href)) {
      try { links.add(new URL(href, `https://${domain}`).toString()); } catch {}
    }
  });
  for (const guess of [`https://${domain}/careers`, `https://${domain}/jobs`]) links.add(guess);
  let all = home;
  for (const link of [...links].slice(0, 4)) all += await fetchPage(link);
  return all;
}

export async function resolve(name: string, domain: string | undefined, db: Database.Database): Promise<Resolved> {
  const key = `resolve:${domain ?? alnum(name)}`;
  const hit = db.prepare("SELECT result FROM lookups WHERE key = ?").get(key) as { result: string } | undefined;
  if (hit) return JSON.parse(hit.result);

  // An empty board is a fallback, not an answer (n8n lesson: a stale Workable
  // account with 0 jobs must not stop the ladder).
  let result: Resolved | null = null;
  let fallback: Resolved | null = null;
  for (const slug of slugGuesses(name)) {
    const r = await probeSlug(name, slug);
    if (r && r.jobs > 0) { result = r; break; }
    if (r) fallback ??= r;
  }
  if (!result && domain) result = grepTokens(await careersHtml(domain, false));
  // RESOLVER_MAX_RUNG=2 skips the rendered fallback — it costs 5 TinyFish
  // fetches per company and (measured 2 Sep 2026, 364 companies) found ~nothing
  // the free rungs missed. Use it for bulk sweeps.
  if (!result && domain && process.env.TINYFISH_API_KEY && process.env.RESOLVER_MAX_RUNG !== "2") {
    const r = grepTokens(await careersHtml(domain, true));
    if (r) result = { ...r, rung: 3 };
  }
  const final = result ?? fallback ?? { ats: "none_found" as const, rung: 3 };

  db.prepare("INSERT OR REPLACE INTO lookups (key, provider, result, cost) VALUES (?, 'resolver', ?, 0)")
    .run(key, JSON.stringify(final));
  db.prepare(
    `INSERT INTO companies (domain, name, ats, ats_token, source) VALUES (?, ?, ?, ?, 'resolver')
     ON CONFLICT(domain) DO UPDATE SET ats=excluded.ats, ats_token=excluded.ats_token`,
  ).run(domain ?? alnum(name), name, final.ats, final.token ?? null);
  return final;
}
