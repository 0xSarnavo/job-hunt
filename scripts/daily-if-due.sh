#!/bin/bash
# Runs the daily pipeline at most once per day, the first time the machine is
# awake after EARLIEST_HOUR. launchd (or cron) calls this every 30 min; it's a
# silent no-op once today's run is done. A failed run (Docker down, network out,
# 4+ steps failed) leaves no stamp, so the next tick retries — but at most
# MAX_ATTEMPTS times per day, so a broken day can't hammer APIs for hours.
# Manual run anytime: npm run daily (unconditional, doesn't count attempts).
cd "$(dirname "$0")/.."
STAMP=data/.last-daily
ATTEMPTS=data/.daily-attempts
EARLIEST_HOUR=8
MAX_ATTEMPTS=3

today=$(date +%F)
[ "$(date +%-H)" -lt "$EARLIEST_HOUR" ] && exit 0
[ "$(cat "$STAMP" 2>/dev/null)" = "$today" ] && exit 0

[ -r "$ATTEMPTS" ] && read -r att_day att_n < "$ATTEMPTS"
[ "$att_day" = "$today" ] || att_n=0
if [ "${att_n:-0}" -ge "$MAX_ATTEMPTS" ]; then
  # already tried MAX_ATTEMPTS times today; give up quietly until tomorrow
  exit 0
fi
echo "$today $((att_n + 1))" > "$ATTEMPTS"

# Remember what was already running: if YOU had the CRM (or Docker) open, the
# run leaves them alone. If the run started them, it shuts them down after, so
# an unattended daily costs zero RAM once finished. KEEP_CRM_UP=1 disables this.
docker_was_up=0 crm_was_up=0
docker info >/dev/null 2>&1 && docker_was_up=1
[ "$docker_was_up" = 1 ] && docker compose -f docker-compose.crm.yml ps --status running 2>/dev/null | grep -q crm-server && crm_was_up=1

echo "=== daily run starting $(date) (attempt $((att_n + 1))/$MAX_ATTEMPTS) ==="
bash scripts/run-daily.sh && date +%F > "$STAMP"

if [ "$crm_was_up" = 0 ] && [ "${KEEP_CRM_UP:-0}" != 1 ]; then
  docker compose -f docker-compose.crm.yml down 2>/dev/null
  # quit Docker Desktop only if this run started it and nothing else uses it
  if [ "$docker_was_up" = 0 ] && [ -z "$(docker ps -q 2>/dev/null)" ]; then
    osascript -e 'quit app "Docker Desktop"' 2>/dev/null || osascript -e 'quit app "Docker"' 2>/dev/null
  fi
fi
