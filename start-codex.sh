#!/usr/bin/env bash
set -Eeuo pipefail

# launchd starts with a minimal PATH, so keep common Node install paths explicit.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

START_SCRIPT="$ROOT_DIR/start-codex.sh"
CODEX_MODEL="${WECHAT_ACP_CODEX_MODEL:-gpt-5.5}"
AGENT="${WECHAT_ACP_AGENT:-npx @zed-industries/codex-acp -c model=$CODEX_MODEL}"
CLI="$ROOT_DIR/dist/bin/wechat-acp.js"
LOG_DIR="${WECHAT_ACP_LOG_DIR:-$HOME/.wechat-acp}"
LOG_FILE="$LOG_DIR/wechat-acp.log"
PID_FILE="$LOG_DIR/daemon.pid"

NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "未找到 node，请先安装 Node.js 20+，或通过 NODE_BIN 指定路径。" >&2
  exit 127
fi

needs_build=0
if [ ! -f "$CLI" ]; then
  needs_build=1
elif [ -n "$(find "$ROOT_DIR/src" "$ROOT_DIR/bin" -type f -name '*.ts' -newer "$CLI" -print -quit)" ]; then
  needs_build=1
elif [ "$ROOT_DIR/package.json" -nt "$CLI" ] || [ "$ROOT_DIR/tsconfig.json" -nt "$CLI" ]; then
  needs_build=1
fi

if [ "$needs_build" -eq 1 ]; then
  NPM_BIN="${NPM_BIN:-}"
  if [ -z "$NPM_BIN" ]; then
    NPM_BIN="$(command -v npm || true)"
  fi
  if [ -z "$NPM_BIN" ]; then
    echo "未找到 npm，无法构建项目。" >&2
    exit 127
  fi
  echo "检测到构建产物缺失或已过期，正在构建项目..."
  "$NPM_BIN" run build
fi

mkdir -p "$LOG_DIR"

run_cli() {
  if [ -n "${WECHAT_ACP_CONFIG:-}" ]; then
    "$NODE_BIN" "$CLI" "$@" --config "$WECHAT_ACP_CONFIG"
  else
    "$NODE_BIN" "$CLI" "$@"
  fi
}

open_login_terminal() {
  local runner="$LOG_DIR/wechat-acp-login-and-start.command"
  local root_dir_q
  local start_script_q

  root_dir_q="$(printf '%q' "$ROOT_DIR")"
  start_script_q="$(printf '%q' "$START_SCRIPT")"

  cat > "$runner" <<SCRIPT
#!/usr/bin/env bash
cd $root_dir_q || exit 1
export WECHAT_ACP_INTERACTIVE_LOGIN=1
exec $start_script_q
SCRIPT
  chmod +x "$runner"

  if command -v open >/dev/null 2>&1; then
    open -a Terminal "$runner"
    echo "登录态已过期，已打开 Terminal 显示二维码。扫码授权后会继续启动主链路。"
    return 0
  fi

  echo "登录态已过期，但当前环境无法打开 Terminal。请手动运行: $START_SCRIPT" >&2
  return 1
}

set +e
auth_output="$(run_cli auth-status 2>&1)"
auth_code=$?
set -e
printf '%s\n' "$auth_output"

if [ "$auth_code" -eq 10 ]; then
  status_output="$(run_cli status 2>&1 || true)"
  if printf '%s\n' "$status_output" | grep -q '^Running '; then
    echo "检测到旧 daemon 正在运行，先停止后重新登录。"
    run_cli stop || true
  fi

  if [ -t 1 ] || [ "${WECHAT_ACP_INTERACTIVE_LOGIN:-}" = "1" ]; then
    echo "登录态已过期，开始显示二维码登录..."
    run_cli login
  else
    open_login_terminal
    exit 0
  fi
elif [ "$auth_code" -ne 0 ]; then
  echo "登录态检查失败，将继续尝试启动主链路；如启动后仍提示过期，请运行 $START_SCRIPT 重新扫码。" >&2
fi

status_output="$(run_cli status 2>&1 || true)"
if printf '%s\n' "$status_output" | grep -q '^Running '; then
  echo "$status_output"
  echo "wechat-acp ($AGENT) 已在运行，无需重复启动。"
  exit 0
fi

run_cli --agent "$AGENT" --daemon

echo "------------------------------------------------"
echo "wechat-acp ($AGENT) 已在守护进程模式下启动。"
echo "状态检查: \"$NODE_BIN\" \"$CLI\" status"
echo "停止服务: \"$NODE_BIN\" \"$CLI\" stop"
echo "PID 文件: $PID_FILE"
echo "运行日志: tail -f \"$LOG_FILE\""
echo "------------------------------------------------"
