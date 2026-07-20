import { Cron } from "croner";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { CronJob, CronSchedule, IncomingMessage } from "../types.js";
import { inQuietHours, nowIso, readJson, uid, writeJson } from "../utils.js";

export type CronRunner = (job: CronJob) => Promise<void>;

/**
 * Built-in scheduler (Hermes/OpenClaw style).
 * Jobs persist to dataDir/cron/jobs.json and can deliver results to Telegram.
 */
export class CronScheduler {
  private cfg: AppConfig;
  private log: Logger;
  private jobsPath: string;
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, Cron | NodeJS.Timeout>();
  private runner?: CronRunner;
  private heartbeatTimer?: NodeJS.Timeout;
  private running = false;

  constructor(cfg: AppConfig, log: Logger) {
    this.cfg = cfg;
    this.log = log.child("cron");
    this.jobsPath = join(cfg.dataDir, "cron", "jobs.json");
    this.load();
  }

  setRunner(runner: CronRunner): void {
    this.runner = runner;
  }

  list(): CronJob[] {
    return [...this.jobs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  add(input: {
    name: string;
    schedule: CronSchedule | string;
    prompt: string;
    deliver: CronJob["deliver"];
    enabled?: boolean;
    model?: string;
  }): CronJob {
    const schedule = normalizeSchedule(input.schedule);
    const job: CronJob = {
      id: uid("job"),
      name: input.name,
      enabled: input.enabled ?? true,
      schedule,
      prompt: input.prompt,
      deliver: input.deliver,
      model: input.model,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      runCount: 0,
    };
    this.jobs.set(job.id, job);
    this.persist();
    if (this.running && job.enabled) this.arm(job);
    this.log.info(`added job ${job.name}`, { id: job.id, schedule: job.schedule });
    return job;
  }

  update(id: string, patch: Partial<Pick<CronJob, "name" | "prompt" | "enabled" | "schedule" | "deliver" | "model">>): CronJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (patch.name !== undefined) job.name = patch.name;
    if (patch.prompt !== undefined) job.prompt = patch.prompt;
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    if (patch.deliver !== undefined) job.deliver = patch.deliver;
    if (patch.model !== undefined) job.model = patch.model;
    if (patch.schedule !== undefined) job.schedule = normalizeSchedule(patch.schedule as CronSchedule | string);
    job.updatedAt = nowIso();
    this.jobs.set(id, job);
    this.persist();
    this.disarm(id);
    if (this.running && job.enabled) this.arm(job);
    return job;
  }

  remove(id: string): boolean {
    const ok = this.jobs.delete(id);
    this.disarm(id);
    if (ok) this.persist();
    return ok;
  }

  start(): void {
    if (!this.cfg.cron.enabled) {
      this.log.info("cron disabled in config");
      return;
    }
    this.running = true;
    for (const job of this.jobs.values()) {
      if (job.enabled) this.arm(job);
    }
    if (this.cfg.cron.heartbeat.enabled) {
      const ms = Math.max(1, this.cfg.cron.heartbeat.everyMinutes) * 60_000;
      this.heartbeatTimer = setInterval(() => void this.runHeartbeat(), ms);
      // don't keep process alive solely for heartbeat unref? keep it — gateway should stay up
      this.log.info(`heartbeat every ${this.cfg.cron.heartbeat.everyMinutes}m`);
    }
    this.log.info(`scheduler started with ${this.jobs.size} jobs`);
  }

  stop(): void {
    this.running = false;
    for (const id of [...this.timers.keys()]) this.disarm(id);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.log.info("scheduler stopped");
  }

  async runNow(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job ${id}`);
    await this.execute(job);
  }

  private load(): void {
    const list = readJson<CronJob[]>(this.jobsPath, []);
    for (const j of list) this.jobs.set(j.id, j);
  }

  private persist(): void {
    writeJson(this.jobsPath, this.list());
  }

  private arm(job: CronJob): void {
    this.disarm(job.id);
    const sched = job.schedule;
    if (sched.kind === "cron") {
      const c = new Cron(
        sched.expr,
        {
          timezone: sched.timezone,
          protect: true,
        },
        () => void this.execute(job),
      );
      this.timers.set(job.id, c);
      job.nextRunAt = c.nextRun()?.toISOString();
      this.persist();
    } else if (sched.kind === "every") {
      const t = setInterval(() => void this.execute(job), Math.max(5_000, sched.everyMs));
      this.timers.set(job.id, t);
      job.nextRunAt = new Date(Date.now() + sched.everyMs).toISOString();
      this.persist();
    } else if (sched.kind === "at") {
      const when = new Date(sched.at).getTime() - Date.now();
      if (when <= 0) {
        void this.execute(job).then(() => {
          job.enabled = false;
          this.persist();
        });
        return;
      }
      const t = setTimeout(() => {
        void this.execute(job).then(() => {
          job.enabled = false;
          this.disarm(job.id);
          this.persist();
        });
      }, when);
      this.timers.set(job.id, t);
      job.nextRunAt = new Date(sched.at).toISOString();
      this.persist();
    }
  }

  private disarm(id: string): void {
    const t = this.timers.get(id);
    if (!t) return;
    if (typeof t === "object" && t && "stop" in t && typeof (t as Cron).stop === "function") {
      (t as Cron).stop();
    } else {
      clearInterval(t as NodeJS.Timeout);
      clearTimeout(t as NodeJS.Timeout);
    }
    this.timers.delete(id);
  }

  private async execute(job: CronJob): Promise<void> {
    if (!this.runner) {
      this.log.warn("no runner set; skip", { id: job.id });
      return;
    }
    this.log.info(`running job ${job.name}`, { id: job.id });
    try {
      await this.runner(job);
      job.lastRunAt = nowIso();
      job.lastStatus = "ok";
      job.lastError = undefined;
      job.runCount += 1;
      this.jobs.set(job.id, job);
      this.persist();
    } catch (err) {
      job.lastRunAt = nowIso();
      job.lastStatus = "error";
      job.lastError = err instanceof Error ? err.message : String(err);
      job.runCount += 1;
      this.jobs.set(job.id, job);
      this.persist();
      this.log.error(`job failed ${job.name}`, { error: job.lastError });
    }
  }

  private async runHeartbeat(): Promise<void> {
    const q = this.cfg.cron.heartbeat.quietHours;
    if (inQuietHours(q.start, q.end)) {
      this.log.debug("heartbeat skipped (quiet hours)");
      return;
    }
    const synthetic: CronJob = {
      id: "heartbeat",
      name: "heartbeat",
      enabled: true,
      schedule: { kind: "every", everyMs: this.cfg.cron.heartbeat.everyMinutes * 60_000 },
      prompt:
        "This is a HEARTBEAT turn. Read HEARTBEAT.md in the workspace and perform the checklist. " +
        "If nothing needs the user's attention, reply with exactly HEARTBEAT_OK and nothing else.",
      deliver: {
        channel: "telegram",
        peerId: this.cfg.telegram.ownerId ? `telegram:${this.cfg.telegram.ownerId}` : "system:heartbeat",
        chatId: this.cfg.telegram.ownerId,
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
      runCount: 0,
    };
    if (!this.cfg.telegram.ownerId) {
      this.log.debug("heartbeat: no ownerId configured, running without delivery");
      synthetic.deliver = { channel: "system", peerId: "system:heartbeat" };
    }
    await this.execute(synthetic);
  }
}

export function normalizeSchedule(input: CronSchedule | string): CronSchedule {
  if (typeof input !== "string") return input;
  const s = input.trim();

  // every: 30m / 1h / 15s
  const everyMatch = s.match(/^every[:\s]+(\d+)\s*(ms|s|m|h|d)$/i);
  if (everyMatch) {
    const n = Number(everyMatch[1]);
    const u = everyMatch[2]!.toLowerCase();
    const mult = u === "ms" ? 1 : u === "s" ? 1000 : u === "m" ? 60_000 : u === "h" ? 3_600_000 : 86_400_000;
    return { kind: "every", everyMs: n * mult };
  }

  // at: ISO timestamp
  if (/^\d{4}-\d{2}-\d{2}/.test(s) || s.startsWith("at:")) {
    const at = s.replace(/^at:\s*/i, "");
    return { kind: "at", at: new Date(at).toISOString() };
  }

  // natural-ish shortcuts
  const lower = s.toLowerCase();
  if (lower === "hourly") return { kind: "cron", expr: "0 * * * *" };
  if (lower === "daily" || lower === "every day") return { kind: "cron", expr: "0 9 * * *" };
  if (lower === "weekly") return { kind: "cron", expr: "0 9 * * 1" };
  if (lower.startsWith("daily at ")) {
    const hm = lower.replace("daily at ", "").trim();
    const [h, m] = hm.split(":").map(Number);
    return { kind: "cron", expr: `${m || 0} ${h || 9} * * *` };
  }

  // assume cron expression
  return { kind: "cron", expr: s };
}

export function describeSchedule(s: CronSchedule): string {
  if (s.kind === "cron") return `cron: ${s.expr}${s.timezone ? ` (${s.timezone})` : ""}`;
  if (s.kind === "every") return `every ${s.everyMs}ms`;
  return `at ${s.at}`;
}

export function cronJobToIncoming(job: CronJob): IncomingMessage {
  return {
    id: uid("cronmsg"),
    channel: "cron",
    peerId: `cron:${job.id}`,
    senderName: `cron:${job.name}`,
    text: job.prompt,
    timestamp: nowIso(),
    metadata: { jobId: job.id, jobName: job.name, deliver: job.deliver },
  };
}
