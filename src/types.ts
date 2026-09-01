import { z } from "zod";

// profile.yaml — the scoring target (PLAN §3, TOOLING step 1).
// Every field optional: the profile completes incrementally and hard filters
// run with whatever exists. Missing field = filter skipped, never crash.
export const Profile = z.object({
  role_titles: z.array(z.string()).default([]),
  stack: z.array(z.string()).default([]),
  years: z.number().optional(),
  domains: z.array(z.string()).default([]),
  // ranked, best first: ["remote-global", "india-remote", "bengaluru", "kolkata"]
  locations: z.array(z.string()).default([]),
  // .nullish(): empty YAML keys parse as null, not undefined
  comp_band: z.object({ min: z.number(), currency: z.string() }).nullish(),
  dealbreakers: z.array(z.string()).default([]),
  availability: z.string().optional(),
  proof_points: z.array(z.string()).default([]),
  max_posting_age_days: z.number().default(60),
});
export type Profile = z.infer<typeof Profile>;

// Normalised posting — what every JobSource returns (PLAN §2A).
export const Posting = z.object({
  source: z.string(),
  company: z.string(),
  company_domain: z.string().optional(),
  title: z.string(),
  url: z.string(),
  location: z.string().optional(),
  remote: z.boolean().optional(),
  posted_at: z.string().optional(), // ISO date; absent = unknown, not fresh
  description: z.string().optional(),
});
export type Posting = z.infer<typeof Posting>;
