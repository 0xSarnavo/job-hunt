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
bash scripts/run-daily.sh                  # or run the numbered scripts one at a time
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
scripts/     the pipeline, numbered in run order (1-fetch → 12-portfolios) + run-daily.sh
data/        EVERYTHING generated & personal (gitignored): jobhunt.db, cv-briefs/, reports
profile.yaml YOUR profile (gitignored) — copy profile.example.yaml
.env         YOUR keys (gitignored) — copy .env.example
```

## The pipeline (scripts/, in run order)

| step | what it does |
|---|---|
| 1-fetch | pulls postings from every configured job portal into SQLite |
| 2-llm-score | free-model judge re-scores the rule-based matches |
| 3-cv-briefs | writes a CV-tailoring brief per double-passed job → `data/cv-briefs/` |
| 4-sync | pushes matched jobs to the CRM (Companies + Opportunities kanban) |
| 7-funded | funding RSS → enrich → 5–50 headcount pitch targets |
| 11-vc-companies | newest YC batches → active pitch targets |
| 5-people | finds founders/hiring managers per company, drafts LinkedIn notes |
| 6-emails | email waterfall for people YOU marked `Fetch Email = YES` in the CRM |
| 8-followups | drafts follow-ups for stale SENT cards |
| 9-connect-list | regenerates `data/connect-list.md` — who to connect with today |
| 12-portfolios | investor programs (YC, a16z, ...) + their portfolio companies → CRM |
| 10-usage-sync | per-vendor API usage counters → CRM |

## The CRM model (Twenty)

Five objects, created by `npm run setup-crm`:

1. **Job Portals** — every place the pipeline pulls postings/signals from (registry: `src/registry.ts`)
2. **Investor Portfolios** — accelerators & VC programs (YC, a16z, Sequoia, ...) with scrape status
3. **Companies** — scraped from job portals and investor portfolios, linked to their portfolio
4. **People** — per company, tiered (founder / hiring manager / peer / recruiter) with drafted notes
5. **Opportunities** — matched/pitched roles on a QUEUED → SENT → REPLIED kanban

plus **API Usage** — free-tier budget counters per vendor.

Nothing is ever sent automatically: LinkedIn connects are a list you click yourself, and emails
are Gmail drafts you review and send yourself. See `docs/PLAN.md` §6–7 for why.
