#!/bin/bash
# The daily pipeline, one step per line, in dependency order.
# Edit freely: comment out steps, reorder, add your own between them.
# Steps fail independently — one bad source never stops the rest.
# Each step runs under `step <max-minutes> <script>`: a hung step is killed at
# its time cap instead of blocking the day. Failures are counted; 4+ failed
# steps means something systemic (network/APIs down) — the script exits 1 so
# the launchd wrapper retries later (max 3 attempts/day, see daily-if-due.sh).
# What each run left undone (and why): data/PENDING.md
cd "$(dirname "$0")/.."

FAIL_LOG=$(mktemp)
step() {  # step <max-minutes> <script.mts>
  local mins=$1 name=$2 rc
  timeout -k 30 "${mins}m" npx tsx "scripts/$name"
  rc=$?
  if [ $rc -eq 124 ] || [ $rc -eq 137 ]; then
    echo "$name — TIMED OUT at ${mins}m (hung? see log above)" >> "$FAIL_LOG"
  elif [ $rc -ne 0 ]; then
    echo "$name — exit $rc" >> "$FAIL_LOG"
  fi
}

# CRM is local + on-demand (docker-compose.crm.yml): bring it up and wait.
# Stop it later with `npm run crm-down` — data persists in docker volumes.
if ! docker info >/dev/null 2>&1; then
  open -a Docker
  for i in $(seq 1 40); do docker info >/dev/null 2>&1 && break; sleep 3; done
fi
docker info >/dev/null 2>&1 || { echo "Docker daemon did not start; aborting" >&2; exit 1; }
docker compose -f docker-compose.crm.yml up -d 2>/dev/null
for i in $(seq 1 60); do curl -sf -o /dev/null "${TWENTY_URL:-http://localhost:3010}/healthz" && break; sleep 2; done

# -- signals in --------------------------------------------------------------
# 1-fetch, 7-funded, 14-backfill touch different sources — run them in parallel
# (SQLite busy_timeout makes concurrent writers safe; CRM-heavy steps stay serial
# because Twenty's rate limit is shared).
step 30  1-fetch.mts &        # job portals (incl. CRM-added boards), incremental
step 30  7-funded.mts &       # funding RSS (US/EU/India/AU) -> 5-50 headcount pitch targets
step 60  14-backfill.mts &    # 2-year archive backfill, one bounded chunk per day
wait
step 30  11-vc-companies.mts  # latest YC batch -> active pitch targets
step 45  12-portfolios.mts    # investor programs + portfolio companies -> CRM
step 30  16-crm-pull.mts      # absorb records YOU added in the CRM by hand
step 60  13-careers.mts       # careers pages -> ATS + matching roles (your adds first)

# -- judge + prep ------------------------------------------------------------
step 15  15-feedback.mts      # pull YOUR irrelevant-marks from the CRM first
step 60  2-llm-score.mts      # free-model judge on new matches (quotes your verdicts)
step 60  3-cv-briefs.mts      # CV-tailoring briefs for double-passed jobs
step 45  4-sync.mts           # matched jobs -> Twenty CRM kanban

# -- people + outreach (nothing sends itself) --------------------------------
step 120 5-people.mts         # people + LinkedIn notes for top companies
step 30  6-emails.mts         # ONLY people you marked Fetch Email=YES
step 30  8-followups.mts      # drafts follow-ups for stale SENT cards
step 15  9-connect-list.mts   # regenerates data/connect-list.md for today

# -- bookkeeping -------------------------------------------------------------
step 15  10-usage-sync.mts    # API usage counters -> CRM

# nightly CRM backup, rotates weekly (crm-backup-Mon.sql.gz ... Sun)
docker compose -f docker-compose.crm.yml exec -T crm-db pg_dump -U postgres -d default \
  | gzip > "data/crm-backup-$(date +%a).sql.gz" 2>/dev/null || true

# -- verdict -----------------------------------------------------------------
FAILS=$(wc -l < "$FAIL_LOG" | tr -d ' ')
if [ "$FAILS" -gt 0 ]; then
  echo "=== $FAILS step(s) failed:"
  cat "$FAIL_LOG"
fi
rm -f "$FAIL_LOG"
if [ "$FAILS" -ge 4 ]; then
  echo "=== too many failures — likely systemic; leaving day unstamped for retry" >&2
  exit 1
fi
echo "=== daily run complete $(date) ==="
