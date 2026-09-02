import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { Profile } from "./types.ts";

export function loadProfile(path = "profile.yaml"): Profile {
  return Profile.parse(parse(readFileSync(path, "utf8")));
}

// One-line candidate brief for LLM judge prompts — built from profile.yaml so
// nothing personal is ever hardcoded in the (public) scripts.
export function profileBrief(p: Profile): string {
  return [
    p.years != null ? `Candidate: ${p.years} years experience (stretch +0.5).` : null,
    p.role_titles.length ? `Target roles: ${p.role_titles.join(", ")}.` : null,
    p.domains.length ? `Domains: ${p.domains.join(", ")}.` : null,
    p.locations.length ? `Location preference (ranked): ${p.locations.join(" > ")}; roles restricted to other regions or onsite elsewhere = unsuitable.` : null,
    p.dealbreakers.length ? `Dealbreakers: ${p.dealbreakers.join(", ")}.` : null,
  ].filter(Boolean).join(" ");
}
