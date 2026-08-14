# AGENTS.md — disk-agent

Short map for coding agents. Prefer this over skimming the whole repo.

## What this is

**Personal AI agent gateway** (OpenClaw/Hermes-style) on the **Pi coding-agent SDK**.

- **Channels:** Telegram (grammY) + local `disk-agent chat` REPL; voice notes → Whisper STT
- **Runtime:** agentic loop with coding tools + memory, cron, browser, skills, provider-native web search (pi-web-search)
- **Auth:** OpenCode Go / provider API keys (shared with Pi), not under `~/.disk-agent`

Package: `@amanm/disk-agent` · Node ≥ 20.6 · ESM TypeScript (`src/` → `dist/`)

Two schema libraries, deliberately: **zod** validates the YAML config
(`config.ts`) only; **typebox** defines Pi agent tools (that's what `defineTool`
expects). Don't cross them. Formatting is enforced by **Biome** (`biome.json`) —
2-space, double quotes, semicolons, trailing commas, 100 cols.

## Docs contract (keep these current)

- **AGENTS.md is the map agents read first.** When you change architecture,
  commands, conventions, or add/rename a module, update this file in the same
  change — not "later". Stale maps cause agents to miss things.
- **CHANGELOG.md records user-visible changes** (new flags, behaviors, fixes,
  dependency adds) under `## Unreleased` or the next version. Anything a user
  could notice goes in; maintenance-only refactors can skip it.
- **ROADMAP.md holds planned work.** Move an item to CHANGELOG.md when it ships.

## Architecture (one glance)

```
Telegram / CLI  →  Gateway  →  AgentRuntime (Pi session)
                      │              │
                      ├ memory       ├ custom tools (tools.ts)
                      ├ cron         ├ Pi extensions (web search, browser-native)
                      ├ browser      └ system prompt (runtime.ts)
                      └ sessions
```

| Concern | Where |
|---------|--------|
| CLI entry | `src/cli.ts` |
| Gateway orchestration | `src/gateway.ts` |
| Pi session + system prompt | `src/agent/runtime.ts` |
| Custom tools + **tool allowlist** | `src/agent/tools.ts` |
| Pi extension paths (`pi-web-search`, …) | `src/agent/pi.ts` |
| Setup / doctor | `src/setup.ts` + `src/setup/` (`tui.ts` OpenTUI wizard, `pi-import.ts` Pi model/provider import) |
| Config + dotenv | `src/config.ts` |
| Path layout | `src/paths.ts` |
| Telegram | `src/channels/telegram.ts` |
| Memory / cron / skills | `src/memory/`, `src/cron/`, `src/skills/` |
| Voice STT (Whisper) | `src/voice/transcribe.ts` |

## Runtime data (not in git)

| Path | Purpose |
|------|---------|
| `~/.disk-agent/` | Home: config, `.env`, workspace, sessions, logs |
| `~/.disk-agent/.env` | Secrets (`TELEGRAM_BOT_TOKEN`, `OPENCODE_API_KEY`, `OPENAI_API_KEY` / `GROQ_API_KEY` for voice STT, …) |
| `~/.disk-agent/workspace/` | Identity (`SOUL.md`, `USER.md`, `MEMORY.md`, skills) |
| `~/.pi/agent/auth.json` | LLM auth (shared with `pi` CLI) |

Home resolve order: `DISK_AGENT_HOME` → `$XDG_DATA_HOME/disk-agent` → `~/.disk-agent`.

## Critical implementation notes

1. **`createAgentSession({ tools })` is an allowlist.** New tools (custom *or* from Pi extensions) must be added to `ALL_AGENT_TOOL_NAMES` in `tools.ts` or the model never sees them.

2. **Pi extensions** load via `additionalExtensionPaths` from `resolveAgentExtensionPaths()`:
   - `pi-web-search` → `web_search`, `url_context` (provider-native — no API key needed)

3. **Detached gateway does not read fish/shell config.** Put secrets in `~/.disk-agent/.env` (loaded by `loadConfig` / dotenv). Restart gateway after env changes: `disk-agent gateway restart`.

4. **Custom tools** use Pi `defineTool` + TypeBox (`typebox` package). Return `{ content, details }`.

5. **Coding cwd vs workspace:** `cfg.cwd` is for read/bash/edit; `cfg.workspaceDir` is identity/memory. Don’t conflate them.

6. **Default Pi packages** for setup: `DEFAULT_PI_PACKAGES` in `setup.ts` (`pi-web-search`, `pi-agent-browser-native`).

7. **ESM + `NodeNext`:** relative imports MUST carry the `.js` extension even though the source is `.ts` (`from "./utils.js"`). Omitting it type-checks in some editors and fails at runtime.

8. **Nested zod config defaults use `.prefault({})`, not `.default({})`.** `.default({})` stores the literal `{}` without running field-level defaults, so every nested key comes back `undefined`. Verify a new section with `ConfigSchema.parse({})`.

9. **`MEMORY.md` mirrors `facts.json`.** `saveFact` appends a line, `deleteFact` removes it. Any new fact mutation must maintain both or the agent reads deleted facts back out of its injected context.

10. **Setup UI:** `disk-agent setup` opens an **OpenTUI wizard** (`src/setup/tui.ts`, raw
    `@opentui/core` constructs — not the React bindings) when the runtime can create the
    native renderer: Bun, or Node ≥ 26.4 with `--experimental-ffi`. Under older Node it
    re-execs the same command under `bun` if on PATH, else falls back to classic readline
    prompts; `--no-tui` forces the classic flow. Wizard values map to `SetupOptions`
    (`tuiValuesToOptions`) and the run continues with `yes: true`.

11. **Pi model/provider import** lives in `src/setup/pi-import.ts`: reads
    `~/.pi/agent/auth.json` (provider keys), `models-store.json` (catalog), and
    `settings.json` (Pi's `defaultProvider`/`defaultModel`). Prefers the pi SDK
    (`ModelRuntime.create`, offline) with a raw-JSON fallback.

12. **OpenTUI gotchas** (when editing `tui.ts`): `getRenderable(id)` only matches *direct*
    children — use the Wizard's recursive `findById`; a destroyed renderable keeps receiving
    keys until something else is focused, so every screen must focus its first focusable
    (`focusRootId`). Select screens need that focus or `ITEM_SELECTED` never fires.

13. **Test seams live in the codebase:** `Gateway` takes optional `agent`/`telegram`
    constructor deps (`GatewayDeps` — structural `AgentLike`/`TelegramLike` picks) and
    `AgentRuntime` takes `RuntimeDeps.sessionFactory`, which bypasses the Pi SDK glue so
    tests can drive `run()`'s streaming pipeline with `test/runtime.test.ts`'s
    `FakePiSession`. Production call sites construct with no deps — don't add required params.

14. **Fake Pi sessions must mimic restore semantics:** `SessionRegistry.setSessionFile`
    overwrites `rec.sessionId` with the session's id, so a fake's `sessionId` must adopt
    `opts.sessionId` and its `sessionFile` must exist on disk (`resume()` refuses missing
    files). Premade fakes with fixed ids break cache reuse and resume tests.

## State & concurrency conventions

- **All JSON state goes through `writeJson` / `writeFileAtomic`** (`utils.ts`) — temp file + `rename`. Never `writeFileSync` a state file directly; a crash mid-write corrupts it.
- **Append with `appendText`** (`appendFileSync`). Don't read-modify-write a whole file to add one line.
- **`SessionRegistry` caches `index.json` behind an mtime check.** Use `readIndex()` / `writeIndex()`, never `readJson(this.indexPath, …)` directly, or the cache goes stale.
- **Per-peer work is serialized by `KeyedQueue`** on `channel:peerId`. A lane can assume no concurrent handler for the same peer, but `list()` / `get()` are callable from outside the queue — treat reads as racy.
- **The Pi session cache is bounded** (`SESSION_IDLE_TTL_MS` 2h, `SESSION_CACHE_MAX` 32) and evicts via `evictStaleSessions`. New code paths that cache a session must refresh `lastUsedAt`.
- **No busy-wait.** `sleepSync` (`daemon.ts`) uses `Atomics.wait`; don't reintroduce a `while (Date.now() < end)` spin.

## Commands

```bash
npm install
npm run build          # tsc → dist/
npm run dev -- <cmd>   # tsx src/cli.ts …
npm run typecheck      # tsc --noEmit
npm test               # node:test via tsx
npm run lint           # biome lint
npm run check          # biome lint + format check
npm run format         # biome format --write

disk-agent setup       # OpenTUI wizard (re-execs under bun if needed); --no-tui = classic prompts
disk-agent doctor      # health check
disk-agent update      # npm self-update + restart gateway
disk-agent gateway start|stop|restart|status
disk-agent chat        # local REPL
```

Run `npm run typecheck && npm test` before handing work back — both take seconds.
CI (`.github/workflows/ci.yml`) runs typecheck + biome + build + tests on Node 20/22/24,
plus the full suite under Bun — the OpenTUI wizard tests in `test/setup-tui.test.ts` need
Bun's native FFI renderer and skip under plain Node. Run them locally with `bun test`.

## Testing

`node:test` + `node:assert/strict` run through `tsx`; files are `test/*.test.ts`.
Anything touching disk uses `mkdtempSync(join(tmpdir(), …))` in `beforeEach` and
`rmSync(…, { recursive: true, force: true })` in `afterEach` — see
`test/session.test.ts`. Always pass an explicit `dataDir`; never let a test write
to the real `~/.disk-agent`.

Covered: `daemon`, `utils`, `memory/store`, `session/manager`, `update`, format
and voice helpers; `gateway` (commands, streaming, queueing, cron delivery), `agent/runtime`
(event pipeline via an injectable fake-session seam) and `channels/telegram` (auth/pairing,
bot-free) — see the `## Unreleased` changelog; `setup/pi-import` (pure, any Node) and `setup/tui` wizard
walkthrough (Bun only — native renderer). **Thinnest coverage — edit with care:** the Pi
SDK glue inside `agent/runtime.ts` (loader/model-resolution/`createAgentSession` path — only
reachable without the `sessionFactory` seam) and `channels/telegram.ts` media/voice handlers
(need a real bot).

## Adding something new

| Goal | Do this |
|------|---------|
| New agent tool | `defineTool` in `tools.ts` (or skills tools) + name on `ALL_AGENT_TOOL_NAMES` + mention in system prompt in `runtime.ts` |
| New Pi extension | Resolve path in `pi.ts`, include in `resolveAgentExtensionPaths()`, allowlist tool names, optional setup/doctor |
| New env secret | `upsertEnv` / prompt in `setup.ts`, document in `writeEnvExample` (`config.ts`), read via `process.env` after `loadConfig` |
| New CLI command | `src/cli.ts` → call into gateway/setup/domain modules |
| Setup wizard screen / option | Screens + state in `src/setup/tui.ts`; pure logic in `src/setup/pi-import.ts`; wire into `runSetup` in `setup.ts` + `SetupOptions`; test in `test/setup-tui.test.ts` (Bun) |

## Don’t

- Store LLM tokens under `~/.disk-agent` — use `~/.pi/agent`.
- Commit `.env` or real API keys.
- Assume extension tools are active without updating the allowlist.
- Use pre-built Pi tool instances with a custom `cwd` (use name-based tools / factories).
- Widen `dmPolicy` to `open` or weaken `isAuthorized` unless asked.
- Hand-edit `dist/` — generated and gitignored.

## Product voice (runtime agent)

When changing the **user-facing** agent prompt: useful, tool-first, concise on Telegram with **minimal markdown** (no tables/heading stacks); never claim missing tools that are registered; prefer `web_search` → `web_fetch` for research; `browser_*` for interactive sites.
