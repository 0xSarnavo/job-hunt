# job-hunt

Signal-led outreach for a job search. One pipeline, two signals: **job postings that match a
profile**, and **recently funded companies confirmed to be hiring**.

Both signals feed the same machine — company → people → enrich → score → personalise → execute.
The design note explains why that is one system rather than two, and why the cheapest way to
answer "is this company hiring?" is the target's own ATS rather than any job board.

**Status: design only.** No code yet. → [PLAN.md](PLAN.md)

## Shape

- Job signal: Greenhouse/Lever/Ashby public boards, Adzuna, Jooble, Remotive, RemoteOK, Arbeitnow, HN
- Funding signal: Entrackr, Inc42, YourStory, TechCrunch, YC, Wellfound
- Enrichment: waterfall across free provider tiers, self-hosted SMTP verification, cache-forever
- Execution: LinkedIn connection queue you click yourself, Gmail drafts you send yourself

Human in the loop at both send points, on purpose. See §6 and §7.
