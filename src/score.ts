import type { Posting, Profile } from "./types.ts";

// Deterministic rubric. Score 0–100 or a hard reject with a reason.
// PLAN §3: the score is a hypothesis with an expiry — log it, then rebuild
// the weights from reply data after ~50 sends.
//
//   title match     0–40   best role_title hit in the posting title
//   keyword overlap 0–30   profile.stack terms in title+description
//   location fit    0–20   ranked locations from the geography decision
//   freshness bonus 0–10   posted within 14 days
//
// Hard rejects: dealbreakers, staleness > max_posting_age_days, geo-restricted
// remote, onsite outside acceptable cities.

export interface Verdict {
  score: number;
  reject: string | null;
  why: string; // human-readable breakdown, shown in CRM notes / status
  expRequired: number | null; // years the posting asks for; >3 is marked, never rejected
}

// Years-of-experience ask, read near the word "experience" to avoid company-age
// noise ("founded 8 years ago"). Ranges take their minimum ("3-5 years" → 3);
// multiple asks take the largest.
export function extractExpYears(text: string): number | null {
  const found: number[] = [];
  const re = /(\d{1,2})\s*(?:\+|plus)?\s*(?:[-–—]|to)?\s*(?:\d{1,2})?\s*\+?\s*(?:years?|yrs?)\b/gi;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    const window = text.slice(Math.max(0, idx - 60), idx + m[0].length + 60);
    if (!/experien|exp\b|track record|working (in|with|as)/i.test(window)) continue;
    const n = parseInt(m[1]!, 10);
    if (n >= 1 && n <= 20) found.push(n);
  }
  return found.length ? Math.max(...found) : null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

const DEALBREAKER_PATTERNS: [RegExp, string][] = [
  [/\b(memecoin|meme coin|casino|gambling|betting|igaming)\b/i, "memecoin/gambling"],
  [/\b(equity[- ]only|unpaid|no salary|sweat equity)\b/i, "equity-only/unpaid"],
  [/\b(performance marketing|paid (ads|media|acquisition)|ppc|sem) (manager|lead|specialist)\b/i, "pure performance marketing"],
  [/\blead gen(eration)? (specialist|executive|agent)\b/i, "pure lead-gen"],
];

const GEO_RESTRICTED = /\b(us[- ]only|usa only|eu only|europe only|uk only|must be (located|based) in (the )?(us|usa|uk|eu|europe|canada)|north america only|(us|uk|eu) work authori[sz]ation|timezone[s]? *: *(us|est|pst|cst)|within \d+ hours of (est|pst|cet))\b/i;

export function score(p: Posting, profile: Profile): Verdict {
  const title = norm(p.title);
  const text = norm(`${p.title} ${p.description ?? ""}`);
  const loc = norm(p.location ?? "");
  const expRequired = extractExpYears(text);

  const rejectVerdict = (reject: string, why: string): Verdict => ({ score: 0, reject, why, expRequired });

  for (const [re, reason] of DEALBREAKER_PATTERNS)
    if (re.test(text)) return rejectVerdict(reason, reason);

  if (p.posted_at) {
    const ageDays = (Date.now() - Date.parse(p.posted_at)) / 86_400_000;
    if (ageDays > profile.max_posting_age_days)
      return rejectVerdict("stale", `${Math.round(ageDays)}d old > ${profile.max_posting_age_days}d`);
  }

  // --- title match 0–40 ---
  // Wrong-function titles never get title credit even when they contain target
  // keywords ("Recruiter (GTM & Business)" — the comparison test's false positive).
  const WRONG_FUNCTION = /\b(recruiter|talent acquisition|account executive|account manager|sales development|\bsdr\b|\bbdr\b|customer success|journeyman)\b/i;
  let titleScore = 0;
  let titleHit = "";
  if (!WRONG_FUNCTION.test(title))
  for (const rt of profile.role_titles) {
    const t = norm(rt);
    if (title.includes(t)) {
      titleScore = 40; titleHit = rt; break;
    }
    const words = t.split(" ");
    const hits = words.filter((w) => title.includes(w)).length;
    const partial = Math.round((hits / words.length) * 25);
    if (partial > titleScore) { titleScore = partial; titleHit = `~${rt}`; }
  }

  // --- keyword overlap 0–30 ---
  const kwHits = profile.stack.filter((k) => text.includes(norm(k)));
  const kwScore = Math.round(Math.min(kwHits.length / 6, 1) * 30);

  // --- location 0–20 ---
  const remoteish = p.remote === true || /\bremote\b|\banywhere\b|\bwork from home\b/.test(loc) || loc === "";
  let locScore = 0;
  let locWhy = "";
  if (remoteish && GEO_RESTRICTED.test(text))
    return rejectVerdict("geo-restricted remote", "remote but restricted to a region we can't work from");
  // Location field naming a specific western country + Remote usually means
  // work-authorization there ("Georgia, USA, Remote") — show it, but low.
  const usRemote = /\b(usa|united states|u\.s\.|canada|germany|austria|france|netherlands)\b/i.test(loc)
    && !/india|worldwide|global|anywhere/i.test(loc);
  if (remoteish && usRemote) { locScore = 5; locWhy = "remote(geo?)"; }
  else if (remoteish) { locScore = 20; locWhy = "remote"; }
  else {
    // onsite: score cities from the profile's ranked locations (best first).
    // "remote-global" and "<country>-remote" entries are handled above/below.
    const ALIASES: Record<string, RegExp> = {
      bengaluru: /bengaluru|bangalore/, kolkata: /kolkata|calcutta/,
      mumbai: /mumbai|bombay/, delhi: /delhi|gurgaon|gurugram|noida/,
    };
    const cities = profile.locations.filter((l) => l !== "remote-global" && !l.endsWith("-remote"));
    const idx = cities.findIndex((c) => (ALIASES[c] ?? new RegExp(c.replace(/[^a-z0-9]+/gi, ".?"), "i")).test(loc));
    const country = profile.locations.find((l) => l.endsWith("-remote"))?.replace(/-remote$/, "");
    if (idx >= 0) { locScore = Math.max(12 - idx * 2, 6); locWhy = cities[idx]!; }
    else if (country && new RegExp(`\\b${country}\\b`, "i").test(loc)) { locScore = 8; locWhy = country; }
    else return rejectVerdict("location", `onsite ${p.location}`);
  }

  // --- freshness bonus 0–10 ---
  let fresh = 0;
  if (p.posted_at && (Date.now() - Date.parse(p.posted_at)) / 86_400_000 <= 14) fresh = 10;

  // --- experience ask: mark, never reject (stretch = profile.years + 0.5) ---
  // Unstated asks are implied by title seniority ("Senior PMM" ≈ 5y,
  // "Head of/Director" ≈ 8y) — the comparison test's second finding.
  const implied =
    /\b(head of|director|vp|vice president)\b/i.test(title) ? 8 :
    /\b(principal|staff)\b/i.test(title) ? 7 :
    /\b(senior|sr\.?)\b/i.test(title) ? 5 : null;
  const effectiveExp = expRequired ?? implied;
  const stretchYears = (profile.years ?? 3) + 0.5;
  let expPenalty = 0;
  if (effectiveExp != null && effectiveExp > stretchYears)
    expPenalty = Math.min(Math.round((effectiveExp - stretchYears) * 3), 12);

  const total = Math.max(titleScore + kwScore + locScore + fresh - expPenalty, 0);
  return {
    score: total,
    reject: null,
    expRequired,
    why:
      `title:${titleScore}(${titleHit || "none"}) kw:${kwScore}(${kwHits.slice(0, 4).join(",") || "none"}) loc:${locScore}(${locWhy}) fresh:${fresh}` +
      (effectiveExp != null ? ` exp-ask:${expRequired ?? `~${implied}(implied)`}y${expPenalty ? `(-${expPenalty})` : ""}` : ""),
  };
}
