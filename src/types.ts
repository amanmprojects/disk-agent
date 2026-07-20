/** Shared types for the Disk Agent gateway. */

export type ChannelId = "telegram" | "cli" | "cron" | "system";

export interface IncomingMessage {
  id: string;
  channel: ChannelId;
  /** Stable peer key used for session routing, e.g. telegram:12345 */
  peerId: string;
  /** Human-readable sender label */
  senderName?: string;
  /** Telegram numeric user id (when channel=telegram) */
  userId?: string;
  chatId?: string;
  text: string;
  /** ISO timestamp */
  timestamp: string;
  /** Optional media / attachments metadata */
  attachments?: MessageAttachment[];
  /** True when this is a slash command handled outside the agent loop */
  isCommand?: boolean;
  metadata?: Record<string, unknown>;
}

export interface MessageAttachment {
  type: "photo" | "document" | "voice" | "audio" | "video" | "other";
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  localPath?: string;
  caption?: string;
}

export interface OutgoingMessage {
  channel: ChannelId;
  peerId: string;
  chatId?: string;
  text: string;
  parseMode?: "Markdown" | "HTML" | "MarkdownV2";
  replyToMessageId?: string;
  silent?: boolean;
  /** When true, suppress delivery (e.g. HEARTBEAT_OK) */
  suppress?: boolean;
}

export interface SessionKey {
  channel: ChannelId;
  peerId: string;
}

export interface SessionRecord {
  key: string;
  channel: ChannelId;
  peerId: string;
  sessionId: string;
  /** Absolute path to Pi session .jsonl when known */
  sessionFile?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  metadata?: Record<string, unknown>;
}

export type CronSchedule =
  | { kind: "cron"; expr: string; timezone?: string }
  | { kind: "every"; everyMs: number }
  | { kind: "at"; at: string };

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  /** Natural language / freeform prompt delivered to the agent */
  prompt: string;
  /** Where to deliver the result */
  deliver: {
    channel: ChannelId;
    peerId: string;
    chatId?: string;
  };
  /** Optional model override */
  model?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  runCount: number;
}

export interface MemoryEntry {
  id: string;
  kind: "fact" | "preference" | "project" | "note";
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  source?: string;
}

export interface PairingRequest {
  code: string;
  userId: string;
  username?: string;
  firstName?: string;
  createdAt: string;
  expiresAt: string;
}

export interface AgentRunResult {
  text: string;
  sessionKey: string;
  toolCalls: number;
  durationMs: number;
  error?: string;
}

export interface BrowserActionResult {
  ok: boolean;
  message: string;
  screenshotPath?: string;
  url?: string;
  title?: string;
  data?: unknown;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
