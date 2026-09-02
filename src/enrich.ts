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
