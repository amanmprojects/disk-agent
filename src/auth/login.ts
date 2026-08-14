/**
 * CLI OAuth / API-key login against Pi's ModelRuntime (shared ~/.pi/agent/auth.json).
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { getSharedModelRuntime } from "../agent/pi.js";

export type LoginProvider = string;

/** Minimal auth interaction shape compatible with Pi ModelRuntime.login. */
interface CliAuthPrompt {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
}

interface CliAuthEvent {
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  links?: readonly { url: string; label?: string }[];
}

function openBrowser(url: string): void {
  const p = platform();
  try {
    if (p === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (p === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* user can open manually */
  }
}

function createCliInteraction(rl: ReturnType<typeof createInterface>) {
  return {
    async prompt(prompt: CliAuthPrompt): Promise<string> {
      if (prompt.type === "select" && prompt.options?.length) {
        console.log(chalk.bold(prompt.message));
        for (const opt of prompt.options) {
          console.log(
            `  ${chalk.cyan(opt.id)}  ${opt.label}${opt.description ? chalk.dim(` — ${opt.description}`) : ""}`,
          );
        }
        const answer = (await rl.question(chalk.bold("choice> "))).trim();
        if (!answer) return prompt.options[0]?.id ?? "";
        return answer;
      }

      const label =
        prompt.type === "secret"
          ? `${prompt.message} (paste carefully — terminal may echo)`
          : prompt.message;
      const suffix = prompt.placeholder ? chalk.dim(` [${prompt.placeholder}]`) : "";
      const answer = (await rl.question(`${label}${suffix}: `)).trim();
      return answer || prompt.placeholder || "";
    },
    notify(event: CliAuthEvent): void {
      if (event.type === "auth_url" && event.url) {
        console.log("");
        console.log(chalk.green("Open this URL to authenticate:"));
        console.log(chalk.underline(event.url));
        if (event.instructions) console.log(chalk.dim(event.instructions));
        openBrowser(event.url);
        console.log(chalk.dim("Waiting for browser callback…"));
        console.log("");
        return;
      }
      if (event.type === "device_code" && event.userCode && event.verificationUri) {
        console.log("");
        console.log(chalk.green("Device code authentication:"));
        console.log(`  Code: ${chalk.bold(event.userCode)}`);
        console.log(`  URL:  ${chalk.underline(event.verificationUri)}`);
        openBrowser(event.verificationUri);
        console.log(chalk.dim("Waiting for confirmation…"));
        console.log("");
        return;
      }
      if (event.type === "info" && event.message) {
        console.log(chalk.cyan(event.message));
        if (event.links?.length) {
          for (const link of event.links) {
            console.log(`  ${link.label ?? "link"}: ${chalk.underline(link.url)}`);
          }
        }
        return;
      }
      if (event.type === "progress" && event.message) {
        console.log(chalk.dim(event.message));
      }
    },
  };
}

/**
 * Run OAuth (or API-key) login for a provider. Tokens land in ~/.pi/agent/auth.json.
 */
export async function loginProvider(
  provider: LoginProvider = "opencode-go",
  opts?: { type?: "oauth" | "api_key"; force?: boolean },
): Promise<{ ok: true; provider: string } | { ok: false; error: string }> {
  const type = opts?.type ?? "oauth";

  const rt = await getSharedModelRuntime();

  if (!opts?.force && rt.hasConfiguredAuth(provider) && type === "oauth") {
    console.log(chalk.green(`✓ Already logged in to ${provider}`));
    return { ok: true, provider };
  }

  if (!rt.getProvider(provider) && !rt.getRegisteredProviderIds().includes(provider)) {
    return {
      ok: false,
      error: [
        `Provider "${provider}" is not registered.`,
        provider === "opencode-go" || provider === "opencode"
          ? "OpenCode Go/Zen is built into pi — set OPENCODE_API_KEY or run: disk-agent login opencode-go --type api_key"
          : `Available: ${rt.getRegisteredProviderIds().join(", ") || "(none)"}`,
      ].join("\n"),
    };
  }

  const rl = createInterface({ input, output });
  try {
    console.log(chalk.bold(`Logging in to ${provider} (${type})…`));
    // ModelRuntime.login expects AuthInteraction from pi-ai; our object is structurally compatible.
    await rt.login(provider, type, createCliInteraction(rl) as never);
    console.log(chalk.green(`✓ Logged in to ${provider}`));
    console.log(chalk.dim("Credentials stored in ~/.pi/agent/auth.json (shared with pi)"));
    return { ok: true, provider };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cancel/i.test(msg)) {
      return { ok: false, error: "Login cancelled" };
    }
    return { ok: false, error: msg };
  } finally {
    rl.close();
  }
}

/** True if any useful provider has auth configured. */
export async function hasAnyAuth(): Promise<boolean> {
  try {
    const rt = await getSharedModelRuntime();
    for (const id of rt.getRegisteredProviderIds()) {
      if (rt.hasConfiguredAuth(id)) return true;
    }
    if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function authStatus(): Promise<{
  providers: Array<{ id: string; auth: boolean }>;
  any: boolean;
}> {
  const rt = await getSharedModelRuntime();
  const providers = rt.getRegisteredProviderIds().map((id) => ({
    id,
    auth: rt.hasConfiguredAuth(id),
  }));
  return {
    providers,
    any: providers.some((p) => p.auth) || Boolean(process.env.OPENAI_API_KEY),
  };
}
