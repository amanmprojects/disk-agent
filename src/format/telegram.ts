import { escapeHtml } from "../utils.js";

/**
 * Light Markdown → Telegram HTML.
 * Intentionally conservative so broken MD never breaks delivery.
 */
export function markdownToTelegramHtml(input: string): string {
  let s = input.replace(/\r\n/g, "\n");

  // Extract fenced code blocks first
  const fences: string[] = [];
  s = s.replace(/```(?:[\w+-]*)\n?([\s\S]*?)```/g, (_m, code: string) => {
    const i = fences.length;
    fences.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000FENCE${i}\u0000`;
  });

  // Inline code
  const inlines: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const i = inlines.length;
    inlines.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000INLINE${i}\u0000`;
  });

  // Escape remaining text, then re-apply simple markers on plain text segments
  // Split on placeholders so we don't double-escape them
  const parts = s.split(/(\u0000(?:FENCE|INLINE)\d+\u0000)/);
  const out = parts
    .map((part) => {
      if (part.startsWith("\u0000FENCE") || part.startsWith("\u0000INLINE")) return part;
      return formatPlainMarkdown(escapeHtml(part));
    })
    .join("");

  return out
    .replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)] ?? "")
    .replace(/\u0000INLINE(\d+)\u0000/g, (_m, i) => inlines[Number(i)] ?? "");
}

function formatPlainMarkdown(escaped: string): string {
  let s = escaped;
  // Headings → bold line
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  // Bold **x** or __x__
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__(.+?)__/g, "<b>$1</b>");
  // Italic *x* or _x_ (avoid matching inside words for _)
  s = s.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "<i>$1</i>");
  s = s.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "<i>$1</i>");
  // Strikethrough ~~x~~
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  // Blockquotes
  s = s.replace(/^(?:&gt;|>)\s?(.+)$/gm, "<blockquote>$1</blockquote>");
  // Collapse adjacent blockquotes into one where possible
  s = s.replace(/<\/blockquote>\n<blockquote>/g, "\n");
  return s;
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
  let html = markdownToTelegramHtml(answer.trim() || "(no response)");
  if (meta && (meta.durationMs != null || meta.toolCalls)) {
    const bits: string[] = [];
    if (meta.durationMs != null) bits.push(`${meta.durationMs}ms`);
    if (meta.toolCalls) bits.push(`${meta.toolCalls} tools`);
    html += `\n\n<i>${escapeHtml(bits.join(" · "))}</i>`;
  }
  return html;
}

export function formatCronHtml(name: string, body: string): string {
  return `<b>⏰ ${escapeHtml(name)}</b>\n\n${markdownToTelegramHtml(body)}`;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
