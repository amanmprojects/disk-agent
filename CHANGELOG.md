# Changelog

## 2.1.1

### Setup / auth

- Setup now offers the **OpenCode Go** option even when SuperGrok credentials already exist — after "credentials already present" it asks "Add OpenCode Go subscription (API key) too?"
- `disk-agent setup --login-provider opencode-go` works when already authenticated (previously the flag was ignored and the provider choice was skipped)

## 2.1.0

### Auth / models

- **OpenCode Go subscription support** — the setup wizard now offers SuperGrok (OAuth) or OpenCode Go (API key) at the auth step, and `disk-agent login opencode-go --type api_key` stores the key in `~/.pi/agent/auth.json`
  - `OPENCODE_API_KEY` is applied to both `opencode` (Zen) and `opencode-go` providers in the shared ModelRuntime
  - Model fallback chain now includes OpenCode Go / Zen (`kimi-k2.6`, `grok-4.5`, `claude-sonnet-4-5`, …) after SuperGrok and before xAI
  - New `--login-provider <supergrok|opencode-go>` flag for non-interactive `disk-agent setup`
  - `disk-agent doctor` checks `OPENCODE_API_KEY`; `status` shows an `opencode:` line; `.env.example` documents the key and model ids

### Telegram / delivery

- **Interleaved assistant text** is delivered in stream order: narration before a tool round is sent immediately, then tool activity, then the next text segment — not buffered into one combined final message
  - Example: `That search was noisy…` appears after the first `web_search` and before the next one
  - Final bubble only contains the remaining undelivered tail (plus optional verbose meta)

## 1.2.0

### CLI

- `disk-agent update [version]` — install the latest (or pinned) `@amanm/disk-agent` from npm and restart the detached gateway
  - `--check` reports current vs registry without installing
  - `--no-restart` updates the package only

## 1.1.0

### Telegram reply formatting

- Convert a small markdown subset in agent replies to Telegram HTML (`parse_mode: HTML`):
  - `**bold**`, `*italic*` (asterisks only), `` `inline code` ``, fenced code blocks, `[label](https://…)` links
  - Bullet lists and plain newlines pass through unchanged
  - Raw HTML from the model stays escaped (no tag injection)
- System prompt documents supported Telegram-friendly formatting and keeps the **minimal markdown** guidance
- Underscore italic (`_like_this_`) is intentionally unsupported so `snake_case` paths stay intact

## 1.0.0

### Ready for npm

- Version **1.0.0** with publish metadata (`files`, `bin`, `exports`, `engines`, `publishConfig`)
- One-command install: `npm install -g @amanm/disk-agent`
- Interactive one-command setup: `disk-agent setup`
  - Home layout + workspace/skills seed
  - Prompts for agent name, model, **Telegram bot token**, owner id, cwd
  - Installs **Pi** CLI if missing
  - Installs Pi extensions: **pi-supergrok**, **pi-agent-browser-native**
  - Installs **[agent-browser](https://agent-browser.dev/)** + Chrome (`agent-browser install`)
  - SuperGrok / X Premium OAuth login

### Standardized home directory

All runtime state lives under a single root:

- `$DISK_AGENT_HOME`, or
- `$XDG_DATA_HOME/disk-agent`, or
- `~/.disk-agent`

Layout: `config.yaml`, `.env`, `workspace/` (identity + memory + workspace skills), `skills/` (user-global), `sessions/`, `pi-sessions/`, `cron/`, `memory/`, `pairings/`, `browser/`, `media/`, `prefs/`, `logs/`.

User skills default to `~/.disk-agent/skills` (legacy `~/.agents/skills` still discovered).

Auth remains shared with Pi at `~/.pi/agent/auth.json`.

### New CLI commands

- `disk-agent setup` — full first-run bootstrap
- `disk-agent login [provider]` — SuperGrok / provider OAuth
- `disk-agent doctor` — install / paths / auth health check
- `disk-agent paths` — print the standardized layout

### Library

- Exports: `runSetup`, `runDoctor`, `getPaths`, `loginProvider`, `getVersion`, path helpers
