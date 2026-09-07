import { getText } from "../http.ts";
import type { JobSource } from "./source.ts";
import type { Posting, Profile } from "../types.ts";
import { stripHtml } from "./feeds.ts";

// Slug-addressable job boards that server-render their listings into a Next.js
// __NEXT_DATA__ blob. That blob is already structured JSON, so unlike the VC
// boards (../vc.ts) these need no rendered fetch and no LLM parse — plain GET,
// one regex, done.
//
// Both are India-heavy, which is where the geography ladder points after
// remote-global (profile.locations: remote-global → india-remote → bengaluru
// → kolkata).
//
// The catch: a made-up slug does not error, it returns a 200 page with an
// empty job list. Guessing "developer-advocate-jobs" therefore fails silently.
// So every candidate URL is checked against the site's own sitemap first and
// only known-good ones are fetched.

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function nextData(html: string): any | null {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try { return JSON.parse(m[1]!); } catch { return null; }
}

// Every <loc> path under /jobs/, as a set of bare slugs. Fetched once per run
// per board; the sitemaps are a few MB so they get a longer timeout.
async function jobSlugs(sitemapUrl: string, prefix: string): Promise<Set<string>> {
  const xml = await getText(sitemapUrl, 60_000);
  if (!xml) return new Set();
  const out = new Set<string>();
  for (const m of xml.matchAll(/<loc>([^<]*)<\/loc>/g)) {
    const path = m[1]!.split(prefix)[1];
    if (path && !path.includes("/")) out.add(path);
  }
  return out;
}

// Candidate slugs for one role title, best first: the plain role board, then
// the same role narrowed to each geography the profile ranks.
function candidates(role: string, geos: string[]): string[] {
  const r = slug(role);
  return [`${r}-jobs`, ...geos.map((g) => `${r}-jobs-in-${g}`)];
}

// profile.locations uses our vocabulary; each board spells places its own way.
// Unmapped entries simply produce no candidate (and anything that survives the
// mapping is still sitemap-checked), so a wrong guess costs nothing.
const CUTSHORT_GEO: Record<string, string[]> = {
  "bengaluru": ["bangalore-bengaluru"],
  "kolkata": ["kolkata"],
};
const WEEKDAY_GEO: Record<string, string[]> = {
  "remote-global": ["india-remote"], // Weekday is India-centric; no global board
  "india-remote": ["india-remote"],
  "bengaluru": ["bengaluru"],
  "kolkata": ["kolkata"],
};

const geosFor = (profile: Profile, map: Record<string, string[]>) =>
  [...new Set(profile.locations.flatMap((l) => map[l] ?? []))];

// Pick the URLs to fetch: role × geography, keep only sitemap-known slugs,
// cap the total so a long role_titles list cannot blow up a daily run.
function planUrls(profile: Profile, known: Set<string>, geos: string[], base: string, cap: number) {
  const urls: string[] = [];
  for (const role of profile.role_titles) {
    for (const c of candidates(role, geos)) {
      if (known.has(c) && !urls.includes(base + c)) urls.push(base + c);
      if (urls.length >= cap) return urls;
    }
  }
  return urls;
}

// ---------------------------------------------------------------- cutshort
// Indian market, skills-indexed (no "developer advocate" — it indexes
// marketing-jobs, growth-hacking-jobs, community-management-jobs, ...).
// Listings carry no posted date anywhere in the payload, so posted_at stays
// unset. That is survivable but not free: score.ts skips the staleness reject
// when posted_at is absent (so these are never dropped as stale) but they also
// never earn the freshness bonus, so Cutshort hits rank slightly below dated
// ones. If Cutshort ever starts stale-flooding, filter it on the detail page.
export const cutshort: JobSource = {
  name: "cutshort",
  async fetchPostings(profile: Profile) {
    const known = await jobSlugs(
      "https://cutshort-data.s3.amazonaws.com/cloudfront/public/listings-sitemap.xml",
      "cutshort.io/jobs/",
    );
    if (!known.size) return [];
    const urls = planUrls(profile, known, geosFor(profile, CUTSHORT_GEO),
      "https://cutshort.io/jobs/", Number(process.env.CUTSHORT_PAGES ?? 6));

    const out: Posting[] = [];
    for (const url of urls) {
      const html = await getText(url, 40_000);
      if (!html) continue;
      const d = nextData(html);
      const q = (d?.props?.pageProps?.dehydratedState?.queries ?? [])
        .find((x: any) => String(x?.queryKey).includes("jobListData"));
      for (const j of q?.state?.data?.data?.pageData?.jobs ?? []) {
        if (!j?.headline || !j?.publicUrl) continue;
        out.push({
          source: "cutshort",
          company: j.companyDetails?.name ?? j.companyId?.name ?? "?",
          title: j.headline,
          url: j.publicUrl,
          location: j.locationsText ?? (j.locations ?? []).join(", "),
          remote: j.remoteType === "remote_okay" || j.remoteType === "remote_only",
          description: [j.salaryRangeText, (j.allSkills ?? []).join(", "), stripHtml(j.sanitizedComment)]
            .filter(Boolean).join(" · ").slice(0, 4000),
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------- weekday
// The richest of the four: each listing carries companyDomain and a jdLink
// that usually points at the company's real ATS (Greenhouse, Lever, ...), so
// these postings feed the ATS resolver as well as the jobs table.
export const weekday: JobSource = {
  name: "weekday",
  async fetchPostings(profile: Profile) {
    const known = await jobSlugs("https://www.weekday.works/sitemap.xml", "weekday.works/jobs/");
    if (!known.size) return [];
    const urls = planUrls(profile, known, geosFor(profile, WEEKDAY_GEO),
      "https://www.weekday.works/jobs/", Number(process.env.WEEKDAY_PAGES ?? 6));

    const out: Posting[] = [];
    for (const url of urls) {
      const html = await getText(url, 40_000);
      if (!html) continue;
      for (const j of nextData(html)?.props?.pageProps?.jobs ?? []) {
        const title = j?.role ?? j?.rawTitle;
        const link = j?.jdLink ?? j?.careersPageLink ?? j?.directJobLink;
        if (!title || !link) continue;
        const location = Array.isArray(j.location) ? j.location.join(", ") : (j.location ?? "");
        out.push({
          source: "weekday",
          company: j.companyName ?? "?",
          company_domain: j.companyDomain || undefined,
          title: String(title).trim(),
          url: link,
          location,
          remote: /remote/i.test(`${location} ${j.workModel ?? ""}`),
          posted_at: j.jdAddedOn ?? j.addedOn,
          description: [j.compensation, (j.skills ?? []).join(", "), j.jobDetailsFromCompany]
            .filter(Boolean).join(" · ").slice(0, 4000),
        });
      }
    }
    return out;
  },
};
