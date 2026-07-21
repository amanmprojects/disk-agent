import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatFinalHtml, plainToTelegramHtml } from "../src/format/telegram.js";
import { joinAssistantTextParts } from "../src/agent/runtime.js";

describe("plainToTelegramHtml", () => {
  it("escapes raw HTML so the model cannot inject tags", () => {
    const out = plainToTelegramHtml("use bash & <tag>");
    assert.equal(out, "use bash &amp; &lt;tag&gt;");
  });

  it("converts bold, italic, and inline code", () => {
    const out = plainToTelegramHtml("**Done.** Use *now* with `bash`");
    assert.equal(out, "<b>Done.</b> Use <i>now</i> with <code>bash</code>");
  });

  it("converts fenced code blocks", () => {
    const out = plainToTelegramHtml("run:\n```\necho hi\n```");
    assert.equal(out, "run:\n<pre>echo hi</pre>");
  });

  it("converts fenced blocks with language tag", () => {
    const out = plainToTelegramHtml("```ts\nconst x = 1;\n```");
    assert.equal(out, '<pre><code class="language-ts">const x = 1;</code></pre>');
  });

  it("converts https links", () => {
    const out = plainToTelegramHtml("see [docs](https://example.com/a)");
    assert.equal(out, 'see <a href="https://example.com/a">docs</a>');
  });

  it("does not treat underscores as italic (snake_case paths)", () => {
    const out = plainToTelegramHtml("path: src/foo_bar.ts");
    assert.equal(out, "path: src/foo_bar.ts");
  });

  it("leaves bullet lists as plain text", () => {
    const out = plainToTelegramHtml("- one\n- two");
    assert.equal(out, "- one\n- two");
  });

  it("does not convert markdown inside code spans", () => {
    const out = plainToTelegramHtml("use `**not bold**` literally");
    assert.equal(out, "use <code>**not bold**</code> literally");
  });
});

describe("formatFinalHtml", () => {
  it("converts markdown and appends optional meta footer", () => {
    const out = formatFinalHtml("**Done.** Three tool calls:", {
      durationMs: 12,
      toolCalls: 3,
    });
    assert.equal(out, "<b>Done.</b> Three tool calls:\n\n<i>12ms · 3 tools</i>");
  });

  it("preserves plain prose and spaces around periods", () => {
    const out = formatFinalHtml("Sure — firing a few now.\n\nDone. Three tool calls:");
    assert.equal(out, "Sure — firing a few now.\n\nDone. Three tool calls:");
  });
});

describe("joinAssistantTextParts", () => {
  it("inserts paragraph break when gluing bare segments", () => {
    assert.equal(
      joinAssistantTextParts(["Sure — firing a few now.", "Done. Three tool calls:"]),
      "Sure — firing a few now.\n\nDone. Three tool calls:",
    );
  });

  it("does not double-space when boundary already has whitespace", () => {
    assert.equal(joinAssistantTextParts(["Hello ", "world"]), "Hello world");
    assert.equal(joinAssistantTextParts(["Hello\n\n", "world"]), "Hello\n\nworld");
  });
});
