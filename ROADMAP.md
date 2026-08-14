# Roadmap

Planned / wished-for work, not commitments. When an item ships, move it to
CHANGELOG.md under the release it lands in. New ideas welcome here — a roadmap
is a backlog, not a promise.

## Setup wizard (OpenTUI)

- [ ] **Live progress screen for install steps** — the wizard currently destroys the
      renderer after "Review & run" and installs print to the console. Suspend/resume
      the renderer around `ensurePi` / `ensurePiPackages` / `ensureAgentBrowser` / login
      and show per-step status + failure details inside the TUI.
- [ ] **Terminal-width adaptation** — screens use a fixed 64-col box that clips on narrow
      terminals; OpenTUI reflows on resize, the wizard doesn't track it yet.
- [ ] **`--tui` force flag** — only `--no-tui` exists today; a positive flag helps
      pty-driven scripting and CI screenshots.
- [ ] **Timeout guard on `collectPiModels`** — `ModelRuntime.create` is offline-only but
      unguarded; wrap it in a short deadline and lean on the raw-JSON fallback.
- [ ] **Model picker search/filter** — Pi catalogs can hold hundreds of models; the picker
      currently caps at 5 per provider with no way to search.
- [ ] **Verify the Node ≥ 26.4 + `--experimental-ffi` path** — only the Bun renderer path
      is exercised by tests/CI today; run the wizard natively under Node 26 once and fix
      any quirks.

## Testing & CI

- [ ] **PTY-level E2E for setup** — a scripted pseudo-terminal walkthrough (renderer +
      real `dist/cli.js setup`) to catch integration issues the test renderer can't
      (terminal capability handshake, re-exec under bun).
- [ ] **CI: include the Bun job in the matrix** — the `tui` job is separate today so a Bun
      regression doesn't block the Node matrix; consider a `bun test` step on one Node
      variant instead of a standalone job.

## Runtime & platform

- [ ] **Windows verification** — bun re-exec and the OpenTUI native renderer on
      Windows (winpty/ConPTY) are entirely unverified.
- [ ] **Upstream OpenTUI fixes** — `getRenderable(id)` matching only direct children and
      destroyed renderables retaining key focus forced workarounds in `tui.ts`
      (`findById`, `focusRootId`); revisit when upstream changes.
- [ ] **Shared secret vault story** — auth lives in `~/.pi/agent/auth.json` by design, but
      `~/.disk-agent/.env` still holds Telegram keys in plaintext; evaluate
      keyring integration as an opt-in.

## Product ideas

- [ ] **Terminal dashboard** (`disk-agent ui`) — a live OpenTUI view of sessions, cron
      jobs, memory facts, and gateway health; natural follow-up to the setup wizard and
      a good showcase for the constructs API.
- [ ] **Semantic memory search** — today `MEMORY.md`/facts are linear; a vector index over
      facts + daily logs would make recall scale past a few hundred entries.
- [ ] **Per-task model routing** — cheap/fast model for chat and heartbeats, big reasoning
      model for deep work; `resolveModel` already has fallback chains to build on.
- [ ] **Voice replies (TTS)** — STT exists for inbound voice notes; outbound spoken replies
      would complete the loop.
