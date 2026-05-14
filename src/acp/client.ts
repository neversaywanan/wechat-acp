/**
 * ACP Client implementation for WeChat.
 *
 * Implements the acp.Client interface: handles session updates (accumulates
 * text chunks), auto-allows all permission requests, and provides filesystem
 * access for the agent.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";

export interface WeChatAcpClientOpts {
  sendTyping: () => Promise<void>;
  onThoughtFlush: (text: string) => Promise<void>;
  log: (msg: string) => void;
  showThoughts: boolean;
  agentCwd?: string;
  mediaOutputDir?: string;
  generatedImagesRoot?: string;
}

const IMAGEGEN_TOOL_ID_RE = /^ig_[a-z0-9_-]+$/i;
const LOCAL_MEDIA_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".heic",
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
]);

const MIME_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/bmp", ".bmp"],
  ["image/heic", ".heic"],
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
]);

const RAW_MEDIA_PATH_RE = /(?:file:\/\/|~\/|\/|\.\.?\/)[^\s<>"')]+\.(?:jpe?g|png|gif|webp|bmp|heic|mp4|mov|m4v|webm)(?:[?#][^\s<>"')]*)?/gi;
const GENERATED_IMAGE_WAIT_ATTEMPTS = 8;
const GENERATED_IMAGE_WAIT_MS = 250;

export class WeChatAcpClient implements acp.Client {
  private chunks: string[] = [];
  private thoughtChunks: string[] = [];
  private opts: WeChatAcpClientOpts;
  private lastTypingAt = 0;
  private sessionId: string | undefined;
  private generatedImageToolIds = new Set<string>();
  private emittedMediaKeys = new Set<string>();
  private static readonly TYPING_INTERVAL_MS = 5_000;

  constructor(opts: WeChatAcpClientOpts) {
    this.opts = opts;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  updateCallbacks(callbacks: { sendTyping: () => Promise<void>; onThoughtFlush: (text: string) => Promise<void> }): void {
    this.opts = {
      ...this.opts,
      sendTyping: callbacks.sendTyping,
      onThoughtFlush: callbacks.onThoughtFlush,
    };
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    // Auto-allow: find first "allow" option
    const allowOpt = params.options.find(
      (o) => o.kind === "allow_once" || o.kind === "allow_always",
    );
    const optionId = allowOpt?.optionId ?? params.options[0]?.optionId ?? "allow";

    this.opts.log(`[permission] auto-allowed: ${params.toolCall?.title ?? "unknown"} → ${optionId}`);

    return {
      outcome: {
        outcome: "selected",
        optionId,
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        await this.maybeFlushThoughts();
        await this.appendContentBlock(update.content);
        // Throttle typing indicators
        await this.maybeSendTyping();
        break;

      case "tool_call":
        await this.maybeFlushThoughts();
        this.rememberGeneratedImageTool(update);
        if (update.content) {
          await this.appendToolContent(update.content);
        }
        await this.appendMediaReferencesFromRawOutput(update.rawOutput);
        this.opts.log(`[tool] ${update.title} (${update.status})`);
        await this.maybeSendTyping();
        break;

      case "agent_thought_chunk":
        if (update.content.type === "text") {
          const text = update.content.text;
          this.opts.log(`[thought] ${text.length > 80 ? text.substring(0, 80) + "..." : text}`);
          if (this.opts.showThoughts) {
            this.thoughtChunks.push(text);
          }
        }
        await this.maybeSendTyping();
        break;

      case "tool_call_update":
        this.rememberGeneratedImageTool(update);
        if (update.content) {
          await this.appendToolContent(update.content);
        }
        await this.appendMediaReferencesFromRawOutput(update.rawOutput);
        if (update.status) {
          this.opts.log(`[tool] ${update.toolCallId} → ${update.status}`);
        }
        break;

      case "plan":
        // Log plan entries
        if (update.entries) {
          const items = update.entries
            .map((e: acp.PlanEntry, i: number) => `  ${i + 1}. [${e.status}] ${e.content}`)
            .join("\n");
          this.opts.log(`[plan]\n${items}`);
        }
        break;
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    try {
      const content = await fs.promises.readFile(params.path, "utf-8");
      return { content };
    } catch (err) {
      throw new Error(`Failed to read file ${params.path}: ${String(err)}`);
    }
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    try {
      await fs.promises.writeFile(params.path, params.content, "utf-8");
      return {};
    } catch (err) {
      throw new Error(`Failed to write file ${params.path}: ${String(err)}`);
    }
  }

  /** Get accumulated text and reset the buffer. Also flushes any remaining thoughts. */
  async flush(): Promise<string> {
    await this.maybeFlushThoughts();
    await this.appendGeneratedImageFiles();
    const text = this.chunks.join("");
    this.chunks = [];
    this.generatedImageToolIds.clear();
    this.emittedMediaKeys.clear();
    this.lastTypingAt = 0;
    return text;
  }

  private async appendToolContent(content: acp.ToolCallContent[]): Promise<void> {
    for (const c of content) {
      if (c.type === "content") {
        await this.appendContentBlock(c.content);
        continue;
      }

      if (c.type === "diff") {
        const diff = c as acp.Diff;
        const header = `--- ${diff.path}`;
        const lines: string[] = [header];
        if (diff.oldText != null) {
          for (const l of diff.oldText.split("\n")) lines.push(`- ${l}`);
        }
        if (diff.newText != null) {
          for (const l of diff.newText.split("\n")) lines.push(`+ ${l}`);
        }
        this.chunks.push("\n```diff\n" + lines.join("\n") + "\n```\n");
      }
    }
  }

  private async appendContentBlock(content: acp.ContentBlock): Promise<void> {
    if (content.type === "text") {
      this.chunks.push(content.text);
      return;
    }

    if (content.type === "image") {
      await this.appendBinaryContent(content.data, content.mimeType, content.uri ?? undefined, "acp-image");
      return;
    }

    if (content.type === "resource_link") {
      await this.appendMediaPathReference(content.uri);
      return;
    }

    if (content.type === "resource") {
      const resource = content.resource;
      if ("blob" in resource) {
        await this.appendBinaryContent(resource.blob, resource.mimeType ?? undefined, resource.uri, "acp-resource");
      } else {
        await this.appendMediaPathReference(resource.uri);
      }
    }
  }

  private rememberGeneratedImageTool(update: { toolCallId?: string; title?: string | null }): void {
    const toolCallId = update.toolCallId;
    const title = update.title ?? "";
    if (!toolCallId) return;
    if (IMAGEGEN_TOOL_ID_RE.test(toolCallId) || /image generation|图片生成|生成图片/i.test(title)) {
      this.generatedImageToolIds.add(toolCallId);
    }
  }

  private async appendGeneratedImageFiles(): Promise<void> {
    if (!this.sessionId || this.generatedImageToolIds.size === 0) return;

    for (const toolCallId of this.generatedImageToolIds) {
      const generatedPath = await this.findGeneratedImagePath(toolCallId);
      if (generatedPath) {
        await this.appendMediaPathReference(generatedPath);
      }
    }
  }

  private async findGeneratedImagePath(toolCallId: string): Promise<string | null> {
    const root = this.opts.generatedImagesRoot ?? path.join(os.homedir(), ".codex", "generated_images");
    const sessionDir = path.join(root, this.sessionId!);
    const candidates = [".png", ".jpg", ".jpeg", ".webp", ".gif"].map((ext) => path.join(sessionDir, `${toolCallId}${ext}`));

    for (let attempt = 0; attempt < GENERATED_IMAGE_WAIT_ATTEMPTS; attempt += 1) {
      for (const candidate of candidates) {
        if (await isFile(candidate)) return candidate;
      }
      await sleep(GENERATED_IMAGE_WAIT_MS);
    }

    return null;
  }

  private async appendBinaryContent(
    data: string,
    mimeType: string | undefined,
    uri: string | undefined,
    prefix: string,
  ): Promise<void> {
    const ext = extensionForMime(mimeType) ?? extensionFromPath(uri) ?? ".png";
    if (!LOCAL_MEDIA_EXTENSIONS.has(ext)) return;

    const buffer = decodeBase64Payload(data);
    if (buffer.length === 0) return;

    const digest = crypto.createHash("sha256").update(buffer).digest("hex");
    const key = `content:${digest}`;
    if (this.emittedMediaKeys.has(key)) return;
    this.emittedMediaKeys.add(key);

    const sessionPart = safeFilePart(this.sessionId ?? "session");
    const filePath = path.join(this.mediaOutputDir(), `${sessionPart}_${prefix}_${digest.slice(0, 24)}${ext}`);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.promises.writeFile(filePath, buffer, { flag: "wx" });
    } catch (err) {
      if (!isNodeError(err) || err.code !== "EEXIST") throw err;
    }
    this.appendMediaMarkdown(filePath);
  }

  private async appendMediaReferencesFromRawOutput(rawOutput: unknown): Promise<void> {
    for (const mediaPath of extractMediaPathStrings(rawOutput)) {
      await this.appendMediaPathReference(mediaPath);
    }
  }

  private async appendMediaPathReference(rawPath: string | undefined): Promise<void> {
    if (!rawPath || !looksLikeLocalMediaPath(rawPath)) return;

    let actualPath: string;
    try {
      actualPath = await fs.promises.realpath(resolveCandidatePath(rawPath, this.opts.agentCwd ?? process.cwd()));
    } catch {
      return;
    }

    const stat = await fs.promises.stat(actualPath).catch(() => null);
    if (!stat?.isFile()) return;

    const key = `path:${actualPath}:${stat.size}:${Math.round(stat.mtimeMs)}`;
    if (this.emittedMediaKeys.has(key)) return;
    this.emittedMediaKeys.add(key);

    const outputPath = await this.copyMediaIntoOutput(actualPath, stat);
    this.appendMediaMarkdown(outputPath);
  }

  private async copyMediaIntoOutput(actualPath: string, stat: fs.Stats): Promise<string> {
    const outputDir = this.mediaOutputDir();
    const relative = path.relative(outputDir, actualPath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return actualPath;
    }

    const ext = path.extname(actualPath).toLowerCase();
    const base = safeFilePart(path.basename(actualPath, ext));
    const digest = crypto
      .createHash("sha256")
      .update(`${actualPath}:${stat.size}:${Math.round(stat.mtimeMs)}`)
      .digest("hex")
      .slice(0, 16);
    const sessionPart = safeFilePart(this.sessionId ?? "session");
    const outputPath = path.join(outputDir, `${sessionPart}_${base}_${digest}${ext}`);

    await fs.promises.mkdir(outputDir, { recursive: true });
    try {
      await fs.promises.copyFile(actualPath, outputPath, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if (!isNodeError(err) || err.code !== "EEXIST") throw err;
    }
    return outputPath;
  }

  private mediaOutputDir(): string {
    return this.opts.mediaOutputDir ?? path.join(this.opts.agentCwd ?? process.cwd(), "outbound-media", "codex-generated-images");
  }

  private appendMediaMarkdown(filePath: string): void {
    this.chunks.push(`\n![generated image](<${filePath}>)\n`);
  }

  private async maybeFlushThoughts(): Promise<void> {
    if (this.thoughtChunks.length === 0) return;
    const thoughtText = this.thoughtChunks.join("");
    this.thoughtChunks = [];
    if (thoughtText.trim()) {
      try {
        await this.opts.onThoughtFlush(`💭 [Thinking]\n${thoughtText}`);
      } catch {
        // best effort
      }
    }
  }

  private async maybeSendTyping(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTypingAt < WeChatAcpClient.TYPING_INTERVAL_MS) return;
    this.lastTypingAt = now;
    try {
      await this.opts.sendTyping();
    } catch {
      // typing is best-effort
    }
  }
}

function decodeBase64Payload(value: string): Buffer {
  const comma = value.indexOf(",");
  const raw = value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
  try {
    return Buffer.from(raw, "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

function extensionForMime(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  return MIME_EXTENSIONS.get(mimeType.toLowerCase());
}

function extensionFromPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ext = path.extname(normalizeMediaTarget(value)).toLowerCase();
  return LOCAL_MEDIA_EXTENSIONS.has(ext) ? ext : undefined;
}

function looksLikeLocalMediaPath(value: string): boolean {
  if (hasNonLocalScheme(value)) return false;
  const ext = path.extname(normalizeMediaTarget(value)).toLowerCase();
  return LOCAL_MEDIA_EXTENSIONS.has(ext);
}

function normalizeMediaTarget(value: string): string {
  const trimmed = value.trim();
  const fragmentIndex = trimmed.indexOf("#");
  const queryIndex = trimmed.indexOf("?");
  const cutIndexes = [fragmentIndex, queryIndex].filter((index) => index >= 0);
  return cutIndexes.length ? trimmed.slice(0, Math.min(...cutIndexes)) : trimmed;
}

function hasNonLocalScheme(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  return !!schemeMatch && schemeMatch[1].toLowerCase() !== "file";
}

function resolveCandidatePath(rawPath: string, root: string): string {
  const target = normalizeMediaTarget(rawPath);
  if (target.startsWith("file://")) {
    return fileURLToPath(target);
  }
  const expanded = expandHome(target);
  return path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function extractMediaPathStrings(value: unknown, depth = 0, output = new Set<string>()): string[] {
  if (depth > 5 || output.size >= 20) return [...output];

  if (typeof value === "string") {
    for (const match of value.matchAll(RAW_MEDIA_PATH_RE)) {
      const candidate = match[0];
      if (looksLikeLocalMediaPath(candidate)) output.add(candidate);
    }
    if (looksLikeLocalMediaPath(value)) output.add(value);
    return [...output];
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) {
      extractMediaPathStrings(item, depth + 1, output);
      if (output.size >= 20) break;
    }
    return [...output];
  }

  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value).slice(0, 80)) {
      extractMediaPathStrings(item, depth + 1, output);
      if (output.size >= 20) break;
    }
  }

  return [...output];
}

async function isFile(filePath: string): Promise<boolean> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  return !!stat?.isFile();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "file";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
