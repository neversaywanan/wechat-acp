#!/usr/bin/env bash
set -Eeuo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_SCRIPT="$ROOT_DIR/start-codex.sh"
LABEL="${WECHAT_ACP_LAUNCH_LABEL:-com.wechat-acp.codex}"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/.wechat-acp"
USER_ID="$(id -u)"

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g'
}

mkdir -p "$PLIST_DIR" "$LOG_DIR"
chmod +x "$START_SCRIPT"

LABEL_XML="$(xml_escape "$LABEL")"
ROOT_DIR_XML="$(xml_escape "$ROOT_DIR")"
START_SCRIPT_XML="$(xml_escape "$START_SCRIPT")"
PATH_XML="$(xml_escape "$PATH")"
OUT_LOG_XML="$(xml_escape "$LOG_DIR/launchd.out.log")"
ERR_LOG_XML="$(xml_escape "$LOG_DIR/launchd.err.log")"

cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL_XML</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$START_SCRIPT_XML</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR_XML</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$PATH_XML</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$OUT_LOG_XML</string>
  <key>StandardErrorPath</key>
  <string>$ERR_LOG_XML</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST_FILE" >/dev/null

launchctl bootout "gui/$USER_ID" "$PLIST_FILE" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$USER_ID" "$PLIST_FILE"
launchctl enable "gui/$USER_ID/$LABEL" >/dev/null 2>&1 || true

echo "已安装并启用开机登录自启动: $LABEL"
echo "LaunchAgent: $PLIST_FILE"
echo "启动脚本: $START_SCRIPT"
echo "launchd 日志: $LOG_DIR/launchd.out.log / $LOG_DIR/launchd.err.log"
