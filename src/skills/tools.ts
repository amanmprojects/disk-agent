import { spawn } from "node:child_process";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SkillsStore, SkillScope } from "./store.js";

export function createSkillTools(store: SkillsStore) {
  const skill_list = defineTool({
    name: "skill_list",
    label: "Skill List",
    description:
      "List installed agent skills (name, source, description). Use before create/find to see what's available.",
    parameters: Type.Object({}),
    async execute() {
      const skills = store.list();
      if (!skills.length) {
        return {
          content: [{ type: "text" as const, text: "No skills installed." }],
          details: { skills },
        };
      }
      const text = skills
        .map((s) => `- ${s.name} [${s.source}] — ${s.description}\n  ${s.path}`)
        .join("\n");
      return { content: [{ type: "text" as const, text }], details: { skills } };
    },
  });

  const skill_load = defineTool({
    name: "skill_load",
    label: "Skill Load",
    description:
      "Read the full SKILL.md for an installed skill by name. Call this when a skill matches the user's task, then follow its instructions.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name, e.g. create-skill or find-skills" }),
    }),
    async execute(_id, params) {
      const body = store.readBody(params.name);
      if (!body) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Skill not found: ${params.name}. Use skill_list or skill_find.`,
            },
          ],
          details: { ok: false, path: "" },
        };
      }
      const info = store.get(params.name);
      return {
        content: [
          {
            type: "text" as const,
            text: `# Skill: ${params.name}\nPath: ${info?.path}\n\n${body}`,
          },
        ],
        details: { ok: true, path: info?.path ?? "" },
      };
    },
  });

  const skill_create = defineTool({
    name: "skill_create",
    label: "Skill Create",
    description:
      "Create a new skill package (SKILL.md). Use when the user wants to save a reusable workflow. Keep body under ~200 lines; put detail in references via write tool after.",
    parameters: Type.Object({
      name: Type.String({ description: "lowercase-hyphen name, e.g. pr-review" }),
      description: Type.String({
        description: "What it does + trigger phrases (shown in skill catalog)",
      }),
      body: Type.String({
        description: "Markdown instructions WITHOUT yaml frontmatter",
      }),
      scope: Type.Optional(
        Type.Union([
          Type.Literal("workspace"),
          Type.Literal("project"),
          Type.Literal("user"),
        ]),
      ),
      force: Type.Optional(Type.Boolean({ description: "Overwrite if exists" })),
    }),
    async execute(_id, params) {
      const result = store.create({
        name: params.name,
        description: params.description,
        body: params.body,
        scope: (params.scope as SkillScope) || "workspace",
        force: params.force,
      });
      const details = result.ok
        ? {
            ok: true,
            error: "",
            path: result.skill.path,
            name: result.skill.name,
          }
        : {
            ok: false,
            error: result.error,
            path: "",
            name: params.name,
          };
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? `Created skill **${result.skill.name}** at ${result.skill.path}\nScope: ${result.skill.source}\nInvoke via natural language or /skills use ${result.skill.name}`
              : `Error: ${result.error}`,
          },
        ],
        details,
      };
    },
  });

  const skill_delete = defineTool({
    name: "skill_delete",
    label: "Skill Delete",
    description: "Delete a skill package by name from workspace/project/user scopes.",
    parameters: Type.Object({
      name: Type.String(),
      scope: Type.Optional(
        Type.Union([
          Type.Literal("workspace"),
          Type.Literal("project"),
          Type.Literal("user"),
        ]),
      ),
    }),
    async execute(_id, params) {
      const result = store.delete(params.name, params.scope as SkillScope | undefined);
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? `Deleted skill ${params.name} (${result.path})`
              : `Error: ${result.error}`,
          },
        ],
        details: result,
      };
    },
  });

  const skill_find = defineTool({
    name: "skill_find",
    label: "Skill Find",
    description:
      "Search the open skills ecosystem (skills.sh via npx skills find). Use when the user wants a community skill for a task.",
    parameters: Type.Object({
      query: Type.String({ description: "Search keywords, e.g. react performance" }),
    }),
    async execute(_id, params) {
      const result = await runSkillsCli(["find", params.query], 60_000);
      const text =
        result.stdout.trim() ||
        result.stderr.trim() ||
        (result.code === 0 ? "No output." : `find failed (exit ${result.code})`);
      return {
        content: [
          {
            type: "text" as const,
            text:
              text +
              "\n\nBrowse: https://skills.sh/\nInstall with skill_install or: npx skills add <owner/repo@skill> -y",
          },
        ],
        details: result,
      };
    },
  });

  const skill_install = defineTool({
    name: "skill_install",
    label: "Skill Install",
    description:
      "Install a skill from the ecosystem using npx skills add. Example package: vercel-labs/agent-skills@react-best-practices or a github URL.",
    parameters: Type.Object({
      package: Type.String({
        description: "Package spec: owner/repo@skill or https://github.com/...",
      }),
      skill: Type.Optional(
        Type.String({ description: "Skill name when installing from a repo URL" }),
      ),
      global: Type.Optional(
        Type.Boolean({ description: "Install with -g (user-level). Default false (project)." }),
      ),
    }),
    async execute(_id, params) {
      const args = ["add", params.package, "-y"];
      if (params.skill) args.push("--skill", params.skill);
      if (params.global) args.push("-g");
      const result = await runSkillsCli(args, 120_000);
      const text =
        (result.stdout + "\n" + result.stderr).trim() ||
        (result.code === 0 ? "Installed." : `install failed (exit ${result.code})`);
      return {
        content: [
          {
            type: "text" as const,
            text:
              text +
              "\n\nRun skill_list to verify. New skills load on the next agent turn.",
          },
        ],
        details: result,
      };
    },
  });

  return [skill_list, skill_load, skill_create, skill_delete, skill_find, skill_install];
}

export const SKILL_TOOL_NAMES = [
  "skill_list",
  "skill_load",
  "skill_create",
  "skill_delete",
  "skill_find",
  "skill_install",
] as const;

function runSkillsCli(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["--yes", "skills", ...args], {
      env: { ...process.env, npm_config_yes: "true" },
      cwd: process.cwd(),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: 124, stdout, stderr: stderr + "\n(timeout)" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
