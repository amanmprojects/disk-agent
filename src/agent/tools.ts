import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { BrowserService } from "../browser/service.js";
import type { CronScheduler } from "../cron/scheduler.js";
import type { MemoryStore } from "../memory/store.js";
import type { SessionRegistry } from "../session/manager.js";
import type { SkillsStore } from "../skills/store.js";
import { createSkillTools, SKILL_TOOL_NAMES } from "../skills/tools.js";
import { describeSchedule } from "../cron/scheduler.js";
import type { ChannelId } from "../types.js";

export interface ToolContext {
  memory: MemoryStore;
  cron: CronScheduler;
  browser: BrowserService;
  sessions: SessionRegistry;
  skills: SkillsStore;
  /** Default delivery target for cron jobs created from this chat */
  defaultDeliver?: {
    channel: ChannelId;
    peerId: string;
    chatId?: string;
  };
  workspaceDir: string;
}

/** Names of all disk-agent custom tools (must be included in Pi tools allowlist). */
export const DISK_TOOL_NAMES = [
  "memory_save",
  "memory_search",
  "memory_log",
  "memory_delete",
  "cron_list",
  "cron_add",
  "cron_remove",
  "cron_run",
  "web_get",
  "browser_open",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_screenshot",
  "browser_eval",
  "browser_close",
  "session_list",
  "session_reset",
  ...SKILL_TOOL_NAMES,
] as const;

export const BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/** Full allowlist passed to createAgentSession({ tools }) */
export const ALL_AGENT_TOOL_NAMES: string[] = [
  ...BUILTIN_TOOL_NAMES,
  ...DISK_TOOL_NAMES,
];

/**
 * Custom tools exposed to the Pi agent — memory, cron, browser, web, sessions.
 */
export function createDiskTools(ctx: ToolContext) {
  const memory_save = defineTool({
    name: "memory_save",
    label: "Memory Save",
    description:
      "Persist a durable fact, preference, or note about the user or environment. Use when the user says remember, or when you learn something that should survive across sessions.",
    parameters: Type.Object({
      content: Type.String({ description: "Atomic fact to remember" }),
      kind: Type.Optional(
        Type.Union([
          Type.Literal("fact"),
          Type.Literal("preference"),
          Type.Literal("project"),
          Type.Literal("note"),
        ]),
      ),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params) {
      const entry = ctx.memory.saveFact({
        content: params.content,
        kind: params.kind,
        tags: params.tags,
        source: "agent",
      });
      return {
        content: [{ type: "text" as const, text: `Saved memory ${entry.id}: ${entry.content}` }],
        details: entry,
      };
    },
  });

  const memory_search = defineTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search long-term memory and daily logs for relevant facts.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const hits = ctx.memory.search(params.query, params.limit ?? 8);
      const text =
        hits.length === 0
          ? "No matching memories."
          : hits.map((h, i) => `${i + 1}. [${h.kind}] ${h.content}`).join("\n");
      return { content: [{ type: "text" as const, text }], details: { hits } };
    },
  });

  const memory_log = defineTool({
    name: "memory_log",
    label: "Daily Log",
    description: "Append a note to today's daily memory log (memory/YYYY-MM-DD.md).",
    parameters: Type.Object({
      note: Type.String(),
    }),
    async execute(_id, params) {
      const path = ctx.memory.appendDailyLog(params.note);
      return {
        content: [{ type: "text" as const, text: `Appended to ${path}` }],
        details: { path },
      };
    },
  });

  const memory_delete = defineTool({
    name: "memory_delete",
    label: "Memory Delete",
    description: "Delete a structured memory fact by id.",
    parameters: Type.Object({
      id: Type.String(),
    }),
    async execute(_id, params) {
      const ok = ctx.memory.deleteFact(params.id);
      return {
        content: [{ type: "text" as const, text: ok ? `Deleted ${params.id}` : `Not found: ${params.id}` }],
        details: { ok },
      };
    },
  });

  const cron_list = defineTool({
    name: "cron_list",
    label: "Cron List",
    description: "List scheduled cron/heartbeat jobs.",
    parameters: Type.Object({}),
    async execute() {
      const jobs = ctx.cron.list();
      if (!jobs.length) {
        return { content: [{ type: "text" as const, text: "No cron jobs." }], details: { jobs } };
      }
      const text = jobs
        .map(
          (j) =>
            `- ${j.id} | ${j.enabled ? "ON" : "OFF"} | ${j.name} | ${describeSchedule(j.schedule)} | runs=${j.runCount}` +
            (j.lastRunAt ? ` | last=${j.lastRunAt}` : ""),
        )
        .join("\n");
      return { content: [{ type: "text" as const, text }], details: { jobs } };
    },
  });

  const cron_add = defineTool({
    name: "cron_add",
    label: "Cron Add",
    description:
      "Create a scheduled job. schedule examples: '0 9 * * *' (cron), 'every 30m', 'daily at 09:00', 'weekly', or ISO timestamp for one-shot.",
    parameters: Type.Object({
      name: Type.String(),
      schedule: Type.String({
        description: "Cron expr, 'every 30m', 'daily at 09:00', or ISO time",
      }),
      prompt: Type.String({ description: "What the agent should do when the job fires" }),
      peerId: Type.Optional(Type.String({ description: "Override delivery peer" })),
      chatId: Type.Optional(Type.String()),
      channel: Type.Optional(
        Type.Union([
          Type.Literal("telegram"),
          Type.Literal("cli"),
          Type.Literal("cron"),
          Type.Literal("system"),
        ]),
      ),
    }),
    async execute(_id, params) {
      const deliver = {
        channel: (params.channel ?? ctx.defaultDeliver?.channel ?? "telegram") as ChannelId,
        peerId: params.peerId ?? ctx.defaultDeliver?.peerId ?? "system:cron",
        chatId: params.chatId ?? ctx.defaultDeliver?.chatId,
      };
      const job = ctx.cron.add({
        name: params.name,
        schedule: params.schedule,
        prompt: params.prompt,
        deliver,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Created job ${job.id} (${job.name}) schedule=${describeSchedule(job.schedule)} deliver=${deliver.channel}:${deliver.peerId}`,
          },
        ],
        details: job,
      };
    },
  });

  const cron_remove = defineTool({
    name: "cron_remove",
    label: "Cron Remove",
    description: "Remove a cron job by id.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      const ok = ctx.cron.remove(params.id);
      return {
        content: [{ type: "text" as const, text: ok ? `Removed ${params.id}` : `Not found ${params.id}` }],
        details: { ok },
      };
    },
  });

  const cron_run = defineTool({
    name: "cron_run",
    label: "Cron Run Now",
    description: "Trigger a cron job immediately by id.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      await ctx.cron.runNow(params.id);
      return {
        content: [{ type: "text" as const, text: `Triggered ${params.id}` }],
        details: { id: params.id },
      };
    },
  });

  const web_get = defineTool({
    name: "web_get",
    label: "Web Get",
    description: "Fetch a URL and return extracted text content (no full browser required).",
    parameters: Type.Object({
      url: Type.String(),
    }),
    async execute(_id, params) {
      const r = await ctx.browser.get(params.url);
      return {
        content: [{ type: "text" as const, text: r.ok ? r.message : `Error: ${r.message}` }],
        details: r,
      };
    },
  });

  const browser_open = defineTool({
    name: "browser_open",
    label: "Browser Open",
    description:
      "Open a URL in a real automated browser (agent-browser). Prefer this over web_get when the user asks to use the browser, click, log in, or interact with a page. Falls back to plain fetch if agent-browser is unavailable.",
    parameters: Type.Object({ url: Type.String() }),
    async execute(_id, params) {
      const r = await ctx.browser.open(params.url);
      return {
        content: [{ type: "text" as const, text: r.ok ? r.message : `Error: ${r.message}` }],
        details: r,
      };
    },
  });

  const browser_snapshot = defineTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "Accessibility snapshot of the current browser page with interactive refs (e.g. @e1). Call after browser_open before clicking/filling.",
    parameters: Type.Object({}),
    async execute() {
      const r = await ctx.browser.snapshot();
      return {
        content: [{ type: "text" as const, text: r.ok ? r.message : `Error: ${r.message}` }],
        details: r,
      };
    },
  });

  const browser_click = defineTool({
    name: "browser_click",
    label: "Browser Click",
    description: "Click a CSS selector or snapshot ref like @e1 in the automated browser.",
    parameters: Type.Object({ target: Type.String() }),
    async execute(_id, params) {
      const r = await ctx.browser.click(params.target);
      return {
        content: [{ type: "text" as const, text: r.ok ? r.message : `Error: ${r.message}` }],
        details: r,
      };
    },
  });

  const browser_fill = defineTool({
    name: "browser_fill",
    label: "Browser Fill",
    description: "Type into an input identified by CSS selector or snapshot ref (@eN).",
    parameters: Type.Object({
      target: Type.String(),
      text: Type.String(),
    }),
    async execute(_id, params) {
      const r = await ctx.browser.fill(params.target, params.text);
      return {
        content: [{ type: "text" as const, text: r.ok ? r.message : `Error: ${r.message}` }],
        details: r,
      };
    },
  });

  const browser_screenshot = defineTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Capture a PNG screenshot of the current browser page into the browser artifacts dir.",
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const r = await ctx.browser.screenshot(params.name);
      return {
        content: [
          {
            type: "text" as const,
            text: r.ok ? `Saved screenshot: ${r.screenshotPath ?? r.message}` : `Error: ${r.message}`,
          },
        ],
        details: r,
      };
    },
  });

  const browser_eval = defineTool({
    name: "browser_eval",
    label: "Browser Eval",
    description: "Evaluate JavaScript in the current browser page and return the result.",
    parameters: Type.Object({
      expression: Type.String({ description: "JS expression/function body to evaluate in page context" }),
    }),
    async execute(_id, params) {
      const r = await ctx.browser.eval(params.expression);
      return {
        content: [{ type: "text" as const, text: r.ok ? r.message : `Error: ${r.message}` }],
        details: r,
      };
    },
  });

  const browser_close = defineTool({
    name: "browser_close",
    label: "Browser Close",
    description: "Close the automated browser session when finished.",
    parameters: Type.Object({}),
    async execute() {
      const r = await ctx.browser.close();
      return {
        content: [{ type: "text" as const, text: r.ok ? r.message : `Error: ${r.message}` }],
        details: r,
      };
    },
  });

  const session_list = defineTool({
    name: "session_list",
    label: "Session List",
    description: "List active conversation sessions known to the gateway.",
    parameters: Type.Object({}),
    async execute() {
      const sessions = ctx.sessions.list().slice(0, 30);
      const text =
        sessions.length === 0
          ? "No sessions."
          : sessions
              .map((s) => `- ${s.key} | msgs=${s.messageCount} | updated=${s.updatedAt} | id=${s.sessionId}`)
              .join("\n");
      return { content: [{ type: "text" as const, text }], details: { sessions } };
    },
  });

  const session_reset = defineTool({
    name: "session_reset",
    label: "Session Reset",
    description: "Reset a session by key (e.g. telegram:12345), starting a fresh conversation transcript.",
    parameters: Type.Object({ key: Type.String() }),
    async execute(_id, params) {
      const rec = ctx.sessions.reset(params.key);
      return {
        content: [
          {
            type: "text" as const,
            text: rec ? `Reset ${params.key} → new session ${rec.sessionId}` : `Unknown session ${params.key}`,
          },
        ],
        details: { rec },
      };
    },
  });

  return [
    memory_save,
    memory_search,
    memory_log,
    memory_delete,
    cron_list,
    cron_add,
    cron_remove,
    cron_run,
    web_get,
    browser_open,
    browser_snapshot,
    browser_click,
    browser_fill,
    browser_screenshot,
    browser_eval,
    browser_close,
    session_list,
    session_reset,
    ...createSkillTools(ctx.skills),
  ];
}
