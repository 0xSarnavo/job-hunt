# Where the jobs come from

Every source below feeds the same pipeline. Status says what it needs before it works.

**Ready now** = no key, no signup — we can fetch it today.
**Key in .env** = works as soon as the adapter is written, key already saved.
**Free signup needed** = you create a free account, paste the key in `.env`.
**Later** = deliberately last (see TOOLING.md step 10).

## Job boards — where postings come from

| Platform | What it gives us | How we fetch | Status |
|---|---|---|---|
| Greenhouse | a company's live job board | public JSON API, per company | **ready now** |
| Lever | same | public JSON API, per company | **ready now** |
| Ashby | same | public JSON API, per company | **ready now** |
| Workable | same | public JSON API, per company | **ready now** |
| SmartRecruiters | same | public JSON API, per company | **ready now** |
| Remotive | remote jobs feed | open JSON, no key | **ready now** |
| RemoteOK | remote jobs feed (needs attribution link) | open JSON, no key | **ready now** |
| Arbeitnow | remote/Europe-lean feed | open JSON, no key | **ready now** |
| HN "Who is hiring" | monthly thread, high-signal startup jobs | Algolia API, no key | **ready now** |
| We Work Remotely | remote jobs, strong marketing/devrel categories | RSS feeds, no key | **ready now** |
| Adzuna | big aggregate board, has India | free API, ~1,000 calls/mo | **free signup needed** |
| Jooble | widest country coverage | free API key | **free signup needed** |
| Company careers pages | jobs from companies not on any board above | TinyFish Fetch (renders the page), Firecrawl as backup | **key in .env** |
| YC Work at a Startup | startup jobs + funding stage | TinyFish/Firecrawl fetch | **key in .env** |
| VC portfolio boards (a16z, YC, Sequoia, Lightspeed live; add more from the CRM) | every company is funded by definition + live jobs + salary + headcount — motion B pre-packaged | TinyFish render → free-model parse (`src/sources/vc.ts`); CRM Job Portals with Kind=VC Board & Status=Active are fetched too | **fetching** |
| Wellfound | startup jobs | heavy anti-bot (plain fetches 404); costs Firecrawl credits per page and mostly duplicates the YC/portfolio coverage — parked deliberately | **later** |
| Naukri / Instahyre / Cutshort | India volume | login-walled scraping | **later** |
| Otta / Welcome to the Jungle | curated startup jobs, good matching | login-walled scraping | **later** |
| LinkedIn Jobs | best people-linkage | your own browser session only | **later** |

### Why the big consumer boards (Indeed, Glassdoor, Monster, ZipRecruiter, Google Jobs) aren't here

Three reasons. They have no free APIs (Indeed shut theirs down) and the strongest anti-bot
walls on the internet — fighting them costs real credits. Their listings are mostly *copies*
of the ATS postings we already fetch first-hand, plus stale reposts — the freshness filter
would throw most of it away. And Adzuna + Jooble already give us the legal, free, API version
of the same aggregate view. Same jobs, zero fight.

## Funding news — how we hear a company just raised money

| Platform | Why | How | Status |
|---|---|---|---|
| TechCrunch (venture) | global funding news | RSS feed | **fetching** |
| Crunchbase News | global rounds, high signal | RSS feed | **fetching** |
| FinSMEs | dedicated daily funding briefs, worldwide | RSS feed | **fetching** |
| Entrackr | best India funding tracker | RSS feed | **fetching** |
| Inc42 | India rounds + weekly Funding Galore roundup | RSS feed | **fetching** |
| Sifted | UK/EU startups (FT-backed) | RSS feed | **fetching** |
| Tech.eu | EU funding tracker | RSS feed | **fetching** |
| EU-Startups | EU early-stage rounds | RSS feed | **fetching** |
| Startup Daily | Australia/NZ rounds | RSS feed | **fetching** |
| YourStory | India startup news | RSS feed | available |

A funding story gives us a company name → we check its job board (tables above) → if it's
hiring roles that fit, it becomes a lead.

## The order we build the fetchers

1. The five ATS boards + the resolver that figures out which one a company uses
2. Remotive, RemoteOK, Arbeitnow, HN — the free remote-global feeds
3. Funding RSS → resolver (motion B lights up)
4. Adzuna + Jooble once you've signed up
5. Careers-page fetcher via TinyFish for companies nothing else covers
