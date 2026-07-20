import type { AppConfig } from "./config.js";
import { saveConfig } from "./config.js";
import { AgentRuntime } from "./agent/runtime.js";
import { BrowserService } from "./browser/service.js";
import { TelegramChannel } from "./channels/telegram.js";
import { CronScheduler, cronJobToIncoming, describeSchedule } from "./cron/scheduler.js";
import { Logger, defaultLogPath } from "./logger.js";
import { MemoryStore } from "./memory/store.js";
import { SessionRegistry, makeSessionKey } from "./session/manager.js";
import { SkillsStore } from "./skills/store.js";
import type {
  AgentRunResult,
  CronJob,
  IncomingMessage,
  LiveProgressEvent,
  OutgoingMessage,
} from "./types.js";
import { KeyedQueue } from "./utils.js";
import { helpText } from "./channels/commands.js";
import { ALL_AGENT_TOOL_NAMES } from "./agent/tools.js";
import { parseOnOff, PrefsStore, type PeerPrefs } from "./prefs.js";
import {
  formatCronHtml,
  formatFinalHtml,
  formatThoughtHtml,
  formatToolDoneHtml,
  formatToolRunningHtml,
  markdownToTelegramHtml,
} from "./format/telegram.js";

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
  readonly prefs: PrefsStore;
  readonly skills: SkillsStore;
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
    this.prefs = new PrefsStore(cfg);
    this.skills = new SkillsStore(cfg);
    this.agent = new AgentRuntime({
      cfg,
      log: this.log,
      memory: this.memory,
      cron: this.cron,
      browser: this.browser,
      sessions: this.sessions,
      skills: this.skills,
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
          const isTg = msg.channel === "telegram";
          await this.deliver({
            channel: msg.channel,
            peerId: msg.peerId,
            chatId: msg.chatId,
            text: isTg ? markdownToTelegramHtml(handled) : handled,
            parseMode: isTg ? "HTML" : undefined,
          });
          return handled;
        }
      }

      if (msg.channel === "telegram" && msg.chatId) {
        void this.telegram.typing(msg.chatId);
      }

      const peerKey = makeSessionKey(msg.channel, msg.peerId);
      const prefs = this.prefs.get(peerKey);

      // Live stream progress:
      //  - thoughts → grey blockquote message when each thought finishes
      //  - tools → one message per tool, edited from "running…" → result
      const toolMsgIds = new Map<string, number>();
      let deliverChain: Promise<void> = Promise.resolve();

      const queueLive = (fn: () => Promise<void>) => {
        deliverChain = deliverChain.then(fn).catch((err) => {
          this.log.debug("live deliver failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        if (msg.channel === "telegram" && msg.chatId) {
          void this.telegram.typing(msg.chatId);
        }
        return deliverChain;
      };

      const onProgress =
        prefs.showThoughts || prefs.showSteps
          ? async (ev: LiveProgressEvent) => {
              await queueLive(async () => {
                if (ev.kind === "thought") {
                  if (!prefs.showThoughts) return;
                  await this.deliver({
                    channel: msg.channel,
                    peerId: msg.peerId,
                    chatId: msg.chatId,
                    text: formatThoughtHtml(ev.text),
                    parseMode: msg.channel === "telegram" ? "HTML" : undefined,
                    silent: true,
                  });
                  return;
                }

                if (!prefs.showSteps) return;

                if (ev.kind === "tool_start") {
                  const html = formatToolRunningHtml(ev.name, ev.args);
                  const id = await this.deliver({
                    channel: msg.channel,
                    peerId: msg.peerId,
                    chatId: msg.chatId,
                    text: html,
                    parseMode: msg.channel === "telegram" ? "HTML" : undefined,
                    silent: true,
                  });
                  if (typeof id === "number") toolMsgIds.set(ev.id, id);
                  return;
                }

                if (ev.kind === "tool_end") {
                  const html = formatToolDoneHtml(ev.name, ev.args, ev.ok, ev.detail);
                  const existing = toolMsgIds.get(ev.id);
                  await this.deliver({
                    channel: msg.channel,
                    peerId: msg.peerId,
                    chatId: msg.chatId,
                    text: html,
                    parseMode: msg.channel === "telegram" ? "HTML" : undefined,
                    silent: true,
                    editMessageId: existing,
                  });
                  toolMsgIds.delete(ev.id);
                }
              });
            }
          : undefined;

      const result = await this.agent.run(msg, {
        deliverHint:
          msg.channel === "telegram"
            ? { channel: "telegram", peerId: msg.peerId, chatId: msg.chatId }
            : undefined,
        captureThoughts: prefs.showThoughts,
        captureSteps: prefs.showSteps,
        onProgress,
      });

      // Wait for any in-flight live messages before the final answer
      await deliverChain;

      const bare = result.text?.trim() || "(no response)";
      // Suppress heartbeat OK
      const suppress = bare === "HEARTBEAT_OK" || bare.startsWith("HEARTBEAT_OK\n");

      const text =
        msg.channel === "telegram"
          ? formatFinalHtml(
              bare,
              prefs.showSteps || prefs.showThoughts
                ? { durationMs: result.durationMs, toolCalls: result.toolCalls }
                : undefined,
            )
          : composeFinalReply(bare, result, prefs);

      await this.deliver({
        channel: msg.channel,
        peerId: msg.peerId,
        chatId: msg.chatId,
        text,
        parseMode: msg.channel === "telegram" ? "HTML" : undefined,
        suppress,
      });

      return suppress ? "" : bare;
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

    const isTg = job.deliver.channel === "telegram";
    await this.deliver({
      channel: job.deliver.channel,
      peerId: job.deliver.peerId,
      chatId: job.deliver.chatId,
      text: isTg ? formatCronHtml(job.name, text) : `⏰ ${job.name}\n\n${text}`,
      parseMode: isTg ? "HTML" : undefined,
    });
  }

  private async deliver(out: OutgoingMessage): Promise<number | undefined> {
    if (out.suppress || !out.text) return undefined;
    if (out.channel === "telegram") {
      return this.telegram.send(out);
    }
    if (out.channel === "cli") {
      // CLI: strip simple tags for readability when HTML is used
      const plain = out.text
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      console.log(plain);
      return undefined;
    }
    // system/cron without telegram — log only
    this.log.info(`[deliver:${out.channel}] ${out.text.slice(0, 200)}`);
    return undefined;
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
        const skill = ALL_AGENT_TOOL_NAMES.filter((t) => t.startsWith("skill_"));
        const builtin = ALL_AGENT_TOOL_NAMES.filter(
          (t) => !t.includes("_") || ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(t),
        );
        return [
          `Agent tools (${ALL_AGENT_TOOL_NAMES.length}):`,
          `coding: ${builtin.join(", ")}`,
          `browser: ${browser.join(", ")}`,
          `memory: ${memory.join(", ")}`,
          `cron: ${cron.join(", ")}`,
          `skills: ${skill.join(", ")}`,
          `other: ${ALL_AGENT_TOOL_NAMES.filter((t) => t.startsWith("session_")).join(", ")}`,
        ].join("\n");
      }

      case "skills": {
        const sub = arg.split(/\s+/)[0]?.toLowerCase() || "list";
        const rest = arg.replace(/^\S+\s*/, "").trim();
        if (sub === "list" || !arg) {
          const skills = this.skills.list();
          if (!skills.length) {
            return "No skills yet. Try /skills create or ask me to find community skills.";
          }
          return [
            `Skills (${skills.length}):`,
            ...skills.map((s) => `• ${s.name} [${s.source}] — ${s.description.slice(0, 100)}`),
            ``,
            `Use: /skills use <name>`,
            `Create: /skills create`,
            `Find: ask me to find a skill, or /skills find <query>`,
          ].join("\n");
        }
        if (sub === "use" || sub === "load" || sub === "run") {
          const name = rest || arg.replace(/^(use|load|run)\s+/i, "").trim();
          if (!name) return "Usage: /skills use <name>";
          const body = this.skills.readBody(name);
          if (!body) return `Skill not found: ${name}. Try /skills`;
          // Hand off to agent with skill body loaded
          msg.text =
            `Follow the skill "${name}" below to help the user.\n\n` +
            `--- SKILL.md ---\n${body}\n--- END SKILL ---\n\n` +
            `If the skill needs user input, ask briefly. Otherwise begin.`;
          msg.isCommand = false;
          return null;
        }
        if (sub === "create" || sub === "new") {
          msg.text =
            "The user wants to create a new skill. Load the create-skill skill " +
            "(skill_load create-skill) and guide them through creating one with skill_create.";
          msg.isCommand = false;
          return null;
        }
        if (sub === "find" || sub === "search") {
          const q = rest || "";
          msg.text = q
            ? `Find community skills for: ${q}. Use skill_find or follow find-skills.`
            : "Help me find useful community skills. Load find-skills and search.";
          msg.isCommand = false;
          return null;
        }
        if (sub === "delete" || sub === "rm") {
          const name = rest;
          if (!name) return "Usage: /skills delete <name>";
          const r = this.skills.delete(name);
          return r.ok ? `Deleted ${name}` : `Error: ${r.error}`;
        }
        return "Usage: /skills [list|use <name>|create|find <query>|delete <name>]";
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

      case "thoughts":
      case "reasoning":
      case "think": {
        const peerKey = makeSessionKey(msg.channel, msg.peerId);
        const cur = this.prefs.get(peerKey);
        const v = parseOnOff(arg);
        if (v === null && !arg) {
          return `Thoughts (model reasoning): ${cur.showThoughts ? "ON" : "OFF"}\nUsage: /thoughts on|off`;
        }
        if (v === null) return "Usage: /thoughts on|off";
        const next = this.prefs.set(peerKey, { showThoughts: v });
        return `Thoughts ${next.showThoughts ? "ON" : "OFF"} — I'll ${next.showThoughts ? "send each thought as its own message when it finishes" : "hide model reasoning"}.`;
      }

      case "steps":
      case "tools_trace":
      case "trace": {
        const peerKey = makeSessionKey(msg.channel, msg.peerId);
        const cur = this.prefs.get(peerKey);
        const v = parseOnOff(arg);
        if (v === null && !arg) {
          return `Steps (tool activity): ${cur.showSteps ? "ON" : "OFF"}\nUsage: /steps on|off`;
        }
        if (v === null) return "Usage: /steps on|off";
        const next = this.prefs.set(peerKey, { showSteps: v });
        return `Steps ${next.showSteps ? "ON" : "OFF"} — I'll ${next.showSteps ? "send each tool call as its own message as it happens" : "hide tool activity"}.`;
      }

      case "verbose":
      case "debug": {
        const peerKey = makeSessionKey(msg.channel, msg.peerId);
        const cur = this.prefs.get(peerKey);
        const v = parseOnOff(arg);
        if (v === null && !arg) {
          return [
            "Verbose display prefs:",
            this.prefs.format(cur),
          ].join("\n");
        }
        if (v === null) return "Usage: /verbose on|off\n(turns both thoughts + steps together)";
        const next = this.prefs.set(peerKey, { showThoughts: v, showSteps: v });
        return `Verbose ${v ? "ON" : "OFF"}\n${this.prefs.format(next)}`;
      }

      case "prefs":
      case "display": {
        const peerKey = makeSessionKey(msg.channel, msg.peerId);
        return this.prefs.format(this.prefs.get(peerKey));
      }

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

/** Final answer for non-Telegram channels. */
function composeFinalReply(
  answer: string,
  result: AgentRunResult,
  prefs: PeerPrefs,
): string {
  if (!(prefs.showSteps || prefs.showThoughts)) return answer;
  const meta = [`${result.durationMs}ms`];
  if (result.toolCalls) meta.push(`${result.toolCalls} tools`);
  return `${answer}

(${meta.join(" · ")})`;
}
