import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getUpdates } from "../weixin/api.js";
import { login as loginWeChat, loadToken, type TokenData } from "../weixin/auth.js";
import { defaultHookMediaRoots, resolveOutboundMedia } from "../weixin/outbound-media.js";
import { sendMediaMessage, sendTextMessage, splitText } from "../weixin/send.js";
import { MessageType, type WeixinMessage } from "../weixin/types.js";
import { formatForWeChat, splitOutboundReply } from "../adapter/outbound.js";
import { WECHAT_ACP_SUPPRESS_CODEX_STOP_HOOK } from "../acp/env.js";
import type { WeChatAcpConfig } from "../config.js";

const DEFAULT_EVENTS = ["Stop", "PermissionRequest"] as const;
const DEFAULT_CODEX_HOOKS_PATH = path.join(os.homedir(), ".codex", "hooks.json");
const DEFAULT_CODEX_CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const DEFAULT_BIND_TEXT = "wechat-acp bind";
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_TIMEOUT_MS = 35_000;
const TEXT_CHUNK_LIMIT = 3800;
const HOOK_STATUS_STOP = "Sending WeChat notification";
const HOOK_STATUS_PERMISSION = "Waiting for WeChat approval";

type SupportedHookEvent = (typeof DEFAULT_EVENTS)[number];

interface HookState {
  targetUserId?: string;
  contextToken?: string;
  getUpdatesBuf?: string;
  updatedAt?: string;
}

interface HookIdentity {
  tokenData: TokenData;
  hookState: HookState;
  targetUserId: string;
  contextToken?: string;
}

interface PermissionDecision {
  decision: "allow" | "deny";
  reason: string;
}

export interface CodexHooksCommandOptions {
  binPath: string;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  renderQrUrl?: (url: string) => void;
}

export async function handleCodexHooksCommand(
  args: string[],
  config: WeChatAcpConfig,
  options: CodexHooksCommandOptions,
): Promise<void> {
  const [command = "help", ...rest] = args;
  const out = options.out ?? process.stdout;

  if (command === "help" || command === "-h" || command === "--help") {
    printUsage(out);
    return;
  }
  if (command === "login") return login(config, options);
  if (command === "setup") return setup(rest.join(" ") || DEFAULT_BIND_TEXT, config, options);
  if (command === "hook") return runHook(config, options);
  if (command === "install") return installHooks(rest, config, options);
  if (command === "uninstall") return uninstallHooks(options);
  if (command === "status") return status(config, out);
  if (command === "doctor") return doctor(config, out);
  if (command === "bind") return bind(rest.join(" ") || DEFAULT_BIND_TEXT, config, out);
  if (command === "send") return sendManual(rest, config, out);

  throw new Error(`Unknown codex-hooks command: ${command}`);
}

export async function runCodexHook(config: WeChatAcpConfig, options: CodexHooksCommandOptions): Promise<void> {
  return runHook(config, options);
}

function printUsage(out: NodeJS.WritableStream): void {
  out.write(`wechat-acp Codex hooks

Usage:
  wechat-acp codex-hooks install [--events Stop,PermissionRequest]
  wechat-acp codex-hooks login
  wechat-acp codex-hooks setup [match-text]
  wechat-acp codex-hooks uninstall
  wechat-acp codex-hooks bind [match-text]
  wechat-acp codex-hooks send <message>
  wechat-acp codex-hooks status
  wechat-acp codex-hooks doctor
  wechat-acp codex-hook

Setup:
  1. Log in with WeChat: wechat-acp codex-hooks login
  2. Send "wechat-acp bind" to the ClawBot chat, then run: wechat-acp codex-hooks bind
  3. Install Codex App hooks: wechat-acp codex-hooks install

Environment:
  WECHAT_ACP_HOOK_TO             Override target WeChat user id
  WECHAT_ACP_HOOK_CONTEXT        Override context_token
  WECHAT_ACP_CODEX_HOOKS         Codex hooks.json path, default ~/.codex/hooks.json
  WECHAT_ACP_CODEX_CONFIG        Codex config.toml path, default ~/.codex/config.toml
  WECHAT_ACP_HOOK_MEDIA_ROOTS    Extra media roots, separated by ${path.delimiter}
  WECHAT_ACP_APPROVAL_TIMEOUT_MS Permission approval wait timeout
`);
}

async function runHook(config: WeChatAcpConfig, options: CodexHooksCommandOptions): Promise<void> {
  const raw = await readStdin();
  const payload = parseJsonObject(raw);
  const eventName = payload ? hookEventName(payload) : "";
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;

  try {
    if (payload && eventName === "Stop") {
      if (shouldSuppressStopHookNotification()) return;
      const text = formatStopPayload(payload);
      if (text) await sendHookReply(text, config, payload);
      return;
    }

    if (payload && eventName === "PermissionRequest") {
      const decision = await requestWeChatPermission(payload, config, err);
      if (decision) {
        out.write(`${JSON.stringify(permissionHookOutput(decision))}\n`);
      }
      return;
    }

    const text = formatGenericHookPayload(payload ?? raw);
    if (text) await sendHookReply(text, config, payload ?? undefined);
  } catch (error) {
    err.write(`wechat-acp codex hook warning: ${errorMessage(error)}\n`);
  } finally {
    if (eventName === "Stop") {
      out.write(`${JSON.stringify({ continue: true })}\n`);
    }
  }
}

async function requestWeChatPermission(
  payload: Record<string, unknown>,
  config: WeChatAcpConfig,
  err: NodeJS.WritableStream,
): Promise<PermissionDecision | null> {
  const message = formatPermissionPayload(payload);
  await sendHookReply(message, config, payload);

  const timeoutMs = approvalTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  const identity = loadHookIdentity(config);
  const state = identity.hookState;
  const tokenData = identity.tokenData;

  err.write(`wechat-acp permission hook: waiting ${Math.round(timeoutMs / 1000)}s for WeChat reply\n`);

  while (Date.now() < deadline) {
    const remaining = Math.max(1000, Math.min(DEFAULT_POLL_TIMEOUT_MS, deadline - Date.now()));
    const updates = await getUpdates({
      baseUrl: tokenData.baseUrl,
      token: tokenData.token,
      get_updates_buf: state.getUpdatesBuf ?? "",
      timeoutMs: remaining,
    });

    if (updates.get_updates_buf) {
      state.getUpdatesBuf = updates.get_updates_buf;
      saveHookState(config.storage.dir, state);
    }

    for (const msg of updates.msgs ?? []) {
      if (!isTargetUserMessage(msg, identity.targetUserId)) continue;
      if (msg.context_token) {
        state.contextToken = msg.context_token;
        saveHookState(config.storage.dir, state);
      }
      const text = textFromItems(msg.item_list);
      const decision = parseApprovalReply(text);
      if (decision) return decision;
      if (text.trim()) {
        await sendHookReply("请回复“允许”或“拒绝”。", config, payload);
      }
    }
  }

  err.write("wechat-acp permission hook: approval timed out, falling back to Codex default handling\n");
  return null;
}

function permissionHookOutput(decision: PermissionDecision): object {
  const hookDecision = decision.decision === "allow"
    ? { behavior: "allow" }
    : { behavior: "deny", message: decision.reason };
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: hookDecision,
    },
  };
}

function shouldSuppressStopHookNotification(): boolean {
  return process.env[WECHAT_ACP_SUPPRESS_CODEX_STOP_HOOK] === "1";
}

async function sendManual(args: string[], config: WeChatAcpConfig, out: NodeJS.WritableStream): Promise<void> {
  const text = args.length ? args.join(" ") : await readStdin();
  if (!text.trim()) throw new Error("empty message");
  const sent = await sendHookReply(text, config);
  out.write(`Sent ${sent.textMessages} text message(s), ${sent.mediaMessages} media message(s)\n`);
}

async function login(config: WeChatAcpConfig, options: CodexHooksCommandOptions): Promise<void> {
  const out = options.out ?? process.stdout;
  await loginWeChat({
    baseUrl: config.wechat.baseUrl,
    botType: config.wechat.botType,
    storageDir: config.storage.dir,
    log: (msg) => out.write(`${msg}\n`),
    renderQrUrl: options.renderQrUrl,
  });
  out.write(`Next: send "${DEFAULT_BIND_TEXT}" to the ClawBot chat, then run "wechat-acp codex-hooks bind".\n`);
}

async function setup(matchText: string, config: WeChatAcpConfig, options: CodexHooksCommandOptions): Promise<void> {
  await login(config, options);
  const out = options.out ?? process.stdout;
  out.write(`Now send "${matchText}" to the ClawBot chat in WeChat.\n`);
  await bind(matchText, config, out);
}

async function sendHookReply(
  text: string,
  config: WeChatAcpConfig,
  payload?: Record<string, unknown>,
): Promise<{ textMessages: number; mediaMessages: number }> {
  const identity = loadHookIdentity(config);
  const roots = hookMediaRoots(payload);
  const parts = splitOutboundReply(text);
  let textMessages = 0;
  let mediaMessages = 0;

  for (const part of parts) {
    if (part.type === "text") {
      textMessages += await sendHookText(identity, part.text);
      continue;
    }

    const media = await resolveOutboundMedia(part.path, { roots });
    if (!media.ok) {
      textMessages += await sendHookText(identity, part.fallbackText);
      continue;
    }

    try {
      await sendMediaMessage(
        identity.targetUserId,
        { path: media.path, kind: media.kind },
        {
          baseUrl: identity.tokenData.baseUrl,
          cdnBaseUrl: config.wechat.cdnBaseUrl,
          token: identity.tokenData.token,
          contextToken: identity.contextToken,
        },
      );
      mediaMessages += 1;
    } catch {
      textMessages += await sendHookText(identity, part.fallbackText);
    }
  }

  return { textMessages, mediaMessages };
}

async function sendHookText(identity: HookIdentity, text: string): Promise<number> {
  const formatted = formatForWeChat(text);
  if (!formatted) return 0;
  const chunks = splitText(formatted, TEXT_CHUNK_LIMIT);
  for (const chunk of chunks) {
    await sendTextMessage(identity.targetUserId, chunk, {
      baseUrl: identity.tokenData.baseUrl,
      token: identity.tokenData.token,
      contextToken: identity.contextToken,
    });
  }
  return chunks.length;
}

async function bind(matchText: string, config: WeChatAcpConfig, out: NodeJS.WritableStream): Promise<void> {
  const tokenData = loadHookToken(config);
  const state = loadHookState(config.storage.dir);
  out.write(`Waiting for a WeChat message containing "${matchText}"...\n`);

  while (true) {
    const updates = await getUpdates({
      baseUrl: tokenData.baseUrl,
      token: tokenData.token,
      get_updates_buf: state.getUpdatesBuf ?? "",
      timeoutMs: DEFAULT_POLL_TIMEOUT_MS,
    });

    if (updates.get_updates_buf) {
      state.getUpdatesBuf = updates.get_updates_buf;
      saveHookState(config.storage.dir, state);
    }

    for (const msg of updates.msgs ?? []) {
      if (msg.message_type !== MessageType.USER || msg.group_id || !msg.from_user_id) continue;
      const text = textFromItems(msg.item_list);
      if (!text.includes(matchText)) continue;

      state.targetUserId = msg.from_user_id;
      state.contextToken = msg.context_token || state.contextToken;
      state.updatedAt = new Date().toISOString();
      const statePath = saveHookState(config.storage.dir, state);
      await sendHookText(
        {
          tokenData,
          hookState: state,
          targetUserId: state.targetUserId,
          contextToken: state.contextToken,
        },
        "wechat-acp Codex hooks connected.",
      );
      out.write(`Bound target user. State saved to ${statePath}\n`);
      return;
    }
  }
}

function installHooks(
  args: string[],
  config: WeChatAcpConfig,
  options: CodexHooksCommandOptions,
): void {
  const events = parseEventsArg(args);
  const unsupported = events.filter((eventName) => !isSupportedEvent(eventName));
  if (unsupported.length) {
    throw new Error(`unsupported hook events: ${unsupported.join(", ")}`);
  }

  const hooksConfig = readHooksConfig(false);
  cleanWechatAcpHooks(hooksConfig);

  const command = shellQuote(process.execPath) + " " + shellQuote(path.resolve(options.binPath)) + " codex-hook";
  for (const eventName of events) {
    const entry = {
      type: "command",
      command,
      timeout: eventName === "PermissionRequest" ? Math.ceil(approvalTimeoutMs() / 1000) + 10 : 25,
      statusMessage: eventName === "PermissionRequest" ? HOOK_STATUS_PERMISSION : HOOK_STATUS_STOP,
    };
    const group = eventName === "PermissionRequest" ? { matcher: "*", hooks: [entry] } : { hooks: [entry] };
    hooksConfig.hooks[eventName] = Array.isArray(hooksConfig.hooks[eventName])
      ? [...hooksConfig.hooks[eventName], group]
      : [group];
  }

  const hooksPath = saveHooksConfig(hooksConfig);
  const featurePath = ensureCodexHooksFeatureEnabled();
  const out = options.out ?? process.stdout;
  out.write(`Installed Codex WeChat hooks for ${events.join(", ")} in ${hooksPath}\n`);
  out.write(`Enabled Codex [features].hooks in ${featurePath}\n`);
  out.write("Codex may ask you to trust the new hook command once.\n");
}

function uninstallHooks(options: CodexHooksCommandOptions): void {
  const hooksConfig = readHooksConfig(true);
  cleanWechatAcpHooks(hooksConfig);
  const hooksPath = saveHooksConfig(hooksConfig);
  const out = options.out ?? process.stdout;
  out.write(`Removed wechat-acp Codex hook entries from ${hooksPath}\n`);
}

function status(config: WeChatAcpConfig, out: NodeJS.WritableStream): void {
  const tokenData = loadHookToken(config, false);
  const state = loadHookState(config.storage.dir);
  const hooksConfig = readHooksConfig(false);
  const features = readCodexFeatureStatus();
  const printable = {
    storageDir: config.storage.dir,
    token: Boolean(tokenData),
    boundTarget: Boolean(process.env.WECHAT_ACP_HOOK_TO || state.targetUserId),
    hasContextToken: Boolean(process.env.WECHAT_ACP_HOOK_CONTEXT || state.contextToken),
    hooksPath: codexHooksPath(),
    installedHookEvents: installedEvents(hooksConfig),
    codexConfigPath: codexConfigPath(),
    featuresHooks: features.hooks,
    deprecatedCodexHooksPresent: features.codexHooksPresent,
    updatedAt: state.updatedAt || "",
  };
  out.write(`${JSON.stringify(printable, null, 2)}\n`);
}

function doctor(config: WeChatAcpConfig, out: NodeJS.WritableStream): void {
  const tokenData = loadHookToken(config, false);
  const state = loadHookState(config.storage.dir);
  const hooksConfig = readHooksConfig(false);
  const features = readCodexFeatureStatus();
  const events = installedEvents(hooksConfig);
  const checks = [
    { name: "WeChat token", ok: Boolean(tokenData), detail: tokenData?.accountId || "missing" },
    { name: "Bound target", ok: Boolean(process.env.WECHAT_ACP_HOOK_TO || state.targetUserId), detail: maskId(process.env.WECHAT_ACP_HOOK_TO || state.targetUserId || "missing") },
    { name: "Context token", ok: Boolean(process.env.WECHAT_ACP_HOOK_CONTEXT || state.contextToken), detail: (process.env.WECHAT_ACP_HOOK_CONTEXT || state.contextToken) ? "present" : "missing" },
    { name: "Stop hook", ok: events.includes("Stop"), detail: events.join(", ") || "missing" },
    { name: "PermissionRequest hook", ok: events.includes("PermissionRequest"), detail: events.join(", ") || "missing" },
    { name: "Codex [features].hooks", ok: features.hooks === true, detail: features.hooks === true ? "enabled" : "missing" },
    { name: "Deprecated codex_hooks removed", ok: !features.codexHooksPresent, detail: features.codexHooksPresent ? "codex_hooks present" : "ok" },
  ];

  for (const check of checks) {
    out.write(`${check.ok ? "OK " : "NO "} ${check.name}: ${check.detail}\n`);
  }
  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

function formatStopPayload(payload: Record<string, unknown>): string {
  const finalMessage = firstString(payload, [
    "last_assistant_message",
    "message",
    "summary",
    "body",
    "text",
    "reason",
  ]);

  const sessionTitle = stopSessionCreatedTitle(finalMessage);
  if (sessionTitle) {
    return formatSessionCreatedPayload(payload, sessionTitle);
  }

  if (!shouldNotifyStopPayload(payload, finalMessage)) {
    return "";
  }

  const lines = [
    "Codex App任务完成",
    "",
    `时间: ${formatTime()}`,
  ];

  if (payload.cwd) lines.push(`目录: ${shortValue(payload.cwd, 600)}`);
  const sessionLabel = stopSessionLabel(payload);
  if (sessionLabel) lines.push(`会话: ${shortValue(sessionLabel, 600)}`);
  if (payload.status) lines.push(`状态: ${payload.status}`);
  if (payload.exit_code != null) lines.push(`退出码: ${payload.exit_code}`);
  if (finalMessage) lines.push("", "结果:", shortValue(finalMessage, 2600));
  return lines.join("\n");
}

function formatSessionCreatedPayload(payload: Record<string, unknown>, title: string): string {
  const lines = [
    `${shortValue(title, 600)} 会话已创建`,
    "",
    `时间: ${formatTime()}`,
  ];

  if (payload.cwd) lines.push(`目录: ${shortValue(payload.cwd, 600)}`);
  const sessionLabel = stopSessionLabel(payload);
  if (sessionLabel) lines.push(`会话: ${shortValue(sessionLabel, 600)}`);
  return lines.join("\n");
}

function stopSessionLabel(payload: Record<string, unknown>): string {
  const sessionId = firstString(payload, ["session_id", "sessionId", "thread_id", "threadId"]);
  if (!sessionId) return "";
  return findCodexThreadTitle(sessionId) || sessionId;
}

function findCodexThreadTitle(threadId: string): string {
  return findCodexThreadTitleInSessionIndex(threadId)
    || findCodexThreadTitleInStateDb(threadId);
}

function findCodexThreadTitleInSessionIndex(threadId: string): string {
  const filePath = path.join(os.homedir(), ".codex", "session_index.jsonl");
  if (!fs.existsSync(filePath)) return "";

  try {
    const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!line.includes(threadId)) continue;
      const entry = JSON.parse(line) as unknown;
      const record = objectRecord(entry);
      if (record && firstString(record, ["id"]) === threadId) {
        return firstString(record, ["thread_name", "title", "name"]);
      }
    }
  } catch {
    return "";
  }
  return "";
}

function findCodexThreadTitleInStateDb(threadId: string): string {
  const dbPath = path.join(os.homedir(), ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return "";

  try {
    return execFileSync(
      "sqlite3",
      [
        "-readonly",
        dbPath,
        "select title from threads where id = ? limit 1;",
        threadId,
      ],
      {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    return "";
  }
}

function stopSessionCreatedTitle(message: string): string {
  const text = message.trim();
  if (!text) return "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "";
  }

  const payload = objectRecord(parsed);
  if (!payload) return "";
  const title = firstString(payload, ["title"]);
  if (!title) return "";

  const keys = Object.keys(payload);
  const hasOnlyTitleAndEmptyFilters = keys.every((key) => {
    if (key === "title") return true;
    const item = payload[key];
    return (key === "exclude" || key === "include") && Array.isArray(item) && item.length === 0;
  });
  return hasOnlyTitleAndEmptyFilters ? title : "";
}

function shouldNotifyStopPayload(payload: Record<string, unknown>, finalMessage: string): boolean {
  if (isMeaningfulStopMessage(finalMessage)) {
    return true;
  }

  const status = firstString(payload, ["status"]).toLowerCase();
  if (/\b(error|failed|failure|cancelled|canceled|timeout|refusal)\b/.test(status)) {
    return true;
  }

  if (payload.exit_code != null) {
    const exitCode = Number(payload.exit_code);
    return Number.isFinite(exitCode) ? exitCode !== 0 : String(payload.exit_code).trim() !== "0";
  }

  return false;
}

function isMeaningfulStopMessage(message: string): boolean {
  const text = message.trim();
  if (!text) return false;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (isEmptyStopControlPayload(parsed)) {
      return false;
    }
  } catch {
    // Plain text is a valid task result.
  }

  return true;
}

function isEmptyStopControlPayload(value: unknown): boolean {
  const payload = objectRecord(value);
  if (!payload) return false;
  const keys = Object.keys(payload);
  if (keys.length === 0) return true;
  return keys.every((key) => {
    const item = payload[key];
    return (key === "exclude" || key === "include") && Array.isArray(item) && item.length === 0;
  });
}

function formatPermissionPayload(payload: Record<string, unknown>): string {
  const title = firstString(payload, ["title"]) || "Codex 权限请求";
  const toolName = firstString(payload, ["tool_name", "toolName", "name"]);
  const command = firstString(payload, ["command", "cmd"]);
  const reason = firstString(payload, ["reason", "description", "message", "prompt"]);
  const toolInput = objectRecord(payload.tool_input) ?? objectRecord(payload.toolInput);
  const toolInputCommand = firstString(toolInput, ["command", "cmd"]);
  const lines = [
    title,
    "",
    "回复“允许”继续，或回复“拒绝”取消。",
    "",
    `时间: ${formatTime()}`,
  ];

  if (payload.cwd) lines.push(`目录: ${shortValue(payload.cwd, 600)}`);
  if (toolName) lines.push(`工具: ${shortValue(toolName, 300)}`);
  if (command || toolInputCommand) lines.push(`命令: ${shortValue(command || toolInputCommand, 1200)}`);
  if (reason) lines.push(`说明: ${shortValue(reason, 800)}`);
  if (payload.session_id) lines.push(`会话: ${payload.session_id}`);
  lines.push(`请求: ${crypto.randomBytes(4).toString("hex")}`);
  return lines.join("\n");
}

function formatGenericHookPayload(payload: Record<string, unknown> | string): string {
  if (typeof payload === "string") return payload.trim();
  const eventName = hookEventName(payload);
  const message = firstString(payload, ["message", "body", "text", "summary", "reason", "prompt"]);
  const lines = [eventName || "Codex hook"];
  if (message) lines.push(shortValue(message, 1600));
  if (payload.cwd) lines.push(`cwd: ${shortValue(payload.cwd, 600)}`);
  if (payload.session_id) lines.push(`session_id: ${payload.session_id}`);
  return lines.join("\n");
}

function parseApprovalReply(text: string): PermissionDecision | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  if (/^(允许|同意|批准|可以|好|确认|allow|approve|approved|yes|y|ok|1)(\b|\s|。|，|,|!|！|$)/i.test(normalized)) {
    return { decision: "allow", reason: `Approved from WeChat: ${shortValue(text, 200)}` };
  }
  if (/^(拒绝|不允许|不同意|取消|deny|denied|reject|rejected|no|n|2)(\b|\s|。|，|,|!|！|$)/i.test(normalized)) {
    return { decision: "deny", reason: `Denied from WeChat: ${shortValue(text, 200)}` };
  }
  return null;
}

function parseEventsArg(args: string[]): SupportedHookEvent[] {
  const index = args.findIndex((arg) => arg === "--events" || arg.startsWith("--events="));
  if (index === -1) return [...DEFAULT_EVENTS];
  const raw = args[index].startsWith("--events=") ? args[index].slice("--events=".length) : args[index + 1] || "";
  const events = raw.split(",").map((eventName) => eventName.trim()).filter(Boolean);
  return events as SupportedHookEvent[];
}

function isSupportedEvent(eventName: string): eventName is SupportedHookEvent {
  return DEFAULT_EVENTS.includes(eventName as SupportedHookEvent);
}

function readHooksConfig(required: boolean): { hooks: Record<string, Array<Record<string, unknown>>> } {
  const filePath = codexHooksPath();
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error(`hooks file not found: ${filePath}`);
    return { hooks: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { hooks?: Record<string, Array<Record<string, unknown>>> };
  if (!parsed.hooks || typeof parsed.hooks !== "object") parsed.hooks = {};
  return parsed as { hooks: Record<string, Array<Record<string, unknown>>> };
}

function saveHooksConfig(config: { hooks: Record<string, Array<Record<string, unknown>>> }): string {
  const filePath = codexHooksPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

function cleanWechatAcpHooks(config: { hooks: Record<string, Array<Record<string, unknown>>> }): void {
  for (const [eventName, groups] of Object.entries(config.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    const nextGroups = groups
      .map((group) => {
        const hooks = Array.isArray(group.hooks) ? group.hooks.filter((entry) => !isManagedOrObsoleteWechatHookEntry(entry)) : [];
        return { ...group, hooks };
      })
      .filter((group) => group.hooks.length > 0);
    if (nextGroups.length) config.hooks[eventName] = nextGroups;
    else delete config.hooks[eventName];
  }
}

function installedEvents(config: { hooks: Record<string, Array<Record<string, unknown>>> }): string[] {
  return Object.entries(config.hooks || {})
    .filter(([, groups]) => Array.isArray(groups) && groups.some((group) => {
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      return hooks.some(isCurrentWechatAcpHookEntry);
    }))
    .map(([eventName]) => eventName);
}

function isCurrentWechatAcpHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const command = String((entry as { command?: unknown }).command || "");
  return command.includes("wechat-acp") && command.includes("codex-hook");
}

function isManagedOrObsoleteWechatHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const command = String((entry as { command?: unknown }).command || "");
  return isCurrentWechatAcpHookEntry(entry)
    || command.includes("codex-hook-weixin.sh")
    || command.includes("codex-weixin-hook.mjs");
}

function ensureCodexHooksFeatureEnabled(): string {
  const filePath = codexConfigPath();
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const next = setTomlFeatureHooks(original);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (next !== original) fs.writeFileSync(filePath, next, "utf8");
  return filePath;
}

function readCodexFeatureStatus(): { hooks?: boolean; codexHooksPresent: boolean } {
  const filePath = codexConfigPath();
  if (!fs.existsSync(filePath)) return { hooks: undefined, codexHooksPresent: false };
  const text = fs.readFileSync(filePath, "utf8");
  const section = readTomlSection(text, "features");
  let hooks: boolean | undefined;
  let codexHooksPresent = false;
  for (const line of section) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(true|false)\b/i.exec(line);
    if (!match) continue;
    if (match[1] === "hooks") hooks = match[2].toLowerCase() === "true";
    if (match[1] === "codex_hooks") codexHooksPresent = true;
  }
  return { hooks, codexHooksPresent };
}

function setTomlFeatureHooks(text: string): string {
  const lines = text ? text.split(/\r?\n/) : [];
  let featuresStart = lines.findIndex((line) => /^\s*\[features\]\s*(?:#.*)?$/.test(line));
  if (featuresStart === -1) {
    const prefix = lines.length && lines[lines.length - 1] !== "" ? [""] : [];
    return [...lines, ...prefix, "[features]", "hooks = true", ""].join("\n");
  }

  let featuresEnd = lines.length;
  for (let i = featuresStart + 1; i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(lines[i])) {
      featuresEnd = i;
      break;
    }
  }

  let hooksIndex = -1;
  const deprecatedIndexes: number[] = [];
  for (let i = featuresStart + 1; i < featuresEnd; i += 1) {
    if (/^\s*hooks\s*=/.test(lines[i])) hooksIndex = i;
    if (/^\s*codex_hooks\s*=/.test(lines[i])) deprecatedIndexes.push(i);
  }

  if (hooksIndex >= 0) {
    lines[hooksIndex] = "hooks = true";
  } else if (deprecatedIndexes.length > 0) {
    hooksIndex = deprecatedIndexes[0];
    lines[hooksIndex] = "hooks = true";
  } else {
    lines.splice(featuresStart + 1, 0, "hooks = true");
    featuresEnd += 1;
  }

  for (const index of deprecatedIndexes.slice().reverse()) {
    if (index !== hooksIndex) lines.splice(index, 1);
  }

  return lines.join("\n").replace(/\n*$/, "\n");
}

function readTomlSection(text: string, sectionName: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*\\[${escapeRegExp(sectionName)}\\]\\s*(?:#.*)?$`).test(line));
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function loadHookIdentity(config: WeChatAcpConfig): HookIdentity {
  const tokenData = loadHookToken(config);
  const hookState = loadHookState(config.storage.dir);
  const targetUserId = process.env.WECHAT_ACP_HOOK_TO || hookState.targetUserId || "";
  const contextToken = process.env.WECHAT_ACP_HOOK_CONTEXT || hookState.contextToken;
  if (!targetUserId) {
    throw new Error(`missing bound WeChat target. Run: wechat-acp codex-hooks bind`);
  }
  return { tokenData, hookState, targetUserId, contextToken };
}

function loadHookToken(config: WeChatAcpConfig, required?: true): TokenData;
function loadHookToken(config: WeChatAcpConfig, required: false): TokenData | null;
function loadHookToken(config: WeChatAcpConfig, required = true): TokenData | null {
  const token = loadToken(config.storage.dir);
  if (token) return token;

  if (required) throw new Error(`missing WeChat token. Run: wechat-acp --agent codex --login`);
  return null;
}

function loadHookState(storageDir: string): HookState {
  const filePath = hookStatePath(storageDir);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as HookState;
    } catch {
      return {};
    }
  }
  return {};
}

function saveHookState(storageDir: string, state: HookState): string {
  const filePath = hookStatePath(storageDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort only.
  }
  return filePath;
}

function hookStatePath(storageDir: string): string {
  return path.join(storageDir, "codex-hooks.json");
}

function codexHooksPath(): string {
  return process.env.WECHAT_ACP_CODEX_HOOKS || DEFAULT_CODEX_HOOKS_PATH;
}

function codexConfigPath(): string {
  return process.env.WECHAT_ACP_CODEX_CONFIG || DEFAULT_CODEX_CONFIG_PATH;
}

function approvalTimeoutMs(): number {
  const raw = process.env.WECHAT_ACP_APPROVAL_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_APPROVAL_TIMEOUT_MS;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_APPROVAL_TIMEOUT_MS;
}

function hookMediaRoots(payload?: Record<string, unknown>): string[] {
  const cwd = firstString(payload, ["cwd"]) || undefined;
  const envRoots = (process.env.WECHAT_ACP_HOOK_MEDIA_ROOTS || "")
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  return [...new Set([...defaultHookMediaRoots(cwd), ...envRoots])];
}

function isTargetUserMessage(msg: WeixinMessage, targetUserId: string): boolean {
  return msg.message_type === MessageType.USER
    && !msg.group_id
    && Boolean(msg.from_user_id)
    && msg.from_user_id === targetUserId;
}

function textFromItems(items: WeixinMessage["item_list"]): string {
  if (!Array.isArray(items)) return "";
  for (const item of items) {
    if (item?.type === 1 && item.text_item?.text != null) return String(item.text_item.text);
    if (item?.type === 3 && item.voice_item?.text != null) return String(item.voice_item.text);
  }
  return "";
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf.trim()));
    process.stdin.on("error", reject);
  });
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hookEventName(payload: Record<string, unknown>): string {
  return firstString(payload, ["hook_event_name", "hookEventName", "event", "hook"]);
}

function firstString(payload: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (!payload) return "";
  for (const key of keys) {
    const value = payload[key];
    if (value != null && value !== "") return String(value);
  }
  return "";
}

function shortValue(value: unknown, maxLen = 900): string {
  const text = String(value ?? "").trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function formatTime(date = new Date()): string {
  return date.toLocaleString("zh-CN", { hour12: false });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function maskId(value: string): string {
  if (!value || value === "missing") return value;
  if (value.length <= 10) return "***";
  return `${value.slice(0, 4)}...${value.slice(-6)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
