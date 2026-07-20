import { Bot, type Context } from "grammy";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { IncomingMessage, OutgoingMessage, PairingRequest } from "../types.js";
import { chunkText, ensureDir, nowIso, readJson, uid, writeJson } from "../utils.js";
import { helpText, telegramMenuPayload } from "./commands.js";

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/**
 * Telegram channel adapter (grammY).
 * Supports pairing, allowlist, owner_only policies — OpenClaw-style.
 */
export class TelegramChannel {
  private cfg: AppConfig;
  private log: Logger;
  private bot: Bot | null = null;
  private handler?: MessageHandler;
  private pairingPath: string;
  private allowPath: string;

  constructor(cfg: AppConfig, log: Logger) {
    this.cfg = cfg;
    this.log = log.child("telegram");
    this.pairingPath = join(cfg.dataDir, "pairings", "pending.json");
    this.allowPath = join(cfg.dataDir, "pairings", "allowlist.json");
    ensureDir(join(cfg.dataDir, "pairings"));
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  isEnabled(): boolean {
    return !!(this.cfg.telegram.enabled && this.cfg.telegram.botToken);
  }

  async start(): Promise<void> {
    if (!this.isEnabled()) {
      this.log.warn("telegram disabled or missing bot token");
      return;
    }
    const token = this.cfg.telegram.botToken!;
    this.bot = new Bot(token);

    // Register handlers for every menu command (+ start)
    this.bot.command("start", async (ctx) => {
      const userId = String(ctx.from?.id ?? "");
      if (await this.isAuthorized(userId)) {
        await ctx.reply(
          `Hey — I'm ${this.cfg.agentName}.
Type / for command suggestions, or /help for the full list.`,
        );
        return;
      }
      if (this.cfg.telegram.dmPolicy === "pairing") {
        const code = await this.createPairing(ctx);
        await ctx.reply(
          `This bot is locked. Your pairing code is:\n\n\`${code}\`\n\nRun on the host:\n\`disk-agent pair ${code}\``,
          { parse_mode: "Markdown" },
        );
        return;
      }
      await ctx.reply("You are not authorized to use this bot.");
    });

    const route =
      (name: string, opts?: { requireArgs?: boolean; usage?: string }) =>
      async (ctx: Context) => {
        if (!(await this.guard(ctx))) return;
        const match = (ctx.match?.toString() ?? "").trim();
        if (opts?.requireArgs && !match) {
          await ctx.reply(opts.usage ?? `Usage: /${name} <args>`);
          return;
        }
        const text = match ? `/${name} ${match}` : `/${name}`;
        await this.emitCommand(ctx, text);
      };

    this.bot.command("help", route("help"));
    this.bot.command("new", route("new"));
    this.bot.command("status", route("status"));
    this.bot.command("model", route("model"));
    this.bot.command("models", route("models"));
    this.bot.command("remember", route("remember"));
    this.bot.command("memory", route("memory"));
    this.bot.command("cron", route("cron"));
    this.bot.command("browser", route("browser"));
    this.bot.command("tools", route("tools"));
    this.bot.command("whoami", route("whoami"));
    this.bot.command("pair", route("pair"));
    this.bot.command("stop", route("stop"));

    this.bot.on("message:text", async (ctx) => {
      if (!(await this.guard(ctx))) return;
      // Group mention gate
      if (ctx.chat.type !== "private" && this.cfg.telegram.groupsRequireMention) {
        const botInfo = ctx.me;
        const text = ctx.message.text;
        const mentioned =
          text.includes(`@${botInfo.username}`) ||
          (ctx.message.entities ?? []).some((e) => e.type === "mention");
        if (!mentioned) return;
      }
      // Skip texts already handled as bot commands (grammy still may deliver)
      if (ctx.message.text?.startsWith("/") && !ctx.message.text.startsWith("//")) {
        // Unknown slash commands fall through to the agent via handler
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0]?.toLowerCase();
        const known = new Set([
          "start",
          "help",
          "new",
          "status",
          "model",
          "models",
          "remember",
          "memory",
          "cron",
          "browser",
          "tools",
          "whoami",
          "pair",
          "stop",
        ]);
        if (cmd && known.has(cmd)) return;
      }
      const msg = this.toIncoming(ctx, ctx.message.text);
      if (this.handler) await this.handler(msg);
    });

    this.bot.on("message:caption", async (ctx) => {
      if (!(await this.guard(ctx))) return;
      const caption = ctx.message.caption ?? "";
      const msg = this.toIncoming(ctx, caption || "[attachment]");
      if (this.handler) await this.handler(msg);
    });

    this.bot.catch((err) => {
      this.log.error("bot error", { err: String(err) });
    });

    // Register slash-menu suggestions with Telegram (global scope)
    try {
      await this.bot.api.setMyCommands(telegramMenuPayload());
      // Also set for private chats explicitly (some clients cache oddly)
      await this.bot.api.setMyCommands(telegramMenuPayload(), {
        scope: { type: "all_private_chats" },
      });
      this.log.info("telegram command menu registered", {
        count: telegramMenuPayload().length,
      });
    } catch (err) {
      this.log.warn("setMyCommands failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Long polling
    void this.bot.start({
      onStart: (info) => this.log.info(`bot @${info.username} online`),
    });
  }

  /** Re-push command menu (e.g. after config change). */
  async registerCommands(): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.setMyCommands(telegramMenuPayload());
    await this.bot.api.setMyCommands(telegramMenuPayload(), {
      scope: { type: "all_private_chats" },
    });
  }

  async stop(): Promise<void> {
    if (this.bot) {
      try {
        this.bot.stop();
      } catch {
        /* ignore */
      }
      this.bot = null;
    }
  }

  async send(out: OutgoingMessage): Promise<void> {
    if (!this.bot || out.suppress) return;
    const chatId = out.chatId ?? out.peerId.replace(/^telegram:/, "");
    if (!chatId) return;
    const chunks = chunkText(out.text || "…", this.cfg.telegram.maxMessageChars);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(chatId, chunk, {
          parse_mode: out.parseMode,
          disable_notification: out.silent,
        });
      } catch (err) {
        // Retry without parse_mode if markdown fails
        this.log.warn("send failed, retrying plain", { err: String(err) });
        await this.bot.api.sendMessage(chatId, chunk, {
          disable_notification: out.silent,
        });
      }
    }
  }

  /** Send typing action */
  async typing(chatId: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.sendChatAction(chatId, "typing");
    } catch {
      /* ignore */
    }
  }

  // ── Auth / pairing ────────────────────────────────────────────

  getAllowlist(): string[] {
    const fromConfig = this.cfg.telegram.allowFrom ?? [];
    const fromFile = readJson<string[]>(this.allowPath, []);
    const owner = this.cfg.telegram.ownerId ? [this.cfg.telegram.ownerId] : [];
    return [...new Set([...owner, ...fromConfig, ...fromFile].map(String))];
  }

  async isAuthorized(userId: string): Promise<boolean> {
    const policy = this.cfg.telegram.dmPolicy;
    if (policy === "open") return true;
    if (policy === "owner_only") return userId === String(this.cfg.telegram.ownerId ?? "");
    // allowlist + pairing both use allowlist
    return this.getAllowlist().includes(userId);
  }

  async approvePairing(code: string): Promise<{ ok: boolean; userId?: string; error?: string }> {
    const pending = readJson<Record<string, PairingRequest>>(this.pairingPath, {});
    const req = Object.values(pending).find((p) => p.code === code);
    if (!req) return { ok: false, error: "Unknown or expired code" };
    if (new Date(req.expiresAt).getTime() < Date.now()) {
      delete pending[req.userId];
      writeJson(this.pairingPath, pending);
      return { ok: false, error: "Code expired" };
    }
    const allow = this.getAllowlist();
    if (!allow.includes(req.userId)) {
      allow.push(req.userId);
      writeJson(this.allowPath, allow);
    }
    // Promote first paired user to owner if unset
    if (!this.cfg.telegram.ownerId) {
      this.cfg.telegram.ownerId = req.userId;
    }
    delete pending[req.userId];
    writeJson(this.pairingPath, pending);
    this.log.info(`paired user ${req.userId}`, { username: req.username });
    return { ok: true, userId: req.userId };
  }

  listPendingPairings(): PairingRequest[] {
    const pending = readJson<Record<string, PairingRequest>>(this.pairingPath, {});
    return Object.values(pending).filter((p) => new Date(p.expiresAt).getTime() > Date.now());
  }

  private async createPairing(ctx: Context): Promise<string> {
    const userId = String(ctx.from?.id ?? "");
    const pending = readJson<Record<string, PairingRequest>>(this.pairingPath, {});
    const code = uid("pair").slice(-8).toUpperCase();
    const req: PairingRequest = {
      code,
      userId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    pending[userId] = req;
    writeJson(this.pairingPath, pending);
    return code;
  }

  private async guard(ctx: Context): Promise<boolean> {
    const userId = String(ctx.from?.id ?? "");
    if (await this.isAuthorized(userId)) return true;
    if (this.cfg.telegram.dmPolicy === "pairing" && ctx.chat?.type === "private") {
      const code = await this.createPairing(ctx);
      await ctx.reply(
        `Not authorized yet. Pairing code: \`${code}\`\nRun: \`disk-agent pair ${code}\``,
        { parse_mode: "Markdown" },
      );
    } else {
      await ctx.reply("Not authorized.");
    }
    return false;
  }

  private toIncoming(ctx: Context, text: string): IncomingMessage {
    const userId = String(ctx.from?.id ?? "");
    const chatId = String(ctx.chat?.id ?? "");
    // DMs: peer = user; groups: peer = chat
    const isGroup = ctx.chat?.type !== "private";
    const peerId = isGroup ? `group:${chatId}` : userId;
    return {
      id: String(ctx.message?.message_id ?? uid("tg")),
      channel: "telegram",
      peerId,
      senderName: ctx.from?.username || ctx.from?.first_name || userId,
      userId,
      chatId,
      text,
      timestamp: nowIso(),
    };
  }

  private async emitCommand(ctx: Context, text: string): Promise<void> {
    const msg = this.toIncoming(ctx, text);
    msg.isCommand = true;
    if (this.handler) await this.handler(msg);
  }
}
