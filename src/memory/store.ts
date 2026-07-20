import { join } from "node:path";
import type { AppConfig } from "../config.js";
import {
  appendText,
  ensureDir,
  keywordScore,
  listFiles,
  nowIso,
  readJson,
  readText,
  todayStamp,
  uid,
  writeJson,
  writeText,
} from "../utils.js";
import type { MemoryEntry } from "../types.js";

/**
 * OpenClaw/Hermes-style memory:
 * - Workspace markdown: SOUL.md, USER.md, MEMORY.md, memory/YYYY-MM-DD.md
 * - Structured fact store: dataDir/memory/facts.json (searchable)
 */
export class MemoryStore {
  readonly workspaceDir: string;
  readonly factsPath: string;
  private maxFacts: number;

  constructor(cfg: AppConfig) {
    this.workspaceDir = cfg.workspaceDir;
    this.factsPath = join(cfg.dataDir, "memory", "facts.json");
    this.maxFacts = cfg.memory.maxFacts;
    ensureDir(join(cfg.dataDir, "memory"));
    ensureDir(join(this.workspaceDir, "memory"));
  }

  // ── Structured facts ──────────────────────────────────────────

  listFacts(): MemoryEntry[] {
    return readJson<MemoryEntry[]>(this.factsPath, []);
  }

  saveFact(input: {
    content: string;
    kind?: MemoryEntry["kind"];
    tags?: string[];
    source?: string;
  }): MemoryEntry {
    const facts = this.listFacts();
    const entry: MemoryEntry = {
      id: uid("mem"),
      kind: input.kind ?? "fact",
      content: input.content.trim(),
      tags: input.tags ?? [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      source: input.source,
    };
    facts.unshift(entry);
    // de-dupe near-identical content
    const seen = new Set<string>();
    const deduped: MemoryEntry[] = [];
    for (const f of facts) {
      const key = f.content.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(f);
    }
    writeJson(this.factsPath, deduped.slice(0, this.maxFacts));
    // also mirror into MEMORY.md under Facts
    this.appendMemoryMd(`- ${entry.content}`);
    return entry;
  }

  deleteFact(id: string): boolean {
    const facts = this.listFacts();
    const next = facts.filter((f) => f.id !== id);
    if (next.length === facts.length) return false;
    writeJson(this.factsPath, next);
    return true;
  }

  search(query: string, limit = 8): MemoryEntry[] {
    const scored = this.listFacts()
      .map((f) => ({ f, s: keywordScore(query, `${f.content} ${f.tags.join(" ")} ${f.kind}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.f);

    // Also search markdown files
    if (scored.length < limit) {
      const mdHits = this.searchMarkdown(query, limit - scored.length);
      for (const hit of mdHits) {
        scored.push({
          id: uid("md"),
          kind: "note",
          content: hit,
          tags: ["markdown"],
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
      }
    }
    return scored;
  }

  // ── Markdown workspace memory ─────────────────────────────────

  readSoul(): string {
    return readText(join(this.workspaceDir, "SOUL.md")) ?? "";
  }

  readUser(): string {
    return readText(join(this.workspaceDir, "USER.md")) ?? "";
  }

  readMemoryMd(): string {
    return readText(join(this.workspaceDir, "MEMORY.md")) ?? "";
  }

  readAgents(): string {
    return readText(join(this.workspaceDir, "AGENTS.md")) ?? "";
  }

  readHeartbeat(): string {
    return readText(join(this.workspaceDir, "HEARTBEAT.md")) ?? "";
  }

  readIdentity(): string {
    return readText(join(this.workspaceDir, "IDENTITY.md")) ?? "";
  }

  appendMemoryMd(line: string): void {
    const path = join(this.workspaceDir, "MEMORY.md");
    const existing = readText(path) ?? "# MEMORY.md\n\n## Facts\n\n";
    if (existing.includes(line.trim())) return;
    // Prefer inserting under ## Facts
    if (existing.includes("## Facts")) {
      const updated = existing.replace("## Facts", `## Facts\n${line}`);
      writeText(path, updated);
    } else {
      appendText(path, `\n${line}\n`);
    }
  }

  appendDailyLog(note: string): string {
    const path = join(this.workspaceDir, "memory", `${todayStamp()}.md`);
    if (!readText(path)) {
      writeText(path, `# ${todayStamp()}\n\n`);
    }
    const stamp = new Date().toISOString().slice(11, 19);
    appendText(path, `- **${stamp}** ${note.trim()}\n`);
    return path;
  }

  readRecentDailyLogs(days = 2): string {
    const dir = join(this.workspaceDir, "memory");
    const files = listFiles(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, days);

    const parts: string[] = [];
    for (const f of files) {
      const body = readText(join(dir, f));
      if (body?.trim()) parts.push(body.trim());
    }
    return parts.join("\n\n---\n\n");
  }

  searchMarkdown(query: string, limit = 5): string[] {
    const paths = [
      join(this.workspaceDir, "MEMORY.md"),
      join(this.workspaceDir, "USER.md"),
      ...listFiles(join(this.workspaceDir, "memory"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => join(this.workspaceDir, "memory", f)),
    ];

    const hits: { score: number; snippet: string }[] = [];
    for (const p of paths) {
      const text = readText(p);
      if (!text) continue;
      const paragraphs = text.split(/\n{2,}/);
      for (const para of paragraphs) {
        const s = keywordScore(query, para);
        if (s > 0) hits.push({ score: s, snippet: para.trim().slice(0, 500) });
      }
    }
    return hits
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((h) => h.snippet);
  }

  updateUserSection(sectionHeading: string, body: string): void {
    const path = join(this.workspaceDir, "USER.md");
    let text = readText(path) ?? "# USER.md\n\n";
    const heading = sectionHeading.startsWith("#") ? sectionHeading : `## ${sectionHeading}`;
    const re = new RegExp(`${escapeRegExp(heading)}\\n[\\s\\S]*?(?=\\n## |\\n# |$)`);
    if (re.test(text)) {
      text = text.replace(re, `${heading}\n${body.trim()}\n\n`);
    } else {
      text = text.trimEnd() + `\n\n${heading}\n${body.trim()}\n`;
    }
    writeText(path, text);
  }

  /**
   * Build the bootstrap context block injected into the system prompt.
   * Mirrors OpenClaw's identity file loading.
   */
  buildBootstrapContext(cfg: AppConfig): string {
    if (!cfg.memory.enabled) return "";

    const parts: string[] = ["# Workspace Identity & Memory", ""];

    if (cfg.memory.injectSoulMd) {
      const soul = this.readSoul();
      if (soul.trim()) parts.push("## SOUL.md", soul.trim(), "");
    }
    if (cfg.memory.injectUserMd) {
      const user = this.readUser();
      if (user.trim()) parts.push("## USER.md", user.trim(), "");
    }
    if (cfg.memory.injectMemoryMd) {
      const mem = this.readMemoryMd();
      if (mem.trim()) parts.push("## MEMORY.md", mem.trim(), "");
    }

    const agents = this.readAgents();
    if (agents.trim()) parts.push("## AGENTS.md", agents.trim(), "");

    const facts = this.listFacts().slice(0, 30);
    if (facts.length) {
      parts.push("## Structured facts");
      for (const f of facts) {
        parts.push(`- [${f.kind}] ${f.content}`);
      }
      parts.push("");
    }

    if (cfg.memory.injectDailyLog) {
      const daily = this.readRecentDailyLogs(cfg.memory.dailyLogDays);
      if (daily.trim()) {
        parts.push("## Recent daily logs", daily.trim(), "");
      }
    }

    return parts.join("\n");
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
