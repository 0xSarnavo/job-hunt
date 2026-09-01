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
| LLM calls | `claude -p` headless · @anthropic-ai/sdk | **`claude -p --output-format json`** | covered by the existing Claude subscription — zero marginal cost, which is the whole constraint; swap to the SDK only if unattended cron proves flaky |
| Rate limiting | bottleneck · hand-rolled | **hand-rolled token bucket** (~20 lines) | one dependency saved; per-vendor limits live next to the vendor adapter |
| Scheduling | launchd · cron | **launchd** plists | native on macOS, survives reboots, per-job logs |
| HTTP | native fetch · axios · got | **native fetch** | nothing here needs more |

Rejected outright: **Monid** (monid.ai) — metered per-call billing ($1 starter credit, then $0.0013+/call, premium endpoints extra), so it fails the free constraint; its catalog (scraping, enrichment, people data) is the paid version of what the waterfall gets free; and a runtime tool-selection layer fights the cache-forever/per-field-provenance design. Revisit only as a paid gap-filler if a specific lookup repeatedly defeats the free waterfall.

---

## Step 1 — profile.yaml

**Must do:** produce the scoring target: `role_titles`, `stack`, `years`, `domains`, `location`, `remote_ok`, `comp_band`, `dealbreakers`, `proof_points`.

Not a code step. A guided interview in a Claude Code session, merging the resume (Claude reads the PDF directly) and the official LinkedIn data export (Settings → *Get a copy of your data* — free, no scraping). Interview wins conflicts, per PLAN §3. Output validated by the zod schema that ships in step 3.

## Step 2 — ATS resolver + big-3 source

**Must do:** company name/domain → which ATS, if any → normalised live postings. Per §0 the resolver is a four-rung ladder, each rung free:

1. **Slug guessing** against the big-3 JSON APIs (name variants: lowercase, hyphenated, concatenated). Verify: Greenhouse board root returns `name`; Lever/Ashby hits are confirmed via rung 2 before being trusted. Found 5/13 US companies with zero page fetches.
2. **Careers-page signature grep** — fetch homepage, extract careers link (cheerio), grep for embed signatures: `greenhouse.io | lever.co | ashbyhq.com | workable.com | smartrecruiters | zohorecruit | keka | darwinbox | mynexthire | freshteam | recruitee | breezy.hr | dover.com | gem.com`. This is how Zoho/MyNextHire were found in the India sample.
3. **Extended structured adapters**, added lazily as rung 2 discovers them in the wild. Day one: **Workable** (`apply.workable.com/api/v1/widget/accounts/{slug}` — public JSON, verified working) and **SmartRecruiters** (`api.smartrecruiters.com/v1/companies/{id}/postings` — public, returns 200 for junk slugs so check content, never status). India ATSes (Zoho Recruit, Keka, MyNextHire) get read-only page-parse adapters when a target company actually uses one.
4. **Rendered fallback** — Playwright for SPA careers pages, deferred to step 10's scraping infrastructure. Until then a company that defeats rungs 1–3 is logged `ats=unknown`, which is a *note, not a lead* (PLAN §2B).

Everything through rung 3 is native fetch + cheerio + regex. No browser until step 10.

## Step 3 — schema + match

**Must do:** the six tables from PLAN §9; deterministic rubric scoring postings against profile.yaml.

better-sqlite3, schema as one `.sql` file, WAL mode, a `PRAGMA user_version` migration counter. Scoring is plain TypeScript (title match, stack overlap, location/remote, dealbreakers as hard filters) with `claude -p` as tiebreak on borderline scores only. Score + verdict logged to `jobs.match_score` so the rubric can be rebuilt from reply data (PLAN §3).

## Step 4 — free job APIs

**Must do:** `JobSource` adapters returning normalised `Posting`s. All plain fetch behind the token bucket; every response cached in `lookups`.

| Source | Access | Note |
|---|---|---|
| Adzuna | free app id+key, ~1,000 calls/mo | has an India country endpoint |
| Jooble | free API key | widest geography |
| Remotive / RemoteOK / Arbeitnow | open JSON, no key | RemoteOK requires attribution/linkback |
| HN Who's Hiring | Algolia API (`hn.algolia.com`), no key | find monthly thread → fetch comments → `claude -p` parses each into a `Posting` |

Which of these get built first depends on the geography decision — Adzuna/Jooble carry an India-first mix; Remotive/RemoteOK/HN carry a remote-global mix.

## Step 5 — people search + persona tiering

**Must do:** company → named humans matching PLAN §4's persona table, without scraping LinkedIn.

| Candidate | Free allowance | Verdict |
|---|---|---|
| Google Programmable Search JSON API | 100 queries/day | **selected** — `site:linkedin.com/in "{company}" {title}` finds people legitimately |
| Brave Search API | ~2,000 queries/mo (verify current terms at signup) | **selected** — second rung of a search waterfall, same pattern as email |
| GitHub org members API | free | **selected** — best signal for eng leads at small startups; maps to real names via profile pages |
| Company /team /about pages | free | **selected** — fetch + `claude -p` extraction |
| Apollo/RocketReach free tiers | credit-gated, API access unclear on free | rejected for now — re-evaluate only if the above under-fills |

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

## Step 10 — scrape sources

**Playwright**, one scraper per source, each behind the same `JobSource` interface. Built last per PLAN §10; §0 confirms India-first coverage leans on these, which is a reason to decide geography *before* sequencing them.

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
