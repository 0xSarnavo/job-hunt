#!/bin/bash
# Master script STARTER — the daily pipeline, one step per line.
# Edit freely: comment out steps, reorder, add your own between them.
cd "$(dirname "$0")/.."
npx tsx scripts/1-fetch.mts        # job portals, incremental
npx tsx scripts/2-llm-score.mts    # free-model judge
npx tsx scripts/3-cv-briefs.mts    # CV prep for double-passed jobs
npx tsx scripts/4-sync.mts         # -> Twenty CRM
npx tsx scripts/7-funded.mts       # funded 5-50 headcount pitch targets
npx tsx scripts/5-people.mts       # people + LinkedIn notes for top companies
npx tsx scripts/6-emails.mts       # ONLY people you marked Fetch Email=YES
npx tsx scripts/8-followups.mts    # drafts follow-ups for stale SENT cards
