# WeChat ACP

[![NPM Downloads](https://img.shields.io/npm/d18m/wechat-acp)](https://www.npmjs.com/package/wechat-acp)

Bridge WeChat direct messages to any ACP-compatible AI agent.

`wechat-acp` logs in with the WeChat iLink bot API, polls incoming 1:1 messages, forwards them to an ACP agent over stdio, and sends the agent reply back to WeChat.

<img src="./resources/screenshot.jpg" alt="wechat-acp screenshot" width="400" />

## Features

- WeChat QR login with terminal QR rendering
- One ACP agent session per WeChat user
- Built-in ACP agent presets for common CLIs
- Custom raw agent command support
- Auto-allow permission requests from the agent
- Send local image/video replies referenced by the agent
- Codex App hooks for Stop notifications and PermissionRequest approval via WeChat
- Direct message only; group chats are ignored
- Background daemon mode

## Requirements

- Node.js 20+
- A WeChat environment that can use the iLink bot API
- An ACP-compatible agent available locally or through `npx`

## Quick Start

Start with a built-in agent preset:

```bash
npx wechat-acp --agent copilot
```

Or use a raw custom command:

```bash
npx wechat-acp --agent "npx my-agent --acp"
```

On first run, the bridge will:

1. Start WeChat QR login
2. Render a QR code in the terminal
3. Save the login token under `~/.wechat-acp`
4. Begin polling direct messages

## Built-in Agent Presets

List the bundled presets:

```bash
npx wechat-acp agents
```

Current presets:

- `copilot`
- `claude`
- `gemini`
- `qwen`
- `codex`
- `opencode`

These presets resolve to concrete `command + args` pairs internally, so users do not need to type long `npx ...` commands.

## CLI Usage

```text
wechat-acp --agent <preset|command> [options]
wechat-acp agents
wechat-acp login
wechat-acp auth-status
wechat-acp codex-hooks <login|setup|install|uninstall|bind|send|status|doctor>
wechat-acp codex-hook
wechat-acp stop
wechat-acp status
```

Options:

- `--agent <value>`: built-in preset name or raw agent command
- `--cwd <dir>`: working directory for the agent process
- `--login`: force QR re-login and replace the saved token
- `--daemon`: run in background after startup
- `--config <file>`: load JSON config file
- `--idle-timeout <minutes>`: session idle timeout, default `1440` (use `0` for unlimited)
- `--max-sessions <count>`: maximum concurrent user sessions, default `10`
- `--hide-thoughts`: do not forward agent thinking to WeChat (default: forwarded)
- `-h, --help`: show help

Examples:

```bash
npx wechat-acp --agent copilot
npx wechat-acp --agent claude --cwd D:\code\project
npx wechat-acp --agent "npx @github/copilot --acp"
npx wechat-acp --agent gemini --daemon
```

## Local Codex Startup on macOS

This repository includes a local startup script for the `codex` preset:

```bash
./start-codex.sh
```

The script builds stale or missing `dist` output, checks whether the saved WeChat login is still valid, avoids duplicate daemon starts, and writes daemon logs to `~/.wechat-acp/wechat-acp.log`.

If the login has expired, the script shows a QR code first. When invoked by macOS LaunchAgent without a terminal, it opens Terminal automatically so the QR code is visible; after WeChat authorization succeeds, it continues into the daemon startup path.

Install it as a macOS login LaunchAgent:

```bash
./scripts/install-autostart.sh
```

Remove the LaunchAgent:

```bash
./scripts/uninstall-autostart.sh
```

## Codex App Hooks

`wechat-acp` can install Codex App hooks that reuse the same WeChat login and sending code:

- `Stop`: push a task completion summary to WeChat.
- `PermissionRequest`: send the approval request to WeChat and wait for a reply.
- Local image/video references in hook text are uploaded to the WeChat CDN and sent as real media messages.

One-time setup:

```bash
wechat-acp codex-hooks login
```

Send this text to the ClawBot chat in WeChat:

```text
wechat-acp bind
```

Then bind the current WeChat user and install the Codex hooks:

```bash
wechat-acp codex-hooks bind
wechat-acp codex-hooks install
```

You can also run `wechat-acp codex-hooks setup` to perform login and binding in one flow.

The installer writes `~/.codex/hooks.json` and enables the current Codex feature flag in `~/.codex/config.toml`:

```toml
[features]
hooks = true
```

Do not use the deprecated `codex_hooks` feature flag. Newer Codex versions expect `[features].hooks` or `--enable hooks`.

Useful commands:

```bash
wechat-acp codex-hooks login
wechat-acp codex-hooks setup
wechat-acp codex-hooks status
wechat-acp codex-hooks doctor
wechat-acp codex-hooks send "Codex hooks test"
wechat-acp codex-hooks uninstall
```

For `PermissionRequest`, reply in WeChat with `允许` / `allow` to approve, or `拒绝` / `deny` to reject. If no valid reply arrives before the timeout, the hook returns no decision and Codex falls back to its normal handling.

## Configuration File

You can provide a JSON config file with `--config`.

Example:

```json
{
  "agent": {
    "preset": "copilot",
    "cwd": "D:/code/project"
  },
  "session": {
    "idleTimeoutMs": 86400000,
    "maxConcurrentUsers": 10
  }
}
```

You can also override or add agent presets:

```json
{
  "agent": {
    "preset": "my-agent"
  },
  "agents": {
    "my-agent": {
      "label": "My Agent",
      "description": "Internal team agent",
      "command": "npx",
      "args": ["my-agent-cli", "--acp"]
    }
  }
}
```

## Runtime Behavior

- Each WeChat user gets a dedicated ACP session and subprocess.
- Messages are processed serially per user.
- Replies are formatted for WeChat before sending.
- Local image/video links in replies are uploaded and sent as WeChat media messages.
- Typing indicators are sent when supported by the WeChat API.
- Sessions are cleaned up after inactivity (set `idleTimeoutMs` to `0` to disable idle cleanup).

## Outbound Images and Videos

When the agent replies with a Markdown link or image reference to a local image/video file, `wechat-acp` uploads it to WeChat and sends it as media:

```text
![preview](./output/cover.png)
[video](./output/demo.mp4)
```

For safety, outbound media is intentionally restricted:

- only image/video extensions are supported: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, `.heic`, `.mp4`, `.mov`, `.m4v`, `.webm`
- the file must be inside the configured agent working directory (`--cwd`)
- the file header must match an allowed image/video format
- images are capped at 25 MB and videos at 200 MB
- remote URLs, arbitrary files, and documents are not uploaded

## Storage

By default, runtime files are stored under:

```text
~/.wechat-acp
```

This directory is used for:

- saved login token
- Codex hooks target binding (`codex-hooks.json`)
- daemon pid file
- daemon log file
- sync state
- anonymous telemetry install id (`telemetry-id`, see Telemetry section)

## Current Limitations

- Direct messages only; group chats are ignored
- MCP servers are not used
- ACP bridge permission requests are auto-approved; Codex App hook permission requests can be approved from WeChat
- Agent communication is subprocess-only over stdio
- Outbound media is limited to local images/videos under the agent working directory
- Some preset agents may require separate authentication before they can respond successfully

## Development

For local development:

```bash
npm install
npm run build
```

Run the built CLI locally:

```bash
node dist/bin/wechat-acp.js --help
```

Watch mode:

```bash
npm run dev
```

## Telemetry

`wechat-acp` collects anonymous usage telemetry via Azure Application Insights to help understand which agent presets are used and to detect crashes.

**To disable telemetry**, set the `WECHAT_ACP_TELEMETRY` environment variable to `0`, `false`, or `off` before running:

```bash
WECHAT_ACP_TELEMETRY=0 npx wechat-acp --agent copilot
```

**What is collected** (9 event types only):

- `app.start` / `app.stop` — process lifecycle, agent preset name, daemon flag, uptime
- `login.success` / `login.failure` / `token.reused` — WeChat login outcomes (no token, no QR URL)
- `message.received` — message arrived; only the categorical kind (`text` / `image` / `voice` / `file` / `video` / `empty`) and a hashed user id
- `session.created` — new ACP session opened
- `prompt.completed` — ACP turn finished; agent preset, stop reason, duration, reply length
- `reply.sent` — reply pushed back to WeChat; segment count, total length

Plus exception reports for `monitor`, `prompt`, `reply`, `auth`, `agent_spawn`, and `enqueue` failures.

**What is never collected**: message bodies, filenames, voice transcripts, image URLs, login tokens, QR codes, raw agent command strings, environment variables, working directory paths, raw WeChat user IDs.

User IDs are sha256-hashed with a per-install salt stored in `~/.wechat-acp/telemetry-id`. The salt is generated on first run and never leaves your machine. Delete the file to rotate it.

## License

MIT
