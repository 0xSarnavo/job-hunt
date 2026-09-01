#!/bin/bash
# Master script STARTER — the daily pipeline, one step per line.
# Edit freely: comment out steps, reorder, add your own between them.
cd "$(dirname "$0")/.."
npx tsx scripts/1-fetch.mts
npx tsx scripts/2-llm-score.mts
npx tsx scripts/3-cv-briefs.mts
npx tsx scripts/4-sync.mts
