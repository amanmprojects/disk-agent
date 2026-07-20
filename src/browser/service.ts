import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { BrowserActionResult } from "../types.js";
import { ensureDir, nowIso, uid } from "../utils.js";
import type { Logger } from "../logger.js";

/**
 * Browser automation via the `agent-browser` CLI when available,
 * with a graceful fallback that uses plain fetch for simple page text.
 *
 * Inspired by Hermes/OpenClaw "full browser & web control".
 */
export class BrowserService {
  private cfg: AppConfig;
  private log: Logger;
  private artifactDir: string;
  private hasCli: boolean | null = null;

  constructor(cfg: AppConfig, log: Logger) {
    this.cfg = cfg;
    this.log = log.child("browser");
    this.artifactDir = join(cfg.dataDir, "browser");
    ensureDir(this.artifactDir);
  }

  async isAvailable(): Promise<boolean> {
    if (!this.cfg.browser.enabled) return false;
    if (this.hasCli !== null) return this.hasCli;
    this.hasCli = await commandExists("agent-browser");
    if (!this.hasCli) {
      this.log.warn("agent-browser CLI not found; using fetch fallback for web_get");
    }
    return this.hasCli;
  }

  private assertDomainAllowed(url: string): void {
    const allowed = this.cfg.browser.allowedDomains;
    if (!allowed.length) return;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    const ok = allowed.some((d) => host === d || host.endsWith(`.${d}`));
    if (!ok) throw new Error(`Domain not allowed by browser.allowedDomains: ${host}`);
  }

  /** Fetch URL text content (works without browser CLI). */
  async get(url: string): Promise<BrowserActionResult> {
    this.assertDomainAllowed(url);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "disk-agent/0.1 (+https://github.com/local/disk-agent)" },
        signal: AbortSignal.timeout(this.cfg.browser.timeoutMs),
      });
      const ct = res.headers.get("content-type") ?? "";
      const body = await res.text();
      let text = body;
      if (ct.includes("html")) {
        text = htmlToText(body).slice(0, 20_000);
      } else {
        text = body.slice(0, 20_000);
      }
      return {
        ok: res.ok,
        message: text,
        url: res.url,
        data: { status: res.status, contentType: ct },
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), url };
    }
  }

  async open(url: string): Promise<BrowserActionResult> {
    this.assertDomainAllowed(url);
    if (!(await this.isAvailable())) {
      return this.get(url);
    }
    const r = await this.runCli(["open", url, "--json"]);
    return r;
  }

  async snapshot(): Promise<BrowserActionResult> {
    if (!(await this.isAvailable())) {
      return { ok: false, message: "agent-browser not installed; cannot snapshot" };
    }
    return this.runCli(["snapshot", "-i", "--json"]);
  }

  async click(selectorOrRef: string): Promise<BrowserActionResult> {
    if (!(await this.isAvailable())) {
      return { ok: false, message: "agent-browser not installed" };
    }
    return this.runCli(["click", selectorOrRef, "--json"]);
  }

  async fill(selectorOrRef: string, text: string): Promise<BrowserActionResult> {
    if (!(await this.isAvailable())) {
      return { ok: false, message: "agent-browser not installed" };
    }
    return this.runCli(["fill", selectorOrRef, text, "--json"]);
  }

  async screenshot(name?: string): Promise<BrowserActionResult> {
    if (!(await this.isAvailable())) {
      return { ok: false, message: "agent-browser not installed" };
    }
    const file = join(this.artifactDir, `${name ?? uid("shot")}.png`);
    const r = await this.runCli(["screenshot", file, "--json"]);
    if (r.ok) r.screenshotPath = file;
    return r;
  }

  async eval(js: string): Promise<BrowserActionResult> {
    if (!(await this.isAvailable())) {
      return { ok: false, message: "agent-browser not installed" };
    }
    return this.runCli(["eval", js, "--json"]);
  }

  async close(): Promise<BrowserActionResult> {
    if (!(await this.isAvailable())) {
      return { ok: true, message: "no browser session" };
    }
    return this.runCli(["close", "--json"]);
  }

  private runCli(args: string[]): Promise<BrowserActionResult> {
    return new Promise((resolve) => {
      // Prefer absolute path so gateway process PATH quirks don't hide the CLI.
      const bin = resolveBrowserBin();
      this.log.debug(`browser cli: ${bin} ${args.join(" ")}`);
      const child: ChildProcessWithoutNullStreams = spawn(bin, args, {
        env: {
          ...process.env,
          // headless default; set browser.headless=false to show a window
          AGENT_BROWSER_HEADED: this.cfg.browser.headless ? "0" : "1",
        },
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ ok: false, message: `browser timed out after ${this.cfg.browser.timeoutMs}ms` });
      }, this.cfg.browser.timeoutMs);

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, message: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const out = stdout.trim();
        const err = stderr.trim();
        if (code === 0) {
          try {
            // Some CLIs emit a JSON object; others emit NDJSON / text.
            const jsonLine = out
              .split("\n")
              .map((l) => l.trim())
              .reverse()
              .find((l) => l.startsWith("{") || l.startsWith("["));
            if (jsonLine) {
              const data = JSON.parse(jsonLine);
              const message =
                typeof data === "string"
                  ? data
                  : typeof data?.data === "string"
                    ? data.data
                    : typeof data?.result === "string"
                      ? data.result
                      : JSON.stringify(data, null, 0).slice(0, 15_000);
              resolve({ ok: true, message, data, url: data?.url });
              return;
            }
            resolve({ ok: true, message: (out || "ok").slice(0, 15_000) });
          } catch {
            resolve({ ok: true, message: (out || "ok").slice(0, 15_000) });
          }
        } else {
          resolve({
            ok: false,
            message: (err || out || `exit ${code}`).slice(0, 8_000),
          });
        }
      });
    });
  }
}

function resolveBrowserBin(): string {
  const home = process.env.HOME || "";
  const candidates = [
    process.env.AGENT_BROWSER_BIN,
    join(home, ".nvm/versions/node/v24.14.0/bin/agent-browser"),
    "/home/aman/.nvm/versions/node/v24.14.0/bin/agent-browser",
    "agent-browser",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c === "agent-browser") return c;
    if (existsSync(c)) return c;
  }
  return "agent-browser";
}

function commandExists(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Check PATH and known install locations
    if (bin === "agent-browser") {
      const resolved = resolveBrowserBin();
      if (resolved !== "agent-browser" && existsSync(resolved)) {
        resolve(true);
        return;
      }
    }
    const child = spawn("which", [bin]);
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// silence unused import in some builds
void existsSync;
void nowIso;
