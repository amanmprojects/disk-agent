import { escapeHtml } from "../utils.js";

/**
 * Telegram delivery helpers.
 *
 * Agent/user text is HTML-escaped only (no Markdown conversion). Telegram HTML
 * is used solely for *our* chrome: tool lines, thoughts, meta footers.
 */

/** Escape agent/command text for Telegram HTML parse mode — preserve content as-is. */
export function plainToTelegramHtml(input: string): string {
  return escapeHtml(input.replace(/\r\n/g, "\n"));
}

/** Grey-ish thought bubble via blockquote (Telegram renders these muted). */
export function formatThoughtHtml(thought: string): string {
  const body = escapeHtml(thought.trim()).slice(0, 3500);
  // Expandable blockquote on clients that support it
  return `<blockquote expandable>${body}</blockquote>`;
}

/** Minimal thoughts mode — indicator while reasoning tokens stream. */
export function formatThinkingIndicatorHtml(): string {
  return "<i>Thinking…</i>";
}

function meaningfulArgs(args: string): string {
  const a = args.trim();
  if (!a || a === "{}" || a === "null" || a === "undefined") return "";
  return a;
}

/** Tool name only (minimal steps / verbose minimal). */
export function formatToolNameHtml(name: string): string {
  return `<b>⚙ ${escapeHtml(name)}</b>`;
}

/** Tool call with optional args — used by full steps mode. */
export function formatToolCallHtml(name: string, args: string): string {
  const title = formatToolNameHtml(name);
  const a = meaningfulArgs(args);
  const argLine = a ? `\n<code>${escapeHtml(clip(a, 500))}</code>` : "";
  return `${title}${argLine}`;
}

export function formatToolRunningHtml(name: string, args: string): string {
  return `${formatToolCallHtml(name, args)}\n<i>running…</i>`;
}

export function formatToolDoneHtml(
  name: string,
  args: string,
  ok: boolean,
  detail: string,
): string {
  const icon = ok ? "✓" : "✗";
  const status = ok ? "ok" : "error";
  const title = `<b>⚙ ${escapeHtml(name)}</b>  <i>${icon} ${status}</i>`;
  const a = meaningfulArgs(args);
  const argLine = a ? `\n<code>${escapeHtml(clip(a, 300))}</code>` : "";
  const result = detail.trim()
    ? `\n<blockquote expandable>${escapeHtml(clip(detail.trim(), 2500))}</blockquote>`
    : "";
  return `${title}${argLine}${result}`;
}

export function formatFinalHtml(
  answer: string,
  meta?: { durationMs?: number; toolCalls?: number },
): string {
  let html = plainToTelegramHtml(answer.trim() || "(no response)");
  if (meta && (meta.durationMs != null || meta.toolCalls)) {
    const bits: string[] = [];
    if (meta.durationMs != null) bits.push(`${meta.durationMs}ms`);
    if (meta.toolCalls) bits.push(`${meta.toolCalls} tools`);
    html += `\n\n<i>${escapeHtml(bits.join(" · "))}</i>`;
  }
  return html;
}

export function formatCronHtml(name: string, body: string): string {
  return `<b>⏰ ${escapeHtml(name)}</b>\n\n${plainToTelegramHtml(body)}`;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
