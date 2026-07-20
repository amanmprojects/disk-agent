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

const VERSION = getVersion();

const program = new Command();

program
  .name("disk-agent")
  .description("OpenClaw/Hermes-style personal AI agent gateway (Pi-powered)")
  .version(VERSION);

program
  .command("setup")
  .description(
    "Interactive setup: home, Telegram, Pi, extensions (supergrok + agent-browser), SuperGrok login",
  )
  .option("--name <name>", "Agent name")
  .option("--data-dir <path>", "Override home directory (~/.disk-agent)")
  .option("--workspace <path>", "Override workspace directory")
  .option("--telegram-token <token>", "Set Telegram bot token (skips prompt)")
  .option("--owner <id>", "Telegram owner user id")
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

program
  .command("gateway")
  .description("Start the long-running gateway (Telegram + cron + agent)")
  .option("--data-dir <path>", "Override data directory")
  .option("--workspace <path>", "Override workspace directory")
  .option("--cwd <path>", "Coding tools working directory")
  .action(async (opts) => {
    const cfg = loadCfg(opts);
    if (opts.cwd) cfg.cwd = opts.cwd;
    const gw = new Gateway(cfg);
    const shutdown = async (sig: string) => {
      console.log(chalk.yellow(`\n${sig} received, shutting down…`));
      await gw.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    await gw.start();
    console.log(chalk.green(`${cfg.agentName} gateway running. Ctrl+C to stop.`));
    // Keep alive
    await new Promise(() => {
      /* never resolves */
    });
  });

program
  .command("chat")
  .description("Interactive CLI chat with the agent (no Telegram required)")
  .option("--data-dir <path>", "Override data directory")
  .option("--workspace <path>", "Override workspace directory")
  .option("--cwd <path>", "Coding tools working directory")
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

    console.log(chalk.cyan(`${cfg.agentName} CLI chat. /exit to quit, /new to reset.`));
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
  .description("List conversation sessions")
  .option("--data-dir <path>", "Override data directory")
  .action((opts) => {
    const cfg = loadCfg(opts);
    const gw = new Gateway(cfg);
    for (const s of gw.sessions.list()) {
      console.log(`${s.key}  msgs=${s.messageCount}  updated=${s.updatedAt}  id=${s.sessionId}`);
    }
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
