import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { BrowserService } from "../browser/service.js";
import type { CronScheduler } from "../cron/scheduler.js";
import type { Logger } from "../logger.js";
import type { MemoryStore } from "../memory/store.js";
import { SessionRegistry, makeSessionKey } from "../session/manager.js";
import type { AgentRunResult, ChannelId, IncomingMessage, LiveProgressEvent } from "../types.js";
import { ALL_AGENT_TOOL_NAMES, createDiskTools } from "./tools.js";
import {
  bootstrapSupergrok,
  getSharedModelRuntime,
  piAgentDir,
  resolveModel,
  resolveSupergrokExtension,
} from "./pi.js";

export interface RuntimeDeps {
  cfg: AppConfig;
  log: Logger;
  memory: MemoryStore;
  cron: CronScheduler;
  browser: BrowserService;
  sessions: SessionRegistry;
}

interface ActiveSession {
  key: string;
  sessionId: string;
  session: AgentSession;
  unsub?: () => void;
}

/**
 * Wraps the Pi coding-agent SDK with OpenClaw/Hermes-style context assembly,
 * SuperGrok / xAI subscription support via pi-supergrok, and disk-agent tools.
 */
export class AgentRuntime {
  private deps: RuntimeDeps;
  private log: Logger;
  private cache = new Map<string, ActiveSession>();
  private agentDir: string;
  private ready: Promise<void>;

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
    this.log = deps.log.child("agent");
    // Share the real Pi agent dir so OAuth tokens from `pi /login` work.
    this.agentDir = piAgentDir();
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      const info = await bootstrapSupergrok(this.log);
      this.log.info("pi providers ready", {
        supergrok: info.loaded,
        extension: info.extensionPath,
        providers: info.providers,
      });
      await getSharedModelRuntime(this.log);
    } catch (err) {
      this.log.error("failed to bootstrap pi/supergrok", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  async run(
    message: IncomingMessage,
    opts?: {
      onPartial?: (text: string) => void | Promise<void>;
      /** Structured live progress (thought done, tool start/end) */
      onProgress?: (event: LiveProgressEvent) => void | Promise<void>;
      /** @deprecated use onProgress */
      onThought?: (text: string) => void | Promise<void>;
      /** @deprecated use onProgress */
      onStep?: (line: string) => void | Promise<void>;
      deliverHint?: { channel: ChannelId; peerId: string; chatId?: string };
      ephemeral?: boolean;
      /** Capture thinking blocks (and stream via onProgress when complete) */
      captureThoughts?: boolean;
      /** Capture tool start/end (and stream via onProgress immediately) */
      captureSteps?: boolean;
    },
  ): Promise<AgentRunResult> {
    await this.ensureReady();
    const started = Date.now();
    const key = makeSessionKey(message.channel, message.peerId);
    const rec = this.deps.sessions.getOrCreate(message.channel, message.peerId, message.senderName);

    let toolCalls = 0;
    let finalText = "";
    let error: string | undefined;
    const completedThoughts: string[] = [];
    const steps: string[] = [];
    const captureThoughts = opts?.captureThoughts ?? true;
    const captureSteps = opts?.captureSteps ?? true;

    // Serialize async callbacks so Telegram messages stay ordered
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (fn: () => void | Promise<void>) => {
      chain = chain
        .then(() => fn())
        .catch((err) => {
          this.log.debug("stream callback error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    };
    const emit = (ev: LiveProgressEvent) => {
      enqueue(async () => {
        if (opts?.onProgress) await opts.onProgress(ev);
        // back-compat shims
        if (ev.kind === "thought" && opts?.onThought) await opts.onThought(ev.text);
        if (ev.kind === "tool_start" && opts?.onStep) {
          await opts.onStep(`→ ${ev.name}${ev.args ? ` ${ev.args}` : ""}`);
        }
        if (ev.kind === "tool_end" && opts?.onStep) {
          await opts.onStep(
            `${ev.ok ? "✓" : "✗"} ${ev.name}${ev.detail ? ` — ${ev.detail}` : ""}`,
          );
        }
      });
    };

    // Track tool args by id so end events can include them
    const toolArgsById = new Map<string, string>();

    try {
      const active = await this.getOrCreateSession(key, rec.sessionId, message, opts);
      const partials: string[] = [];
      // Buffer thinking deltas until thinking_end (one message per thought block)
      const thinkingBuffers = new Map<number, string[]>();

      if (active.unsub) active.unsub();
      active.unsub = active.session.subscribe((event) => {
        if (event.type === "message_update") {
          const ev = event.assistantMessageEvent as {
            type?: string;
            delta?: string;
            content?: string;
            contentIndex?: number;
          };

          if (ev.type === "text_delta" && ev.delta) {
            partials.push(ev.delta);
            void opts?.onPartial?.(partials.join(""));
          }

          if (captureThoughts) {
            if (ev.type === "thinking_start") {
              thinkingBuffers.set(ev.contentIndex ?? 0, []);
            }
            if (
              (ev.type === "thinking_delta" || ev.type === "reasoning_delta") &&
              ev.delta
            ) {
              const idx = ev.contentIndex ?? 0;
              const buf = thinkingBuffers.get(idx) ?? [];
              buf.push(ev.delta);
              thinkingBuffers.set(idx, buf);
            }
            if (ev.type === "thinking_end" || ev.type === "reasoning_end") {
              const idx = ev.contentIndex ?? 0;
              const fromEnd = (ev.content ?? "").trim();
              const fromBuf = (thinkingBuffers.get(idx) ?? []).join("").trim();
              thinkingBuffers.delete(idx);
              const thought = fromEnd || fromBuf;
              if (thought) {
                completedThoughts.push(thought);
                emit({ kind: "thought", text: thought });
              }
            }
          }
        }

        if (captureSteps && event.type === "tool_execution_start") {
          toolCalls += 1;
          const e = event as {
            toolName?: string;
            toolCallId?: string;
            args?: unknown;
          };
          const name = e.toolName ?? "tool";
          const id = e.toolCallId || `tool_${toolCalls}_${name}`;
          const args = summarizeArgs(e.args);
          toolArgsById.set(id, args);
          const line = `→ ${name}${args ? ` ${args}` : ""}`;
          steps.push(line);
          this.log.debug(`tool start: ${name}`);
          emit({ kind: "tool_start", id, name, args });
        }

        if (captureSteps && event.type === "tool_execution_end") {
          const e = event as {
            toolName?: string;
            toolCallId?: string;
            isError?: boolean;
            error?: string;
            result?: unknown;
          };
          const name = e.toolName ?? "tool";
          const id = e.toolCallId || [...toolArgsById.keys()].pop() || `tool_end_${name}`;
          const args = toolArgsById.get(id) ?? "";
          toolArgsById.delete(id);
          const ok = !e.isError;
          const detail = e.isError
            ? truncate(String(e.error ?? "error"), 800)
            : truncate(summarizeResult(e.result), 800);
          const line = `${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`;
          steps.push(line);
          emit({ kind: "tool_end", id, name, args, ok, detail });
        }
      });

      const prompt = this.formatUserPrompt(message);
      await active.session.prompt(prompt);
      // Flush any pending thought/step deliveries before returning
      await chain;

      finalText = partials.join("").trim() || (await this.extractLastAssistantText(active.session));

      // Fallback: models that only attach thinking on the final message
      if (captureThoughts && !completedThoughts.length) {
        const fromMsg = await this.extractLastAssistantThinking(active.session);
        if (fromMsg) {
          completedThoughts.push(fromMsg);
          emit({ kind: "thought", text: fromMsg });
          await chain;
        }
      }

      // Flush leftover thinking buffers that never got thinking_end
      if (captureThoughts && thinkingBuffers.size) {
        for (const [, parts] of thinkingBuffers) {
          const t = parts.join("").trim();
          if (!t) continue;
          completedThoughts.push(t);
          emit({ kind: "thought", text: t });
        }
        thinkingBuffers.clear();
        await chain;
      }

      this.deps.sessions.touch(key, 1);

      if (message.channel !== "cron" || !message.text.includes("HEARTBEAT")) {
        try {
          this.deps.memory.appendDailyLog(
            `[${message.channel}:${message.peerId}] user: ${truncate(message.text, 200)}`,
          );
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.log.error("agent run failed", { key, error });
      finalText = `Sorry — I hit an error: ${error}`;
      await chain;
    }

    return {
      text: finalText,
      sessionKey: key,
      toolCalls,
      durationMs: Date.now() - started,
      error,
      thoughts: completedThoughts.join("\n\n").trim() || undefined,
      steps: steps.length ? steps : undefined,
    };
  }

  async resetSession(channel: ChannelId, peerId: string): Promise<string> {
    const key = makeSessionKey(channel, peerId);
    const prev = this.cache.get(key);
    if (prev?.unsub) prev.unsub();
    if (prev) {
      try {
        prev.session.dispose();
      } catch {
        /* ignore */
      }
      this.cache.delete(key);
    }
    const rec = this.deps.sessions.reset(key) ?? this.deps.sessions.getOrCreate(channel, peerId);
    return rec.sessionId;
  }

  async disposeAll(): Promise<void> {
    for (const [key, active] of this.cache) {
      if (active.unsub) active.unsub();
      try {
        active.session.dispose();
      } catch {
        /* ignore */
      }
      this.cache.delete(key);
    }
  }

  /** List models useful for status / CLI. */
  async listModels(): Promise<Array<{ provider: string; id: string; auth: boolean }>> {
    await this.ensureReady();
    const rt = await getSharedModelRuntime(this.log);
    const out: Array<{ provider: string; id: string; auth: boolean }> = [];
    for (const m of rt.getModels()) {
      if (m.provider === "supergrok" || m.provider === "xai" || rt.hasConfiguredAuth(m.provider)) {
        out.push({
          provider: m.provider,
          id: m.id,
          auth: rt.hasConfiguredAuth(m.provider),
        });
      }
    }
    return out.sort((a, b) => {
      if (a.provider === "supergrok" && b.provider !== "supergrok") return -1;
      if (b.provider === "supergrok" && a.provider !== "supergrok") return 1;
      return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
    });
  }

  private async getOrCreateSession(
    key: string,
    sessionId: string,
    message: IncomingMessage,
    opts?: {
      deliverHint?: { channel: ChannelId; peerId: string; chatId?: string };
      ephemeral?: boolean;
    },
  ): Promise<ActiveSession> {
    const cached = this.cache.get(key);
    if (cached && cached.sessionId === sessionId && !opts?.ephemeral) {
      return cached;
    }
    if (cached?.unsub) cached.unsub();
    if (cached) {
      try {
        cached.session.dispose();
      } catch {
        /* ignore */
      }
      this.cache.delete(key);
    }

    const { cfg, memory, cron, browser, sessions } = this.deps;
    const cwd = cfg.cwd;
    const modelRuntime = await getSharedModelRuntime(this.log);

    const deliver =
      opts?.deliverHint ??
      (message.channel === "telegram"
        ? {
            channel: "telegram" as const,
            peerId: message.peerId,
            chatId: message.chatId,
          }
        : message.metadata && typeof message.metadata === "object" && "deliver" in message.metadata
          ? (message.metadata.deliver as { channel: ChannelId; peerId: string; chatId?: string })
          : {
              channel: message.channel,
              peerId: message.peerId,
              chatId: message.chatId,
            });

    const customTools = createDiskTools({
      memory,
      cron,
      browser,
      sessions,
      defaultDeliver: deliver,
      workspaceDir: cfg.workspaceDir,
    });

    const bootstrap = memory.buildBootstrapContext(cfg);
    const systemPrompt = buildSystemPrompt({
      agentName: cfg.agentName,
      workspaceDir: cfg.workspaceDir,
      cwd,
      channel: message.channel,
      bootstrap,
      modelLabel: `${cfg.model.provider}/${cfg.model.id}`,
    });

    const ext = resolveSupergrokExtension();
    const settingsManager = SettingsManager.create(cwd, this.agentDir);

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager,
      additionalSkillPaths: [join(cfg.workspaceDir, "skills")],
      additionalExtensionPaths: ext ? [ext] : [],
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
      agentsFilesOverride: (current) => ({
        agentsFiles: [
          ...current.agentsFiles,
          {
            path: join(cfg.workspaceDir, "AGENTS.md"),
            content: memory.readAgents() || "# AGENTS.md\n",
          },
          {
            path: join(cfg.workspaceDir, "IDENTITY.md"),
            content: memory.readIdentity() || `# ${cfg.agentName}\n`,
          },
        ],
      }),
    });
    await loader.reload();

    const resolved = await resolveModel(
      { provider: cfg.model.provider, id: cfg.model.id },
      this.log,
    );

    const rec = sessions.get(key);
    const peerDir = sessions.peerDir(key, sessionId);
    if (!existsSync(peerDir)) mkdirSync(peerDir, { recursive: true });

    let sessionManager: SessionManager;
    if (opts?.ephemeral) {
      sessionManager = SessionManager.inMemory(cwd);
    } else if (rec?.sessionFile && existsSync(rec.sessionFile)) {
      sessionManager = SessionManager.open(rec.sessionFile, peerDir, cwd);
    } else {
      sessionManager = SessionManager.continueRecent(cwd, peerDir);
    }

    // IMPORTANT: options.tools is an allowlist. Custom tools are dropped unless
    // their names are included here (Pi filters customTools through the same set).
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.agentDir,
      modelRuntime,
      model: resolved.model,
      thinkingLevel: mapThinking(cfg.model.thinking),
      tools: ALL_AGENT_TOOL_NAMES,
      customTools,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    });

    // Ensure custom tools stay active even if session restore had a narrower set.
    try {
      const active = typeof session.getActiveToolNames === "function" ? session.getActiveToolNames() : [];
      const missing = ALL_AGENT_TOOL_NAMES.filter((n) => !active.includes(n));
      if (missing.length && typeof session.setActiveToolsByName === "function") {
        session.setActiveToolsByName(ALL_AGENT_TOOL_NAMES);
        this.log.info("activated tools", {
          count: ALL_AGENT_TOOL_NAMES.length,
          browser: ALL_AGENT_TOOL_NAMES.filter((n) => n.startsWith("browser_")),
        });
      } else {
        this.log.debug("active tools", { active });
      }
    } catch (err) {
      this.log.warn("could not verify active tools", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!opts?.ephemeral) {
      const file = session.sessionFile;
      const sid = session.sessionId || sessionId;
      if (file) sessions.setSessionFile(key, file, sid);
    }

    const active: ActiveSession = { key, sessionId, session };
    if (!opts?.ephemeral) this.cache.set(key, active);
    this.log.debug(`session ready`, {
      key,
      sessionId,
      model: `${resolved.provider}/${resolved.id}`,
    });
    return active;
  }

  private formatUserPrompt(message: IncomingMessage): string {
    const bits = [
      `[channel=${message.channel} peer=${message.peerId}` +
        (message.senderName ? ` sender=${message.senderName}` : "") +
        (message.userId ? ` userId=${message.userId}` : "") +
        ` time=${message.timestamp}]`,
      "",
      message.text,
    ];
    if (message.attachments?.length) {
      bits.push("", "Attachments:");
      for (const a of message.attachments) {
        bits.push(
          `- ${a.type}${a.fileName ? ` ${a.fileName}` : ""}${a.localPath ? ` path=${a.localPath}` : ""}${a.caption ? ` caption=${a.caption}` : ""}`,
        );
      }
    }
    return bits.join("\n");
  }

  private async extractLastAssistantText(session: AgentSession): Promise<string> {
    try {
      const messages = (session as unknown as { messages?: unknown[] }).messages;
      if (!Array.isArray(messages)) return "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as { role?: string; content?: unknown; text?: string };
        if (m?.role === "assistant") {
          if (typeof m.content === "string") return m.content;
          if (typeof m.text === "string") return m.text;
          if (Array.isArray(m.content)) {
            return m.content
              .filter((c): c is { type: string; text?: string } => !!c && typeof c === "object")
              .filter((c) => c.type === "text" && c.text)
              .map((c) => c.text!)
              .join("");
          }
        }
      }
    } catch {
      /* ignore */
    }
    return "";
  }

  private async extractLastAssistantThinking(session: AgentSession): Promise<string> {
    try {
      const messages = (session as unknown as { messages?: unknown[] }).messages;
      if (!Array.isArray(messages)) return "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as {
          role?: string;
          content?: unknown;
          thinking?: string;
          reasoning?: string;
        };
        if (m?.role !== "assistant") continue;
        if (typeof m.thinking === "string" && m.thinking.trim()) return m.thinking.trim();
        if (typeof m.reasoning === "string" && m.reasoning.trim()) return m.reasoning.trim();
        if (Array.isArray(m.content)) {
          const parts = m.content
            .filter(
              (c): c is { type: string; thinking?: string; text?: string } =>
                !!c && typeof c === "object",
            )
            .filter((c) => c.type === "thinking" || c.type === "reasoning")
            .map((c) => c.thinking || c.text || "")
            .filter(Boolean);
          if (parts.length) return parts.join("\n").trim();
        }
      }
    } catch {
      /* ignore */
    }
    return "";
  }
}

function summarizeArgs(args: unknown): string {
  if (args == null) return "";
  try {
    if (typeof args === "string") return truncate(args, 120);
    if (typeof args === "object") {
      const o = args as Record<string, unknown>;
      // Prefer common short fields
      for (const k of ["command", "path", "url", "query", "target", "name", "id", "note", "content"]) {
        if (typeof o[k] === "string" && o[k]) {
          return `${k}=${truncate(String(o[k]), 80)}`;
        }
      }
      return truncate(JSON.stringify(args), 120);
    }
    return truncate(String(args), 120);
  } catch {
    return "";
  }
}

function summarizeResult(result: unknown): string {
  if (result == null) return "";
  try {
    if (typeof result === "string") return result;
    if (typeof result === "object" && result && "content" in (result as object)) {
      const content = (result as { content?: unknown }).content;
      if (Array.isArray(content)) {
        return content
          .map((c) =>
            c && typeof c === "object" && "text" in c
              ? String((c as { text?: string }).text ?? "")
              : "",
          )
          .filter(Boolean)
          .join(" ");
      }
    }
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

function buildSystemPrompt(opts: {
  agentName: string;
  workspaceDir: string;
  cwd: string;
  channel: ChannelId;
  bootstrap: string;
  modelLabel: string;
}): string {
  return `You are ${opts.agentName}, a self-hosted personal AI agent (OpenClaw/Hermes-style) running via the Pi coding-agent runtime.

## Environment
- Workspace (identity & memory files): ${opts.workspaceDir}
- Working directory (coding tools cwd): ${opts.cwd}
- Current channel: ${opts.channel}
- Preferred model config: ${opts.modelLabel}

## Capabilities
You have coding tools (read, bash, edit, write, grep, find, ls) plus:
- memory_save / memory_search / memory_log / memory_delete — persistent memory
- cron_list / cron_add / cron_remove / cron_run — scheduled automations
- web_get — plain HTTP fetch + HTML→text (no JS). Good for static pages.
- browser_open / browser_snapshot / browser_click / browser_fill / browser_screenshot / browser_eval / browser_close — **real browser automation** via agent-browser
- session_list / session_reset — conversation session management

## Browser usage (important)
When the user asks to "use the browser", interact with a site, click, fill forms, log in, or handle JS-rendered pages:
1. Call browser_open(url)
2. Call browser_snapshot to get interactive refs (@e1, @e2, …)
3. browser_click / browser_fill using those refs
4. browser_screenshot if visual confirmation helps
5. browser_close when done
Do **not** claim browser tools are unavailable — they are registered in this runtime.
Prefer browser_* over web_get for interactive tasks. Use web_get only for quick static fetches.

## Operating principles
1. Be useful and autonomous. Prefer taking action with tools over asking endless questions.
2. Persist durable facts with memory_save. Append run notes with memory_log.
3. For recurring work, create cron jobs in plain language schedules.
4. Keep Telegram replies concise and scannable on a phone.
5. Never exfiltrate secrets. Ask before destructive operations.
6. On HEARTBEAT turns: if nothing needs attention, reply exactly HEARTBEAT_OK.
7. Read workspace files (SOUL.md, USER.md, MEMORY.md) when you need deeper context; they are also partially injected below.

${opts.bootstrap}
`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function mapThinking(
  level: string,
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  const allowed = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
  if (allowed.has(level)) return level as "off";
  return "medium";
}
