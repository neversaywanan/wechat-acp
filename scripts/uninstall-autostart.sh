#!/usr/bin/env bash
set -Eeuo pipefail

LABEL="${WECHAT_ACP_LAUNCH_LABEL:-com.wechat-acp.codex}"
PLIST_FILE="$HOME/Library/LaunchAgents/$LABEL.plist"
USER_ID="$(id -u)"

launchctl bootout "gui/$USER_ID" "$PLIST_FILE" >/dev/null 2>&1 || true
rm -f "$PLIST_FILE"

echo "已移除开机登录自启动: $LABEL"
