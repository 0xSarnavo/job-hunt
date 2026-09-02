#!/bin/bash
# The daily pipeline, one step per line, in dependency order.
# Edit freely: comment out steps, reorder, add your own between them.
# Steps fail independently — one bad source never stops the rest.
# What each run left undone (and why): data/PENDING.md
cd "$(dirname "$0")/.."

# -- signals in --------------------------------------------------------------
npx tsx scripts/1-fetch.mts         # job portals (incl. CRM-added boards), incremental
npx tsx scripts/7-funded.mts        # funding RSS (US/EU/India/AU) -> 5-50 headcount pitch targets
npx tsx scripts/11-vc-companies.mts # latest YC batch -> active pitch targets
npx tsx scripts/12-portfolios.mts   # investor programs + portfolio companies -> CRM
npx tsx scripts/13-careers.mts      # portfolio companies' careers pages -> ATS + matching roles

# -- judge + prep ------------------------------------------------------------
npx tsx scripts/2-llm-score.mts     # free-model judge on new matches
npx tsx scripts/3-cv-briefs.mts     # CV-tailoring briefs for double-passed jobs
npx tsx scripts/4-sync.mts          # matched jobs -> Twenty CRM kanban

# -- people + outreach (nothing sends itself) --------------------------------
npx tsx scripts/5-people.mts        # people + LinkedIn notes for top companies
npx tsx scripts/6-emails.mts        # ONLY people you marked Fetch Email=YES
npx tsx scripts/8-followups.mts     # drafts follow-ups for stale SENT cards
npx tsx scripts/9-connect-list.mts  # regenerates data/connect-list.md for today

# -- bookkeeping -------------------------------------------------------------
npx tsx scripts/10-usage-sync.mts   # API usage counters -> CRM
