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
import type { AgentRunResult, ChannelId, IncomingMessage } from "../types.js";
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
      deliverHint?: { channel: ChannelId; peerId: string; chatId?: string };
      ephemeral?: boolean;
    },
  ): Promise<AgentRunResult> {
    await this.ensureReady();
    const started = Date.now();
    const key = makeSessionKey(message.channel, message.peerId);
    const rec = this.deps.sessions.getOrCreate(message.channel, message.peerId, message.senderName);

    let toolCalls = 0;
    let finalText = "";
    let error: string | undefined;

    try {
      const active = await this.getOrCreateSession(key, rec.sessionId, message, opts);
      const partials: string[] = [];

      if (active.unsub) active.unsub();
      active.unsub = active.session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          const delta = event.assistantMessageEvent.delta;
          partials.push(delta);
          void opts?.onPartial?.(partials.join(""));
        }
        if (event.type === "tool_execution_start") {
          toolCalls += 1;
          this.log.debug(`tool start: ${(event as { toolName?: string }).toolName ?? "?"}`);
        }
      });

      const prompt = this.formatUserPrompt(message);
      await active.session.prompt(prompt);

      finalText = partials.join("").trim() || (await this.extractLastAssistantText(active.session));
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
    }

    return {
      text: finalText,
      sessionKey: key,
      toolCalls,
      durationMs: Date.now() - started,
      error,
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
        const m = messages[i] as { role?: string; content?: unknown };
        if (m?.role === "assistant") {
          if (typeof m.content === "string") return m.content;
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
