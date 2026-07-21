/**
 * Speech-to-text for Telegram voice/audio messages.
 * OpenAI Whisper and Groq Whisper-compatible HTTP APIs (no SDK required).
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AppConfig } from "../config.js";

export type SttProvider = "openai" | "groq" | "none";

export interface TranscribeInput {
  /** Absolute path to audio file on disk */
  path: string;
  /** MIME type (e.g. audio/ogg) */
  mimeType?: string;
  /** Original filename for multipart (extension matters for some APIs) */
  fileName?: string;
  provider: SttProvider;
  model?: string;
  /** ISO-639-1 language hint */
  language?: string;
  apiKey?: string;
}

export interface TranscribeResult {
  ok: boolean;
  text?: string;
  provider?: SttProvider;
  model?: string;
  error?: string;
}

const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

const DEFAULT_MODELS: Record<Exclude<SttProvider, "none">, string> = {
  openai: "whisper-1",
  groq: "whisper-large-v3-turbo",
};

export function resolveSttProvider(
  configured: AppConfig["voice"]["provider"],
): SttProvider {
  if (configured === "none") return "none";
  if (configured === "openai") return "openai";
  if (configured === "groq") return "groq";
  // auto
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  if (process.env.GROQ_API_KEY?.trim()) return "groq";
  return "none";
}

export function resolveSttApiKey(provider: SttProvider): string | undefined {
  if (provider === "openai") return process.env.OPENAI_API_KEY?.trim() || undefined;
  if (provider === "groq") return process.env.GROQ_API_KEY?.trim() || undefined;
  return undefined;
}

export function defaultSttModel(provider: SttProvider, configured?: string): string | undefined {
  if (configured?.trim()) return configured.trim();
  if (provider === "none") return undefined;
  return DEFAULT_MODELS[provider];
}

/**
 * Transcribe an audio file. Returns { ok: false } with error on failure;
 * never throws for API/network issues.
 */
export async function transcribeAudio(input: TranscribeInput): Promise<TranscribeResult> {
  if (input.provider === "none") {
    return { ok: false, error: "STT provider is none (download-only)" };
  }

  const apiKey = input.apiKey ?? resolveSttApiKey(input.provider);
  if (!apiKey) {
    return {
      ok: false,
      provider: input.provider,
      error:
        input.provider === "openai"
          ? "OPENAI_API_KEY not set"
          : "GROQ_API_KEY not set",
    };
  }

  const model = input.model || defaultSttModel(input.provider);
  if (!model) {
    return { ok: false, provider: input.provider, error: "No STT model configured" };
  }

  const url = input.provider === "openai" ? OPENAI_URL : GROQ_URL;
  const fileName =
    input.fileName ||
    basename(input.path) ||
    (input.mimeType?.includes("ogg") ? "voice.ogg" : "audio.mp3");

  try {
    const bytes = await readFile(input.path);
    const blob = new Blob([bytes], {
      type: input.mimeType || "application/octet-stream",
    });
    const form = new FormData();
    form.append("file", blob, fileName);
    form.append("model", model);
    form.append("response_format", "json");
    if (input.language?.trim()) {
      form.append("language", input.language.trim());
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body.error?.message) detail = body.error.message;
      } catch {
        try {
          detail = (await res.text()).slice(0, 300);
        } catch {
          /* ignore */
        }
      }
      return {
        ok: false,
        provider: input.provider,
        model,
        error: detail,
      };
    }

    const data = (await res.json()) as { text?: string };
    const text = (data.text ?? "").trim();
    if (!text) {
      return {
        ok: false,
        provider: input.provider,
        model,
        error: "Empty transcript",
      };
    }
    return { ok: true, text, provider: input.provider, model };
  } catch (err) {
    return {
      ok: false,
      provider: input.provider,
      model,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build agent-facing user text from caption + transcript. */
export function voiceMessageText(opts: {
  transcript?: string;
  caption?: string;
  kind: "voice" | "audio";
  durationSec?: number;
  sttError?: string;
  localPath?: string;
}): string {
  const dur =
    opts.durationSec != null && opts.durationSec > 0
      ? ` (${opts.durationSec}s)`
      : "";
  const caption = opts.caption?.trim();

  if (opts.transcript?.trim()) {
    const body = opts.transcript.trim();
    if (caption) {
      return `[${opts.kind} message${dur} transcribed]\nCaption: ${caption}\n\n${body}`;
    }
    return body;
  }

  // No transcript — still give the agent something usable
  const bits = [`[User sent a ${opts.kind} message${dur}`];
  if (opts.sttError) bits.push(`; transcription failed: ${opts.sttError}`);
  else bits.push("; no STT configured or transcription unavailable");
  if (opts.localPath) bits.push(`. Audio saved at ${opts.localPath}`);
  bits.push(". Respond based on any caption, or ask the user to type if you need the content.]");
  if (caption) {
    return `${bits.join("")}\n\nCaption: ${caption}`;
  }
  return bits.join("");
}
