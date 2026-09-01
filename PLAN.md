# Job hunt — signal-led outreach for hiring companies

**Reader:** anyone building or running this.
**Job:** after reading, you know why this is one system and not two, which two signals feed it, and the build order.

Design document. No code yet — the build order in §10 is the plan, not a changelog.

Written 1 September 2026.

---

## 0. The reframe

The original request was two workflows: one starting from job postings, one starting from
funding rounds. They are not two workflows. They are **one pipeline with two signal adapters**.

Any standard outbound pipeline runs the same stages: signal → list → enrichment → scoring →
personalisation → deliverability → execution. Job postings and funding rounds are both just
*signals*. Everything downstream of the signal is identical — company → people → enrich →
score → personalise → execute.

```
SIGNAL A: job posting matches profile ─┐
                                       ├─→ company → people → enrich → score → personalise → execute
SIGNAL B: funded + confirmed hiring ───┘
```

Building these as two codebases means writing the people search, the email waterfall, the
LinkedIn queue, and the draft generator twice, and fixing every bug twice.

The only conceptual change from a normal sales pipeline is the ICP inversion: instead of
selling a product to a company, you are selling yourself to one. Same machine, a
`profile.yaml` in the scoring slot instead of an ICP definition.

---

## 1. The one insight that makes motion B cheap

Motion B needs to answer "is this funded company hiring?" The naive path is to search job
boards for the company name, which is slow, lossy, and lags reality by days.

**Every company running Greenhouse, Lever, or Ashby exposes its live job board as public JSON,
unauthenticated, free, real-time:**

```
https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs
https://api.lever.co/v0/postings/{company}
https://api.ashbyhq.com/posting-api/job-board/{name}
```

So the hiring check is: resolve company → detect ATS (fetch the careers page, match the embed
URL) → hit the board JSON. Authoritative, zero cost, zero lag, and it returns the *actual open
roles* — which is exactly the material a personalised mail needs. This is also a **first-class
job source for motion A**, not merely a check for motion B.

**Tested 1 Sep 2026** (TOOLING.md §0): "overwhelmingly on one of these three" holds only for
US early-stage software (~40–70%). For the Entrackr feed it is 1 in 20 — Indian startups sit
on Zoho Recruit, Keka, MyNextHire, first-party pages, or nothing. The resolver is therefore a
detection *ladder* — big-3 slug probe → careers-page signature grep → extended adapters
(Workable, SmartRecruiters, India ATSes) → rendered fallback — and every slug hit must be
org-name-verified before it enters the DB (slugs collide).

Build the ATS resolver early. It is the highest-value component in the system — for the
US/remote-global slice. For India it degrades gracefully into the careers-page scraper.

---

## 2. Signal adapters

### A — job sources

Tiered by acquisition cost. Build tier 1 first; it is enough to prove the pipeline.

| Tier | Source | Access | Notes |
|---|---|---|---|
| 1 | Greenhouse / Lever / Ashby | public JSON | best data, real-time, per-company |
| 1 | Adzuna | free API, 1,000 calls/mo | good aggregate, India + global |
| 1 | Jooble | free API key | 60+ countries, widest geography |
| 1 | Remotive, RemoteOK, Arbeitnow | free JSON feeds | remote-first, richest records in-niche |
| 1 | HN "Who is hiring" | Algolia API, free | monthly thread, parses cleanly, high signal |
| 2 | YC Work at a Startup, Wellfound | scrape | overlaps motion B — both expose funding stage |
| 2 | Naukri, Instahyre, Cutshort | scrape | India volume; Instahyre/Cutshort skew startup-tech |
| 2 | LinkedIn Jobs | browser, your own session | best people-linkage, no API, rate-limit carefully |

**No source is hardcoded.** Each implements a `JobSource` interface returning a normalised
`Posting`. A tool with a platform name baked into a constant is a bug the day a second
platform proves better.

### B — funding sources

Free news first. For the Indian market these beat Crunchbase on both coverage and price.

| Source | Access | Lag |
|---|---|---|
| Entrackr | RSS | ~1 day, best India tracker |
| Inc42 "Funding Galore" | RSS | weekly consolidated |
| YourStory | RSS | ~1 day |
| TechCrunch | RSS | ~1 day, global |
| YC directory, Wellfound | scrape | stage exposed directly |

Extraction from a news item is an LLM job, not a regex job: `{company, amount, round, date,
investors, domain}`. Then resolve domain → ATS → open roles. **A funded company with no ATS
board and no postings is not a lead — it is a note.** Revisit it later; do not spend an email
credit on it today.

---

## 3. Scoring against your profile

`profile.yaml` is built by merging three sources: a structured interview, your resume, and your
LinkedIn. The interview is authoritative where they conflict — resumes and LinkedIn profiles
both systematically undersell actual stack.

Fields that matter for matching: `role_titles`, `stack`, `years`, `domains`, `location`,
`remote_ok`, `comp_band`, `dealbreakers`, and `proof_points` — the last feeds personalisation,
not scoring.

**Treat the score as a hypothesis with an expiry, not a fact.** Log the score, then log whether
the outreach got a reply. After ~50 sends the reply data will tell you the rubric was wrong,
and it will be. Rebuild it from outcomes rather than from intuition.

---

## 4. Who to contact, by company stage

Four personas are worth contacting, but they cannot share a message — a recruiter and a future
peer want opposite things. Tier by headcount:

| Stage | Primary | Secondary | Why |
|---|---|---|---|
| Pre-seed / seed, <20 | Founder / CTO | — | founder still hires directly; owns the decision |
| Series A/B, 20–200 | Hiring manager / eng lead | future peer | owns the req; a recruiter adds nothing |
| 200+ | Eng lead | future peer | recruiter is a gatekeeper competing with 200 applicants |
| Any, no named role | Recruiter | — | only when you cannot identify the req owner |

Hiring-manager identification is the hard part: infer the reporting line from the posting
(team, seniority, stack) and match it against the company's people list. Expect roughly 60%
accuracy, and fall back to the secondary persona when confidence is low.

---

## 5. Email discovery — free, legitimately

Not by rotating accounts on one vendor. That is ToS abuse, it gets detected, and the workflow
fails silently when it does. One real account per vendor, queried as a waterfall. Clay's
published benchmark puts waterfall enrichment 30–50% ahead of any single source on fill rate,
so this is a coverage decision before it is a cost decision.

| Step | Source | Free allowance | API on free tier |
|---|---|---|---|
| 0 | Pattern guess + self-hosted verify | unlimited | yes, self-hosted |
| 1 | Hunter | 50/mo | yes |
| 2 | Prospeo | 75/mo | limited |
| 3 | Tomba | 25/mo | yes |
| 4 | GetProspect | free tier | yes |
| 5 | Findymail | 10/mo, no charge on miss | yes |

Roughly **160+ resolved emails per month at zero cost**, against a realistic job-search need of
20–40. Step 0 alone resolves 50–60% of them before a single credit is spent.

Two hard requirements:

- **Cache forever.** Never look up the same person twice. This is the single thing that keeps
  you inside the free tiers.
- **Record provenance per field, not per record.** "This record came from vendor X" is useless.
  "This email came from Prospeo at confidence 82, verified 2026-09-01; this title came from
  vendor Y at 90" is what later tells you which vendor earned its slot.

### Verification

Self-hosted [Reacher / `check-if-email-exists`](https://github.com/reacherhq/check-if-email-exists)
— Rust, ships as Docker, clean JSON API. Better than 95% accuracy outside catch-all domains.
Catch-alls return `risky`, and no tool on the market solves that.

**Gotcha:** SMTP verification needs outbound port 25, which most cloud providers block by
default. Run it on a local machine, or accept degraded MX-only checks.

---

## 6. LinkedIn — two modes, queue by default

`--mode=queue` **(default)**
Produces a ranked queue: profile URL, why this person, and a drafted note under 300 characters.
You click Connect yourself. Twenty people takes about a minute. Zero ToS exposure.

`--mode=auto` **(opt-in, violates LinkedIn's terms of service)**
Browser automation against your own logged-in session. Documented here because pretending the
option does not exist helps nobody, but it is not the default and the tradeoff is real.
Non-negotiable guardrails if used: 15–20 invites/day maximum, randomised delays, working hours
only, weekdays only, hard stop on any challenge or captcha, and a single kill switch.
Restriction risk is real and the account is the asset — losing it ends both motions.

**Acceptance monitoring** is identical in both modes and requires automating no *actions* at
all: snapshot the connections list daily, diff it, and any new name matching an outstanding
invite is an acceptance. Read-only and low-risk. Acceptance flips the person's state to `warm`,
which selects a different mail template.

---

## 7. Sending — and why cold-outbound advice does not apply

Standard cold-outbound deliverability practice is burner domains, mailbox pools, and never
touching the primary domain. That is correct at volume, and **wrong here.** A hiring manager
who sees mail from `you@getbrandhq.com` sees a spam operation. Job outreach is low-volume,
high-personalisation, and has to carry your real identity to work at all.

Mechanism: Gmail API `users.drafts.create` on your real address. The system writes, you skim,
you send. That also catches bad personalisation before it reaches a human — the failure mode
that actually costs you the opportunity.

Ceiling: about 20/day. That is not a technical limit. Above it, the personalisation is not real.

---

## 8. Applications and sequencing

No auto-applying. Portal forms break constantly and a wrongly submitted application cannot be
retracted. But applications are *tracked*, and that is what unlocks the sequencing:

```
T+0   you apply through the normal channel        → log applied_at
T+0   connection request sent (queue or auto)
T+2   if accepted → warm mail, references the conversation
T+2   if not accepted → cold mail, references the application and the specific role
T+7   single follow-up, then stop
```

"I applied to X two days ago" is a materially stronger opener than a cold introduction. It is
also true, which matters more.

---

## 9. Shape

TypeScript. SQLite for state.

```
companies    (domain, name, stage, funding, ats, headcount, source, first_seen)
jobs         (company, title, url, posted_at, match_score, matched_at)
people       (company, name, title, persona_tier, linkedin, email, email_status, provenance)
touches      (person, channel, state, sent_at, accepted_at, replied_at)
applications (job, applied_at, channel)
lookups      (key, provider, result, cost, observed_at)     -- the free-tier cache
```

CLI verbs: `signal`, `match`, `people`, `enrich`, `queue`, `poll`, `draft`, `status`.
Daily cron: `signal`, `poll`. On demand: `queue`, `draft`.

---

## 10. Build order

1. `profile.yaml` — interview, then merge resume and LinkedIn. Nothing scores without it.
2. ATS resolver plus the Greenhouse/Lever/Ashby source. Highest value per hour; serves both motions.
3. SQLite schema and `match` scoring against the profile.
4. Free job APIs — Adzuna, Jooble, Remotive, RemoteOK, Arbeitnow, HN.
5. People search and persona tiering.
6. Email waterfall and self-hosted verification. Cache from day one.
7. LinkedIn queue mode and acceptance polling.
8. Gmail draft generation, one template per persona.
9. Funding RSS adapter — motion B lights up on the pipeline that already exists.
10. Scrape sources (LinkedIn Jobs, Naukri, Wellfound, YC) — last, highest maintenance.
11. `--mode=auto`, only if queue mode proves that clicking is the actual bottleneck.

Motion A is live after step 8. Motion B costs one adapter after that, which is the entire point
of §0.

---

## 11. Open risks

- **Hiring-manager inference lands around 60%.** The fallback tiering absorbs it. Measure it anyway.
- **Catch-all domains** defeat verification. At this volume, send regardless and accept the bounce.
- **Port 25** is blocked on most cloud hosts. Run verification locally.
- **Scrape sources rot.** Every tier-2 source will break eventually. Budget the maintenance or drop them.
- **GDPR** applies if targeting the EU or UK. Decide the position before step 9, not after.
- **Geography also decides resolver coverage** (TOOLING.md §0): remote-global works on the
  big-3 JSON boards as designed; India-first pushes motion B onto careers scraping and India
  ATS adapters, and moves the tier-2 scrape sources up the build order.
- **LinkedIn account loss** in `--mode=auto`. Which is precisely why it is not the default.
