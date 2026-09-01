# Tooling — per build-order step

**Reader:** whoever writes the code for a §10 step.
**Job:** after reading, you know each step's tool choice, why, and what it replaced. Everything here is free — free tier, free with an account you already pay for, or open source.

Companion to PLAN.md. Step numbers are PLAN.md §10. Written 1 September 2026.

---

## 0. The ATS reality check (run 1 Sep 2026)

PLAN.md §1 claims recently funded startups are "overwhelmingly" on Greenhouse/Lever/Ashby.
Tested against two samples before writing any code:

**India — 20 companies from Entrackr's Aug 2026 weekly roundups**
(Airbound, Runable, Ringg, Yulu, Matter, InstaAstro, Centricity, TrucksUp, Vecton AI, InspeCity, Bakingo, Third Wave Coffee, Omega Seiki, Nexedge, Discovered Materials, Scrubsy, Ayati, Wippi, Lane, Asaya)

- Big-3 hits: **1/20 (5%)** — Airbound → Ashby, 11 live jobs.
- Other machine-readable ATS: Ayati → Zoho Recruit, Yulu → MyNextHire (embed JS on careers subdomain).
- Runable lists roles as first-party pages on its own site (`/careers/staff-software-engineer`, …) — scrapeable, no ATS.
- The rest: no detectable ATS; several have no functioning careers page at all.

**US/global — 13 companies from TechCrunch/TechStartups Aug 2026 coverage**
(River AI, Emerald AI, Digs, Hike Medical, Stability AI, Gatik, Liner, Celera, Airway Tx, W4 Games, Naïve, June, Alice)

- Big-3 confirmed: **5/13 (~38%)** — River AI (Greenhouse, 12 jobs), Stability AI (Greenhouse), Digs (Greenhouse), Emerald AI (Ashby), Hike Medical (Ashby). Several misses are SPA careers pages curl can't render, so the true rate for US early-stage *software* companies is plausibly 50–70%.

**Consequences (refines step 2, does not reopen it):**

1. The big-3 resolver stays step 2 — it is real for the US/remote-global slice and it's still a first-class job source for motion A.
2. For India, the free-real-time-JSON hiring check mostly does not exist. Motion B's hiring check there is a careers-page problem, not an API problem.
3. Detection must be a ladder, not a single check (see step 2 below).
4. Slug guesses collide: Workable slug `matter` is Matter.io not Matter EV; Ashby slug `river` is not River AI. **Every hit must be verified against the org name before it enters the DB.**

---

## Cross-cutting choices

| Concern | Candidates | Selected | Why |
|---|---|---|---|
| Runtime | Node LTS + tsx · Bun · Deno | **Node LTS + tsx** | one runtime that runs everything including Playwright and googleapis; Bun is nicer until step 7 needs a browser |
| SQLite | better-sqlite3 · node:sqlite · Drizzle | **better-sqlite3**, no ORM | prebuilt for macOS arm64, sync API suits a CLI; six tables don't need an ORM |
| CLI | commander · citty · yargs | **commander** | boring and ubiquitous; the CLI is eight verbs |
| Validation | zod · valibot | **zod** | one schema each for `Posting`, `Person`, `profile.yaml`; nothing exotic |
| YAML | yaml · js-yaml | **yaml** | maintained, round-trips comments |
| HTML parsing | cheerio · regex | **cheerio** | careers-link extraction needs a DOM; regex stays for ATS signature grep |
| LLM calls | OpenCode Zen free models · `claude -p` · @anthropic-ai/sdk | **two tiers behind `src/llm.ts`**: light = OpenCode free model, heavy = `claude -p` | the model is assumed weak and swappable; correctness lives in the harness — schema-constrained prompts (zod → JSON Schema), validate-and-retry with the validator's error, light→heavy escalation, forever-cache in `lookups` keyed on task+input so model swaps never churn it. Light: extraction (funding items, HN posts, careers pages). Heavy: judgement (hiring-manager inference, drafts). Needs one-time `opencode auth login` |
| Rate limiting | bottleneck · hand-rolled | **hand-rolled token bucket** (~20 lines) | one dependency saved; per-vendor limits live next to the vendor adapter |
| Scheduling | launchd · cron | **launchd** plists | native on macOS, survives reboots, per-job logs |
| HTTP | native fetch · axios · got | **native fetch** | nothing here needs more |

Rejected: **ScrapeGraphAI** — its job (LLM-extracts structured data from fetched pages) is
exactly what TinyFish Fetch + `src/llm.ts` already do, in our language; adding it means a
Python runtime for zero new capability, and its hosted API is paid. **CRM: Twenty, selected**
(decided 1 Sep 2026 — user wants human-facing tracking/stats). Deployed from the Railway
`twenty-crm` template into project `job-hunt-crm` (server + worker + Postgres + Redis):
https://twenty-production-ee00.up.railway.app — the one paid piece of the stack (Railway
hosting). Chosen over Comp AI CRM for the mature human UI; the agent side already has SQLite.
**SQLite remains the system of record** — the CRM is a one-way view: a `sync` CLI verb pushes
`companies`/`people`/`touches` into Twenty via its REST API (`TWENTY_API_KEY` + `TWENTY_URL`
in .env), built alongside step 8. Never write pipeline state into the CRM by hand; it gets
overwritten on next sync.

Rejected outright: **Monid** (monid.ai) — metered per-call billing ($1 starter credit, then $0.0013+/call, premium endpoints extra), so it fails the free constraint; its catalog (scraping, enrichment, people data) is the paid version of what the waterfall gets free; and a runtime tool-selection layer fights the cache-forever/per-field-provenance design. Revisit only as a paid gap-filler if a specific lookup repeatedly defeats the free waterfall.

---

## Step 1 — profile.yaml

**Must do:** produce the scoring target: `role_titles`, `stack`, `years`, `domains`,
`locations` (ranked list per the geography decision, not a boolean), `comp_band`,
`dealbreakers`, `proof_points`, and `max_posting_age_days: 60` — a posting older than two
months is dead; treat it as a hard filter, not a score penalty.

Not a code step. A guided interview in a Claude Code session, merging the resume (Claude
reads the PDF directly) and the official LinkedIn data export (Settings → *Get a copy of your
data* — free, no scraping). Interview wins conflicts, per PLAN §3. Output validated by the
zod schema that ships in step 3.

**The profile completes incrementally** (it is half done as of 1 Sep 2026). The pipeline must
not block on a full profile: hard filters (freshness, dealbreakers, locations) run with
whatever fields exist; scoring waits for the full profile. Missing field = filter skipped,
never crash.

## Step 2 — ATS resolver + big-3 source

**Must do:** company name/domain → which ATS, if any → normalised live postings. Per §0 the resolver is a four-rung ladder, each rung free:

1. **Slug guessing** against the big-3 JSON APIs (name variants: lowercase, hyphenated, concatenated). Verify: Greenhouse board root returns `name`; Lever/Ashby hits are confirmed via rung 2 before being trusted. Found 5/13 US companies with zero page fetches.
2. **Careers-page signature grep** — fetch homepage, extract careers link (cheerio), grep for embed signatures: `greenhouse.io | lever.co | ashbyhq.com | workable.com | smartrecruiters | zohorecruit | keka | darwinbox | mynexthire | freshteam | recruitee | breezy.hr | dover.com | gem.com`. This is how Zoho/MyNextHire were found in the India sample.
3. **Extended structured adapters**, added lazily as rung 2 discovers them in the wild. Day one: **Workable** (`apply.workable.com/api/v1/widget/accounts/{slug}` — public JSON, verified working) and **SmartRecruiters** (`api.smartrecruiters.com/v1/companies/{id}/postings` — public, returns 200 for junk slugs so check content, never status). India ATSes (Zoho Recruit, Keka, MyNextHire) get read-only page-parse adapters when a target company actually uses one.
4. **Rendered fallback** — TinyFish Fetch first (free, real browser, 1,000 URLs/day — see
   Crawl tier below), Firecrawl scrape second (1,000 credits/mo, heavier anti-bot). A company
   that defeats all four rungs is logged `ats=unknown`, which is a *note, not a lead* (PLAN §2B).

Everything through rung 3 is native fetch + cheerio + regex; rung 4 is an API call, not a
local browser. Playwright stays out of the resolver entirely.

## Step 3 — schema + match

**Must do:** the six tables from PLAN §9; deterministic rubric scoring postings against profile.yaml.

better-sqlite3, schema as one `.sql` file, WAL mode, a `PRAGMA user_version` migration counter. Scoring is plain TypeScript (title match, stack overlap, location/remote, dealbreakers as hard filters) with `claude -p` as tiebreak on borderline scores only. Score + verdict logged to `jobs.match_score` so the rubric can be rebuilt from reply data (PLAN §3).

## Step 4 — free job APIs

**Must do:** `JobSource` adapters returning normalised `Posting`s. All plain fetch behind the token bucket; every response cached in `lookups`.

| Source | Access | Note |
|---|---|---|
| Adzuna | free app id+key, ~1,000 calls/mo | has an India country endpoint |
| Jooble | free API key, **500 requests default** (their 1 Sep 2026 grant email; more on request) | widest geography — budget it: 1 query/day/geo ≈ 60–90 req/mo |
| Remotive / RemoteOK / Arbeitnow | open JSON, no key | RemoteOK requires attribution/linkback |
| HN Who's Hiring | Algolia API (`hn.algolia.com`), no key | find monthly thread → fetch comments → `claude -p` parses each into a `Posting` |

Per the geography decision, the keyless remote-global sources (Remotive, RemoteOK, Arbeitnow,
HN, big-3 boards) build first; Adzuna (India endpoint) and Jooble follow.

**Cleaning order, applied at ingestion:** normalise to `Posting` → dedupe (the same role is
cross-posted on multiple boards; key on canonical apply-URL, else normalised company+title) →
hard filters (freshness ≤ `max_posting_age_days`, ranked locations, dealbreakers) → then
score. Push filters into the source query where the API allows it — Adzuna's `max_days_old`,
Jooble's date filter — so quota is never spent fetching postings that get dropped locally.
Filtered-out postings are still recorded in `jobs` with a reject reason: that's what later
tells you a filter is too tight.

## Step 5 — people search + persona tiering

**Must do:** company → named humans matching PLAN §4's persona table, without scraping LinkedIn.

| Candidate | Free allowance | Verdict |
|---|---|---|
| TinyFish Search | free, 30 req/min · 500/hr | **selected, rung 1** — structured JSON, limits dwarf the alternatives |
| Fiber AI (api.fiber.ai) | allowance TBD — confirm before wiring | **selected, rung 2** (user decision, 1 Sep 2026) — real prospecting DB: people/company search, contact reveal, job-change monitoring; behind the cache like every vendor |
| Google Programmable Search JSON API | 100 queries/day | **selected, rung 3** — `site:linkedin.com/in "{company}" {title}` finds people legitimately |
| Brave Search API | ~2,000 queries/mo (verify current terms at signup) | **selected, rung 4** — same waterfall pattern as email |
| GitHub org members API | free | **selected** — best signal for eng leads at small startups; maps to real names via profile pages |
| Company /team /about pages | free | **selected** — fetch + LLM-light extraction |
| Apollo.io | free key verified 1 Sep 2026: all *people* endpoints locked (`API_INACCESSIBLE`), but **`organizations/enrich` works — 600 req/day, 50/min** | **selected for company enrichment, not people**: one call per domain returns headcount (feeds PLAN §4 persona tiering), industry, founded year, total funding + latest round stage/date (cross-checks motion B's RSS extraction), revenue, location. Cache forever per domain. People lookups stay manual via their UI |
| RocketReach free tier | credit-gated | rejected — covered by the above |

Hiring-manager inference (posting → likely req owner) is a `claude -p` job over the posting plus the people list; PLAN §11 already budgets for ~60% accuracy.

## Step 6 — email waterfall + verification

As PLAN §5 — the vendor table stands. No SDKs; each vendor is ~30 lines of fetch. Cache in `lookups` before any vendor is called, provenance per field.

Verification: **Reacher** (`reacherhq/backend` Docker image) locally. **Test outbound port 25 from the home connection on day one** — Indian residential ISPs commonly block it, same as cloud hosts. If blocked: MX-check + pattern-confidence only, and lean harder on vendor-side verification (Findymail doesn't charge on miss).

## Step 7 — LinkedIn queue + acceptance polling

Queue mode: CLI table output (profile URL, why-this-person, drafted <300-char note). No UI until the CLI proves insufficient.

Acceptance polling: **Playwright persistent context** (`user-data-dir` keeps the login) reading the connections list daily, diff against `touches` where `state='invited'`. Read-only, per PLAN §6. Playwright over Puppeteer: better maintained, same free. This is the step that pins the runtime to Node.

## Step 8 — Gmail drafts

**googleapis** npm (official, free), OAuth desktop flow, `gmail.compose` scope only, token cached locally. Drafts via `users.drafts.create`; you press send (PLAN §7). Templates are TypeScript template literals, one per persona — a template engine would be a dependency with no job. Personalisation content comes from `claude -p` fed the posting, the company's funding note, and `proof_points`.

## Step 9 — funding RSS

**rss-parser** npm over Entrackr / Inc42 / YourStory / TechCrunch feeds. Extraction of `{company, amount, round, date, investors, domain}` is a `claude -p` call validated by zod (PLAN §2B says LLM, not regex — correct). Then straight into the step-2 resolver. Expect the §0 India numbers: most Entrackr companies will land `ats=unknown` → notes, not leads.

## Crawl tier — Firecrawl + TinyFish (verified 1 Sep 2026)

What the two vendors actually provide, checked against their own pricing/docs:

| | TinyFish | Firecrawl |
|---|---|---|
| Free fetch | **Fetch: free forever** — 150 URLs/min, 1,000 URLs/day, real browser with JS/SPA rendering, markdown/JSON/HTML out, failed fetches don't count | 1,000 credits/**month**, 1 credit/page scrape or crawl, 2 concurrent; handles proxies/anti-bot; open-source + self-hostable |
| Free search | **Search: free forever** — 30 req/min, 500/hr, structured JSON | search costs 2 credits per 10 results — don't use |
| Metered (not used) | Agent $0.016/step, Browser $0.002/min ($8 starter wallet) | paid plans from $16/mo |
| Extras | CLI, TS SDK, MCP | Map (site URL discovery), Crawl (recursive), Parse |

Division of labor — the fetch ladder, cheapest first, every result cached in `lookups`:

1. **Native fetch** — unlimited, covers everything with server-rendered HTML.
2. **TinyFish Fetch** — the rendered-fetch workhorse: SPA careers pages (resolver rung 4),
   India ATS boards (Keka/Zoho Recruit/MyNextHire recurring re-checks), /team pages, YC Work
   at a Startup public listings. 1,000/day is ~30× Firecrawl's monthly budget, so it takes all
   recurring work.
3. **Firecrawl** — anti-bot fallback when TinyFish Fetch gets blocked (Wellfound is the likely
   customer), plus `map` to find a company's careers URL when the homepage hides it.
   1,000/mo is plenty for a fallback rung. **One account** — PLAN §5's one-account-per-vendor
   rule applies; the second account lapses, and the budget math shows it was never needed.
4. **Playwright** — only for login-walled sources (step 10) and your own LinkedIn session
   (steps 7/11). Never for anonymous fetching; the APIs above do that for free.

TinyFish Search additionally takes rung 1 of the step-5 people-finder waterfall. TinyFish's
metered Agent/Browser products and AgentQL are not used — extraction from fetched markdown is
a `claude -p` job, already free. Not crawled, ever: anything with a JSON API or RSS feed
(big-3 boards, Workable, SmartRecruiters, Adzuna, Jooble, Remotive, RemoteOK, Arbeitnow, HN
Algolia, funding feeds), and LinkedIn in any form.

## Step 10 — scrape sources

One scraper per source behind the same `JobSource` interface. Anonymous-access sources
(Naukri public listings, Wellfound) go through the crawl tier's fetch ladder; **Playwright**
is reserved for login-walled sources (Instahyre, Cutshort). Built last per PLAN §10 — and per
the geography decision, only if the remote-global + Adzuna funnel proves thin.

## Step 11 — mode=auto

Same Playwright persistent context as step 7. Deferred; guardrails as PLAN §6.

---

## The geography decision (decided 1 Sep 2026)

Priority order: **remote-global → India remote → Bengaluru → Kolkata.** EU/UK are not
targeted, so no GDPR position is needed.

What this means for the build:

- The remote-global sources (big-3 boards, Remotive, RemoteOK, HN) lead — conveniently the
  free, low-maintenance ones, and the slice where the §0 numbers say the resolver works.
- Adzuna (India endpoint) and Jooble carry the India tiers in step 4; Entrackr leads still
  flow through motion B but most will land `ats=unknown` until the India ATS adapters and
  scrape tier exist (steps 2 rung 3 / step 10).
- The priority order is scoring input, not just source selection: `location` scoring in step 3
  weights remote-global ≥ India-remote > BLR > Kolkata, and it belongs in profile.yaml
  (step 1) as a ranked list, not a boolean `remote_ok`.
