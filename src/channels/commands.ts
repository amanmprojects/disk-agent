/**
 * Telegram bot command menu + help text.
 * Registered via Bot API setMyCommands so "/" shows autocomplete suggestions.
 */
export interface BotCommandDef {
  command: string;
  description: string;
  /** If true, only listed in help (not Telegram menu) — e.g. start */
  menu?: boolean;
}

/** Commands shown in Telegram's "/" autocomplete (max 100; keep short). */
export const TELEGRAM_MENU_COMMANDS: BotCommandDef[] = [
  { command: "help", description: "Show all commands & tips", menu: true },
  { command: "new", description: "Reset this chat session", menu: true },
  { command: "status", description: "Gateway / model / memory status", menu: true },
  { command: "context", description: "Context window usage for this chat", menu: true },
  { command: "effort", description: "Set thinking effort (off…xhigh)", menu: true },
  { command: "model", description: "Show or set model (provider/id)", menu: true },
  { command: "models", description: "List available SuperGrok/xAI models", menu: true },
  { command: "remember", description: "Save a fact to long-term memory", menu: true },
  { command: "memory", description: "Search or list memories", menu: true },
  { command: "cron", description: "List scheduled jobs", menu: true },
  { command: "browser", description: "Browser tools status / quick open", menu: true },
  { command: "tools", description: "List agent tools", menu: true },
  { command: "skills", description: "List / use / create skills", menu: true },
  { command: "thoughts", description: "Show/hide model reasoning on|off", menu: true },
  { command: "steps", description: "Tool activity on|off|minimal", menu: true },
  { command: "verbose", description: "Toggle thoughts+steps together", menu: true },
  { command: "prefs", description: "Show display preferences", menu: true },
  { command: "whoami", description: "Your Telegram user id", menu: true },
  { command: "pair", description: "Show pairing info (host approves)", menu: true },
  { command: "stop", description: "Cancel / acknowledge idle", menu: true },
];

export function telegramMenuPayload(): Array<{ command: string; description: string }> {
  return TELEGRAM_MENU_COMMANDS.filter((c) => c.menu !== false).map((c) => ({
    command: c.command,
    description: c.description.slice(0, 256),
  }));
}

export function helpText(agentName: string): string {
  const lines = [
    `*${agentName} — commands*`,
    ``,
    `Tap / or type / to see suggestions.`,
    ``,
    ...TELEGRAM_MENU_COMMANDS.map((c) => `/${c.command} — ${c.description}`),
    ``,
    `*Usage examples*`,
    `/remember I prefer short replies`,
    `/memory search timezone`,
    `/model`,
    `/model supergrok/grok-4.5`,
    `/context — how full the context window is`,
    `/effort medium — thinking: off|minimal|low|medium|high|xhigh`,
    `/browser https://example.com`,
    `/cron`,
    `/thoughts on  — include model reasoning`,
    `/steps on       — tool calls + results as they happen`,
    `/steps minimal  — tool calls only (no results)`,
    `/verbose on     — thoughts + full steps`,
    `/skills`,
    `/skills use create-skill`,
    `/skills create`,
    ``,
    `*Just chat* for coding, browsing, cron setup, skills, etc.`,
    `Tools: read, bash, edit, write, browser_*, memory_*, cron_*, skill_*, web_get.`,
  ];
  return lines.join("\n");
}
