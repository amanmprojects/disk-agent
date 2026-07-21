# Disk Agent

**OpenClaw / Hermes-style personal AI agent gateway**, powered by the [Pi coding-agent](https://github.com/badlogic/pi-mono) SDK.

Chat from **Telegram** (or a local CLI), with **persistent memory**, **cron/heartbeat automations**, **browser/web tools**, and **per-peer session management** — running on your machine.

```
You (Telegram / CLI)
        │
        ▼
   ┌─────────┐     sessions · memory · cron · browser
   │ Gateway │──────────────────────────────────────────┐
   └────┬────┘                                          │
        │  agentic loop (Pi SDK)                        │
        ▼                                               ▼
   LLM + tools                              ~/.disk-agent/
   (read/bash/edit/… + memory/cron/web)     workspace · skills · sessions
```

## Install & setup (v1)

**Requirements:** Node.js **≥ 20.6**

```bash
# 1) Install
npm install -g @amanm/disk-agent

# 2) Interactive setup (does everything)
disk-agent setup
```

That single `setup` wizard:

1. Creates the **standardized home directory** (`~/.disk-agent` or `$XDG_DATA_HOME/disk-agent`)
2. Seeds workspace identity files + built-in skills
3. **Prompts** for agent name, model, Telegram bot token (from [@BotFather](https://t.me/BotFather)), owner id, coding cwd
4. Installs the **Pi** CLI if missing (`@earendil-works/pi-coding-agent`)
5. Installs Pi extensions: **pi-supergrok**, **pi-agent-browser-native**, **@tavily/pi-extension**
6. Installs **[agent-browser](https://agent-browser.dev/)** globally and runs `agent-browser install` (Chrome)
7. Walks you through **SuperGrok / X Premium OAuth** (or skips if tokens / `XAI_API_KEY` already exist)

For Tavily web search, set `TAVILY_API_KEY` in `~/.disk-agent/.env` (or the process env).

Non-interactive (CI / scripted):

```bash
disk-agent setup --yes --skip-login \
  --telegram-token "123456:ABC..." \
  --owner "your_telegram_user_id" \
  --tavily-key "tvly-..."
# later:
disk-agent login
```

Flags:

```bash
disk-agent setup \
  --name Disk \
  --model supergrok/grok-4.5 \
  --telegram-token "123456:ABC..." \
  --owner "your_telegram_user_id" \
  --tavily-key "tvly-..."   # optional: Tavily web_search / web_fetch \
  --skip-browser   # optional: skip agent-browser
  --skip-login     # optional: skip SuperGrok OAuth
```

Verify:

```bash
disk-agent doctor
disk-agent models
disk-agent status
```

### Run

```bash
# secrets (if not passed to setup)
$EDITOR ~/.disk-agent/.env
# TELEGRAM_BOT_TOKEN=...
# TAVILY_API_KEY=tvly-...

# Detached (recommended on a VPS — survives logout)
disk-agent gateway start
disk-agent gateway status
disk-agent gateway stop
disk-agent gateway restart

# Update to the latest published version and restart the gateway
disk-agent update
disk-agent update --check          # report only
disk-agent update 1.2.0            # pin a version
disk-agent update --no-restart     # package only

# Foreground (dev / Ctrl+C to stop)
disk-agent gateway
# or
disk-agent chat             # local REPL only
```

Logs: `~/.disk-agent/logs/gateway.log` · pid: `~/.disk-agent/gateway.pid`

1. DM your bot on Telegram → pairing code  
2. On the host: `disk-agent pair <CODE>`  
3. Chat normally  

Telegram extras: `/context` (context window usage), `/effort medium` (thinking level).  

### From source

```bash
git clone <repo> && cd disk-agent
npm install
npm run build
npm link                  # optional — puts disk-agent on PATH
disk-agent setup
```

## Features

| Area | What you get |
|------|----------------|
| **Telegram channel** | grammY long-polling bot, pairing / allowlist / owner policies, group mention gate, chunked replies, **voice notes** (Whisper STT) |
| **Memory** | OpenClaw-style `SOUL.md` / `USER.md` / `MEMORY.md` / daily `memory/YYYY-MM-DD.md` + searchable fact store |
| **Cron + heartbeat** | Cron expressions, `every 30m`, `daily at 09:00`, one-shots; quiet hours; `HEARTBEAT_OK` suppression |
| **Browser / web** | Tavily `web_search` / `web_fetch` (`@tavily/pi-extension`, needs `TAVILY_API_KEY`); `web_get` (fetch+HTML strip); full automation when [`agent-browser`](https://www.npmjs.com/package/agent-browser) is installed |
| **Sessions** | Per-peer Pi session transcripts, `/new` archive+reset, `/sessions` + `/resume`, serialized lanes |
| **Coding agent** | Full Pi toolset: read, bash, edit, write, grep, find, ls |
| **Skills / identity** | Workspace + user skills under one home tree; bootstrap context each run |

Inspired by **OpenClaw**, **Hermes Agent**, and **Pi**.

## Auth

| Method | How |
|--------|-----|
| **SuperGrok / X Premium** (recommended) | `disk-agent setup` or `disk-agent login` → OAuth → `~/.pi/agent/auth.json` |
| **xAI API key** | `export XAI_API_KEY=…` or put it in `~/.disk-agent/.env` |
| **Other Pi providers** | `ANTHROPIC_API_KEY`, OpenAI Codex OAuth via `pi`, etc. |

Auth is **not** stored under `~/.disk-agent` — it deliberately uses **`~/.pi/agent/auth.json`** so one SuperGrok login works for both `pi` and disk-agent.

```bash
disk-agent login              # SuperGrok OAuth
disk-agent login xai --type api_key
disk-agent models             # should show supergrok/* with [auth]
```

## Standardized directory layout

Everything disk-agent owns lives under one home root:

| Priority | Path |
|----------|------|
| 1 | `$DISK_AGENT_HOME` |
| 2 | `$XDG_DATA_HOME/disk-agent` |
| 3 | `~/.disk-agent` |

```
~/.disk-agent/
├── config.yaml              # gateway config
├── .env                     # secrets (not committed)
├── .env.example
├── workspace/               # agent identity & markdown memory
│   ├── SOUL.md              # personality
│   ├── USER.md              # who you are
│   ├── MEMORY.md            # curated long-term memory
│   ├── AGENTS.md            # operating rules
│   ├── HEARTBEAT.md         # proactive checklist
│   ├── IDENTITY.md
│   ├── memory/YYYY-MM-DD.md
│   ├── knowledge/
│   └── skills/**/SKILL.md   # workspace skills (default for skill_create)
├── skills/**/SKILL.md       # user-global skills
├── sessions/                # logical session index
├── pi-sessions/             # Pi jsonl transcripts (per peer)
├── cron/jobs.json
├── memory/facts.json        # structured facts
├── pairings/                # telegram allowlist + pending codes
├── browser/                 # screenshots / artifacts
├── media/                   # inbound Telegram files
├── prefs/
└── logs/gateway.log
```

```bash
disk-agent paths              # print resolved paths
```

Edit `SOUL.md` to change voice. The agent maintains `USER.md` / `MEMORY.md` over time.

### Skills locations

| Location | Scope |
|----------|--------|
| `~/.disk-agent/workspace/skills/` | Workspace (default for `skill_create`) |
| `~/.disk-agent/skills/` | User-global |
| `<cwd>/.agents/skills/` | Project |
| `~/.agents/skills/` | Legacy interop (still discovered) |

Built-ins seeded on setup: **create-skill**, **find-skills**, **remember**.

## CLI reference

```
disk-agent setup          Full bootstrap (home + pi + extensions + login)
disk-agent login [prov]   SuperGrok / provider OAuth
disk-agent doctor         Health check
disk-agent update         Update to latest npm version and restart the gateway
disk-agent paths          Print directory layout
disk-agent gateway        Foreground gateway (Telegram + cron)
disk-agent gateway start  Detached OS process (VPS-friendly)
disk-agent gateway stop   Stop detached gateway
disk-agent gateway status Detached process status
disk-agent gateway restart
disk-agent chat           Interactive local REPL
disk-agent pair <code>    Approve Telegram pairing
disk-agent status         Config / SuperGrok auth status
disk-agent models         List SuperGrok / xAI / other models
disk-agent sessions              List active conversation sessions
disk-agent sessions history      List archived (previous) sessions
disk-agent sessions resume <id>  Resume a previous session by id or .jsonl path
disk-agent sessions files        List raw pi-sessions transcripts (incl. orphans)
disk-agent chat --resume <id>    Start CLI chat on a previous session
disk-agent skills list|show|create|delete|paths
disk-agent memory list|search|save
disk-agent cron list|add|remove|run
```

Chat slash commands include `/context` (window usage), `/effort <level>` (thinking effort), `/sessions` (previous transcripts for this chat), and `/resume <id>`.

### Session history

- Each peer has one **active** transcript.
- `/new` (or `session_reset`) **archives** the current transcript and starts fresh.
- List archives: `disk-agent sessions history` or `/sessions` in chat.
- Resume: `disk-agent sessions resume <id>` / `disk-agent chat --resume <id>` / `/resume <id>` (short id prefixes work).

### Cron examples

```bash
disk-agent cron add morning "0 9 * * *" "Summarize my calendar priorities and send a short brief."
disk-agent cron add ping "every 2h" "Check HEARTBEAT.md monitors; HEARTBEAT_OK if nothing."
disk-agent cron add weekly "weekly" "Review MEMORY.md and suggest 3 cleanups."
```

## Telegram security

Default DM policy is **`pairing`**:

- Unknown users get a short-lived code
- You approve with `disk-agent pair <code>` on the host
- First paired user becomes `ownerId` if unset

```yaml
telegram:
  enabled: true
  dmPolicy: pairing   # pairing | allowlist | owner_only | open
  allowFrom: []
  ownerId: "123456789"
  groupsRequireMention: true
```

**Do not use `open` on a public bot.**

## Configuration

Primary file: `~/.disk-agent/config.yaml` (created by `setup`).

```yaml
agentName: Disk
cwd: /home/you/code          # coding tools working directory
model:
  provider: supergrok
  id: grok-4.5
  thinking: medium
telegram:
  enabled: true
  dmPolicy: pairing
cron:
  enabled: true
  heartbeat:
    enabled: true
    everyMinutes: 30
    quietHours: { start: 23, end: 8 }
browser:
  enabled: true
  headless: true
memory:
  enabled: true
  dailyLogDays: 2
logging:
  level: info
```

Environment overrides: `TELEGRAM_BOT_TOKEN`, `DISK_AGENT_OWNER_ID`, `DISK_AGENT_MODEL`, `DISK_AGENT_PROVIDER`, `DISK_AGENT_HOME`, `DISK_AGENT_WORKSPACE`, `DISK_AGENT_CWD`, `XAI_API_KEY`, plus other provider API keys.

### Telegram voice messages

Voice notes (and optional audio files) are downloaded, transcribed with Whisper, and sent to the agent as text.

| Setting | Default | Notes |
|---------|---------|--------|
| `voice.enabled` | `true` | Set `false` to reject voice notes |
| `voice.provider` | `auto` | `auto` picks OpenAI if `OPENAI_API_KEY` is set, else Groq if `GROQ_API_KEY`, else download-only |
| `voice.model` | provider default | OpenAI: `whisper-1`; Groq: `whisper-large-v3-turbo` |
| `voice.language` | unset | Optional ISO-639-1 hint (`en`, `es`, …) |
| `voice.includeAudio` | `true` | Also process Telegram audio *file* messages |

```bash
# ~/.disk-agent/.env — pick one:
OPENAI_API_KEY=sk-...
# or free-tier Whisper:
GROQ_API_KEY=gsk_...
```

Restart the gateway after changing env: `disk-agent gateway restart`.

## Agent tools

Built-in (Pi): `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

| Extra tool | Purpose |
|------------|---------|
| `memory_save` / `memory_search` / `memory_log` / `memory_delete` | Long-term + daily memory |
| `cron_list` / `cron_add` / `cron_remove` / `cron_run` | Scheduler |
| `web_search` | Tavily web search (`TAVILY_API_KEY`) |
| `web_fetch` | Tavily extract from URLs |
| `web_get` | Fetch URL → text (plain HTTP) |
| `browser_open` / `snapshot` / `click` / `fill` / `screenshot` | Browser automation |
| `session_list` / `session_reset` / `session_resume` | Session management (list, archive, resume) |
| `skill_list` / `skill_load` / `skill_create` / … | Skills |

## Library usage

```ts
import { bootstrapHome, Gateway, runSetup } from "@amanm/disk-agent";

// Programmatic setup (same as CLI)
await runSetup({ yes: true, skipLogin: true });

const cfg = bootstrapHome();
const gw = new Gateway(cfg);
await gw.start();
```

## Development

```bash
npm run dev -- status
npm run gateway
npm run typecheck
npm run build
npm test
```

## Design notes

1. **Gateway as control plane** — channels never call the LLM directly; everything is normalized → queued per session → agent loop → deliver.
2. **Markdown memory** — sessions end, files persist (OpenClaw). Structured facts add search without a vector DB.
3. **Heartbeat** — proactive loop with `HEARTBEAT_OK` suppression so you are not spammed.
4. **Pi as the hands** — we embed `createAgentSession` rather than reimplementing a coding agent.
5. **Pairing by default** — remote chat access is gated until you approve on the host.
6. **One home tree** — config, workspace, skills, sessions, and logs share a standardized directory.

## License

MIT
