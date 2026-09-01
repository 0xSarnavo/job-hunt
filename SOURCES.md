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
| Adzuna | big aggregate board, has India | free API, ~1,000 calls/mo | **free signup needed** |
| Jooble | widest country coverage | free API key | **free signup needed** |
| Company careers pages | jobs from companies not on any board above | TinyFish Fetch (renders the page), Firecrawl as backup | **key in .env** |
| YC Work at a Startup | startup jobs + funding stage | TinyFish/Firecrawl fetch | **key in .env** |
| Wellfound | startup jobs | heavy anti-bot; Firecrawl, test cheaply first | **key in .env** |
| Naukri / Instahyre / Cutshort | India volume | login-walled scraping | **later** |
| LinkedIn Jobs | best people-linkage | your own browser session only | **later** |

## Funding news — how we hear a company just raised money

| Platform | Why | How | Status |
|---|---|---|---|
| Entrackr | best India funding tracker | RSS feed | **ready now** |
| Inc42 Funding Galore | weekly India roundup | RSS feed | **ready now** |
| YourStory | India startup news | RSS feed | **ready now** |
| TechCrunch | global funding news | RSS feed | **ready now** |

A funding story gives us a company name → we check its job board (tables above) → if it's
hiring roles that fit, it becomes a lead.

## The order we build the fetchers

1. The five ATS boards + the resolver that figures out which one a company uses
2. Remotive, RemoteOK, Arbeitnow, HN — the free remote-global feeds
3. Funding RSS → resolver (motion B lights up)
4. Adzuna + Jooble once you've signed up
5. Careers-page fetcher via TinyFish for companies nothing else covers
