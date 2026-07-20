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
   LLM + tools                              ~/.disk-agent/workspace
   (read/bash/edit/… + memory/cron/web)     SOUL.md · USER.md · MEMORY.md
```

## Features

| Area | What you get |
|------|----------------|
| **Telegram channel** | grammY long-polling bot, pairing / allowlist / owner policies, group mention gate, chunked replies |
| **Memory** | OpenClaw-style `SOUL.md` / `USER.md` / `MEMORY.md` / daily `memory/YYYY-MM-DD.md` + searchable fact store |
| **Cron + heartbeat** | Cron expressions, `every 30m`, `daily at 09:00`, one-shots; quiet hours; `HEARTBEAT_OK` suppression |
| **Browser / web** | `web_get` (fetch+HTML strip); full automation when [`agent-browser`](https://www.npmjs.com/package/agent-browser) is installed |
| **Sessions** | Per-peer Pi session transcripts, `/new` reset, serialized lanes (no parallel tool conflicts) |
| **Coding agent** | Full Pi toolset: read, bash, edit, write, grep, find, ls |
| **Skills / identity** | Workspace skills + bootstrap context injection each run |

Inspired by:

- **OpenClaw** — gateway, channel adapters, markdown memory, heartbeat, pairing
- **Hermes Agent** — persistent memory, scheduled delivery to chat platforms, browser control, multi-platform gateway
- **Pi** — the embedded coding-agent runtime and tool loop

## Quick start

### Requirements

- Node.js **≥ 20.6**
- **Auth (one of):**
  - **SuperGrok / X Premium** via [`pi-supergrok`](https://github.com/dvcrn/pi-supergrok) OAuth (recommended — shares `~/.pi/agent/auth.json` with Pi)
  - `XAI_API_KEY` from [console.x.ai](https://console.x.ai)
  - Other Pi providers (`ANTHROPIC_API_KEY`, OpenAI Codex OAuth, …)
- Optional: Telegram bot token from [@BotFather](https://t.me/BotFather)
- Optional: `npm i -g agent-browser` (+ browser backend) for full browser control

### Install

```bash
cd disk-agent
npm install          # includes @earendil-works/pi-coding-agent + pi-supergrok
npm run build
npm link             # optional — exposes `disk-agent` on your PATH
```

### Auth with SuperGrok / xAI subscription

Disk Agent uses the **same Pi agent directory** (`~/.pi/agent`) as the interactive `pi` CLI, and loads the `pi-supergrok` extension so the `supergrok` provider is registered.

```bash
# If you already use pi with SuperGrok, you're done — tokens are reused.
# Otherwise:
pi install npm:pi-supergrok   # or rely on this project's dependency
pi                            # open TUI
# then: /login supergrok
# then: /model supergrok/grok-4.5
```

Verify from disk-agent:

```bash
disk-agent models
disk-agent status
```

You should see `supergrok/...` lines marked `auth`.

**API key alternative** (no subscription OAuth):

```bash
export XAI_API_KEY=xai-...
export DISK_AGENT_MODEL=xai/grok-4
# or keep provider=supergrok if the extension accepts the key
```

### Setup

```bash
# Initialize ~/.disk-agent (config, workspace identity files, dirs)
npx tsx src/cli.ts setup
# or after build:
disk-agent setup --name Disk --model supergrok/grok-4.5
```

Create `~/.disk-agent/.env` (Telegram + optional keys):

```bash
TELEGRAM_BOT_TOKEN=123456:ABC...
# DISK_AGENT_OWNER_ID=your_telegram_user_id
# DISK_AGENT_MODEL=supergrok/grok-4.5
# XAI_API_KEY=...   # only if not using SuperGrok OAuth
```

### Run the gateway

```bash
disk-agent gateway
# or
npm run gateway
```

1. DM your bot on Telegram → it replies with a **pairing code**
2. On the host: `disk-agent pair <CODE>`
3. Chat normally

### CLI chat (no Telegram)

```bash
disk-agent chat
```

## CLI reference

```
disk-agent setup          Initialize home + workspace
disk-agent gateway        Long-running Telegram + cron gateway
disk-agent chat           Interactive local REPL
disk-agent pair <code>    Approve Telegram pairing
disk-agent status         Config / SuperGrok auth status
disk-agent models         List SuperGrok / xAI / other models
disk-agent sessions       List conversation sessions
disk-agent skills list|show|create|delete|paths
disk-agent memory list|search|save
disk-agent cron list|add|remove|run
```

### Skills

Skills are reusable `SKILL.md` packages ([Agent Skills](https://agentskills.io) standard).

| Location | Scope |
|----------|--------|
| `~/.disk-agent/workspace/skills/` | Workspace (default for `skill_create`) |
| `<cwd>/.agents/skills/` | Project |
| `~/.agents/skills/` | User-global |

Built-ins seeded on setup:

- **create-skill** — guided skill authoring (inspired by siviter-xyz/dot-agent)
- **find-skills** — discover/install from [skills.sh](https://skills.sh) / `npx skills`
- **remember** — persist facts via memory tools

Agent tools: `skill_list`, `skill_load`, `skill_create`, `skill_delete`, `skill_find`, `skill_install`.

Telegram: `/skills`, `/skills use create-skill`, `/skills create`, `/skills find react`.

### Cron examples

```bash
# Cron expression — every day 9:00
disk-agent cron add morning "0 9 * * *" "Summarize my calendar priorities and send a short brief."

# Interval
disk-agent cron add ping "every 2h" "Check HEARTBEAT.md monitors; HEARTBEAT_OK if nothing."

# Natural shortcut
disk-agent cron add weekly "weekly" "Review MEMORY.md and suggest 3 cleanups."
```

From chat you can also say: *“Every weekday at 8:30, research AI news and message me a 5-bullet brief.”* — the agent uses `cron_add`.

## Workspace layout (OpenClaw-style)

```
~/.disk-agent/
├── config.yaml          # gateway config
├── .env                 # secrets (not committed)
├── sessions/            # logical session index
├── pi-sessions/         # Pi jsonl transcripts (per peer)
├── cron/jobs.json       # scheduled jobs
├── memory/facts.json    # structured facts
├── pairings/            # telegram allowlist + pending codes
├── browser/             # screenshots / artifacts
├── logs/gateway.log
└── workspace/           # agent identity & memory files
    ├── SOUL.md          # personality
    ├── USER.md          # who you are
    ├── MEMORY.md        # curated long-term memory
    ├── AGENTS.md        # operating rules
    ├── HEARTBEAT.md     # proactive checklist
    ├── IDENTITY.md
    ├── memory/YYYY-MM-DD.md
    └── skills/**/SKILL.md
```

Edit `SOUL.md` to change voice. The agent maintains `USER.md` / `MEMORY.md` over time.

## Telegram security

Default DM policy is **`pairing`**:

- Unknown users get a short-lived code
- You approve with `disk-agent pair <code>` on the host
- First paired user becomes `ownerId` if unset

Other policies in `config.yaml`:

```yaml
telegram:
  enabled: true
  dmPolicy: pairing   # pairing | allowlist | owner_only | open
  allowFrom: []
  ownerId: "123456789"
  groupsRequireMention: true
```

**Do not use `open` on a public bot.**

## Agent tools

Built-in (Pi): `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

Disk Agent extras:

| Tool | Purpose |
|------|---------|
| `memory_save` / `memory_search` / `memory_log` / `memory_delete` | Long-term + daily memory |
| `cron_list` / `cron_add` / `cron_remove` / `cron_run` | Scheduler |
| `web_get` | Fetch URL → text |
| `browser_open` / `snapshot` / `click` / `fill` / `screenshot` | Browser automation |
| `session_list` / `session_reset` | Session management |

## Configuration

Primary file: `~/.disk-agent/config.yaml` (created by `setup`).

```yaml
agentName: Disk
cwd: /home/you/code          # coding tools working directory
model:
  provider: supergrok        # pi-supergrok OAuth (SuperGrok / X sub)
  id: grok-4.5
  thinking: medium
  # id: grok-4.3 | grok-composer-2.5-fast | grok-4.20-0309-reasoning
  # provider: xai            # built-in xAI (API key or OAuth)
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
  allowedDomains: []         # empty = all domains
memory:
  enabled: true
  dailyLogDays: 2
logging:
  level: info
```

Environment overrides: `TELEGRAM_BOT_TOKEN`, `DISK_AGENT_OWNER_ID`, `DISK_AGENT_MODEL` (`supergrok/grok-4.5`), `DISK_AGENT_PROVIDER`, `DISK_AGENT_HOME`, `DISK_AGENT_WORKSPACE`, `DISK_AGENT_CWD`, `XAI_API_KEY`, plus other provider API keys.

Auth is **not** stored under `~/.disk-agent` — it deliberately uses **`~/.pi/agent/auth.json`** so a single SuperGrok login works for both `pi` and disk-agent.

## Library usage

```ts
import { bootstrapHome, Gateway } from "disk-agent";

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
```

## Design notes

1. **Gateway as control plane** — channels never call the LLM directly; everything is normalized → queued per session → agent loop → deliver.
2. **Markdown memory** — sessions end, files persist (OpenClaw). Structured facts add search without a vector DB.
3. **Heartbeat** — proactive loop with `HEARTBEAT_OK` suppression so you are not spammed.
4. **Pi as the hands** — we embed `createAgentSession` rather than reimplementing a coding agent.
5. **Pairing by default** — remote chat access is gated until you approve on the host.

## License

MIT
