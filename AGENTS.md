# AGENTS.md — disk-agent

Short map for coding agents. Prefer this over skimming the whole repo.

## What this is

**Personal AI agent gateway** (OpenClaw/Hermes-style) on the **Pi coding-agent SDK**.

- **Channels:** Telegram (grammY) + local `disk-agent chat` REPL; voice notes → Whisper STT
- **Runtime:** agentic loop with coding tools + memory, cron, browser, skills, Tavily search
- **Auth:** SuperGrok / xAI (shared with Pi), not under `~/.disk-agent`

Package: `@amanm/disk-agent` · Node ≥ 20.6 · ESM TypeScript (`src/` → `dist/`)

## Architecture (one glance)

```
Telegram / CLI  →  Gateway  →  AgentRuntime (Pi session)
                      │              │
                      ├ memory       ├ custom tools (tools.ts)
                      ├ cron         ├ Pi extensions (supergrok, tavily)
                      ├ browser      └ system prompt (runtime.ts)
                      └ sessions
```

| Concern | Where |
|---------|--------|
| CLI entry | `src/cli.ts` |
| Gateway orchestration | `src/gateway.ts` |
| Pi session + system prompt | `src/agent/runtime.ts` |
| Custom tools + **tool allowlist** | `src/agent/tools.ts` |
| SuperGrok / Tavily extension paths | `src/agent/pi.ts` |
| Setup / doctor | `src/setup.ts` |
| Config + dotenv | `src/config.ts` |
| Path layout | `src/paths.ts` |
| Telegram | `src/channels/telegram.ts` |
| Memory / cron / skills | `src/memory/`, `src/cron/`, `src/skills/` |
| Voice STT (Whisper) | `src/voice/transcribe.ts` |

## Runtime data (not in git)

| Path | Purpose |
|------|---------|
| `~/.disk-agent/` | Home: config, `.env`, workspace, sessions, logs |
| `~/.disk-agent/.env` | Secrets (`TELEGRAM_BOT_TOKEN`, `TAVILY_API_KEY`, `OPENAI_API_KEY` / `GROQ_API_KEY` for voice STT, …) |
| `~/.disk-agent/workspace/` | Identity (`SOUL.md`, `USER.md`, `MEMORY.md`, skills) |
| `~/.pi/agent/auth.json` | LLM auth (shared with `pi` CLI) |

Home resolve order: `DISK_AGENT_HOME` → `$XDG_DATA_HOME/disk-agent` → `~/.disk-agent`.

## Critical implementation notes

1. **`createAgentSession({ tools })` is an allowlist.** New tools (custom *or* from Pi extensions) must be added to `ALL_AGENT_TOOL_NAMES` in `tools.ts` or the model never sees them.

2. **Pi extensions** load via `additionalExtensionPaths` from `resolveAgentExtensionPaths()`:
   - `pi-supergrok` → SuperGrok provider
   - `@tavily/pi-extension` → `web_search`, `web_fetch` (needs `TAVILY_API_KEY`)

3. **Detached gateway does not read fish/shell config.** Put secrets in `~/.disk-agent/.env` (loaded by `loadConfig` / dotenv). Restart gateway after env changes: `disk-agent gateway restart`.

4. **Custom tools** use Pi `defineTool` + TypeBox (`typebox` package). Return `{ content, details }`.

5. **Coding cwd vs workspace:** `cfg.cwd` is for read/bash/edit; `cfg.workspaceDir` is identity/memory. Don’t conflate them.

6. **Default Pi packages** for setup: `DEFAULT_PI_PACKAGES` in `setup.ts` (`pi-supergrok`, `pi-agent-browser-native`, `@tavily/pi-extension`).

## Commands

```bash
npm install
npm run build          # tsc → dist/
npm run dev -- <cmd>   # tsx src/cli.ts …
npm test

disk-agent setup       # first-run: home, Telegram, Tavily key, Pi, extensions
disk-agent doctor      # health check
disk-agent gateway start|stop|restart|status
disk-agent chat        # local REPL
```

## Adding something new

| Goal | Do this |
|------|---------|
| New agent tool | `defineTool` in `tools.ts` (or skills tools) + name on `ALL_AGENT_TOOL_NAMES` + mention in system prompt in `runtime.ts` |
| New Pi extension | Resolve path in `pi.ts`, include in `resolveAgentExtensionPaths()`, allowlist tool names, optional setup/doctor |
| New env secret | `upsertEnv` / prompt in `setup.ts`, document in `writeEnvExample` (`config.ts`), read via `process.env` after `loadConfig` |
| New CLI command | `src/cli.ts` → call into gateway/setup/domain modules |

## Don’t

- Store LLM tokens under `~/.disk-agent` — use `~/.pi/agent`.
- Commit `.env` or real API keys.
- Assume extension tools are active without updating the allowlist.
- Use pre-built Pi tool instances with a custom `cwd` (use name-based tools / factories).

## Product voice (runtime agent)

When changing the **user-facing** agent prompt: useful, tool-first, concise on Telegram with **minimal markdown** (no tables/heading stacks); never claim missing tools that are registered; prefer `web_search` → `web_fetch` for research; `browser_*` for interactive sites.
