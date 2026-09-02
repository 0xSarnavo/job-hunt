import type { Posting, Profile } from "../types.ts";

// Every job source implements this. No platform names in core code (PLAN §2A).
// The profile is passed so sources can push filters server-side
// (e.g. Adzuna max_days_old from profile.max_posting_age_days).
export interface JobSource {
  name: string;
  fetchPostings(profile: Profile): Promise<Posting[]>;
}
