/**
 * Outbound adapter: format ACP output for WeChat delivery.
 */

export type OutboundReplyPart =
  | { type: "text"; text: string }
  | { type: "media"; path: string; fallbackText: string };

const LOCAL_MEDIA_EXTENSION_PATTERN = String.raw`(?:jpe?g|png|gif|webp|bmp|heic|mp4|mov|m4v|webm)`;

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

const MARKDOWN_LINK_RE = /!?\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const BARE_LOCAL_MEDIA_RE = new RegExp(
  String.raw`(?:^|[\s"'(])((?:file:\/\/|~\/|\/|\.\.?\/)[^\s<>"')]+\.(?:${LOCAL_MEDIA_EXTENSION_PATTERN})(?:[?#][^\s<>"')]*)?)`,
  "gi",
);

/**
 * Strip markdown formatting for cleaner WeChat display.
 * Preserves code blocks (as they're useful even in plain text).
 */
export function formatForWeChat(text: string): string {
  // Remove image references ![alt](url)
  let out = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[$1]");

  // Convert links [text](url) → text (url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Remove bold/italic markers but keep text
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, "$1");
  out = out.replace(/\*\*(.+?)\*\*/g, "$1");
  out = out.replace(/\*(.+?)\*/g, "$1");
  out = out.replace(/__(.+?)__/g, "$1");
  out = out.replace(/_(.+?)_/g, "$1");

  // Remove heading markers
  out = out.replace(/^#{1,6}\s+/gm, "");

  // Clean up excessive blank lines
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

export function splitOutboundReply(text: string): OutboundReplyPart[] {
  const parts: OutboundReplyPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const whole = match[0];
    const rawTarget = normalizeLocalMediaTarget(parseMarkdownTarget(match[2] ?? ""));
    const start = match.index ?? 0;
    if (!rawTarget || !isLocalMediaReference(rawTarget)) {
      continue;
    }

    appendTextWithBareMedia(parts, text.slice(cursor, start));
    parts.push({ type: "media", path: rawTarget, fallbackText: whole });
    cursor = start + whole.length;
  }

  appendTextWithBareMedia(parts, text.slice(cursor));
  return parts.length > 0 ? parts : [{ type: "text", text }];
}

function appendTextWithBareMedia(parts: OutboundReplyPart[], text: string): void {
  let cursor = 0;
  for (const match of text.matchAll(BARE_LOCAL_MEDIA_RE)) {
    const whole = match[0];
    const rawTarget = normalizeLocalMediaTarget(match[1] ?? "");
    const wholeStart = match.index ?? 0;
    const targetOffset = whole.indexOf(match[1] ?? "");
    const targetStart = wholeStart + Math.max(targetOffset, 0);
    const targetEnd = targetStart + (match[1] ?? "").length;

    if (!rawTarget || !isLocalMediaReference(rawTarget)) {
      continue;
    }

    appendTextPart(parts, text.slice(cursor, targetStart));
    parts.push({ type: "media", path: rawTarget, fallbackText: match[1] ?? rawTarget });
    cursor = targetEnd;
  }

  appendTextPart(parts, text.slice(cursor));
}

function appendTextPart(parts: OutboundReplyPart[], text: string): void {
  if (!text) return;
  const previous = parts[parts.length - 1];
  if (previous?.type === "text") {
    previous.text += text;
    return;
  }
  parts.push({ type: "text", text });
}

function parseMarkdownTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    if (end > 1) return trimmed.slice(1, end);
  }
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function normalizeLocalMediaTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) return "";
  const fragmentIndex = trimmed.indexOf("#");
  const queryIndex = trimmed.indexOf("?");
  const cutIndexes = [fragmentIndex, queryIndex].filter((index) => index >= 0);
  if (!cutIndexes.length) return trimmed;
  return trimmed.slice(0, Math.min(...cutIndexes));
}

function isLocalMediaReference(target: string): boolean {
  if (hasNonLocalScheme(target)) return false;
  const lower = target.toLowerCase();
  return [...LOCAL_MEDIA_EXTENSIONS].some((ext) => lower.endsWith(ext));
}

function hasNonLocalScheme(target: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(target)) return false;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(target);
  return !!schemeMatch && schemeMatch[1].toLowerCase() !== "file";
}
