// Single source of truth for the two CRM directory objects:
//   Job Portals — every place the pipeline pulls job postings / funding signals from
//   Investor Portfolios — accelerators & VC programs whose member companies we track
// scripts/12-portfolios.mts seeds these into Twenty and keeps counts fresh.

export type PortalKind = "ATS_API" | "FEED" | "AGGREGATOR_API" | "VC_BOARD" | "FUNDING_RSS" | "SCRAPE" | "COMPANY_BOARD";
export type PortalStatus = "ACTIVE" | "PLANNED" | "LATER";

export interface Portal {
  slug: string;          // matches jobs.source / companies.source prefixes in SQLite
  name: string;
  url: string;
  kind: PortalKind;
  status: PortalStatus;
  gives: string;         // what this portal contributes to the pipeline
}

export const PORTALS: Portal[] = [
  { slug: "greenhouse", name: "Greenhouse", url: "https://boards.greenhouse.io", kind: "ATS_API", status: "ACTIVE", gives: "a company's live job board, public JSON API" },
  { slug: "lever", name: "Lever", url: "https://jobs.lever.co", kind: "ATS_API", status: "ACTIVE", gives: "a company's live job board, public JSON API" },
  { slug: "ashby", name: "Ashby", url: "https://jobs.ashbyhq.com", kind: "ATS_API", status: "ACTIVE", gives: "a company's live job board, public JSON API" },
  { slug: "workable", name: "Workable", url: "https://apply.workable.com", kind: "ATS_API", status: "ACTIVE", gives: "a company's live job board, public JSON API" },
  { slug: "smartrecruiters", name: "SmartRecruiters", url: "https://careers.smartrecruiters.com", kind: "ATS_API", status: "ACTIVE", gives: "a company's live job board, public JSON API" },
  { slug: "remotive", name: "Remotive", url: "https://remotive.com", kind: "FEED", status: "ACTIVE", gives: "remote jobs feed, open JSON" },
  { slug: "remoteok", name: "RemoteOK", url: "https://remoteok.com", kind: "FEED", status: "ACTIVE", gives: "remote jobs feed, open JSON (attribution required)" },
  { slug: "arbeitnow", name: "Arbeitnow", url: "https://arbeitnow.com", kind: "FEED", status: "ACTIVE", gives: "remote/Europe-lean feed, open JSON" },
  { slug: "hn", name: "HN Who is hiring", url: "https://news.ycombinator.com", kind: "FEED", status: "ACTIVE", gives: "monthly thread, high-signal startup jobs (Algolia API)" },
  { slug: "weworkremotely", name: "We Work Remotely", url: "https://weworkremotely.com", kind: "FEED", status: "ACTIVE", gives: "remote jobs, strong marketing/devrel categories (RSS)" },
  { slug: "adzuna", name: "Adzuna", url: "https://www.adzuna.com", kind: "AGGREGATOR_API", status: "ACTIVE", gives: "big aggregate board incl. India, free API ~1000 calls/mo" },
  { slug: "jooble", name: "Jooble", url: "https://jooble.org", kind: "AGGREGATOR_API", status: "ACTIVE", gives: "widest country coverage, free API" },
  { slug: "vc:yc", name: "YC Jobs board", url: "https://www.ycombinator.com/jobs", kind: "VC_BOARD", status: "ACTIVE", gives: "YC company jobs by role; every company funded by definition" },
  { slug: "vc:a16z", name: "a16z Jobs board", url: "https://jobs.a16z.com", kind: "VC_BOARD", status: "ACTIVE", gives: "a16z portfolio jobs, searchable, salary + direct ATS links" },
  { slug: "funded", name: "Funding RSS bundle", url: "https://techcrunch.com/category/venture/", kind: "FUNDING_RSS", status: "ACTIVE", gives: "who just raised, worldwide: TechCrunch, Crunchbase News, FinSMEs, Entrackr, Inc42, Sifted, Tech.eu, EU-Startups, Startup Daily (AU) — feeds motion B" },
  { slug: "resolver", name: "Company careers pages", url: "https://tinyfish.ai", kind: "SCRAPE", status: "ACTIVE", gives: "rendered careers pages for companies on no known board" },
  { slug: "vc-list:yc", name: "YC directory (yc-oss API)", url: "https://yc-oss.github.io/api", kind: "VC_BOARD", status: "ACTIVE", gives: "latest YC batches as pitch targets, free JSON" },
  { slug: "wellfound", name: "Wellfound", url: "https://wellfound.com", kind: "SCRAPE", status: "PLANNED", gives: "startup jobs; heavy anti-bot, test cheaply first" },
  { slug: "sequoia-jobs", name: "Sequoia Jobs board", url: "https://jobs.sequoiacap.com", kind: "VC_BOARD", status: "PLANNED", gives: "Sequoia portfolio jobs" },
  { slug: "lightspeed-jobs", name: "Lightspeed Jobs board", url: "https://jobs.lsvp.com", kind: "VC_BOARD", status: "PLANNED", gives: "Lightspeed portfolio jobs" },
  { slug: "naukri", name: "Naukri / Instahyre / Cutshort", url: "https://www.naukri.com", kind: "SCRAPE", status: "LATER", gives: "India volume; login-walled scraping" },
  { slug: "otta", name: "Otta / Welcome to the Jungle", url: "https://otta.com", kind: "SCRAPE", status: "LATER", gives: "curated startup jobs; login-walled" },
  { slug: "linkedin", name: "LinkedIn Jobs", url: "https://www.linkedin.com/jobs", kind: "SCRAPE", status: "LATER", gives: "best people-linkage; own browser session only" },
];

export type PortfolioKind = "ACCELERATOR" | "VC" | "DIRECTORY";
export type ScrapeStatus = "SCRAPED" | "PLANNED";

export interface Portfolio {
  slug: string;          // portfolio_companies.program key
  name: string;
  kind: PortfolioKind;
  site: string;
  portfolioUrl: string;
  jobsBoardUrl?: string;
  scrape: ScrapeStatus;
  notes: string;
}

export const PORTFOLIOS: Portfolio[] = [
  { slug: "yc", name: "Y Combinator", kind: "ACCELERATOR", site: "https://www.ycombinator.com", portfolioUrl: "https://yc-oss.github.io/api/companies/all.json", jobsBoardUrl: "https://www.workatastartup.com", scrape: "SCRAPED", notes: "full directory via yc-oss mirror (free JSON, refreshed daily); all batches stored locally, recent batches pushed to CRM" },
  { slug: "a16z", name: "Andreessen Horowitz (a16z)", kind: "VC", site: "https://a16z.com", portfolioUrl: "https://a16z.com/portfolio/", jobsBoardUrl: "https://jobs.a16z.com", scrape: "SCRAPED", notes: "portfolio page embeds the full company list as JSON — parsed directly, active companies pushed to CRM" },
  { slug: "a16z-speedrun", name: "a16z Speedrun", kind: "ACCELERATOR", site: "https://speedrun.a16z.com", portfolioUrl: "https://speedrun.a16z.com/companies", scrape: "PLANNED", notes: "a16z's games/consumer accelerator" },
  { slug: "sequoia", name: "Sequoia Capital", kind: "VC", site: "https://www.sequoiacap.com", portfolioUrl: "https://www.sequoiacap.com/our-companies/", jobsBoardUrl: "https://jobs.sequoiacap.com", scrape: "PLANNED", notes: "site bot-walls plain fetches; needs rendered scrape (tinyfish/firecrawl)" },
  { slug: "peak-xv", name: "Peak XV Partners (ex Sequoia India)", kind: "VC", site: "https://www.peakxv.com", portfolioUrl: "https://www.peakxv.com/companies/", scrape: "PLANNED", notes: "India + SEA — geography fit" },
  { slug: "lightspeed", name: "Lightspeed Venture Partners", kind: "VC", site: "https://lsvp.com", portfolioUrl: "https://lsvp.com/portfolio/", jobsBoardUrl: "https://jobs.lsvp.com", scrape: "PLANNED", notes: "" },
  { slug: "accel", name: "Accel", kind: "VC", site: "https://www.accel.com", portfolioUrl: "https://www.accel.com/relationships", jobsBoardUrl: "https://jobs.accel.com", scrape: "PLANNED", notes: "strong India practice" },
  { slug: "index-ventures", name: "Index Ventures", kind: "VC", site: "https://www.indexventures.com", portfolioUrl: "https://www.indexventures.com/companies/", scrape: "PLANNED", notes: "" },
  { slug: "greylock", name: "Greylock", kind: "VC", site: "https://greylock.com", portfolioUrl: "https://greylock.com/companies/", jobsBoardUrl: "https://jobs.greylock.com", scrape: "PLANNED", notes: "" },
  { slug: "techstars", name: "Techstars", kind: "ACCELERATOR", site: "https://www.techstars.com", portfolioUrl: "https://www.techstars.com/portfolio", scrape: "PLANNED", notes: "huge portfolio; filter hard before pushing" },
  { slug: "500-global", name: "500 Global", kind: "ACCELERATOR", site: "https://500.co", portfolioUrl: "https://500.co/companies", scrape: "PLANNED", notes: "" },
  { slug: "neo", name: "Neo", kind: "ACCELERATOR", site: "https://neo.com", portfolioUrl: "https://neo.com/companies", scrape: "PLANNED", notes: "small, high-quality cohorts" },
  { slug: "ai-grant", name: "AI Grant", kind: "ACCELERATOR", site: "https://aigrant.org", portfolioUrl: "https://aigrant.org", scrape: "PLANNED", notes: "AI-native startups — strong profile fit" },
  { slug: "south-park-commons", name: "South Park Commons", kind: "ACCELERATOR", site: "https://www.southparkcommons.com", portfolioUrl: "https://www.southparkcommons.com/community", scrape: "PLANNED", notes: "" },
  { slug: "antler", name: "Antler", kind: "ACCELERATOR", site: "https://www.antler.co", portfolioUrl: "https://www.antler.co/portfolio", scrape: "PLANNED", notes: "has India cohorts" },
  { slug: "entrepreneur-first", name: "Entrepreneur First", kind: "ACCELERATOR", site: "https://www.joinef.com", portfolioUrl: "https://www.joinef.com/companies/", scrape: "PLANNED", notes: "has Bengaluru cohorts" },
  { slug: "blume", name: "Blume Ventures", kind: "VC", site: "https://blume.vc", portfolioUrl: "https://blume.vc/portfolio", scrape: "PLANNED", notes: "India early-stage" },
  { slug: "blr-map", name: "Bangalore Startup Map", kind: "DIRECTORY", site: "https://www.bangalorestartupmap.com", portfolioUrl: "https://www.bangalorestartupmap.com/", scrape: "SCRAPED", notes: "880+ Bengaluru startups + 70 VCs with stage/sector/founders — geography fit; startups parsed from the page's embedded JSON" },
];
