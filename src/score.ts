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

  for (const [re, reason] of DEALBREAKER_PATTERNS)
    if (re.test(text)) return { score: 0, reject: reason, why: reason };

  if (p.posted_at) {
    const ageDays = (Date.now() - Date.parse(p.posted_at)) / 86_400_000;
    if (ageDays > profile.max_posting_age_days)
      return { score: 0, reject: "stale", why: `${Math.round(ageDays)}d old > ${profile.max_posting_age_days}d` };
  }

  // --- title match 0–40 ---
  let titleScore = 0;
  let titleHit = "";
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
    return { score: 0, reject: "geo-restricted remote", why: "remote but restricted to a region we can't work from" };
  if (remoteish) { locScore = 20; locWhy = "remote"; }
  else if (/bengaluru|bangalore/.test(loc)) { locScore = 12; locWhy = "bengaluru"; }
  else if (/kolkata|calcutta/.test(loc)) { locScore = 10; locWhy = "kolkata"; }
  else if (/\bindia\b/.test(loc)) { locScore = 8; locWhy = "india"; }
  else return { score: 0, reject: "location", why: `onsite ${p.location}` };

  // --- freshness bonus 0–10 ---
  let fresh = 0;
  if (p.posted_at && (Date.now() - Date.parse(p.posted_at)) / 86_400_000 <= 14) fresh = 10;

  const total = titleScore + kwScore + locScore + fresh;
  return {
    score: total,
    reject: null,
    why: `title:${titleScore}(${titleHit || "none"}) kw:${kwScore}(${kwHits.slice(0, 4).join(",") || "none"}) loc:${locScore}(${locWhy}) fresh:${fresh}`,
  };
}
