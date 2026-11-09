// Where a chat's skills come from beyond pi's own places, and the plain text work on a skill's file
// (§chat/skill-sources). Harness-neutral: the pi half is server/harness/pi/skill-sources.ts.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultClaudeDir } from "../pi-config/extensions/claude-code/accounts.ts";

const isFile = (p: string): boolean => {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
};

/** `.claude/skills` in `cwd` and each folder above it, nearest first, up to the nearest folder holding
    `.git` (with none, to the disk's root): the walk pi makes for `.agents/skills`. The Claude config
    folder's own `skills` is never one: it holds what Claude syncs (homeClaudeSkillDirs). */
export function projectClaudeSkillDirs(cwd: string, claudeDir: string = defaultClaudeDir()): string[] {
  const own = new Set([resolve(claudeDir, "skills"), resolve(homedir(), ".claude", "skills")]);
  const out: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    const skills = join(dir, ".claude", "skills");
    if (!own.has(skills) && existsSync(skills)) out.push(skills);
    if (existsSync(join(dir, ".git"))) return out;
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

/** The skills placed directly in the Claude config folder's `skills`: each child folder holding its own
    SKILL.md, never the folder itself, whose search would reach what Claude syncs below `synced/`. */
export function homeClaudeSkillDirs(claudeDir: string = defaultClaudeDir()): string[] {
  const root = join(claudeDir, "skills");
  let names: string[];
  try {
    names = readdirSync(root).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return [];
  }
  return names.map((n) => join(root, n)).filter((d) => isFile(join(d, "SKILL.md")));
}

/** Every path a chat in `cwd` adds to pi's own places: the project's first, then the home folder's. */
export function claudeSkillPaths(cwd: string, claudeDir: string = defaultClaudeDir()): string[] {
  return [...projectClaudeSkillDirs(cwd, claudeDir), ...homeClaudeSkillDirs(claudeDir)];
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A skill file's text below its front matter (none: all of it), read as text, so a front matter YAML
    refuses still has an end. */
export function skillBody(text: string): string {
  const s = text.replace(/^\uFEFF/, "");
  const m = FRONT.exec(s);
  return (m ? s.slice(m[0].length) : s).trim();
}

/** Claude Code's rule for a plain value its own YAML pass would refuse. */
const RISKY = /[{}[\]*&#!|>%@`]|: /;
const KEY_VALUE = /^([A-Za-z_][\w-]*):[ \t]+(\S.*?)[ \t]*$/;

/** `text` with each risky plain top-level front matter value quoted (§chat.skill-sources/rescue); null
    when nothing changed. A quoted value, a block marker and a closed flow list or map stay as written. */
export function quotedFrontMatter(text: string): string | null {
  const s = text.replace(/^\uFEFF/, "");
  const m = FRONT.exec(s);
  if (!m) return null;
  let changed = false;
  const lines = m[1]!.split(/\r?\n/).map((line) => {
    const kv = KEY_VALUE.exec(line);
    if (!kv) return line;
    const value = kv[2]!;
    if (!RISKY.test(value) || /^["']/.test(value) || /^[|>][+-]?\d*$/.test(value) || /^\[.*\]$/.test(value) || /^\{.*\}$/.test(value)) return line;
    changed = true;
    return `${kv[1]}: "${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  });
  return changed ? `---\n${lines.join("\n")}\n---\n${s.slice(m[0].length)}` : null;
}

/** The words of `/skill:name`'s text: split on white space, a quoted run counting as one. */
export function argumentWords(args: string): string[] {
  const out: string[] = [];
  for (const m of args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/** Claude's placeholders filled in (§chat.skill-sources/arguments). `used`: an argument placeholder was
    there, so the text needn't follow the skill as well. */
export function fillPlaceholders(body: string, o: { args: string; skillDir: string; names?: readonly string[] }): { text: string; used: boolean } {
  const words = argumentWords(o.args);
  let used = false;
  const word = (n: number, whole: string): string => {
    if (n >= words.length) return whole;
    used = true;
    return words[n]!;
  };
  const names = (o.names ?? []).filter((n) => /^[A-Za-z_]\w*$/.test(n));
  // One pass, so a word that holds placeholder text is never filled again.
  const named = names.length ? `|\\$(${names.join("|")})\\b` : "";
  const every = new RegExp(`\\$\\{CLAUDE_SKILL_DIR\\}|\\$ARGUMENTS\\[(\\d+)\\]|\\$ARGUMENTS\\b|\\$(\\d+)\\b${named}`, "g");
  const text = body.replace(every, (all: string, index: unknown, short: unknown, name: unknown) => {
    if (all === "${CLAUDE_SKILL_DIR}") return o.skillDir;
    if (all === "$ARGUMENTS") {
      used = true;
      return o.args;
    }
    if (typeof index === "string") return word(Number(index), all);
    if (typeof short === "string") return word(Number(short), all);
    return word(names.indexOf(String(name)), all);
  });
  return { text, used };
}

/** `/skill:name rest` as its name and text; null for anything else. */
export function skillCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/skill:")) return null;
  const space = text.search(/\s/);
  const name = space < 0 ? text.slice(7) : text.slice(7, space);
  return name ? { name, args: space < 0 ? "" : text.slice(space + 1).trim() } : null;
}

/** The user message `/skill:name` becomes, in pi's own form (server/skills.ts reads it back; quirk P41). */
export function expandedSkill(s: { name: string; filePath: string; skillDir: string; body: string; args: string }): string {
  const block = `<skill name="${s.name}" location="${s.filePath}">\nReferences are relative to ${s.skillDir}.\n\n${s.body}\n</skill>`;
  return s.args ? `${block}\n\n${s.args}` : block;
}
