/**
 * Skills: which ones the session's prompt OFFERED, and which ones it actually LOADED.
 *
 * Read from the session's own JSONL with our parser, never through the SDK: `SessionManager.open`
 * rewrites files (CLAUDE.md), and a TUI may own this one. Pure — it takes parsed entries and
 * returns data, so every rule below is pinned by server/skills.test.ts.
 *
 * None of the signals is authoritative on its own:
 *
 * - **offered.** pi writes the available-skills block into the prompt as a `sections.skills`
 *   string on `role:"system"` message entries. Those patches are diff-only, so the block appears
 *   only in the entries that changed the set — replaying them along the branch gives "offered from
 *   T₁ until T₂". A skill being offered is NOT evidence that it was used.
 * - **invoked.** pi rewrites an explicit `/skill:name` into the user message BEFORE persisting it,
 *   so the row itself carries `<skill name="…" location="…">body</skill>` and any trailing args
 *   (`parseSkillBlock`, agent-session.js). A Claude Code worker's `Skill` tool call carries
 *   `{skill, args}` instead. Both are exact.
 * - **read.** The model loading the file itself. pi's own TUI classifies a `read` whose basename is
 *   SKILL.md as a skill load and names it after the parent directory; we use the same rule so the
 *   two surfaces agree instead of inventing a second one.
 * - **shell.** The same act through bash (`cat …/SKILL.md`), which is the common form on the Claude
 *   Code side. INFERRED, and labelled so: a command can name a SKILL.md for other reasons, and pi's
 *   renderer does not classify this route at all.
 */

import { posix } from "node:path";
import type { SessionSkillOffer, SessionSkills, SessionSkillUse } from "../shared/protocol";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** pi's own parser for an expanded skill command, anchored at the start of the user row. */
const SKILL_BLOCK_RE = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?/;

/** Commands that read a file: the first word of a command segment. */
const READ_VERBS = new Set(["cat", "bat", "batcat", "less", "more", "head", "tail", "sed", "awk", "strings"]);

/** A heredoc's body is text a command writes, not a command being run: `python3 - <<'EOF' … EOF`. */
const stripHeredocs = (command: string): string => command.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, " ");

/**
 * The SKILL.md files a shell command actually READS.
 *
 * Deliberately narrow, because this route is inferred rather than recorded and the pane must never
 * claim a load when a command merely mentioned a file. Two real false positives from this machine's
 * own sessions shaped the rules: `… | head -6; grep -rl "x/SKILL.md"` matched a read verb and a path
 * from two different commands, and a python heredoc whose source text contained `/s/alpha/SKILL.md`
 * matched as if it were the command line. So: one command segment at a time, the path must be the
 * argument the read verb reads, and heredoc bodies are not commands.
 */
export function shellSkillPaths(command: string): string[] {
  const out: string[] = [];
  for (const segment of stripHeredocs(command).split(/[|;&\n]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      if (!READ_VERBS.has(tokens[i]!)) continue;
      // Skip flags, then take consecutive file arguments: `cat a/SKILL.md b/SKILL.md` reads both.
      for (let j = i + 1; j < tokens.length; j++) {
        const token = tokens[j]!.replace(/^['"]|['"]$/g, "");
        // Skip flags and a flag's own argument (`head -n 40 FILE`), then take consecutive file
        // arguments: `cat a/SKILL.md b/SKILL.md` reads both.
        if (token.startsWith("-") || /^\d+$/.test(token)) continue;
        if (!/SKILL\.md$/.test(token)) break;
        out.push(token);
      }
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&amp;": "&" };

/** The five entities pi escapes into the prompt section (in one pass, so `&amp;lt;` stays literal). */
const unescapeXml = (s: string): string => s.replace(/&(?:lt|gt|quot|apos|#39|amp);/g, (m) => ENTITIES[m] ?? m);

/** Text content of a message's `content`, which is a string or a block array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (isRec(b) && typeof b.text === "string" ? b.text : "")).join("\n");
}

/** The text inside one `<tag>…</tag>`, unescaped; undefined when the tag is absent or empty. */
function tagOf(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  const text = m?.[1]?.trim();
  return text ? unescapeXml(text) : undefined;
}

/** The skills a `sections.skills` prompt section lists. */
export function parseSkillSection(section: string): { name: string; description?: string; location?: string }[] {
  const out: { name: string; description?: string; location?: string }[] = [];
  for (const m of section.matchAll(/<skill>([\s\S]*?)<\/skill>/g)) {
    const block = m[1] ?? "";
    const name = tagOf(block, "name");
    if (!name) continue;
    const description = tagOf(block, "description");
    const location = tagOf(block, "location");
    out.push({ name, ...(description ? { description } : {}), ...(location ? { location } : {}) });
  }
  return out;
}

/** Characters a directory name in a shell command can carry and a real skill name never does: a
    command like `cat $dir/SKILL.md` must not become a skill called `$dir`. */
const NOT_A_SKILL_NAME = /[$*?{}[\]\s"'`]/;

/**
 * pi's read renderer names a skill after the directory holding its SKILL.md (`…/playwright/SKILL.md`).
 *
 * A relative path is resolved against the cwd the transcript records before the name is taken, so
 * `cat ../SKILL.md` in `/repo/pkg` names `repo` (the directory that file is really in) instead of
 * `..`. `.` and `..` can never come back as a name, whatever the path was.
 */
export function skillNameFromPath(path: string, cwd?: string): string | undefined {
  const raw = !path.startsWith("/") && cwd ? `${cwd}/${path}` : path;
  const parts = posix.normalize(raw).split("/").filter((s) => s && s !== "." && s !== "..");
  if (parts.length < 2) return undefined;
  const name = parts[parts.length - 2];
  return name && !NOT_A_SKILL_NAME.test(name) ? name : undefined;
}

/**
 * Replay the offered set along the branch. A section that arrives without a `skills` key is
 * unchanged (the patches are diff-only); one that arrives as null means the section was removed.
 */
function applyOffer(
  listed: { name: string; description?: string; location?: string }[],
  at: string | undefined,
  open: Map<string, SessionSkillOffer>,
  offered: SessionSkillOffer[],
): void {
  const names = new Set(listed.map((s) => s.name));
  for (const [name, offer] of [...open]) {
    if (names.has(name)) continue;
    if (at) offer.until = at;
    offered.push(offer);
    open.delete(name);
  }
  for (const s of listed) {
    const current = open.get(s.name);
    if (current) {
      // Same skill, re-emitted: refresh the metadata, keep the window it was first offered in.
      if (s.description) current.description = s.description;
      if (s.location) current.location = s.location;
      continue;
    }
    open.set(s.name, {
      name: s.name,
      from: at ?? "",
      ...(s.description ? { description: s.description } : {}),
      ...(s.location ? { location: s.location } : {}),
    });
  }
}

/** One skill load, from a user row or from an assistant tool call. */
function use(name: string, entryId: string, at: string | undefined, how: SessionSkillUse["how"], extra: Partial<SessionSkillUse> = {}): SessionSkillUse {
  return { name, at: at ?? "", entryId, how, ...extra };
}

/** One tool call's skill evidence, if it is a skill load at all. */
function usesFromToolCall(name: string, args: unknown, entryId: string, at: string | undefined, cwd: string | undefined): SessionSkillUse[] {
  const tool = name.toLowerCase();
  const a = isRec(args) ? args : {};
  // An explicit invocation (Claude Code): {skill, args}.
  if (tool === "skill") {
    const skill = str(a.skill);
    if (!skill) return [];
    const own = str(a.args);
    return [use(skill, entryId, at, "invoked", own ? { args: own } : {})];
  }
  // pi's own rule: a read whose basename is SKILL.md is a skill load, named after its directory.
  if (tool === "read") {
    // pi spells the argument `path`; a Claude Code Read tool spells it `file_path`.
    const path = str(a.path) ?? str(a.file_path) ?? "";
    if (!/SKILL\.md$/.test(path)) return [];
    const skill = skillNameFromPath(path, cwd);
    return skill ? [use(skill, entryId, at, "read", { location: path })] : [];
  }
  // The bash route, inferred: only when a command really reads a SKILL.md.
  if (tool === "bash") {
    const command = str(a.command) ?? str(a.cmd) ?? "";
    const paths = new Map<string, string>();
    for (const path of shellSkillPaths(command)) {
      const skill = skillNameFromPath(path, cwd);
      if (skill && !paths.has(skill)) paths.set(skill, path);
    }
    return [...paths].map(([skill, path]) => use(skill, entryId, at, "shell", { location: path }));
  }
  return [];
}

/**
 * Everything the entries say about skills: what was offered along this branch, and every load.
 * Pass the active branch, oldest first — the same entries the transcript renders.
 */
export function collectSkills(entries: readonly unknown[]): SessionSkills {
  const offered: SessionSkillOffer[] = [];
  const open = new Map<string, SessionSkillOffer>();
  const used: SessionSkillUse[] = [];
  /** The directory relative paths resolve against: pi's header carries it, and so does every
      Claude Code line. Without it a relative SKILL.md path cannot be named honestly. */
  let cwd: string | undefined;

  for (const entry of entries) {
    if (!isRec(entry)) continue;
    const at = str(entry.timestamp);
    const thisCwd = str(entry.cwd);
    if (thisCwd) cwd = thisCwd;
    // pi entries carry `id`; a Claude Code line carries `uuid`, which is what its transcript rows
    // are keyed by (`claude-transcript.ts`), so a jump target resolves on both backends.
    const id = str(entry.id) ?? str(entry.uuid) ?? "";
    const message = isRec(entry.message) ? entry.message : undefined;
    if (!message) continue;
    const role = str(message.role);
    // pi wraps everything in a `message` entry; a Claude Code transcript's line type IS the role
    // (`assistant`, `user`). Both are accepted so one parser serves the two backends.
    const type = str(entry.type);
    if (type !== "message" && type !== "assistant" && type !== "user" && type !== "system") continue;

    if (role === "system") {
      const sections = isRec(message.sections) ? message.sections : undefined;
      // Absent key: unchanged. Present and null: the section was removed, so nothing is offered.
      if (sections && "skills" in sections) applyOffer(parseSkillSection(str(sections.skills) ?? ""), at, open, offered);
      continue;
    }

    if (role === "user") {
      const text = textOf(message.content).trimStart();
      const m = SKILL_BLOCK_RE.exec(text);
      if (m) {
        const args = m[4]?.trim();
        used.push(use(m[1]!, id, at, "invoked", { location: m[2]!, ...(args ? { args } : {}) }));
      }
      continue;
    }

    if (role === "assistant" && Array.isArray(message.content)) {
      // One item per block in the transcript, so the row to jump to is `${entryId}:${blockIndex}`.
      message.content.forEach((block, i) => {
        if (!isRec(block)) return;
        // pi writes `toolCall` with `arguments`; a Claude Code transcript writes `tool_use` with
        // `input`. One parser for both, so "what counts as a skill load" is defined once.
        const blockType = str(block.type);
        if (blockType !== "toolCall" && blockType !== "tool_use") return;
        const name = str(block.name);
        if (!name) return;
        const args = isRec(block.arguments) ? block.arguments : block.input;
        used.push(...usesFromToolCall(name, args, `${id}:${i}`, at, cwd));
      });
    }
  }

  for (const offer of open.values()) offered.push(offer);
  offered.sort((a, b) => a.from.localeCompare(b.from) || a.name.localeCompare(b.name));
  return { offered, used };
}

/** Whether anything about skills is known: an empty result is left off the insight entirely. */
export function hasSkills(skills: SessionSkills): boolean {
  return skills.offered.length > 0 || skills.used.length > 0;
}
