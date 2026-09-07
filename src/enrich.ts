import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { track } from "./usage.ts";

// Shared enrichment helpers. Everything cached forever in `lookups`.

export function cacheGet(db: Database.Database, key: string): any | null {
  const hit = db.prepare("SELECT result FROM lookups WHERE key = ?").get(key) as any;
  return hit ? JSON.parse(hit.result) : null;
}
export function cachePut(db: Database.Database, key: string, provider: string, result: unknown, cost = 0) {
  db.prepare("INSERT OR REPLACE INTO lookups (key, provider, result, cost) VALUES (?, ?, ?, ?)")
    .run(key, provider, JSON.stringify(result), cost);
}

// domain via TinyFish search (free)
export function companyDomain(db: Database.Database, company: string): string | null {
  const key = `domain:${company.toLowerCase()}`;
  const hit = cacheGet(db, key);
  if (hit) return hit.domain;
  let domain: string | null = null;
  try {
    track("tinyfish-search");
    const out = execFileSync("tinyfish", ["search", "query", `${company} official website`], { encoding: "utf8", timeout: 60_000 });
    const m = out.match(/https?:\/\/(?:www\.)?([a-z0-9-]+\.[a-z.]{2,10})\//i);
    if (m && !/linkedin|wikipedia|crunchbase|twitter|facebook|youtube|github/.test(m[1]!)) domain = m[1]!;
  } catch {}
  cachePut(db, key, "tinyfish-search", { domain });
  return domain;
}

export interface YcFounder {
  name: string;
  title: string;
  linkedin_url: string;
}

function decodeEntities(s: string): string {
  return s.replaceAll("&quot;", '"').replaceAll("&amp;", "&")
    .replaceAll("&#039;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

// bracket-match a JSON array starting at `start` (handles nested []/{} and strings)
function jsonArrayAt(text: string, start: number): any[] | null {
  let depth = 0, inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (ch === "\\") i++; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)) as any[]; }
        catch { return null; }
      }
    }
  }
  return null;
}

// YC board founders — free exact data (names, titles, LinkedIn) from the
// public ycombinator.com company page. Plain HTTP, no vendor credits, cached forever.
export async function ycFounders(db: Database.Database, slug: string): Promise<YcFounder[]> {
  const key = `yc:founders:${slug.toLowerCase()}`;
  const hit = cacheGet(db, key);
  if (hit) return hit.founders ?? [];
  let founders: YcFounder[] = [];
  try {
    await new Promise((r) => setTimeout(r, 500)); // be polite to ycombinator.com
    const res = await fetch(`https://www.ycombinator.com/companies/${slug}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: AbortSignal.timeout(45_000),
    });
    if (res.ok) {
      const text = decodeEntities(await res.text());
      const i = text.indexOf('"founders":[');
      if (i !== -1) {
        const arr = jsonArrayAt(text, text.indexOf("[", i));
        founders = (arr ?? [])
          .map((f: any) => ({
            name: String(f.full_name ?? f.name ?? "").trim(),
            title: String(f.title ?? "Co-Founder").slice(0, 120),
            linkedin_url: String(f.linkedin_url ?? ""),
          }))
          .filter((p: YcFounder) => p.name && /linkedin\.com\/in\//i.test(p.linkedin_url));
      }
    }
  } catch {}
  cachePut(db, key, "yc-board", { founders });
  return founders;
}

export interface OrgInfo {
  headcount: number | null;
  founded: number | null;
  funding_stage: string | null;
  funding_date: string | null; // ISO
  funding_total: string | null;
  industry: string | null;
}

// Apollo organizations/enrich — free tier, 600/day, the one Apollo endpoint we have
export async function apolloEnrich(db: Database.Database, domain: string): Promise<OrgInfo | null> {
  const key = `apollo:org:${domain}`;
  const hit = cacheGet(db, key);
  if (hit) return hit.org ?? null;
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;
  try {
    track("apollo");
    const res = await fetch(`https://api.apollo.io/api/v1/organizations/enrich?domain=${domain}`, {
      headers: { "X-Api-Key": apiKey }, signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) { cachePut(db, key, "apollo", { org: null }); return null; }
    const o = ((await res.json()) as any)?.organization;
    const org: OrgInfo | null = o ? {
      headcount: o.estimated_num_employees ?? null,
      founded: o.founded_year ?? null,
      funding_stage: o.latest_funding_stage ?? null,
      funding_date: o.latest_funding_round_date ?? null,
      funding_total: o.total_funding_printed ?? null,
      industry: o.industry ?? null,
    } : null;
    cachePut(db, key, "apollo", { org }, 1);
    return org;
  } catch { return null; }
}
