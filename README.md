# job-hunt

Signal-led outreach for a job search, built to run on **free tiers only**. One pipeline, two
signals: **job postings that match a profile**, and **recently funded companies confirmed to be
hiring**. Both feed the same machine — company → people → enrich → score → personalise → execute —
with a human in the loop at every send point.

Anyone can clone this and run their own job hunt: your profile, CV, and all generated data stay
local (gitignored) — nothing personal lives in this repo.

## Quickstart

```bash
git clone https://github.com/0xSarnavo/job-hunt && cd job-hunt
npm install
cp .env.example .env                       # fill in the keys you have — missing ones just disable that step
cp profile.example.yaml profile.yaml       # YOUR target roles, dealbreakers, proof points
npm run daily                              # the whole pipeline — run this every day
```

Every external dependency is optional and degrades gracefully:

- **LLM calls** shell out to a CLI — default `opencode run` (free models) for cheap extraction and
  `claude -p` for judgement calls. Point `LLM_LIGHT` / `LLM_HEAVY` in `.env` at ANY prompt-taking
  CLI you have (`claude -p`, `opencode run -m <model>`, `llm`, ...). Nothing is hard-required: a
  step that can't reach a model skips its items and moves on.
- **API keys** (`.env.example` lists them all) each unlock one step. No key → that source/step is
  skipped, the rest of the pipeline still runs.
- **CRM**: a free self-hosted [Twenty](https://twenty.com) instance (Railway template works).
  `npm run setup-crm` builds the whole data model for you. No CRM configured → SQLite still holds
  everything.

## Folder map

```
docs/        PLAN.md (the spec) · SOURCES.md (where jobs come from) · TOOLING.md (per-step tools)
src/         shared library — db, llm, scoring, resolver, sources/, CRM setup & sync, registry
scripts/     the pipeline, numbered steps + run-daily.sh (canonical run order lives there)
data/        EVERYTHING generated & personal (gitignored): jobhunt.db, cv-briefs/, email-drafts/,
             connect-list.md, portfolio-companies.md, PENDING.md (what's left undone and why)
profile.yaml YOUR profile (gitignored) — copy profile.example.yaml
.env         YOUR keys (gitignored) — copy .env.example
```

## The pipeline (run order = `scripts/run-daily.sh`)

**Signals in**
| step | what it does |
|---|---|
| 1-fetch | pulls postings from every configured job portal (incl. boards you add in the CRM) |
| 7-funded | funding RSS (US · EU · UK · India · AU) → enrich → 5–50 headcount pitch targets |
| 11-vc-companies | newest YC batches → active pitch targets |
| 12-portfolios | investor programs (YC, a16z, Bangalore Startup Map, CRM-added) + their companies → CRM |
| 13-careers | portfolio companies' careers pages → ATS detected, live matching roles → Opportunities |

**Judge + prep**
| step | what it does |
|---|---|
| 2-llm-score | free-model judge re-scores the rule-based matches |
| 3-cv-briefs | writes a CV-tailoring brief per double-passed job → `data/cv-briefs/` |
| 4-sync | pushes matched jobs to the CRM (Companies + Opportunities kanban) |

**People + outreach (nothing sends itself)**
| step | what it does |
|---|---|
| 5-people | finds founders/hiring managers per company, drafts LinkedIn notes |
| 6-emails | email waterfall for people YOU marked `Fetch Email = YES` in the CRM |
| 8-followups | drafts follow-ups for stale SENT cards |
| 9-connect-list | regenerates `data/connect-list.md` — who to connect with today |

**Bookkeeping**: 10-usage-sync pushes per-vendor API-usage counters to the CRM, and steps that
stop at a cap or quota write what's left (and why) to `data/PENDING.md`.

## The CRM model (Twenty)

Five objects, created by `npm run setup-crm`:

1. **Job Portals** — every place the pipeline pulls postings/signals from (registry: `src/registry.ts`).
   Status legend: *Active* = fetched on every run · *Planned* = adapter exists, flip the status to
   start it · *Later* = blocked on something real (login walls, account risk — see SOURCES.md)
2. **Investor Portfolios** — accelerators & VC programs (YC, a16z, Sequoia, ...) with scrape status
3. **Companies** — scraped from job portals and investor portfolios, linked to their portfolio
4. **People** — per company, tiered (founder / hiring manager / peer / recruiter) with drafted notes
5. **Opportunities** — matched/pitched roles on a QUEUED → SENT → REPLIED kanban

plus **API Usage** — free-tier budget counters per vendor.

Nothing is ever sent automatically: LinkedIn connects are a list you click yourself, and emails
are Gmail drafts you review and send yourself. See `docs/PLAN.md` §6–7 for why.

## Customizing

**Add a job board — from the CRM.** Create a Job Portal record with Kind = *VC Board*,
Status = *Active*, and a Portal URL. The next `1-fetch` run fetches that page, parses the
listings with the free model, and scores them like any other source. Any *Planned* board
starts the same way — just flip its Status to Active.

**Add an investor program — from the CRM.** Create an Investor Portfolio record with a
Portfolio URL. The next `12-portfolios` run fetches the page, extracts the company list
(best effort — clean directory pages work well), pushes companies with websites into the CRM
linked to your record, and keeps its counts updated. For sites needing a dedicated parser,
add an entry in `src/registry.ts` and a scraper block in `scripts/12-portfolios.mts`
(the YC / a16z / Bangalore-map blocks are the templates).

**Company boards find themselves.** `13-careers` resolves each portfolio company's ATS and
adds discovered boards as Job Portal records (Kind = *Company Board*) — your personal,
growing list of boards worth watching.

**What's public vs private.** The registries of portals and programs you follow
(`src/registry.ts`) are part of the repo. The *results* — companies, people, roles, drafts,
your profile — live only in `data/`, `profile.yaml`, and your CRM, all gitignored.

**Knobs.** Every script has a "Knobs" block at the top (batch sizes, batches to push,
models). Env overrides: `LLM_LIGHT` / `LLM_HEAVY` (any prompt-taking CLI), `JOBHUNT_DB`,
`PORTFOLIO_YC_BATCHES`, `PORTFOLIO_PUSH_MAX`, `CAREERS_PER_RUN`, `VC_QUERIES`.
