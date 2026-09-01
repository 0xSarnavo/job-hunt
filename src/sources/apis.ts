import { getJson, postJson } from "../http.ts";
import type { JobSource } from "./source.ts";
import type { Posting, Profile } from "../types.ts";
import { stripHtml } from "./feeds.ts";

// Adzuna: ~1,000 calls/mo. One call per top role title, India endpoint,
// freshness pushed server-side via max_days_old (TOOLING step 4).
export const adzuna: JobSource = {
  name: "adzuna",
  async fetchPostings(profile: Profile) {
    const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
    if (!id || !key) return [];
    const out: Posting[] = [];
    for (const rt of profile.role_titles.slice(0, Number(process.env.ADZUNA_QUERIES ?? 6))) {
      const d = await getJson(
        `https://api.adzuna.com/v1/api/jobs/in/search/1?app_id=${id}&app_key=${key}` +
          `&results_per_page=50&what_phrase=${encodeURIComponent(rt)}` +
          `&max_days_old=${profile.max_posting_age_days}&sort_by=date`,
      );
      for (const j of d?.results ?? [])
        out.push({
          source: "adzuna",
          company: j.company?.display_name ?? "?",
          title: j.title?.replace(/<\/?[^>]+>/g, "") ?? "?",
          url: j.redirect_url,
          location: j.location?.display_name ?? "",
          posted_at: j.created,
          description: stripHtml(j.description),
        });
    }
    return out;
  },
};

// Jooble: 500 requests TOTAL on the current grant — two queries per run, no more.
export const jooble: JobSource = {
  name: "jooble",
  async fetchPostings(profile: Profile) {
    const key = process.env.JOOBLE_API_KEY;
    if (!key) return [];
    const out: Posting[] = [];
    for (const rt of profile.role_titles.slice(0, Number(process.env.JOOBLE_QUERIES ?? 2))) {
      const d = await postJson(`https://jooble.org/api/${key}`, {
        keywords: rt,
        location: "remote",
      });
      for (const j of d?.jobs ?? [])
        out.push({
          source: "jooble",
          company: j.company || "?",
          title: j.title ?? "?",
          url: j.link,
          location: j.location || "remote",
          posted_at: j.updated,
          description: stripHtml(j.snippet),
        });
    }
    return out;
  },
};
