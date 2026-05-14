import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OutboundMediaKind } from "./send.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const OUTBOUND_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const OUTBOUND_VIDEO_MAX_BYTES = 200 * 1024 * 1024;

export interface OutboundMediaResolveOptions {
  roots: string[];
  maxImageBytes?: number;
  maxVideoBytes?: number;
}

export type OutboundMediaResolveResult =
  | { ok: true; path: string; kind: OutboundMediaKind }
  | { ok: false; reason: string };

export async function resolveOutboundMedia(
  rawPath: string,
  options: OutboundMediaResolveOptions,
): Promise<OutboundMediaResolveResult> {
  let resolved: string;
  try {
    resolved = resolveCandidatePath(rawPath, options.roots[0] ?? process.cwd());
  } catch {
    return { ok: false, reason: "invalid local file path" };
  }

  const kind = mediaKindFromPath(resolved);
  if (!kind) return { ok: false, reason: "unsupported media type" };

  let actualPath: string;
  try {
    actualPath = await fs.realpath(resolved);
  } catch {
    return { ok: false, reason: "file not found" };
  }

  const allowedRoots = await resolveExistingRoots(options.roots);
  if (!allowedRoots.some((root) => isPathInside(root, actualPath))) {
    return { ok: false, reason: "outside allowed media directories" };
  }

  const stat = await fs.stat(actualPath);
  if (!stat.isFile()) return { ok: false, reason: "not a file" };

  const maxBytes = kind === "image"
    ? options.maxImageBytes ?? OUTBOUND_IMAGE_MAX_BYTES
    : options.maxVideoBytes ?? OUTBOUND_VIDEO_MAX_BYTES;
  if (stat.size > maxBytes) {
    return { ok: false, reason: `${kind} is larger than ${Math.round(maxBytes / 1024 / 1024)}MB` };
  }

  if (!(await hasExpectedMediaSignature(actualPath, kind))) {
    return { ok: false, reason: "file content does not match an allowed image/video format" };
  }

  return { ok: true, path: actualPath, kind };
}

export function defaultOutboundMediaRoots(cwd?: string): string[] {
  const roots = [
    cwd,
    process.cwd(),
    path.join(os.homedir(), ".codex", "generated_images"),
    path.join(os.homedir(), "Documents", "Codex"),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(roots.map((root) => path.resolve(expandHome(root))))];
}

export function defaultHookMediaRoots(cwd?: string): string[] {
  return defaultOutboundMediaRoots(cwd);
}

export function mediaKindFromPath(filePath: string): OutboundMediaKind | null {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

function resolveCandidatePath(rawPath: string, root: string): string {
  if (rawPath.startsWith("file://")) {
    return fileURLToPath(rawPath);
  }
  const expanded = expandHome(rawPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function resolveExistingRoots(roots: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      resolved.push(await fs.realpath(path.resolve(expandHome(root))));
    } catch {
      // Ignore missing roots; the media file itself must still exist.
    }
  }
  return [...new Set(resolved)];
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function hasExpectedMediaSignature(filePath: string, kind: OutboundMediaKind): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);
    return kind === "image" ? hasImageSignature(header) : hasVideoSignature(header);
  } finally {
    await handle.close();
  }
}

function hasImageSignature(header: Buffer): boolean {
  if (header.length < 4) return false;
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return true;
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (header.subarray(0, 6).toString("ascii") === "GIF87a") return true;
  if (header.subarray(0, 6).toString("ascii") === "GIF89a") return true;
  if (header.subarray(0, 2).toString("ascii") === "BM") return true;
  if (
    header.length >= 12
    && header.subarray(0, 4).toString("ascii") === "RIFF"
    && header.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return true;
  }
  return isIsoBmffBrand(header, ["heic", "heix", "hevc", "hevx", "mif1", "msf1"]);
}

function hasVideoSignature(header: Buffer): boolean {
  if (header.length < 4) return false;
  if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return true;
  return isIsoBmffBrand(header, ["isom", "iso2", "avc1", "mp41", "mp42", "M4V ", "qt  "]);
}

function isIsoBmffBrand(header: Buffer, allowedBrands: string[]): boolean {
  if (header.length < 12 || header.subarray(4, 8).toString("ascii") !== "ftyp") return false;
  const brands = new Set<string>();
  brands.add(header.subarray(8, 12).toString("ascii"));
  for (let offset = 16; offset + 4 <= header.length; offset += 4) {
    brands.add(header.subarray(offset, offset + 4).toString("ascii"));
  }
  return allowedBrands.some((brand) => brands.has(brand));
}
