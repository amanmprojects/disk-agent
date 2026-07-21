import { escapeHtml } from "../utils.js";

/**
 * Telegram delivery helpers.
 *
 * Final agent text uses a small markdown subset converted to Telegram HTML
 * (`parse_mode: HTML`). Chrome we own (tools, thoughts, meta) is written as
 * HTML tags directly and never goes through the markdown converter.
 */

/**
 * Convert agent/command text to Telegram HTML.
 *
 * Supported markdown subset (everything else is escaped as plain text):
 * - **bold**
 * - *italic* (single asterisks; not underscore — avoids snake_case paths)
 * - `inline code`
 * - ``` fenced code blocks ```
 * - [label](https://…) links
 *
 * Bullets (`- item`) and newlines pass through as plain text (Telegram shows them fine).
 */
export function plainToTelegramHtml(input: string): string {
  const text = input.replace(/\r\n/g, "\n");
  const fences: string[] = [];
  const codes: string[] = [];

  // 1. Extract fenced code blocks first
  let s = text.replace(/```(?:([a-zA-Z0-9_+-]+)\r?\n)?([\s\S]*?)```/g, (_m, lang: string | undefined, code: string) => {
    const i = fences.length;
    // Drop one leading newline (common after ```) and one trailing newline before ```
    const body = escapeHtml(code.replace(/^\n/, "").replace(/\n$/, ""));
    if (lang) {
      fences.push(`<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>`);
    } else {
      fences.push(`<pre>${body}</pre>`);
    }
    return `\u0000F${i}\u0000`;
  });

  // 2. Extract inline code
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const i = codes.length;
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000C${i}\u0000`;
  });

  // 3. Escape the rest (raw HTML from the model cannot inject tags)
  s = escapeHtml(s);

  // 4. Links — label is already escaped; only allow http(s) hrefs
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => {
    return `<a href="${escapeHtml(url)}">${label}</a>`;
  });

  // 5. Bold **…** then italic *…* (order matters)
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");

  // 6. Restore protected segments
  s = s.replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? "");
  s = s.replace(/\u0000F(\d+)\u0000/g, (_m, i: string) => fences[Number(i)] ?? "");

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
