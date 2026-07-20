import type { AppConfig } from "./config.js";
import { saveConfig } from "./config.js";
import { AgentRuntime } from "./agent/runtime.js";
import { BrowserService } from "./browser/service.js";
import { TelegramChannel } from "./channels/telegram.js";
import { CronScheduler, cronJobToIncoming, describeSchedule } from "./cron/scheduler.js";
import { Logger, defaultLogPath } from "./logger.js";
import { MemoryStore } from "./memory/store.js";
import { SessionRegistry } from "./session/manager.js";
import type { CronJob, IncomingMessage, OutgoingMessage } from "./types.js";
import { KeyedQueue } from "./utils.js";
import { makeSessionKey } from "./session/manager.js";
import { helpText } from "./channels/commands.js";
import { ALL_AGENT_TOOL_NAMES } from "./agent/tools.js";

/**
 * Gateway control plane — OpenClaw-style single process that owns:
 * channels, session routing, agent runtime, cron, memory, browser.
 */
export class Gateway {
  readonly cfg: AppConfig;
  readonly log: Logger;
  readonly memory: MemoryStore;
  readonly sessions: SessionRegistry;
  readonly cron: CronScheduler;
  readonly browser: BrowserService;
  readonly telegram: TelegramChannel;
  readonly agent: AgentRuntime;
  private queue = new KeyedQueue();
  private started = false;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.log = new Logger({ level: cfg.logging.level, filePath: defaultLogPath(cfg.dataDir) });
    this.memory = new MemoryStore(cfg);
    this.sessions = new SessionRegistry(cfg);
    this.cron = new CronScheduler(cfg, this.log);
    this.browser = new BrowserService(cfg, this.log);
    this.telegram = new TelegramChannel(cfg, this.log);
    this.agent = new AgentRuntime({
      cfg,
      log: this.log,
      memory: this.memory,
      cron: this.cron,
      browser: this.browser,
      sessions: this.sessions,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.log.info(`starting ${this.cfg.agentName} gateway`, {
      workspace: this.cfg.workspaceDir,
      cwd: this.cfg.cwd,
    });

    // Wire cron runner
    this.cron.setRunner((job) => this.runCronJob(job));
    this.cron.start();

    // Wire telegram
    this.telegram.onMessage(async (msg) => {
      await this.handleIncoming(msg);
    });
    await this.telegram.start();

    this.log.info("gateway online");
  }

  async stop(): Promise<void> {
    this.log.info("stopping gateway");
    this.cron.stop();
    await this.telegram.stop();
    await this.agent.disposeAll();
    this.started = false;
  }

  /** Public entry for CLI chat / tests */
  async handleIncoming(msg: IncomingMessage): Promise<string> {
    const key = makeSessionKey(msg.channel, msg.peerId);
    return this.queue.run(key, async () => {
      // Built-in slash commands (fast path)
      if (msg.text.startsWith("/")) {
        const handled = await this.handleCommand(msg);
        if (handled !== null) {
          await this.deliver({
            channel: msg.channel,
            peerId: msg.peerId,
            chatId: msg.chatId,
            text: handled,
          });
          return handled;
        }
      }

      if (msg.channel === "telegram" && msg.chatId) {
        void this.telegram.typing(msg.chatId);
      }

      const result = await this.agent.run(msg, {
        deliverHint:
          msg.channel === "telegram"
            ? { channel: "telegram", peerId: msg.peerId, chatId: msg.chatId }
            : undefined,
        onPartial: undefined,
      });

      const text = result.text?.trim() || "(no response)";

      // Suppress heartbeat OK
      const suppress = text === "HEARTBEAT_OK" || text.startsWith("HEARTBEAT_OK\n");

      await this.deliver({
        channel: msg.channel,
        peerId: msg.peerId,
        chatId: msg.chatId,
        text,
        suppress,
      });

      return suppress ? "" : text;
    });
  }

  async runCronJob(job: CronJob): Promise<void> {
    const incoming = cronJobToIncoming(job);
    // Use deliver target as the conversation peer for context isolation per job
    const result = await this.agent.run(incoming, {
      ephemeral: job.id === "heartbeat",
      deliverHint: job.deliver,
    });

    const text = result.text?.trim() || "";
    if (!text || text === "HEARTBEAT_OK" || text.startsWith("HEARTBEAT_OK")) {
      this.log.debug(`cron ${job.name}: suppressed empty/heartbeat`);
      return;
    }

    await this.deliver({
      channel: job.deliver.channel,
      peerId: job.deliver.peerId,
      chatId: job.deliver.chatId,
      text: `⏰ *${job.name}*\n\n${text}`,
      parseMode: "Markdown",
    });
  }

  private async deliver(out: OutgoingMessage): Promise<void> {
    if (out.suppress || !out.text) return;
    if (out.channel === "telegram") {
      await this.telegram.send(out);
      return;
    }
    if (out.channel === "cli") {
      console.log(out.text);
      return;
    }
    // system/cron without telegram — log only
    this.log.info(`[deliver:${out.channel}] ${out.text.slice(0, 200)}`);
  }

  private async handleCommand(msg: IncomingMessage): Promise<string | null> {
    // strip @BotName suffix Telegram adds in groups: /help@DiskAgentBot
    const raw = msg.text.slice(1).trim();
    const [cmdToken, ...rest] = raw.split(/\s+/);
    const cmd = (cmdToken ?? "").split("@")[0]?.toLowerCase() ?? "";
    const arg = rest.join(" ").trim();

    switch (cmd) {
      case "help":
      case "start":
        return helpText(this.cfg.agentName);

      case "new": {
        const id = await this.agent.resetSession(msg.channel, msg.peerId);
        return `New session started (${id}).`;
      }

      case "status": {
        const sessions = this.sessions.list().length;
        const jobs = this.cron.list().length;
        const facts = this.memory.listFacts().length;
        let browser = "unknown";
        try {
          browser = (await this.browser.isAvailable()) ? "agent-browser ready" : "fetch-only";
        } catch {
          browser = "error";
        }
        return [
          `${this.cfg.agentName} status`,
          `workspace: ${this.cfg.workspaceDir}`,
          `cwd: ${this.cfg.cwd}`,
          `model: ${this.cfg.model.provider}/${this.cfg.model.id}`,
          `sessions: ${sessions}`,
          `cron jobs: ${jobs}`,
          `memory facts: ${facts}`,
          `browser: ${browser}`,
          `telegram: ${this.telegram.isEnabled() ? "enabled" : "disabled"}`,
          `tools: ${ALL_AGENT_TOOL_NAMES.length}`,
        ].join("\n");
      }

      case "model": {
        if (!arg) {
          return `Current model: ${this.cfg.model.provider}/${this.cfg.model.id}\nUsage: /model supergrok/grok-4.5\nOr: /models`;
        }
        if (arg.includes("/")) {
          const [provider, ...idParts] = arg.split("/");
          this.cfg.model.provider = provider!;
          this.cfg.model.id = idParts.join("/");
        } else {
          this.cfg.model.id = arg;
        }
        saveConfig(this.cfg);
        // Drop cached sessions so next turn picks new model
        await this.agent.disposeAll();
        return `Model set to ${this.cfg.model.provider}/${this.cfg.model.id} (saved). Send a new message.`;
      }

      case "models": {
        try {
          await this.agent.ensureReady();
          const models = await this.agent.listModels();
          const lines = models.slice(0, 40).map((m) => `${m.auth ? "✓" : "·"} ${m.provider}/${m.id}`);
          return [
            `Available models (${models.length}):`,
            ...lines,
            ``,
            `Current: ${this.cfg.model.provider}/${this.cfg.model.id}`,
            `Set: /model provider/id`,
          ].join("\n");
        } catch (err) {
          return `Could not list models: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case "remember": {
        if (!arg) return "Usage: /remember <fact>";
        const entry = this.memory.saveFact({ content: arg, kind: "fact", source: msg.channel });
        return `Saved (${entry.id}): ${entry.content}`;
      }

      case "memory": {
        if (!arg || arg === "list") {
          const facts = this.memory.listFacts().slice(0, 20);
          if (!facts.length) return "No memories yet. Use /remember <fact>";
          return facts.map((f) => `• [${f.kind}] ${f.content}`).join("\n");
        }
        if (arg.startsWith("search ") || arg.startsWith("find ")) {
          const q = arg.replace(/^(search|find)\s+/i, "");
          const hits = this.memory.search(q, 10);
          if (!hits.length) return `No matches for “${q}”.`;
          return hits.map((h) => `• ${h.content}`).join("\n");
        }
        // bare query = search
        const hits = this.memory.search(arg, 10);
        if (!hits.length) return `No matches for “${arg}”.`;
        return hits.map((h) => `• ${h.content}`).join("\n");
      }

      case "cron": {
        const jobs = this.cron.list();
        if (!jobs.length) {
          return "No cron jobs.\nAsk me in chat: “every day at 9am, send me a brief”.";
        }
        return jobs
          .map(
            (j) =>
              `• ${j.name} (${j.id}) ${j.enabled ? "ON" : "OFF"} — ${describeSchedule(j.schedule)}`,
          )
          .join("\n");
      }

      case "browser": {
        const avail = await this.browser.isAvailable();
        if (!arg) {
          return [
            `Browser: ${avail ? "agent-browser available" : "CLI missing — web_get fetch only"}`,
            `Tools: browser_open, browser_snapshot, browser_click, browser_fill, browser_screenshot, browser_eval, browser_close, web_get`,
            ``,
            `Usage: /browser https://example.com`,
            `Or just chat: “use the browser and open …”`,
          ].join("\n");
        }
        // Quick open via agent turn
        const url = arg.startsWith("http") ? arg : `https://${arg}`;
        // Fall through to agent with explicit instruction
        msg.text = `Use browser_open on ${url}, then browser_snapshot, and summarize the page briefly.`;
        msg.isCommand = false;
        return null;
      }

      case "tools": {
        const browser = ALL_AGENT_TOOL_NAMES.filter((t) => t.startsWith("browser_") || t === "web_get");
        const memory = ALL_AGENT_TOOL_NAMES.filter((t) => t.startsWith("memory_"));
        const cron = ALL_AGENT_TOOL_NAMES.filter((t) => t.startsWith("cron_"));
        const builtin = ALL_AGENT_TOOL_NAMES.filter(
          (t) => !t.includes("_") || ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(t),
        );
        return [
          `Agent tools (${ALL_AGENT_TOOL_NAMES.length}):`,
          `coding: ${builtin.join(", ")}`,
          `browser: ${browser.join(", ")}`,
          `memory: ${memory.join(", ")}`,
          `cron: ${cron.join(", ")}`,
          `other: ${ALL_AGENT_TOOL_NAMES.filter((t) => t.startsWith("session_")).join(", ")}`,
        ].join("\n");
      }

      case "whoami": {
        return [
          `channel: ${msg.channel}`,
          `peerId: ${msg.peerId}`,
          `userId: ${msg.userId ?? "(n/a)"}`,
          `chatId: ${msg.chatId ?? "(n/a)"}`,
          `sender: ${msg.senderName ?? "(n/a)"}`,
        ].join("\n");
      }

      case "pair": {
        const pending = this.telegram.listPendingPairings();
        if (!pending.length) {
          return "No pending pairing codes. If you're locked out, send /start to get a new code, then run on the host: disk-agent pair <CODE>";
        }
        return [
          "Pending pairings (approve on host):",
          ...pending.map((p) => `• ${p.code} user=${p.userId} @${p.username ?? "?"} exp=${p.expiresAt}`),
          ``,
          "Host: disk-agent pair <CODE>",
        ].join("\n");
      }

      case "stop":
        return "OK — idle. Send another message when you want to continue.";

      default:
        // Let the agent handle unknown /commands
        return null;
    }
  }

  /** Approve telegram pairing code and persist owner if first. */
  async pair(code: string): Promise<string> {
    const result = await this.telegram.approvePairing(code);
    if (!result.ok) return `Pairing failed: ${result.error}`;
    // Persist ownerId to config if we set it
    saveConfig(this.cfg);
    return `Paired user ${result.userId}. They can chat with the bot now.`;
  }
}
