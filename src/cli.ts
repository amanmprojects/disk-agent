#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Command } from "commander";
import chalk from "chalk";
import {
  bootstrapHome,
  loadConfig,
  initProjectConfig,
  type AppConfig,
} from "./config.js";
import { Gateway } from "./gateway.js";
import { describeSchedule } from "./cron/scheduler.js";
import { nowIso } from "./utils.js";
import type { IncomingMessage } from "./types.js";
import { runSetup, runDoctor } from "./setup.js";
import { loginProvider } from "./auth/login.js";
import { getVersion } from "./version.js";
import { describeLayout, getPaths } from "./paths.js";
import { SessionRegistry } from "./session/manager.js";
import {
  getDaemonStatus,
  restartDaemon,
  startDaemon,
  stopDaemon,
  writeRuntimePid,
} from "./daemon.js";
import { runUpdate } from "./update.js";

const VERSION = getVersion();

const program = new Command();

program
  .name("disk-agent")
  .description("OpenClaw/Hermes-style personal AI agent gateway (Pi-powered)")
  .version(VERSION);

program
  .command("setup")
  .description(
    "Interactive setup: home, Telegram, Tavily, Pi extensions (supergrok + browser + tavily), SuperGrok login",
  )
  .option("--name <name>", "Agent name")
  .option("--data-dir <path>", "Override home directory (~/.disk-agent)")
  .option("--workspace <path>", "Override workspace directory")
  .option("--telegram-token <token>", "Set Telegram bot token (skips prompt)")
  .option("--owner <id>", "Telegram owner user id")
  .option(
    "--tavily-key <key>",
    "Set Tavily API key for web_search / web_fetch (skips prompt)",
  )
  .option("--model <provider/id>", "Default model, e.g. supergrok/grok-4.5")
  .option("--cwd <path>", "Default coding tools working directory")
  .option("--skip-pi", "Skip installing pi CLI and Pi extensions")
  .option("--skip-browser", "Skip installing agent-browser CLI + Chrome")
  .option("--skip-login", "Skip SuperGrok OAuth login")
  .option("--login", "Force SuperGrok login (even with --yes)")
  .option("--force-login", "Re-run OAuth even if already authenticated")
  .option(
    "-y, --yes",
    "Non-interactive: no prompts; install defaults; skip login unless --login",
  )
  .option(
    "--package <spec>",
    "Extra pi package to install (repeatable), e.g. npm:pi-supergrok",
    (v: string, acc: string[]) => {
      acc.push(v);
      return acc;
    },
    [] as string[],
  )
  .action(async (opts) => {
    try {
      await runSetup({
        agentName: opts.name,
        dataDir: opts.dataDir,
        workspaceDir: opts.workspace,
        telegramToken: opts.telegramToken,
        ownerId: opts.owner,
        tavilyApiKey: opts.tavilyKey,
        model: opts.model,
        cwd: opts.cwd,
        skipPi: Boolean(opts.skipPi),
        skipBrowser: Boolean(opts.skipBrowser),
        skipLogin: Boolean(opts.skipLogin),
        forceLogin: Boolean(opts.forceLogin),
        yes: Boolean(opts.yes),
        login: Boolean(opts.login),
        packages: opts.package?.length ? opts.package : undefined,
      });
      // Optional project-local sample when run from a repo
      try {
        initProjectConfig(process.cwd());
      } catch {
        /* ignore */
      }
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("login")
  .description("Log in to SuperGrok (or another Pi provider) via OAuth")
  .argument("[provider]", "Provider id", "supergrok")
  .option("--type <type>", "oauth | api_key", "oauth")
  .option("--force", "Re-authenticate even if already logged in")
  .action(async (provider: string, opts) => {
    const type = opts.type === "api_key" ? "api_key" : "oauth";
    const result = await loginProvider(provider || "supergrok", {
      type,
      force: Boolean(opts.force),
    });
    if (!result.ok) {
      console.error(chalk.red(result.error));
      process.exitCode = 1;
    }
  });

program
  .command("doctor")
  .description("Check install, paths, pi extensions, and auth")
  .option("--data-dir <path>", "Override home directory")
  .option("--workspace <path>", "Override workspace directory")
  .action(async (opts) => {
    const code = await runDoctor({
      dataDir: opts.dataDir,
      workspaceDir: opts.workspace,
    });
    process.exitCode = code;
  });

program
  .command("update")
  .description(
    "Update @amanm/disk-agent to the latest (or given) version and restart the gateway",
  )
  .argument(
    "[version]",
    "Version or dist-tag (default: latest). Examples: latest, 1.2.0, v1.2.0",
  )
  .option("--check", "Only check for a newer version; do not install or restart")
  .option("--no-restart", "Update the package but do not stop/start the gateway")
  .option("--data-dir <path>", "Override home directory")
  .option("--workspace <path>", "Override workspace directory")
  .option("--cwd <path>", "Coding tools working directory for the restarted gateway")
  .action((version: string | undefined, opts) => {
    try {
      const result = runUpdate({
        version,
        check: Boolean(opts.check),
        noRestart: opts.restart === false,
        dataDir: opts.dataDir,
        workspaceDir: opts.workspace,
        cwd: opts.cwd,
      });
      if (result.ok) {
        console.log(chalk.green(result.message));
        if (result.latestVersion && result.previousVersion !== result.newVersion) {
          console.log(`  was:     v${result.previousVersion}`);
          console.log(`  now:     v${result.newVersion ?? result.latestVersion}`);
        } else if (result.latestVersion && opts.check) {
          console.log(`  current: v${result.previousVersion}`);
          console.log(`  latest:  v${result.latestVersion}`);
        }
        if (result.gatewayMessage) {
          const style = result.restarted ? chalk.green : chalk.dim;
          console.log(style(result.gatewayMessage));
        }
      } else {
        console.error(chalk.red(result.message));
        if (result.gatewayMessage) console.error(chalk.yellow(result.gatewayMessage));
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("paths")
  .description("Print the standardized directory layout")
  .option("--data-dir <path>", "Override home directory")
  .option("--workspace <path>", "Override workspace directory")
  .action((opts) => {
    const p = getPaths({ home: opts.dataDir, workspace: opts.workspace });
    console.log(describeLayout(p));
    console.log("");
    console.log(`home:           ${p.home}`);
    console.log(`workspace:      ${p.workspace}`);
    console.log(`user skills:    ${p.userSkills}`);
    console.log(`workspace skills: ${p.workspaceSkills}`);
    console.log(`config:         ${p.configFile}`);
    console.log(`env:            ${p.envFile}`);
  });

const gatewayCmd = program
  .command("gateway")
  .description(
    "Gateway process: run (foreground), start/stop (detached OS daemon for VPS)",
  )
  .option("--data-dir <path>", "Override data directory")
  .option("--workspace <path>", "Override workspace directory")
  .option("--cwd <path>", "Coding tools working directory");

async function runGatewayForeground(opts: {
  dataDir?: string;
  workspace?: string;
  cwd?: string;
}): Promise<void> {
  const cfg = loadCfg(opts);
  if (opts.cwd) cfg.cwd = opts.cwd;
  writeRuntimePid(cfg.dataDir);
  const gw = new Gateway(cfg);
  const shutdown = async (sig: string) => {
    console.log(chalk.yellow(`\n${sig} received, shutting down…`));
    await gw.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await gw.start();
  const mode = process.env.DISK_AGENT_DAEMON ? "detached" : "foreground";
  console.log(
    chalk.green(
      `${cfg.agentName} gateway running (${mode}, pid ${process.pid}). Ctrl+C or: disk-agent gateway stop`,
    ),
  );
  // Keep alive
  await new Promise(() => {
    /* never resolves */
  });
}

// Default: foreground when `disk-agent gateway` with no subcommand
gatewayCmd.action(async (opts) => {
  await runGatewayForeground(opts);
});

gatewayCmd
  .command("run")
  .description("Run gateway in the foreground (also used by daemon worker)")
  .option("--data-dir <path>", "Override data directory")
  .option("--workspace <path>", "Override workspace directory")
  .option("--cwd <path>", "Coding tools working directory")
  .action(async (opts) => {
    // Merge parent opts if commander nested them
    await runGatewayForeground(opts);
  });

gatewayCmd
  .command("start")
  .description("Start gateway as a detached OS process (survives logout / VPS)")
  .option("--data-dir <path>", "Override data directory")
  .option("--workspace <path>", "Override workspace directory")
  .option("--cwd <path>", "Coding tools working directory")
  .action((opts) => {
    const r = startDaemon({
      dataDir: opts.dataDir,
      workspaceDir: opts.workspace,
      cwd: opts.cwd,
    });
    if (r.ok) console.log(chalk.green(r.message));
    else {
      console.error(chalk.red(r.message));
      process.exitCode = 1;
    }
  });

gatewayCmd
  .command("stop")
  .description("Stop the detached gateway process")
  .option("--data-dir <path>", "Override data directory")
  .action((opts) => {
    const r = stopDaemon(opts.dataDir);
    if (r.ok) console.log(chalk.green(r.message));
    else {
      console.error(chalk.red(r.message));
      process.exitCode = 1;
    }
  });

gatewayCmd
  .command("restart")
  .description("Restart the detached gateway")
  .option("--data-dir <path>", "Override data directory")
  .option("--workspace <path>", "Override workspace directory")
  .option("--cwd <path>", "Coding tools working directory")
  .action((opts) => {
    const r = restartDaemon({
      dataDir: opts.dataDir,
      workspaceDir: opts.workspace,
      cwd: opts.cwd,
    });
    if (r.ok) console.log(chalk.green(r.message));
    else {
      console.error(chalk.red(r.message));
      process.exitCode = 1;
    }
  });

gatewayCmd
  .command("status")
  .description("Show whether the detached gateway is running")
  .option("--data-dir <path>", "Override data directory")
  .action((opts) => {
    const s = getDaemonStatus(opts.dataDir);
    if (s.running) {
      console.log(chalk.green(`Gateway running  pid=${s.pid}`));
      if (s.startedAt) console.log(`  started: ${s.startedAt}`);
      console.log(`  log:     ${s.logFile}`);
      console.log(`  pidfile: ${s.pidFile}`);
    } else if (s.stale) {
      console.log(chalk.yellow(`Gateway not running (stale pid ${s.pid})`));
      console.log(`  pidfile: ${s.pidFile}`);
      console.log(`  log:     ${s.logFile}`);
      process.exitCode = 1;
    } else {
      console.log(chalk.dim("Gateway not running"));
      console.log(`  log:     ${s.logFile}`);
      console.log(`  start:   disk-agent gateway start`);
      process.exitCode = 1;
    }
  });

program
  .command("chat")
  .description("Interactive CLI chat with the agent (no Telegram required)")
  .option("--data-dir <path>", "Override data directory")
  .option("--workspace <path>", "Override workspace directory")
  .option("--cwd <path>", "Coding tools working directory")
  .option(
    "--resume <id>",
    "Resume a previous session by id (prefix ok) or .jsonl path before chatting",
  )
  .action(async (opts) => {
    const cfg = loadCfg(opts);
    if (opts.cwd) cfg.cwd = opts.cwd;
    // Don't start telegram polling in CLI chat
    cfg.telegram.enabled = false;
    const gw = new Gateway(cfg);
    // Start cron only
    gw.cron.setRunner((job) =>
      gw.runCronJob(job).catch((e: unknown) => console.error(e)),
    );
    gw.cron.start();

    if (opts.resume) {
      const result = await gw.agent.resumeSession(String(opts.resume), {
        key: "cli:local",
      });
      if (!result.ok) {
        console.error(chalk.red(result.error));
        await gw.stop();
        process.exitCode = 1;
        return;
      }
      console.log(
        chalk.cyan(
          `Resumed ${result.key} session ${result.sessionId}` +
            (result.sessionFile ? `\n  ${result.sessionFile}` : ""),
        ),
      );
    }

    console.log(
      chalk.cyan(
        `${cfg.agentName} CLI chat. /exit to quit, /new to reset, /sessions, /resume <id>.`,
      ),
    );
    const rl = createInterface({ input, output });
    try {
      while (true) {
        const line = (await rl.question(chalk.bold("you> "))).trim();
        if (!line) continue;
        if (line === "/exit" || line === "/quit") break;
        const msg: IncomingMessage = {
          id: `cli_${Date.now()}`,
          channel: "cli",
          peerId: "local",
          senderName: "user",
          text: line,
          timestamp: nowIso(),
          chatId: "local",
        };
        process.stdout.write(chalk.dim("…thinking\n"));
        const reply = await gw.handleIncoming(msg);
        console.log(chalk.green(`${cfg.agentName}> `) + (reply || "(suppressed)"));
      }
    } finally {
      rl.close();
      await gw.stop();
    }
  });

program
  .command("pair")
  .description("Approve a Telegram pairing code")
  .argument("<code>", "Pairing code from the bot")
  .option("--data-dir <path>", "Override data directory")
  .action(async (code, opts) => {
    const cfg = loadCfg(opts);
    cfg.telegram.enabled = false; // no need to poll
    const gw = new Gateway(cfg);
    const msg = await gw.pair(String(code));
    console.log(msg);
  });

program
  .command("cron")
  .description("Manage cron jobs")
  .option("--data-dir <path>", "Override data directory")
  .argument("[action]", "list | add | remove | run", "list")
  .argument("[args...]", "action arguments")
  .action(async (action: string, args: string[], opts) => {
    const cfg = loadCfg(opts);
    cfg.telegram.enabled = false;
    const gw = new Gateway(cfg);
    const act = (action || "list").toLowerCase();

    if (act === "list") {
      const jobs = gw.cron.list();
      if (!jobs.length) {
        console.log("No jobs.");
        return;
      }
      for (const j of jobs) {
        console.log(
          `${j.id}  ${j.enabled ? "ON " : "OFF"}  ${j.name}  ${describeSchedule(j.schedule)}  runs=${j.runCount}`,
        );
      }
      return;
    }

    if (act === "add") {
      // disk-agent cron add "name" "schedule" "prompt..."
      const [name, schedule, ...promptParts] = args;
      if (!name || !schedule || !promptParts.length) {
        console.error("Usage: disk-agent cron add <name> <schedule> <prompt>");
        process.exit(1);
      }
      const owner = cfg.telegram.ownerId;
      const job = gw.cron.add({
        name,
        schedule,
        prompt: promptParts.join(" "),
        deliver: {
          channel: owner ? "telegram" : "cli",
          peerId: owner ? owner : "local",
          chatId: owner,
        },
      });
      // arm without full start
      gw.cron.start();
      console.log(`Created ${job.id}`);
      await sleep(200);
      gw.cron.stop();
      return;
    }

    if (act === "remove") {
      const id = args[0];
      if (!id) {
        console.error("Usage: disk-agent cron remove <id>");
        process.exit(1);
      }
      console.log(gw.cron.remove(id) ? "Removed" : "Not found");
      return;
    }

    if (act === "run") {
      const id = args[0];
      if (!id) {
        console.error("Usage: disk-agent cron run <id>");
        process.exit(1);
      }
      gw.cron.setRunner((job) => gw.runCronJob(job));
      await gw.cron.runNow(id);
      console.log("Done");
      return;
    }

    console.error(`Unknown action ${act}`);
    process.exit(1);
  });

program
  .command("memory")
  .description("Inspect or write memory")
  .option("--data-dir <path>", "Override data directory")
  .argument("[action]", "list | search | save", "list")
  .argument("[args...]", "query or fact text")
  .action(async (action: string, args: string[], opts) => {
    const cfg = loadCfg(opts);
    const gw = new Gateway(cfg);
    const act = (action || "list").toLowerCase();
    if (act === "list") {
      for (const f of gw.memory.listFacts().slice(0, 50)) {
        console.log(`${f.id} [${f.kind}] ${f.content}`);
      }
      return;
    }
    if (act === "search") {
      const q = args.join(" ");
      for (const f of gw.memory.search(q)) {
        console.log(`${f.id} [${f.kind}] ${f.content}`);
      }
      return;
    }
    if (act === "save") {
      const content = args.join(" ");
      if (!content) {
        console.error("Usage: disk-agent memory save <fact>");
        process.exit(1);
      }
      const e = gw.memory.saveFact({ content });
      console.log(`Saved ${e.id}`);
      return;
    }
    console.error(`Unknown action ${act}`);
    process.exit(1);
  });

program
  .command("sessions")
  .description("List, show history of, or resume conversation sessions")
  .option("--data-dir <path>", "Override data directory")
  .option("--workspace <path>", "Override workspace directory")
  .argument(
    "[action]",
    "list | history | resume | files  (default: list)",
    "list",
  )
  .argument("[idOrKey]", "For history: peer key. For resume: session id or .jsonl path")
  .option("--key <peer>", "Peer key when resuming (e.g. cli:local, telegram:123)")
  .option("--limit <n>", "Max rows to print", "40")
  .action(async (action: string, idOrKey: string | undefined, opts) => {
    const cfg = loadCfg(opts);
    const sessions = new SessionRegistry(cfg);
    const act = (action || "list").toLowerCase();
    const limit = Math.max(1, Number(opts.limit) || 40);

    if (act === "list" || act === "ls") {
      const rows = sessions.list().slice(0, limit);
      if (!rows.length) {
        console.log("No sessions.");
        return;
      }
      for (const s of rows) {
        const archived = s.history?.length ? `  archived=${s.history.length}` : "";
        console.log(
          `${s.key}  msgs=${s.messageCount}  updated=${s.updatedAt}  id=${s.sessionId}${archived}`,
        );
      }
      console.log("");
      console.log(
        chalk.dim(
          "Previous transcripts: disk-agent sessions history [key]\n" +
            "Resume one:          disk-agent sessions resume <id>\n" +
            "Chat with resume:    disk-agent chat --resume <id>",
        ),
      );
      return;
    }

    if (act === "history" || act === "prev" || act === "previous") {
      const key = idOrKey;
      const rows = sessions.listHistory(key).slice(0, limit);
      if (!rows.length) {
        console.log(
          key
            ? `No archived sessions for ${key}.`
            : "No archived sessions. They appear after /new or sessions reset.",
        );
        return;
      }
      for (const s of rows) {
        console.log(
          `${s.sessionId}  ${s.key}  msgs=${s.messageCount}  archived=${s.archivedAt ?? s.updatedAt}` +
            (s.sessionFile ? `\n  ${s.sessionFile}` : ""),
        );
      }
      return;
    }

    if (act === "resume") {
      const id = idOrKey;
      if (!id) {
        console.error("Usage: disk-agent sessions resume <session-id|path> [--key peer]");
        process.exitCode = 1;
        return;
      }
      // Prefer registry-only resume when no gateway is running; still drop in-process cache if we spin one up
      const result = sessions.resumeById(id, opts.key);
      if (!result.ok) {
        console.error(chalk.red(result.error));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green(`Resumed ${result.rec.key}`));
      console.log(`  id:   ${result.rec.sessionId}`);
      if (result.rec.sessionFile) console.log(`  file: ${result.rec.sessionFile}`);
      if (result.rec.key === "cli:local") {
        console.log(chalk.dim("Continue with: disk-agent chat"));
      } else {
        console.log(
          chalk.dim(
            "Next message on that peer will use this transcript. If the gateway is running, restart is not required.",
          ),
        );
      }
      return;
    }

    if (act === "files" || act === "transcripts") {
      const files = sessions.listTranscriptFiles().slice(0, limit);
      if (!files.length) {
        console.log("No transcript files under pi-sessions/.");
        return;
      }
      for (const f of files) {
        const known = sessions.find(f.sessionId);
        const tag = known.length
          ? known.map((k) => `${k.key}${k.active ? "*" : ""}`).join(",")
          : "(orphan)";
        console.log(`${f.sessionId}  ${f.mtime}  ${tag}\n  ${f.path}`);
      }
      return;
    }

    console.error(`Unknown action ${act}. Use: list | history | resume | files`);
    process.exitCode = 1;
  });

program
  .command("skills")
  .description("List, show, create, or delete agent skills")
  .option("--data-dir <path>", "Override data directory")
  .argument("[action]", "list | show | create | delete | paths", "list")
  .argument("[args...]", "name / fields")
  .action(async (action: string, args: string[], opts) => {
    const cfg = loadCfg(opts);
    const gw = new Gateway(cfg);
    const act = (action || "list").toLowerCase();

    if (act === "list" || act === "ls") {
      const skills = gw.skills.list();
      if (!skills.length) {
        console.log("No skills found.");
        return;
      }
      for (const s of skills) {
        console.log(`${s.name.padEnd(22)} [${s.source}]  ${s.description.slice(0, 80)}`);
      }
      return;
    }

    if (act === "paths") {
      for (const p of gw.skills.discoveryPaths()) console.log(p);
      return;
    }

    if (act === "show" || act === "cat") {
      const name = args[0];
      if (!name) {
        console.error("Usage: disk-agent skills show <name>");
        process.exit(1);
      }
      const body = gw.skills.readBody(name);
      if (!body) {
        console.error(`Not found: ${name}`);
        process.exit(1);
      }
      console.log(body);
      return;
    }

    if (act === "create") {
      // disk-agent skills create <name> <description> <body...>
      const [name, description, ...bodyParts] = args;
      if (!name || !description || !bodyParts.length) {
        console.error(
          "Usage: disk-agent skills create <name> <description> <body markdown...>",
        );
        process.exit(1);
      }
      const r = gw.skills.create({
        name,
        description,
        body: bodyParts.join(" "),
        scope: "workspace",
      });
      if (!r.ok) {
        console.error(r.error);
        process.exit(1);
      }
      console.log(`Created ${r.skill.path}`);
      return;
    }

    if (act === "delete" || act === "rm") {
      const name = args[0];
      if (!name) {
        console.error("Usage: disk-agent skills delete <name>");
        process.exit(1);
      }
      const r = gw.skills.delete(name);
      console.log(r.ok ? `Deleted ${r.path}` : r.error);
      return;
    }

    console.error(`Unknown action ${act}`);
    process.exit(1);
  });

program
  .command("status")
  .description("Show configuration and runtime status")
  .option("--data-dir <path>", "Override data directory")
  .action(async (opts) => {
    const cfg = loadCfg(opts);
    const gw = new Gateway(cfg);
    console.log(chalk.bold(`${cfg.agentName}  v${VERSION}`));
    console.log(`data:      ${cfg.dataDir}`);
    console.log(`workspace: ${cfg.workspaceDir}`);
    console.log(`cwd:       ${cfg.cwd}`);
    console.log(`model:     ${cfg.model.provider}/${cfg.model.id}`);
    console.log(
      `telegram:  ${cfg.telegram.enabled ? "enabled" : "disabled"} policy=${cfg.telegram.dmPolicy}`,
    );
    console.log(`owner:     ${cfg.telegram.ownerId ?? "(none)"}`);
    console.log(`sessions:  ${gw.sessions.list().length}`);
    console.log(`cron:      ${gw.cron.list().length} jobs`);
    console.log(`memory:    ${gw.memory.listFacts().length} facts`);
    console.log(`skills:    ${gw.skills.list().length}`);
    try {
      await gw.agent.ensureReady();
      const models = await gw.agent.listModels();
      const sg = models.filter((m) => m.provider === "supergrok");
      const authOk = models.some((m) => m.auth);
      console.log(
        `supergrok: ${sg.length ? `${sg.length} models` : "not loaded"}` +
          (sg.some((m) => m.auth) ? chalk.green(" (auth ok)") : chalk.yellow(" (login needed)")),
      );
      console.log(
        `auth any:  ${authOk ? chalk.green("yes") : chalk.yellow("no — run disk-agent login or set XAI_API_KEY")}`,
      );
    } catch (err) {
      console.log(chalk.red(`pi/auth:   ${err instanceof Error ? err.message : String(err)}`));
    }
    const pending = gw.telegram.listPendingPairings();
    if (pending.length) {
      console.log(chalk.yellow(`pending pairings: ${pending.map((p) => p.code).join(", ")}`));
    }
  });

program
  .command("models")
  .description("List SuperGrok / xAI / other models available to the agent")
  .option("--data-dir <path>", "Override data directory")
  .action(async (opts) => {
    const cfg = loadCfg(opts);
    const gw = new Gateway(cfg);
    await gw.agent.ensureReady();
    const models = await gw.agent.listModels();
    if (!models.length) {
      console.log("No models found. Run: disk-agent setup   (or disk-agent login)");
      process.exitCode = 1;
      return;
    }
    for (const m of models) {
      const flag = m.auth ? chalk.green("auth") : chalk.dim("no-auth");
      console.log(`${m.provider}/${m.id}  [${flag}]`);
    }
    console.log("");
    console.log(`Default: ${cfg.model.provider}/${cfg.model.id}`);
    console.log("Override: DISK_AGENT_MODEL=supergrok/grok-4.5");
  });

program.parse();

function loadCfg(opts: { dataDir?: string; workspace?: string }): AppConfig {
  // Ensure home exists
  bootstrapHome({ dataDir: opts.dataDir, workspaceDir: opts.workspace });
  return loadConfig({ dataDir: opts.dataDir, workspaceDir: opts.workspace });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
