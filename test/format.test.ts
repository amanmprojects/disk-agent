import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatFinalHtml, plainToTelegramHtml } from "../src/format/telegram.js";
import { joinAssistantTextParts } from "../src/agent/runtime.js";

describe("plainToTelegramHtml", () => {
  it("escapes HTML but does not convert markdown", () => {
    const inText = "Sure — firing a few now.\n\n**Done.** Use `bash` & <tag>";
    const out = plainToTelegramHtml(inText);
    assert.equal(
      out,
      "Sure — firing a few now.\n\n**Done.** Use `bash` &amp; &lt;tag&gt;",
    );
    // bold markers left as literal characters, not stripped/eaten
    assert.match(out, /\*\*Done\.\*\*/);
  });
});

describe("formatFinalHtml", () => {
  it("does not rewrite markdown or eat spaces around periods", () => {
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
    assert.equal(
      joinAssistantTextParts(["Hello ", "world"]),
      "Hello world",
    );
    assert.equal(
      joinAssistantTextParts(["Hello\n\n", "world"]),
      "Hello\n\nworld",
    );
  });
});
