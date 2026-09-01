import { execFileSync } from "node:child_process";
import { z } from "zod";
import type Database from "better-sqlite3";
import { extract } from "../llm.ts";
import type { JobSource } from "./source.ts";
import type { Posting, Profile } from "../types.ts";

// VC portfolio job boards — every company is funded by definition (motion B
// pre-packaged). SPA pages, so: TinyFish Fetch renders → the FREE model parses
// the page text into postings. Zero cost end to end.
//
// Each entry is one fetch+parse (~40s). Queries come from the profile's top
// role titles; VC_QUERIES caps how many per board per run.

const BOARDS = [
  { board: "a16z", make: (q: string) => `https://jobs.a16z.com/jobs?q=${encodeURIComponent(q)}` },
  // add more boards as one-liners, e.g. Sequoia/Lightspeed once their URL scheme is probed
];

const Parsed = z.object({
  jobs: z.array(z.object({
    company: z.string(),
    title: z.string(),
    location: z.string().nullable(),
    salary: z.string().nullable(),
    posted_days_ago: z.number().nullable(),
  })).max(25),
});
const EXAMPLE = { jobs: [{ company: "Exa", title: "Developer Advocate", location: "San Francisco, CA", salary: "USD 130,000-230,000 / Year", posted_days_ago: 30 }] };

function tinyfishFetch(url: string): { text: string; links: string[] } {
  const out = execFileSync("tinyfish", ["fetch", "content", "get", "--links", "--format", "markdown", url], {
    encoding: "utf8", timeout: 90_000, maxBuffer: 20_000_000,
  });
  const r = JSON.parse(out)?.results?.[0] ?? {};
  return { text: r.text ?? "", links: (r.links ?? []).map((l: any) => (typeof l === "string" ? l : l?.url ?? "")) };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export function makeVcSource(db?: Database.Database): JobSource {
  return {
    name: "vc-boards",
    async fetchPostings(profile: Profile) {
      const nQueries = Number(process.env.VC_QUERIES ?? 4);
      const out: Posting[] = [];
      for (const b of BOARDS) {
        for (const q of profile.role_titles.slice(0, nQueries)) {
          let page;
          try { page = tinyfishFetch(b.make(q)); } catch { continue; }
          if (page.text.length < 500) continue;
          let parsed;
          try {
            parsed = extract(Parsed,
              `Extract every job listing from this VC portfolio job-board page. posted_days_ago: convert "8 hours ago"→0, "3 days ago"→3, "a month ago"→30, null if absent.`,
              page.text.slice(0, 9000),
              { tier: "light", retries: 2, escalate: false, db, example: EXAMPLE });
          } catch { continue; }
          for (const j of parsed.jobs) {
            const companySlug = slug(j.company);
            const link = page.links.find((l) => l.includes(`/${companySlug}/`) || l.includes(`companies/${companySlug}`));
            out.push({
              source: `vc:${b.board}`,
              company: j.company,
              title: j.title,
              url: link ?? `${b.make(q)}#${companySlug}`,
              location: j.location ?? "",
              remote: /remote/i.test(j.location ?? ""),
              posted_at: j.posted_days_ago != null
                ? new Date(Date.now() - j.posted_days_ago * 86_400_000).toISOString()
                : undefined,
              description: [j.salary, j.location].filter(Boolean).join(" · "),
            });
          }
        }
      }
      return out;
    },
  };
}
