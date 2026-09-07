import Parser from "rss-parser";
import * as cheerio from "cheerio";
import { getJson, getText } from "../http.ts";
import type { JobSource } from "./source.ts";
import type { Posting } from "../types.ts";

export const stripHtml = (html: string | undefined): string =>
  html ? cheerio.load(html).text().replace(/\s+/g, " ").trim().slice(0, 4000) : "";

export const remotive: JobSource = {
  name: "remotive",
  async fetchPostings() {
    const d = await getJson("https://remotive.com/api/remote-jobs?limit=800");
    return (d?.jobs ?? []).map((j: any): Posting => ({
      source: "remotive",
      company: j.company_name ?? "?",
      title: j.title ?? "?",
      url: j.url,
      location: j.candidate_required_location || "remote",
      remote: true,
      posted_at: j.publication_date,
      description: stripHtml(j.description),
    }));
  },
};

export const remoteok: JobSource = {
  name: "remoteok",
  async fetchPostings() {
    const d = await getJson("https://remoteok.com/api");
    if (!Array.isArray(d)) return [];
    return d.filter((j: any) => j?.position && j?.url).map((j: any): Posting => ({
      source: "remoteok", // attribution requirement: links go back to remoteok.com
      company: j.company ?? "?",
      title: j.position,
      url: j.url,
      location: j.location || "remote",
      remote: true,
      posted_at: j.date,
      description: stripHtml(j.description),
    }));
  },
};

export const arbeitnow: JobSource = {
  name: "arbeitnow",
  async fetchPostings() {
    const out: Posting[] = [];
    let url = "https://www.arbeitnow.com/api/job-board-api";
    const pages = Number(process.env.ARBEITNOW_PAGES ?? 2); // daily runs: first pages only
    for (let page = 0; page < pages && url; page++) {
      const d = await getJson(url);
      for (const j of d?.data ?? [])
        out.push({
          source: "arbeitnow",
          company: j.company_name ?? "?",
          title: j.title ?? "?",
          url: j.url,
          location: j.location || (j.remote ? "remote" : ""),
          remote: !!j.remote,
          posted_at: j.created_at ? new Date(j.created_at * 1000).toISOString() : undefined,
          description: stripHtml(j.description),
        });
      url = d?.links?.next;
    }
    return out;
  },
};

export const weworkremotely: JobSource = {
  name: "weworkremotely",
  async fetchPostings() {
    const xml = await getText("https://weworkremotely.com/remote-jobs.rss");
    if (!xml) return [];
    const feed = await new Parser().parseString(xml);
    return (feed.items ?? []).flatMap((i): Posting[] => {
      const m = /^(.*?):\s*(.*)$/.exec(i.title ?? "");
      if (!m || !i.link) return [];
      return [{
        source: "weworkremotely",
        company: m[1]!.trim(),
        title: m[2]!.trim(),
        url: i.link,
        location: "remote",
        remote: true,
        posted_at: i.isoDate,
        description: stripHtml(i.content ?? i.contentSnippet),
      }];
    });
  },
};

// Working Nomads exposes its live board as a plain JSON array — no key, no
// paging params (the endpoint returns the current window, ~45 jobs). Every
// listing is 100% remote by definition of the site, so remote is always true.
export const workingnomads: JobSource = {
  name: "workingnomads",
  async fetchPostings() {
    const d = await getJson("https://www.workingnomads.com/api/exposed_jobs/");
    if (!Array.isArray(d)) return [];
    return d.filter((j: any) => j?.title && j?.url).map((j: any): Posting => ({
      source: "workingnomads",
      company: j.company_name || "?",
      title: j.title,
      url: j.url,
      location: j.location || "remote", // e.g. "WORLDWIDE", "USA Only"
      remote: true,
      posted_at: j.pub_date,
      description: stripHtml(j.description),
    }));
  },
};

// Jobspresso runs WP Job Manager: its job_feed accepts posts_per_page (the
// WordPress name — per_page/showposts are ignored and silently give 10).
// Company and location are packed into one dc:creator field as
// "Company<br>⚲&nbsp;Location".
export const jobspresso: JobSource = {
  name: "jobspresso",
  async fetchPostings() {
    const n = Number(process.env.JOBSPRESSO_POSTS ?? 100);
    const xml = await getText(`https://jobspresso.co/?feed=job_feed&posts_per_page=${n}`);
    if (!xml) return [];
    const feed = await new Parser().parseString(xml);
    return (feed.items ?? []).flatMap((i: any): Posting[] => {
      if (!i.link || !i.title) return [];
      const [companyRaw, locRaw] = String(i.creator ?? "").split(/<br\s*\/?>/i);
      const location = stripHtml(locRaw).replace(/^[⚲\s ]+/, "").trim();
      return [{
        source: "jobspresso",
        company: stripHtml(companyRaw).trim() || "?",
        title: i.title.trim(),
        url: i.link,
        location: location || "remote",
        remote: true, // Jobspresso is a remote-only board
        posted_at: i.isoDate,
        description: stripHtml(i["content:encoded"] ?? i.content ?? i.contentSnippet),
      }];
    });
  },
};

// HN "Who is hiring" — find the latest monthly thread, parse top-level comments.
// Convention: first line is "Company | Role | Location | ...".
export const hnWhoIsHiring: JobSource = {
  name: "hn",
  async fetchPostings() {
    const search = await getJson(
      "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10",
    );
    // Current month's thread opens nearly empty — take the latest two threads;
    // the jobs table PK dedupes overlap across runs.
    const stories = (search?.hits ?? []).filter((h: any) => /who is hiring/i.test(h.title ?? "")).slice(0, 2);
    const out: Posting[] = [];
    for (const story of stories) {
    const item = await getJson(`https://hn.algolia.com/api/v1/items/${story.objectID}`, 120_000);
    for (const c of item?.children ?? []) {
      if (!c?.text) continue;
      const text = stripHtml(c.text);
      const header = text.split(/[.\n]/)[0] ?? "";
      const parts = header.split("|").map((s: string) => s.trim());
      if (parts.length < 2 || parts[0]!.length > 60) continue;
      out.push({
        source: "hn",
        company: parts[0]!,
        title: parts[1]!,
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        location: parts.slice(2).find((p: string) => /remote|onsite|hybrid|,/i.test(p)) ?? "",
        remote: /remote/i.test(text.slice(0, 300)),
        posted_at: c.created_at,
        description: text,
      });
    }
    }
    return out;
  },
};
