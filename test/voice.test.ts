import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSttModel,
  resolveSttProvider,
  voiceMessageText,
} from "../src/voice/transcribe.js";

describe("resolveSttProvider", () => {
  it("honors explicit provider", () => {
    assert.equal(resolveSttProvider("none"), "none");
    assert.equal(resolveSttProvider("openai"), "openai");
    assert.equal(resolveSttProvider("groq"), "groq");
  });

  it("auto picks from env keys", () => {
    const prevOpen = process.env.OPENAI_API_KEY;
    const prevGroq = process.env.GROQ_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      delete process.env.GROQ_API_KEY;
      assert.equal(resolveSttProvider("auto"), "none");

      process.env.GROQ_API_KEY = "gsk_test";
      assert.equal(resolveSttProvider("auto"), "groq");

      process.env.OPENAI_API_KEY = "sk_test";
      assert.equal(resolveSttProvider("auto"), "openai");
    } finally {
      if (prevOpen === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpen;
      if (prevGroq === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = prevGroq;
    }
  });
});

describe("defaultSttModel", () => {
  it("uses configured override", () => {
    assert.equal(defaultSttModel("openai", "whisper-1"), "whisper-1");
    assert.equal(defaultSttModel("groq", "whisper-large-v3"), "whisper-large-v3");
  });

  it("defaults per provider", () => {
    assert.equal(defaultSttModel("openai"), "whisper-1");
    assert.equal(defaultSttModel("groq"), "whisper-large-v3-turbo");
    assert.equal(defaultSttModel("none"), undefined);
  });
});

describe("voiceMessageText", () => {
  it("returns bare transcript when present", () => {
    assert.equal(
      voiceMessageText({ kind: "voice", transcript: "Buy milk tomorrow" }),
      "Buy milk tomorrow",
    );
  });

  it("includes caption with transcript", () => {
    const text = voiceMessageText({
      kind: "voice",
      transcript: "Hello world",
      caption: "note for later",
      durationSec: 3,
    });
    assert.match(text, /voice message \(3s\) transcribed/);
    assert.match(text, /Caption: note for later/);
    assert.match(text, /Hello world/);
  });

  it("explains STT failure without transcript", () => {
    const text = voiceMessageText({
      kind: "audio",
      sttError: "OPENAI_API_KEY not set",
      localPath: "/tmp/a.ogg",
      durationSec: 12,
    });
    assert.match(text, /audio message \(12s\)/);
    assert.match(text, /OPENAI_API_KEY not set/);
    assert.match(text, /\/tmp\/a\.ogg/);
  });
});
