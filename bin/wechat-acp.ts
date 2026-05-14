#!/usr/bin/env node

/**
 * wechat-acp CLI entry point.
 *
 * Usage:
 *   wechat-acp --agent "claude code"
 *   wechat-acp --agent "gemini" --cwd /path/to/project
 *   wechat-acp --agent "npx tsx ./agent.ts" --login
 *   wechat-acp --agent "claude code" --daemon
 *   wechat-acp stop
 *   wechat-acp status
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import qrcodeTerminal from "qrcode-terminal";
import { WeChatAcpBridge } from "../src/bridge.js";
import { formatUnknownError } from "../src/acp/errors.js";
import { handleCodexHooksCommand, runCodexHook } from "../src/codex/hooks.js";
import { getUpdates } from "../src/weixin/api.js";
import { loadToken, login as loginWeChat } from "../src/weixin/auth.js";
import {
  defaultConfig,
  listBuiltInAgents,
  resolveAgentSelection,
} from "../src/config.js";
import type { WeChatAcpConfig } from "../src/config.js";
import {
  initTelemetry,
  trackEvent,
  trackException,
  shutdownTelemetry,
} from "../src/telemetry/index.js";
import packageJson from "../package.json" with { type: "json" };

function usage(): void {
  const presets = listBuiltInAgents()
    .map(({ id }) => id)
    .join(", ");

  console.log(`
wechat-acp — Bridge WeChat to any ACP-compatible AI agent

Usage:
  wechat-acp --agent <preset|command>  [options]
  wechat-acp agents                        List built-in agent presets
  wechat-acp login                         Log in with WeChat QR code, then exit
  wechat-acp auth-status                   Check whether the saved WeChat login is valid
  wechat-acp codex-hooks <command>          Manage Codex App hooks for WeChat
  wechat-acp codex-hook                     Internal command called by Codex hooks
  wechat-acp stop                          Stop a running daemon
  wechat-acp status                        Check daemon status

Options:
  --agent <value>     Built-in preset name or raw agent command
                      Presets: ${presets}
                      Examples: "copilot", "claude", "npx tsx ./agent.ts"
  --cwd <dir>         Working directory for agent (default: current dir)
  --login             Force re-login (new QR code)
  --daemon            Run in background after login
  --config <file>     Config file path (JSON)
  --idle-timeout <m>  Session idle timeout in minutes (default: 1440)
                      Use 0 to disable idle cleanup
  --max-sessions <n>  Max concurrent user sessions (default: 10)
  --hide-thoughts     Do not forward agent thinking to WeChat (default: forwarded)
  -v, --verbose       Verbose logging
  -h, --help          Show this help
`);
}

function parseArgs(argv: string[]): {
  command?: string;
  agent?: string;
  cwd?: string;
  forceLogin: boolean;
  daemon: boolean;
  configFile?: string;
  idleTimeout?: number;
  maxSessions?: number;
  hideThoughts: boolean;
  verbose: boolean;
  help: boolean;
} {
  const result = {
    forceLogin: false,
    daemon: false,
    hideThoughts: false,
    verbose: false,
    help: false,
  } as ReturnType<typeof parseArgs>;

  const args = argv.slice(2);
  let i = 0;

  // Check for subcommand
  if (args[0] && !args[0].startsWith("-")) {
    result.command = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--agent":
        result.agent = args[++i];
        break;
      case "--cwd":
        result.cwd = args[++i];
        break;
      case "--login":
        result.forceLogin = true;
        break;
      case "--daemon":
        result.daemon = true;
        break;
      case "--config":
        result.configFile = args[++i];
        break;
      case "--idle-timeout":
        result.idleTimeout = parseInt(args[++i], 10);
        break;
      case "--max-sessions":
        result.maxSessions = parseInt(args[++i], 10);
        break;
      case "--hide-thoughts":
        result.hideThoughts = true;
        break;
      case "-v":
      case "--verbose":
        result.verbose = true;
        break;
      case "-h":
      case "--help":
        result.help = true;
        break;
      default:
        if (arg?.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
    i++;
  }

  return result;
}

function loadConfigFile(filePath: string): Partial<WeChatAcpConfig> {
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as Partial<WeChatAcpConfig>;
}

function applyConfigFile(config: WeChatAcpConfig, filePath?: string): void {
  if (!filePath) return;
  const fileConfig = loadConfigFile(filePath);
  Object.assign(config.wechat, fileConfig.wechat ?? {});
  Object.assign(config.agent, fileConfig.agent ?? {});
  Object.assign(config.agents, fileConfig.agents ?? {});
  Object.assign(config.session, fileConfig.session ?? {});
  Object.assign(config.daemon, fileConfig.daemon ?? {});
  Object.assign(config.storage, fileConfig.storage ?? {});
}

function extractConfigArg(argv: string[]): { configFile?: string; rest: string[] } {
  const rest: string[] = [];
  let configFile: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      configFile = argv[++i];
      continue;
    }
    if (arg.startsWith("--config=")) {
      configFile = arg.slice("--config=".length);
      continue;
    }
    rest.push(arg);
  }

  return { configFile, rest };
}

function handleAgents(config: WeChatAcpConfig): void {
  console.log("Built-in ACP agent presets:\n");
  for (const { id, preset } of listBuiltInAgents(config.agents)) {
    const commandLine = [preset.command, ...preset.args].join(" ");
    console.log(`${id.padEnd(10)} ${commandLine}`);
    if (preset.description) {
      console.log(`           ${preset.description}`);
    }
  }
}

function handleStop(config: WeChatAcpConfig): void {
  const pidFile = config.daemon.pidFile;
  if (!fs.existsSync(pidFile)) {
    console.log("No daemon running (no PID file found)");
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(pidFile);
    console.log(`Stopped daemon (PID ${pid})`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      fs.unlinkSync(pidFile);
      console.log(`Daemon not running (stale PID ${pid}), cleaned up`);
    } else {
      console.error(`Failed to stop daemon: ${String(err)}`);
    }
  }
}

function handleStatus(config: WeChatAcpConfig): void {
  const pidFile = config.daemon.pidFile;
  if (!fs.existsSync(pidFile)) {
    console.log("Not running");
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0); // test if process exists
    console.log(`Running (PID ${pid})`);
  } catch {
    console.log(`Not running (stale PID ${pid})`);
    fs.unlinkSync(pidFile);
  }
}

function getSyncBufPath(storageDir: string): string {
  return path.join(storageDir, "sync-buf.json");
}

function loadSyncBuf(storageDir: string): string {
  const p = getSyncBufPath(storageDir);
  if (!fs.existsSync(p)) return "";
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as { get_updates_buf?: string };
    return data.get_updates_buf ?? "";
  } catch {
    return "";
  }
}

async function handleLogin(config: WeChatAcpConfig): Promise<void> {
  await loginWeChat({
    baseUrl: config.wechat.baseUrl,
    botType: config.wechat.botType,
    storageDir: config.storage.dir,
    log: (msg) => console.log(msg),
    renderQrUrl: renderQrInTerminal,
  });
}

async function handleAuthStatus(config: WeChatAcpConfig): Promise<void> {
  const tokenData = loadToken(config.storage.dir);
  if (!tokenData) {
    console.log("Auth expired (no saved token)");
    process.exitCode = 10;
    return;
  }

  try {
    const resp = await getUpdates({
      baseUrl: tokenData.baseUrl,
      token: tokenData.token,
      get_updates_buf: loadSyncBuf(config.storage.dir),
      timeoutMs: 5_000,
    });
    const code = resp.errcode ?? resp.ret ?? 0;
    if (code === -14) {
      console.log("Auth expired (errcode -14)");
      process.exitCode = 10;
      return;
    }
    if (code !== 0) {
      console.error(`Auth check failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`);
      process.exitCode = 11;
      return;
    }
    console.log(`Auth valid (Bot: ${tokenData.accountId}, saved at ${tokenData.savedAt})`);
  } catch (err) {
    console.error(`Auth check failed: ${String(err)}`);
    process.exitCode = 11;
  }
}

function daemonize(config: WeChatAcpConfig): void {
  const logFile = config.daemon.logFile;
  const pidFile = config.daemon.pidFile;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });

  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");

  // Re-run ourselves with --no-daemon (internal flag) as a detached process
  const args = process.argv.slice(1).filter((a) => a !== "--daemon");
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, WECHAT_ACP_DAEMON: "1" },
    windowsHide: true,
  });

  child.unref();
  fs.writeFileSync(pidFile, String(child.pid), "utf-8");
  console.log(`Daemon started (PID ${child.pid})`);
  console.log(`Logs: ${logFile}`);
  console.log(`PID file: ${pidFile}`);
  process.exit(0);
}

function renderQrInTerminal(url: string): void {
  qrcodeTerminal.generate(url, { small: true }, (qr: string) => {
    console.log(qr);
  });
}

async function main(): Promise<void> {
  if (process.argv[2] === "codex-hook") {
    const { configFile, rest } = extractConfigArg(process.argv.slice(3));
    const config = defaultConfig();
    applyConfigFile(config, configFile);
    await runCodexHook(config, { binPath: process.argv[1], out: process.stdout, err: process.stderr, renderQrUrl: renderQrInTerminal });
    if (rest.length > 0) {
      // Extra arguments are ignored for hook mode; Codex passes payload on stdin.
    }
    return;
  }

  if (process.argv[2] === "codex-hooks") {
    const { configFile, rest } = extractConfigArg(process.argv.slice(3));
    const config = defaultConfig();
    applyConfigFile(config, configFile);
    await handleCodexHooksCommand(rest, config, { binPath: process.argv[1], out: process.stdout, err: process.stderr, renderQrUrl: renderQrInTerminal });
    return;
  }

  const args = parseArgs(process.argv);

  if (args.help) {
    usage();
    process.exit(0);
  }

  const config = defaultConfig();

  // Load config file if specified
  applyConfigFile(config, args.configFile);

  // Handle subcommands
  if (args.command === "agents") {
    handleAgents(config);
    return;
  }
  if (args.command === "login") {
    await handleLogin(config);
    return;
  }
  if (args.command === "auth-status") {
    await handleAuthStatus(config);
    return;
  }
  if (args.command === "stop") {
    handleStop(config);
    return;
  }
  if (args.command === "status") {
    handleStatus(config);
    return;
  }

  const agentSelection = args.agent ?? config.agent.preset;

  // Require preset or raw command
  if (!agentSelection && !config.agent.command) {
    console.error("Error: --agent is required\n");
    usage();
    process.exit(1);
  }

  if (agentSelection) {
    const resolvedAgent = resolveAgentSelection(agentSelection, config.agents);
    config.agent.preset = resolvedAgent.id;
    config.agent.command = resolvedAgent.command;
    config.agent.args = resolvedAgent.args;
    if (resolvedAgent.env) {
      config.agent.env = { ...(config.agent.env ?? {}), ...resolvedAgent.env };
    }
  }

  if (args.cwd) config.agent.cwd = path.resolve(args.cwd);
  if (args.idleTimeout !== undefined) {
    if (!Number.isFinite(args.idleTimeout) || args.idleTimeout < 0) {
      console.error("Error: invalid --idle-timeout value");
      console.error('Use a non-negative integer minute value, where "0" means unlimited.');
      process.exit(1);
    }
    config.session.idleTimeoutMs = args.idleTimeout * 60_000;
  }
  if (args.maxSessions) config.session.maxConcurrentUsers = args.maxSessions;
  if (args.hideThoughts) config.agent.showThoughts = false;
  config.daemon.enabled = args.daemon;

  // Handle daemon mode
  if (args.daemon && !process.env.WECHAT_ACP_DAEMON) {
    daemonize(config);
    return;
  }

  // Initialize telemetry. No-op when WECHAT_ACP_TELEMETRY=0/false/off.
  initTelemetry({
    version: packageJson.version,
    storageDir: config.storage.dir,
    agentPreset: config.agent.preset ?? "raw",
    daemon: config.daemon.enabled,
  });
  trackEvent("app.start", {
    agentPreset: config.agent.preset ?? "raw",
    daemon: config.daemon.enabled,
  });
  const startedAt = Date.now();

  // Create and start bridge
  const bridge = new WeChatAcpBridge(config, (msg) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] ${msg}`);
  });

  // Handle graceful shutdown
  const shutdown = async (reason: "signal" | "error" | "normal") => {
    trackEvent("app.stop", { reason, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
    await bridge.stop();
    await shutdownTelemetry();
    process.exit(reason === "error" ? 1 : 0);
  };
  process.on("SIGINT", () => void shutdown("signal"));
  process.on("SIGTERM", () => void shutdown("signal"));

  try {
    await bridge.start({
      forceLogin: args.forceLogin,
      renderQrUrl: renderQrInTerminal,
    });
  } catch (err) {
    if ((err as Error).message === "aborted") {
      // Normal shutdown
    } else {
      trackException(err, "main");
      trackEvent("app.stop", { reason: "error", uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
      await shutdownTelemetry();
      console.error(`Fatal: ${formatUnknownError(err)}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`Fatal: ${formatUnknownError(err)}`);
  process.exit(1);
});
