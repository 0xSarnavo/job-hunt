#!/bin/bash
# Installs the once-a-day automation for THIS checkout (run it again if you
# move the folder). macOS: a launchd agent ticks every 30 min and calls
# scripts/daily-if-due.sh, which runs the pipeline once per day, the first
# time your machine is awake after 8 AM. Linux: prints the crontab line to add.
cd "$(dirname "$0")/.." || exit 1
REPO=$(pwd)

if [ "$(uname)" = "Darwin" ]; then
  LABEL=com.jobhunt.daily
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$REPO/scripts/daily-if-due.sh</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$REPO</string>
	<key>StartInterval</key>
	<integer>1800</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin</string>
	</dict>
	<key>StandardOutPath</key>
	<string>$REPO/data/daily-cron.log</string>
	<key>StandardErrorPath</key>
	<string>$REPO/data/daily-cron.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || { echo "launchctl failed" >&2; exit 1; }
  echo "Installed. The pipeline runs once a day, first time this Mac is awake after 8 AM."
  echo "Watch it:     tail -f $REPO/data/daily-cron.log"
  echo "Uninstall:    launchctl bootout gui/\$(id -u)/$LABEL && rm $PLIST"
else
  echo "Add this line to your crontab (run: crontab -e):"
  echo "*/30 * * * * cd $REPO && bash scripts/daily-if-due.sh >> data/daily-cron.log 2>&1"
fi
