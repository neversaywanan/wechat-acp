/**
 * Send messages via WeChat iLink API.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { getUploadUrl, sendMessage } from "./api.js";
import { aesEcbPaddedSize, uploadToCdn } from "./media.js";
import { MessageType, MessageState, MessageItemType, UploadMediaType } from "./types.js";
import type { CDNMedia, MessageItem } from "./types.js";

export interface WeixinSendOpts {
  baseUrl: string;
  cdnBaseUrl?: string;
  token?: string;
  contextToken?: string;
}

export type OutboundMediaKind = "image" | "video";

export interface WeixinMediaFile {
  path: string;
  kind: OutboundMediaKind;
}

export async function sendTextMessage(
  to: string,
  text: string,
  opts: WeixinSendOpts,
): Promise<string> {
  const clientId = `wechat-acp-${crypto.randomUUID()}`;
  await sendMessage({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        ...(opts.contextToken ? { context_token: opts.contextToken } : {}),
        item_list: [{ type: 1, text_item: { text } }],
      },
    },
  });
  return clientId;
}

export async function sendMediaMessage(
  to: string,
  mediaFile: WeixinMediaFile,
  opts: WeixinSendOpts,
): Promise<string> {
  if (!opts.cdnBaseUrl) {
    throw new Error("cdnBaseUrl is required to send media");
  }

  const upload = await uploadOutboundMedia(to, mediaFile, opts);
  const clientId = `wechat-acp-${crypto.randomUUID()}`;
  await sendMessage({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        ...(opts.contextToken ? { context_token: opts.contextToken } : {}),
        item_list: [makeMediaItem(upload)],
      },
    },
  });
  return clientId;
}

interface UploadedOutboundMedia {
  kind: OutboundMediaKind;
  encryptedParam: string;
  aesKeyHex: string;
  encryptedSize: number;
  rawMd5: string;
}

async function uploadOutboundMedia(
  to: string,
  mediaFile: WeixinMediaFile,
  opts: WeixinSendOpts,
): Promise<UploadedOutboundMedia> {
  const buffer = await fs.readFile(mediaFile.path);
  const rawMd5 = crypto.createHash("md5").update(buffer).digest("hex");
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const encryptedSize = aesEcbPaddedSize(buffer.length);
  const filekey = crypto.randomBytes(16).toString("hex");
  const mediaType = mediaFile.kind === "image" ? UploadMediaType.IMAGE : UploadMediaType.VIDEO;

  const uploadInfo = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: to,
      rawsize: buffer.length,
      rawfilemd5: rawMd5,
      filesize: encryptedSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
    },
  });

  const uploadFullUrl = uploadInfo.upload_full_url?.trim();
  if (!uploadFullUrl && !uploadInfo.upload_param) {
    throw new Error(`getUploadUrl returned no upload URL: ${summarizeUploadUrlResponse(uploadInfo)}`);
  }

  const encryptedParam = await uploadToCdn({
    buffer,
    uploadParam: uploadInfo.upload_param,
    uploadFullUrl,
    aesKey,
    filekey,
    cdnBaseUrl: opts.cdnBaseUrl!,
  });

  return {
    kind: mediaFile.kind,
    encryptedParam,
    aesKeyHex,
    encryptedSize,
    rawMd5,
  };
}

function summarizeUploadUrlResponse(resp: object): string {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resp)) {
    if (typeof value === "string") {
      summary[key] = value ? `<string:${value.length}>` : "";
    } else {
      summary[key] = value;
    }
  }
  return JSON.stringify(summary);
}

function makeMediaItem(upload: UploadedOutboundMedia): MessageItem {
  const media: CDNMedia = {
    encrypt_query_param: upload.encryptedParam,
    aes_key: Buffer.from(upload.aesKeyHex).toString("base64"),
    encrypt_type: 1,
  };

  if (upload.kind === "image") {
    return {
      type: MessageItemType.IMAGE,
      image_item: {
        media,
        aeskey: upload.aesKeyHex,
        mid_size: upload.encryptedSize,
      },
    };
  }

  return {
    type: MessageItemType.VIDEO,
    video_item: {
      media,
      video_size: upload.encryptedSize,
      video_md5: upload.rawMd5,
    },
  };
}

/**
 * Split text into segments of max length, respecting line breaks where possible.
 */
export function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const segments: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      segments.push(remaining);
      break;
    }

    // Try to break at a newline
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt <= 0) breakAt = maxLen;

    segments.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).replace(/^\n/, "");
  }

  return segments;
}
