import { getJson } from "../http.ts";
import type { Posting } from "../types.ts";
import { stripHtml } from "./feeds.ts";

// Per-company public JSON boards (PLAN §1). Each returns live postings for one
// verified {ats, token} — the resolver (../resolver.ts) supplies those.

export type AtsKind = "greenhouse" | "lever" | "ashby" | "workable" | "smartrecruiters";

export async function fetchBoard(ats: AtsKind, token: string, company: string): Promise<Posting[]> {
  switch (ats) {
    case "greenhouse": {
      const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
      return (d?.jobs ?? []).map((j: any): Posting => ({
        source: `greenhouse:${token}`, company, title: j.title, url: j.absolute_url,
        location: j.location?.name ?? "", posted_at: j.updated_at, description: stripHtml(j.content),
      }));
    }
    case "lever": {
      const d = await getJson(`https://api.lever.co/v0/postings/${token}?mode=json`);
      return (Array.isArray(d) ? d : []).map((j: any): Posting => ({
        source: `lever:${token}`, company, title: j.text, url: j.hostedUrl,
        location: j.categories?.location ?? "", remote: /remote/i.test(j.workplaceType ?? j.categories?.location ?? ""),
        posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
        description: (j.descriptionPlain ?? "").slice(0, 4000),
      }));
    }
    case "ashby": {
      const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${token}`);
      return (d?.jobs ?? []).map((j: any): Posting => ({
        source: `ashby:${token}`, company, title: j.title, url: j.jobUrl ?? j.applyUrl,
        location: j.location ?? "", remote: !!j.isRemote,
        posted_at: j.publishedAt, description: stripHtml(j.descriptionHtml),
      }));
    }
    case "workable": {
      const d = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${token}`);
      return (d?.jobs ?? []).map((j: any): Posting => ({
        source: `workable:${token}`, company: d?.name ?? company, title: j.title, url: j.url,
        location: [j.city, j.country].filter(Boolean).join(", "),
        remote: /remote/i.test(j.workplace ?? ""), posted_at: j.published_on, description: "",
      }));
    }
    case "smartrecruiters": {
      const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${token}/postings`);
      return (d?.content ?? []).map((j: any): Posting => ({
        source: `smartrecruiters:${token}`, company, title: j.name,
        url: j.applyUrl ?? `https://jobs.smartrecruiters.com/${token}/${j.id}`,
        location: [j.location?.city, j.location?.country].filter(Boolean).join(", "),
        remote: !!j.location?.remote, posted_at: j.releasedDate, description: "",
      }));
    }
  }
}
