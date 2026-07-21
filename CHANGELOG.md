# Changelog

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
