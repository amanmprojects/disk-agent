import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { AppConfig } from "../config.js";
import { ensureDir, nowIso } from "../utils.js";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  baseDir: string;
  source: string;
  disableModelInvocation?: boolean;
}

export type SkillScope = "workspace" | "project" | "user";

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Disk-agent skills catalog.
 * Discovers SKILL.md packages from workspace, project, user, and pi locations.
 */
export class SkillsStore {
  readonly workspaceSkillsDir: string;
  readonly projectSkillsDir: string;
  readonly userSkillsDir: string;
  readonly cwd: string;

  constructor(cfg: AppConfig) {
    this.cwd = cfg.cwd;
    this.workspaceSkillsDir = join(cfg.workspaceDir, "skills");
    this.projectSkillsDir = join(cfg.cwd, ".agents", "skills");
    this.userSkillsDir = join(homedir(), ".agents", "skills");
    ensureDir(this.workspaceSkillsDir);
  }

  /** All directories Pi + disk-agent should scan for skills. */
  discoveryPaths(): string[] {
    const paths = [
      this.workspaceSkillsDir,
      this.projectSkillsDir,
      this.userSkillsDir,
      join(homedir(), ".pi", "agent", "skills"),
      join(this.cwd, ".pi", "skills"),
      join(this.cwd, ".agents", "skills"),
    ];
    // unique existing
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of paths) {
      const abs = resolve(p);
      if (seen.has(abs)) continue;
      seen.add(abs);
      if (existsSync(abs)) out.push(abs);
    }
    return out;
  }

  scopeDir(scope: SkillScope): string {
    if (scope === "workspace") return this.workspaceSkillsDir;
    if (scope === "project") return this.projectSkillsDir;
    return this.userSkillsDir;
  }

  list(): SkillInfo[] {
    const byName = new Map<string, SkillInfo>();
    for (const dir of this.discoveryPaths()) {
      const found = scanSkillsDir(dir, sourceLabel(dir, this));
      for (const s of found) {
        // First wins (workspace preferred because discoveryPaths order)
        if (!byName.has(s.name)) byName.set(s.name, s);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillInfo | undefined {
    return this.list().find((s) => s.name === name);
  }

  readBody(name: string): string | null {
    const s = this.get(name);
    if (!s) return null;
    try {
      return readFileSync(s.path, "utf8");
    } catch {
      return null;
    }
  }

  validateName(name: string): string | null {
    if (!NAME_RE.test(name)) {
      return "Name must be 2–64 chars, lowercase letters/digits/hyphens, start and end alphanumeric.";
    }
    return null;
  }

  create(input: {
    name: string;
    description: string;
    body: string;
    scope?: SkillScope;
    force?: boolean;
  }): { ok: true; skill: SkillInfo } | { ok: false; error: string } {
    const name = input.name.trim().toLowerCase();
    const nameErr = this.validateName(name);
    if (nameErr) return { ok: false, error: nameErr };

    const description = input.description.trim();
    if (description.length < 10) {
      return { ok: false, error: "description must be at least 10 characters (used for auto-discovery)." };
    }
    if (description.length > 1024) {
      return { ok: false, error: "description too long (max 1024)." };
    }

    let body = input.body.trim();
    if (!body) return { ok: false, error: "body is required" };
    // Strip accidental frontmatter from body
    if (body.startsWith("---")) {
      body = body.replace(/^---[\s\S]*?---\s*/, "").trim();
    }

    // Keep under ~200 lines guidance
    const lines = body.split("\n").length;
    if (lines > 250) {
      return {
        ok: false,
        error: `SKILL.md body is ${lines} lines. Keep under ~200; move detail into references/.`,
      };
    }

    const scope = input.scope ?? "workspace";
    const base = join(this.scopeDir(scope), name);
    const skillPath = join(base, "SKILL.md");

    if (existsSync(skillPath) && !input.force) {
      return { ok: false, error: `Skill already exists at ${skillPath}. Pass force=true to overwrite.` };
    }

    ensureDir(base);
    ensureDir(join(base, "references"));
    ensureDir(join(base, "scripts"));

    const content = `---
name: ${name}
description: ${yamlEscape(description)}
---

${body.endsWith("\n") ? body : body + "\n"}`;

    // atomic write
    const tmp = skillPath + `.tmp.${Date.now()}`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, skillPath);

    // drop empty helper dirs if unused
    try {
      if (readdirSync(join(base, "references")).length === 0) {
        /* keep — useful scaffold */
      }
    } catch {
      /* ignore */
    }

    return {
      ok: true,
      skill: {
        name,
        description,
        path: skillPath,
        baseDir: base,
        source: scope,
      },
    };
  }

  delete(name: string, scope?: SkillScope): { ok: boolean; error?: string; path?: string } {
    const n = name.trim().toLowerCase();
    const candidates = scope
      ? [join(this.scopeDir(scope), n)]
      : [
          join(this.workspaceSkillsDir, n),
          join(this.projectSkillsDir, n),
          join(this.userSkillsDir, n),
        ];
    for (const dir of candidates) {
      const skillPath = join(dir, "SKILL.md");
      if (existsSync(skillPath)) {
        rmSync(dir, { recursive: true, force: true });
        return { ok: true, path: dir };
      }
    }
    return { ok: false, error: `Skill not found: ${n}` };
  }

  /** Compact catalog for system prompt / tools */
  catalogText(limit = 40): string {
    const skills = this.list().slice(0, limit);
    if (!skills.length) return "(no skills installed)";
    return skills
      .map((s) => `- **${s.name}** (${s.source}): ${s.description.slice(0, 160)}`)
      .join("\n");
  }
}

function sourceLabel(dir: string, store: SkillsStore): string {
  if (dir === store.workspaceSkillsDir) return "workspace";
  if (dir === store.projectSkillsDir) return "project";
  if (dir === store.userSkillsDir) return "user";
  if (dir.includes("/.pi/agent/skills")) return "pi-global";
  if (dir.includes("/.pi/skills")) return "pi-project";
  return "other";
}

function scanSkillsDir(dir: string, source: string): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const out: SkillInfo[] = [];
  walk(dir, (skillMd, baseDir) => {
    const parsed = parseSkillMd(skillMd);
    if (!parsed) return;
    out.push({
      name: parsed.name,
      description: parsed.description,
      path: skillMd,
      baseDir,
      source,
      disableModelInvocation: parsed.disableModelInvocation,
    });
  });
  return out;
}

function walk(dir: string, onSkill: (skillMd: string, baseDir: string) => void, depth = 0): void {
  if (depth > 6) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const skillMd = join(dir, "SKILL.md");
  if (existsSync(skillMd) && statSync(skillMd).isFile()) {
    onSkill(skillMd, dir);
    return; // don't recurse into skill package
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) walk(p, onSkill, depth + 1);
    } catch {
      /* ignore */
    }
  }
}

function parseSkillMd(path: string): {
  name: string;
  description: string;
  disableModelInvocation?: boolean;
} | null {
  try {
    const raw = readFileSync(path, "utf8");
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) {
      // fallback: directory name
      const name = dirname(path).split("/").pop() || "unnamed";
      return { name, description: `(no description) ${name}` };
    }
    const block = fm[1]!;
    const name = matchField(block, "name") || dirname(path).split("/").pop() || "unnamed";
    const description = matchField(block, "description") || `(no description) ${name}`;
    const disable = matchField(block, "disable-model-invocation");
    return {
      name: name.trim(),
      description: description.trim().replace(/\s+/g, " "),
      disableModelInvocation: disable === "true",
    };
  } catch {
    return null;
  }
}

function matchField(block: string, key: string): string | undefined {
  // Folded/multiline block scalar: key: >\n  line...\n  line...
  const folded = new RegExp(
    `^${key}:\\s*[>|][-+]?\\s*\\n([\\s\\S]*?)(?=\\n[^\\s#]|$)`,
    "mi",
  );
  const fm = block.match(folded);
  if (fm) {
    return fm[1]!
      .split("\n")
      .map((l) => l.replace(/^\s+/, "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  // single line
  const re = new RegExp(`^${key}:\\s*(.+)$`, "mi");
  const m = block.match(re);
  if (!m) return undefined;
  let v = m[1]!.trim();
  if (v === ">" || v === "|" || v.startsWith(">") || v.startsWith("|")) {
    // bare indicator without catching body — try lines after
    const lines = block.split("\n");
    const idx = lines.findIndex((l) => new RegExp(`^${key}:`, "i").test(l));
    if (idx >= 0) {
      const collected: string[] = [];
      for (let i = idx + 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^\S/.test(line) && !/^\s/.test(line)) break;
        if (/^[a-zA-Z0-9_-]+:\s*/.test(line) && !/^\s/.test(line)) break;
        collected.push(line.replace(/^\s+/, "").trim());
      }
      const joined = collected.filter(Boolean).join(" ").trim();
      if (joined) return joined;
    }
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (v === ">" || v === "|") return undefined;
  return v;
}

function yamlEscape(s: string): string {
  // Prefer plain if safe, else double-quoted
  if (/^[A-Za-z0-9 ,._/()+@'%-]+$/.test(s) && !s.includes(": ")) return s;
  return JSON.stringify(s);
}

/** Seed built-in skills into workspace if missing. */
export function seedBuiltinSkills(workspaceDir: string, projectCwd: string): void {
  const workspaceSkills = join(workspaceDir, "skills");
  ensureDir(workspaceSkills);

  writeSkillIfMissing(join(workspaceSkills, "create-skill"), CREATE_SKILL_MD);
  writeSkillIfMissing(join(workspaceSkills, "remember"), REMEMBER_SKILL_MD);

  // find-skills: prefer project .agents copy; also mirror into workspace
  const projectFind = join(projectCwd, ".agents", "skills", "find-skills", "SKILL.md");
  const wsFindDir = join(workspaceSkills, "find-skills");
  if (existsSync(projectFind) && !existsSync(join(wsFindDir, "SKILL.md"))) {
    ensureDir(wsFindDir);
    writeFileSync(join(wsFindDir, "SKILL.md"), readFileSync(projectFind, "utf8"), "utf8");
  } else {
    writeSkillIfMissing(wsFindDir, FIND_SKILLS_MD);
  }
}

function writeSkillIfMissing(dir: string, content: string): void {
  const p = join(dir, "SKILL.md");
  if (existsSync(p)) return;
  ensureDir(dir);
  ensureDir(join(dir, "references"));
  writeFileSync(p, content, "utf8");
}

const CREATE_SKILL_MD = `---
name: create-skill
description: >
  Create a new agent skill (SKILL.md package) for reusable workflows.
  Use when the user wants to create a skill, scaffold a skill, save a repeated
  workflow as a skill, or runs /skills create / create-skill.
---

# Create Skill

Create a focused, reusable skill package the agent can load later.

## Progressive disclosure (critical)

- **SKILL.md body ≤ ~200 lines.** Put deep docs in \`references/\`.
- \`description\` frontmatter drives auto-discovery — include trigger phrases.
- Name: lowercase, digits, hyphens only (\`deploy-k8s\`).

## Workflow

### 1. Gather requirements

Ask only what's missing:

1. **name** — e.g. \`pr-review\`
2. **scope** — \`workspace\` (default, ~/.disk-agent/workspace/skills), \`project\` (.agents/skills), or \`user\` (~/.agents/skills)
3. **what it does** — workflow / repeated prompt / domain steps

### 2. Draft description

1–2 sentences + trigger keywords. Show the user and confirm.

### 3. Write the skill

Prefer the \`skill_create\` tool:

\`\`\`
skill_create(
  name,
  description,
  body,          # markdown instructions WITHOUT frontmatter
  scope="workspace"
)
\`\`\`

Or write files manually:

\`\`\`
<scope-dir>/<name>/SKILL.md
<scope-dir>/<name>/scripts/     # optional
<scope-dir>/<name>/references/  # optional
\`\`\`

### 4. SKILL.md shape

\`\`\`markdown
---
name: my-skill
description: What it does. Use when user says X, Y, or Z.
---

# My Skill

## When to use
...

## Steps
1. ...
2. ...

## Examples
...
\`\`\`

### 5. Confirm

- Tell the user the path and how to invoke (\`/skills use my-skill\` or natural language).
- New skills appear in \`skill_list\` immediately; a fresh session picks them up in the system catalog.
- Do **not** put secrets in skills.

## Quality bar

- Actionable steps the agent can follow with existing tools
- Prefer CLI/tools already available over new scripts
- Link to \`references/\` instead of dumping huge docs into SKILL.md
`;

const REMEMBER_SKILL_MD = `---
name: remember
description: Persist user facts and preferences into MEMORY.md / memory tools. Use when the user says remember that, save this preference, or shares stable personal context.
---

# Remember

When the user says "remember that..." or shares a stable preference:

1. Call \`memory_save\` with a clear, atomic fact.
2. Optionally update USER.md if it is profile-level (name, timezone, stack).
3. Confirm briefly what you stored.
`;

const FIND_SKILLS_MD = `---
name: find-skills
description: >
  Discover and install agent skills from the open ecosystem (skills.sh).
  Use when the user asks how do I do X, find a skill for X, is there a skill,
  or wants to extend capabilities with community skills.
---

# Find Skills

Help users discover and install skills from the open agent skills ecosystem.

## Skills CLI

\`\`\`bash
npx skills find [query]
npx skills add <owner/repo@skill> -y
npx skills add https://github.com/owner/repo --skill <name> -y
npx skills update
\`\`\`

Browse: https://skills.sh/

Or use tools: \`skill_find\` (search) and \`skill_install\` (install).

## Workflow

1. Understand domain + task.
2. Check https://skills.sh/ leaderboard for popular options.
3. Search: \`npx skills find <query>\` or \`skill_find\`.
4. Verify quality (installs, source reputation, stars).
5. Present options with install command + skills.sh link.
6. Install on request with \`skill_install\` or \`npx skills add ... -y\`.

## When nothing is found

Offer to help directly, or create a custom skill with \`create-skill\` / \`skill_create\`.
`;

// touch nowIso for future metadata
void nowIso;
void mkdirSync;
