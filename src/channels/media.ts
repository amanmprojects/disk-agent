import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { MessageAttachment } from "../types.js";
import { uid } from "../utils.js";

const IMAGE_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tgs": "application/x-tgsticker",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
};

export function isImageMime(mime?: string): boolean {
  if (!mime) return false;
  return IMAGE_MIME.has(mime.toLowerCase()) || mime.toLowerCase().startsWith("image/");
}

export function guessMime(fileName?: string, fallback = "application/octet-stream"): string {
  if (!fileName) return fallback;
  const ext = extname(fileName).toLowerCase();
  return EXT_MIME[ext] ?? fallback;
}

export interface DownloadedMedia {
  attachment: MessageAttachment;
  /** Absolute path on disk */
  path: string;
  bytes: Buffer;
}

/**
 * Download a Telegram file by file_id into dataDir/media/YYYY-MM-DD/.
 */
export async function downloadTelegramFile(opts: {
  token: string;
  fileId: string;
  dataDir: string;
  fileName?: string;
  mimeType?: string;
  type: MessageAttachment["type"];
  caption?: string;
  /** Prefer smaller downloads for photos — caller should pick the right file_id */
  maxBytes?: number;
}): Promise<DownloadedMedia> {
  const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
  const metaRes = await fetch(
    `https://api.telegram.org/bot${opts.token}/getFile?file_id=${encodeURIComponent(opts.fileId)}`,
  );
  const meta = (await metaRes.json()) as {
    ok: boolean;
    description?: string;
    result?: { file_path?: string; file_size?: number };
  };
  if (!meta.ok || !meta.result?.file_path) {
    throw new Error(meta.description || "getFile failed");
  }
  if (meta.result.file_size && meta.result.file_size > maxBytes) {
    throw new Error(`File too large (${meta.result.file_size} bytes, max ${maxBytes})`);
  }

  const filePath = meta.result.file_path;
  const url = `https://api.telegram.org/file/bot${opts.token}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  const ab = await res.arrayBuffer();
  const bytes = Buffer.from(ab);
  if (bytes.length > maxBytes) {
    throw new Error(`File too large after download (${bytes.length} bytes)`);
  }

  const day = new Date().toISOString().slice(0, 10);
  const dir = join(opts.dataDir, "media", day);
  await mkdir(dir, { recursive: true });

  const baseName =
    opts.fileName ||
    filePath.split("/").pop() ||
    `${uid("media")}${extname(filePath) || ""}`;
  const safeName = baseName.replace(/[^\w.\-()+@]+/g, "_");
  const localPath = join(dir, `${Date.now()}_${safeName}`);
  await writeFile(localPath, bytes);

  const mime =
    opts.mimeType ||
    guessMime(safeName, guessMime(filePath, "application/octet-stream"));

  const attachment: MessageAttachment = {
    type: opts.type,
    fileId: opts.fileId,
    fileName: safeName,
    mimeType: mime,
    localPath,
    caption: opts.caption,
    size: bytes.length,
    base64: isImageMime(mime) ? bytes.toString("base64") : undefined,
  };

  return { attachment, path: localPath, bytes };
}

/** Convert image attachments into Pi ImageContent blocks. */
export function attachmentsToImages(
  attachments: MessageAttachment[] | undefined,
): Array<{ type: "image"; data: string; mimeType: string }> {
  if (!attachments?.length) return [];
  const out: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const a of attachments) {
    if (!a.base64 || !isImageMime(a.mimeType)) continue;
    out.push({
      type: "image",
      data: a.base64,
      mimeType: a.mimeType || "image/jpeg",
    });
  }
  return out;
}

/** Human summary for logs / prompts */
export function describeAttachments(attachments: MessageAttachment[] | undefined): string {
  if (!attachments?.length) return "";
  return attachments
    .map((a) => {
      const bits: string[] = [a.type];
      if (a.fileName) bits.push(a.fileName);
      if (a.mimeType) bits.push(a.mimeType);
      if (a.durationSec != null) bits.push(`${a.durationSec}s`);
      if (a.localPath) bits.push(`saved:${a.localPath}`);
      if (a.base64) bits.push("vision:yes");
      if (a.transcript) {
        const t =
          a.transcript.length > 120 ? `${a.transcript.slice(0, 117)}…` : a.transcript;
        bits.push(`transcript:"${t}"`);
      }
      return `- ${bits.join(" · ")}`;
    })
    .join("\n");
}

// silence unused imports in some toolchains
void createWriteStream;
void pipeline;
void Readable;
