import { Bot, type Context } from "grammy";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type {
  IncomingMessage,
  MessageAttachment,
  OutgoingMessage,
  PairingRequest,
} from "../types.js";
import { chunkText, ensureDir, nowIso, readJson, uid, writeJson } from "../utils.js";
import { helpText, telegramMenuPayload } from "./commands.js";
import { downloadTelegramFile, guessMime, isImageMime } from "./media.js";

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
    this.bot.command("skills", route("skills"));
    this.bot.command("thoughts", route("thoughts"));
    this.bot.command("steps", route("steps"));
    this.bot.command("verbose", route("verbose"));
    this.bot.command("prefs", route("prefs"));
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
          "skills",
          "thoughts",
          "reasoning",
          "think",
          "steps",
          "trace",
          "verbose",
          "debug",
          "prefs",
          "display",
          "whoami",
          "pair",
          "stop",
        ]);
        if (cmd && known.has(cmd)) return;
      }
      const msg = this.toIncoming(ctx, ctx.message.text);
      if (this.handler) await this.handler(msg);
    });

    // Photos (with or without caption)
    this.bot.on("message:photo", async (ctx) => {
      if (!(await this.guard(ctx))) return;
      if (!(await this.groupOk(ctx))) return;
      await this.handleMediaMessage(ctx);
    });

    // Image documents, stickers, other media with optional caption
    this.bot.on("message:document", async (ctx) => {
      if (!(await this.guard(ctx))) return;
      if (!(await this.groupOk(ctx))) return;
      await this.handleMediaMessage(ctx);
    });

    this.bot.on("message:sticker", async (ctx) => {
      if (!(await this.guard(ctx))) return;
      if (!(await this.groupOk(ctx))) return;
      await this.handleMediaMessage(ctx);
    });

    // Captions for non-photo media that still carry caption-only delivery
    // (photo/document handlers already cover the common cases)
    this.bot.on("message:caption", async (ctx) => {
      if (!(await this.guard(ctx))) return;
      if (!(await this.groupOk(ctx))) return;
      // Avoid double-handling when photo/document already processed
      if (ctx.message.photo?.length || ctx.message.document || ctx.message.sticker) return;
      await this.handleMediaMessage(ctx);
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

  /**
   * Send a message. Returns the first Telegram message_id (useful for later edits).
   * When out.editMessageId is set, edits that message instead (single chunk only).
   */
  async send(out: OutgoingMessage): Promise<number | undefined> {
    if (!this.bot || out.suppress) return undefined;
    const chatId = out.chatId ?? out.peerId.replace(/^telegram:/, "");
    if (!chatId) return undefined;

    // Edit path — one message only
    if (out.editMessageId != null) {
      const messageId = Number(out.editMessageId);
      try {
        await this.bot.api.editMessageText(chatId, messageId, out.text || "…", {
          parse_mode: out.parseMode,
        });
        return messageId;
      } catch (err) {
        // Fallback: plain edit, then give up (don't spam a new message for edits)
        try {
          await this.bot.api.editMessageText(chatId, messageId, out.text || "…");
          return messageId;
        } catch (err2) {
          this.log.warn("edit failed", {
            error: err2 instanceof Error ? err2.message : String(err2),
            prev: err instanceof Error ? err.message : String(err),
          });
          return messageId;
        }
      }
    }

    const chunks = chunkText(out.text || "…", this.cfg.telegram.maxMessageChars);
    let firstId: number | undefined;
    for (const chunk of chunks) {
      try {
        const msg = await this.bot.api.sendMessage(chatId, chunk, {
          parse_mode: out.parseMode,
          disable_notification: out.silent,
        });
        if (firstId == null) firstId = msg.message_id;
      } catch (err) {
        // Retry without parse_mode if HTML/markdown fails
        this.log.warn("send failed, retrying plain", { err: String(err) });
        try {
          const msg = await this.bot.api.sendMessage(chatId, stripTags(chunk), {
            disable_notification: out.silent,
          });
          if (firstId == null) firstId = msg.message_id;
        } catch (err2) {
          this.log.error("send failed plain", {
            error: err2 instanceof Error ? err2.message : String(err2),
          });
        }
      }
    }
    return firstId;
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

  private toIncoming(
    ctx: Context,
    text: string,
    attachments?: MessageAttachment[],
  ): IncomingMessage {
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
      attachments,
    };
  }

  private async groupOk(ctx: Context): Promise<boolean> {
    if (ctx.chat?.type === "private") return true;
    if (!this.cfg.telegram.groupsRequireMention) return true;
    const botInfo = ctx.me;
    const text = ctx.message?.text || ctx.message?.caption || "";
    const mentioned =
      text.includes(`@${botInfo.username}`) ||
      [...(ctx.message?.entities ?? []), ...(ctx.message?.caption_entities ?? [])].some(
        (e) => e.type === "mention",
      );
    // Photos in groups without mention: still allow if it's a reply to the bot
    const replyToBot =
      ctx.message?.reply_to_message?.from?.id != null &&
      ctx.message.reply_to_message.from.id === ctx.me.id;
    return mentioned || replyToBot;
  }

  private async handleMediaMessage(ctx: Context): Promise<void> {
    const token = this.cfg.telegram.botToken;
    if (!token) return;

    const caption = (ctx.message?.caption || "").trim();
    const attachments: MessageAttachment[] = [];
    const notes: string[] = [];

    try {
      // Largest photo size
      const photos = ctx.message?.photo;
      if (photos?.length) {
        const best = photos[photos.length - 1]!;
        try {
          const dl = await downloadTelegramFile({
            token,
            fileId: best.file_id,
            dataDir: this.cfg.dataDir,
            fileName: `photo_${best.file_unique_id}.jpg`,
            mimeType: "image/jpeg",
            type: "photo",
            caption: caption || undefined,
          });
          dl.attachment.width = best.width;
          dl.attachment.height = best.height;
          attachments.push(dl.attachment);
          notes.push(`photo ${best.width}x${best.height}`);
        } catch (err) {
          this.log.warn("photo download failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          notes.push("photo (download failed)");
        }
      }

      const doc = ctx.message?.document;
      if (doc) {
        const mime = doc.mime_type || guessMime(doc.file_name);
        try {
          const dl = await downloadTelegramFile({
            token,
            fileId: doc.file_id,
            dataDir: this.cfg.dataDir,
            fileName: doc.file_name || `doc_${doc.file_unique_id}`,
            mimeType: mime,
            type: isImageMime(mime) ? "document" : "document",
            caption: caption || undefined,
          });
          // Only keep base64 for images; large binaries stay on disk
          if (!isImageMime(dl.attachment.mimeType)) {
            delete dl.attachment.base64;
          }
          attachments.push(dl.attachment);
          notes.push(`document ${doc.file_name || mime}`);
        } catch (err) {
          this.log.warn("document download failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          notes.push(`document (download failed)`);
        }
      }

      const sticker = ctx.message?.sticker;
      if (sticker) {
        // Static stickers are webp; animated/video stickers are less useful for vision
        const isStatic = !sticker.is_animated && !sticker.is_video;
        if (isStatic) {
          try {
            const dl = await downloadTelegramFile({
              token,
              fileId: sticker.file_id,
              dataDir: this.cfg.dataDir,
              fileName: `sticker_${sticker.file_unique_id}.webp`,
              mimeType: "image/webp",
              type: "sticker",
              caption: sticker.emoji || undefined,
            });
            attachments.push(dl.attachment);
            notes.push(`sticker ${sticker.emoji || ""}`.trim());
          } catch (err) {
            this.log.warn("sticker download failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          notes.push("animated/video sticker (not downloaded)");
        }
      }
    } catch (err) {
      this.log.error("media handling failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const imageCount = attachments.filter((a) => isImageMime(a.mimeType) && a.base64).length;
    const defaultText =
      caption ||
      (imageCount
        ? `[User sent ${imageCount} image${imageCount > 1 ? "s" : ""}${notes.length ? `: ${notes.join(", ")}` : ""}. Describe/analyze what you see and help with their request.]`
        : attachments.length
          ? `[User sent attachment${attachments.length > 1 ? "s" : ""}${notes.length ? `: ${notes.join(", ")}` : ""}. Paths are on disk — use tools if needed.]`
          : "[User sent media that could not be downloaded.]");

    // Brief ack while the agent works
    if (ctx.chat?.id) {
      void this.typing(String(ctx.chat.id));
    }

    const msg = this.toIncoming(ctx, defaultText, attachments.length ? attachments : undefined);
    this.log.info("media message", {
      attachments: attachments.length,
      images: imageCount,
      caption: caption.slice(0, 80),
    });
    if (this.handler) await this.handler(msg);
  }

  private async emitCommand(ctx: Context, text: string): Promise<void> {
    const msg = this.toIncoming(ctx, text);
    msg.isCommand = true;
    if (this.handler) await this.handler(msg);
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}
