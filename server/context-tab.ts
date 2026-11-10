// What fills one chat's context window now: GET /api/sessions/context-view (shared/protocol.ts
// SessionContextView), the session pane's Context tab. Read-only and never cached; it keeps no record.
//
// Every part is one Sova already reads elsewhere:
//  - the instruction files and skills: /api/sessions/context's read (server/session-setup.ts);
//  - the mode, rules and docs: the held chat's system prompt by section (`promptSections`), and its tools as
//    declared (`declaredTools`), so they are unknown (`prompt: false`) for a chat this server doesn't hold;
//  - the instruction files below cwd: the deeper-context engine's own walk (server/deeper-context.ts);
//  - the total and the window: the transcript head's rule (contextOfBranch, resolveContext).
// The conversation is estimated from the branch's messages since the latest compaction, and tallied by
// kind (`talk`); a skill counts as read when the Skills tab's own rules (server/skills.ts) find all of its
// SKILL.md loaded in what the model still sees, and as read in part with the count of its lines that were.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, sep } from "node:path";
import type { HBlock, HEntry, HarnessToolInfo } from "../shared/harness";
import { CHARS_PER_TOKEN, type SessionContextNested, type SessionContextPart, type SessionContextTalk, type SessionContextView, type SessionSetup } from "../shared/protocol";
import type { SpecialSpec } from "../shared/chat-runtime";
import { chatHandle } from "./chat-handle";
import { deeperContextAllow } from "./chat-special";
import { listSubfolderInstructions, resolveToolPath, visiblePart } from "./deeper-context";
import { resolveContext } from "./models";
import { estimateTokens, getSessionSetup } from "./session-setup";
import { toolTokens } from "./session-tools";
import { fileLinesOf, linesLoaded } from "./skill-lines";
import { collectSkillLoads, type SkillLoad, skillLinesOf } from "./skills";
import { readBranch } from "./harness/pi/reader";
import { contextOfBranch, resetsContext } from "./harness/pi/usage";

/** The sections that aren't one of their own: the files and skills are listed one by one, the mode alone. */
const LISTED = new Set(["project_context", "skills", "mode"]);
const SECTION_LABELS: Record<string, string> = { preamble: "Preamble", tools: "Tool list", rules: "Rules", docs: "Pi docs", cwd: "Working folder", addendum: "Added instructions" };
/** pi's estimate for one image (pi-coding-agent compaction estimateTokens: 4800 characters). */
const IMAGE_CHARS = 4800;

/** The held chat's prompt sections and declared tools, or null when nothing here holds it. */
export interface HeldPrompt {
  sections: Record<string, string>;
  tools: HarnessToolInfo[];
  /** A special chat's loader options (which subfolder files its hook may load); null for any other chat. */
  loader: SpecialSpec["loader"] | null;
}

export interface ContextViewDeps {
  setup?: (path: string) => Promise<SessionSetup>;
  held?: (path: string) => Promise<HeldPrompt | null>;
  branch?: (path: string) => Promise<readonly HEntry[]>;
  context?: typeof resolveContext;
  nested?: typeof listSubfolderInstructions;
  /** A skill's SKILL.md as it is now, to count the lines its reads loaded. */
  readText?: (path: string) => Promise<string>;
  now?: () => number;
}

async function heldPrompt(path: string): Promise<HeldPrompt | null> {
  const chat = chatHandle(path);
  if (!chat) return null;
  try {
    const [sections, tools, loader] = await Promise.all([chat.promptSections(), chat.declaredTools(), chat.specialLoader()]);
    return { sections, tools, loader };
  } catch {
    return null; // a chat that closed mid-read is a chat not held
  }
}

/** An instruction file's name: relative inside the chat's folder, else `~/...` under the home folder. */
export const labelOf = (cwd: string, path: string, home = homedir()): string => {
  const rel = relative(cwd, path);
  if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) return rel;
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
};

const blockChars = (b: HBlock): number =>
  b.type === "text" ? (b.text ?? "").length
  : b.type === "thinking" ? (b.thinking ?? "").length
  : b.type === "toolCall" ? (b.name ?? "").length + (JSON.stringify(b.arguments ?? {}) ?? "").length
  : b.type === "image" ? IMAGE_CHARS
  : 0;

/** What one entry puts in the model's context, in characters. */
function entryChars(h: HEntry): number {
  switch (h.kind) {
    case "user":
    case "assistant":
    case "tool-result":
      return h.blocks.reduce((n, b) => n + blockChars(b), 0);
    case "summary":
      return h.inMessage ? (h.summary ?? "").length : 0;
    case "compaction":
      return (h.summary ?? "").length;
    case "shell":
      // A `!!` command never reaches the model (§chat.shell-mode/model): it holds no context.
      return h.private ? 0 : (h.command ?? "").length + (h.output ?? "").length;
    case "note":
      return h.inMessage ? (typeof h.content === "string" ? h.content : JSON.stringify(h.content ?? "")).length : 0;
    default:
      return 0;
  }
}

/** Where what the model sees starts: the latest compaction's kept part (or the compaction itself), and that
    compaction's index; 0 and -1 with none. */
function windowStart(branch: readonly HEntry[]): { from: number; reset: number } {
  for (let i = branch.length - 1; i >= 0; i--) {
    const h = branch[i]!;
    if (!resetsContext(h)) continue;
    const kept = h.kind === "compaction" ? (h as { firstKeptEntryId?: string }).firstKeptEntryId : undefined;
    const k = kept ? branch.findIndex((e) => e.id === kept) : -1;
    return { from: k !== -1 && k < i ? k : i, reset: i };
  }
  return { from: 0, reset: -1 };
}

/** ≈ tokens of the messages in context: those after the latest compaction, plus the part it kept. */
export function conversationTokens(branch: readonly HEntry[]): number {
  let chars = 0;
  for (let i = windowStart(branch).from; i < branch.length; i++) chars += entryChars(branch[i]!);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

const tokensOf = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/** The conversation in context by kind: your messages, replies, tool results (less `loadedNested`, the
    subfolder files they carry), the rest; and the latest compaction's summary. Walks the same span as
    conversationTokens. */
export function conversationTalk(branch: readonly HEntry[], loadedNested = 0): SessionContextTalk {
  const { from, reset } = windowStart(branch);
  const chars = { user: 0, replies: 0, toolResults: 0, other: 0 };
  const count = { user: 0, replies: 0, toolResults: 0, other: 0 };
  let summary: SessionContextTalk["summary"];
  for (let i = from; i < branch.length; i++) {
    const h = branch[i]!;
    const c = entryChars(h);
    const kind =
      // A `!!` command is not in the window (§chat.shell-mode/model): no message of yours there.
      h.kind === "user" || (h.kind === "shell" && !h.private) ? "user"
      : h.kind === "assistant" ? "replies"
      : h.kind === "tool-result" ? "toolResults"
      : (h.kind === "note" || h.kind === "summary") && c > 0 ? "other"
      : null;
    if (h.kind === "compaction" && i === reset) {
      if (h.summary) summary = { text: h.summary, tokens: tokensOf(h.summary.length), ...(h.at ? { at: h.at } : {}) };
    } else if (kind) {
      chars[kind] += c;
      count[kind]++;
    }
  }
  const tally = (k: keyof typeof chars, less = 0) => ({ count: count[k], tokens: Math.max(0, tokensOf(chars[k]) - less) });
  return {
    user: tally("user"),
    replies: tally("replies"),
    toolResults: tally("toolResults", loadedNested),
    other: tally("other"),
    ...(summary ? { summary } : {}),
  };
}

/** The skills loaded in what the model still sees, by name and by resolved SKILL.md path: the Skills tab's
    own evidence (a read, an invocation, or a shell command reading the file), since the latest compaction.
    Each with its loads, which say which lines of the file they loaded. */
export function skillsRead(branch: readonly HEntry[], cwd: string): { names: Map<string, SkillLoad[]>; paths: Map<string, SkillLoad[]> } {
  const names = new Map<string, SkillLoad[]>();
  const paths = new Map<string, SkillLoad[]>();
  const add = (m: Map<string, SkillLoad[]>, key: string, u: SkillLoad) => m.set(key, [...(m.get(key) ?? []), u]);
  for (const u of collectSkillLoads(skillLinesOf(visiblePart(branch), cwd)).used) {
    add(names, u.name, u);
    if (u.location) add(paths, resolveToolPath(cwd, u.location), u);
  }
  return { names, paths };
}

/**
 * How much of one skill's SKILL.md its loads put in front of the model, counted against the file as it
 * is now: whole (`read: true`), some of its lines (`linesRead` of `lines`), or none. An invocation loads
 * the whole skill; a read or shell load, the lines its chains reach (server/skill-lines.ts), as a union.
 */
export function skillReadState(loads: readonly SkillLoad[], text: string | null, knownLines?: number): Pick<SessionContextPart, "read" | "linesRead" | "lines"> {
  if (loads.length === 0) return { read: false };
  if (loads.some((u) => !u.chains)) return { read: true };
  const file = text !== null ? fileLinesOf(text) : knownLines !== undefined ? { count: knownLines } : null;
  // A file that can't be measured can't be counted: a read with no bounds counts as whole, any other as none.
  if (!file) return loads.some((u) => u.chains!.some((c) => c.every((s) => s.kind === "cap"))) ? { read: true } : { read: false };
  const loaded = linesLoaded(loads.flatMap((u) => u.chains!), file).size;
  if (loaded >= file.count) return { read: true };
  if (loaded === 0) return { read: false };
  return { read: false, linesRead: loaded, lines: file.count };
}

/** The text pi lists one offered skill with (pi formatSkillsForPrompt): its name, description and location. */
const skillListing = (name: string, description: string | undefined, path: string): string =>
  `  <skill>\n    <name>${name}</name>\n    <description>${description ?? ""}</description>\n    <location>${path}</location>\n  </skill>`;

export async function getContextView(path: string, deps: ContextViewDeps = {}): Promise<SessionContextView> {
  const now = deps.now ?? Date.now;
  const setup = await (deps.setup ?? ((p) => getSessionSetup(p)))(path);
  if (setup.state === "remote") return { state: "remote", cwd: setup.cwd, checkedAt: now() };
  if (setup.state !== "ok") return { state: "unavailable", cwd: setup.cwd, reason: setup.reason, checkedAt: now() };
  const cwd = setup.cwd;

  const [held, branch] = await Promise.all([(deps.held ?? heldPrompt)(path), (deps.branch ?? readBranch)(path).catch(() => [] as HEntry[])]);
  const ctx = await (deps.context ?? resolveContext)(contextOfBranch(branch));

  const instructions: SessionContextPart[] = setup.context
    .filter((f) => !f.off)
    .map((f) => ({ id: `file:${f.path}`, label: labelOf(cwd, f.path), path: f.path, tokens: f.tokens ?? Math.ceil(f.bytes / CHARS_PER_TOKEN) }));
  const loads = skillsRead(branch, cwd);
  const readText = deps.readText ?? ((p: string) => readFile(p, "utf8"));
  const skills: SessionContextPart[] = await Promise.all(
    setup.skills
      .filter((k) => !k.off)
      .map(async (k) => {
        // A load found by name and by path is one load, not two.
        const mine = [...new Set([...(loads.names.get(k.name) ?? []), ...(loads.paths.get(resolveToolPath(cwd, k.path)) ?? [])])];
        const text = mine.length > 0 ? await readText(k.path).catch(() => null) : null;
        return {
          id: `skill:${k.name}`,
          label: k.name,
          ...(k.description ? { detail: k.description } : {}),
          path: k.path,
          tokens: estimateTokens(skillListing(k.name, k.description, k.path)),
          ...skillReadState(mine, text, k.lines),
        };
      }),
  );

  let mode: SessionContextPart | null = null;
  const rules: SessionContextPart[] = [];
  const tools: SessionContextPart[] = [];
  if (held) {
    for (const [name, text] of Object.entries(held.sections)) {
      if (!text || (LISTED.has(name) && name !== "mode")) continue;
      const part = { id: `section:${name}`, label: name === "mode" ? "Mode" : (SECTION_LABELS[name] ?? name), text, tokens: estimateTokens(text) };
      if (name === "mode") mode = part;
      else rules.push(part);
    }
    for (const { source: _s, origin: _o, ...decl } of held.tools) {
      tools.push({ id: `tool:${decl.name}`, label: decl.name, text: JSON.stringify(decl, null, 2), tokens: toolTokens(decl.description, decl.parameters) });
    }
  }

  // Only what the chat's hook would load: none for a loadout with no context files, and a special chat's
  // files only where its file tools may read (the hook's own allow, server/chat-special.ts).
  const allow = held?.loader ? deeperContextAllow(held.loader) : () => true;
  const walk = allow ? (deps.nested ?? listSubfolderInstructions)(cwd, branch) : { files: [], incomplete: false };
  const nested: SessionContextNested[] = walk.files.filter((f) => allow!(f.abs)).map((f) => ({ path: f.path, abs: f.abs, folder: f.dir, tokens: Math.ceil(f.chars / CHARS_PER_TOKEN), loaded: f.loaded }));
  const loadedNested = nested.reduce((n, f) => n + (f.loaded ? f.tokens : 0), 0);

  return {
    state: "ok",
    cwd,
    window: ctx?.window ?? null,
    total: ctx?.tokens ?? null,
    prompt: held !== null,
    instructions,
    mode,
    rules,
    skills,
    tools,
    conversation: Math.max(0, conversationTokens(branch) - loadedNested),
    talk: conversationTalk(branch, loadedNested),
    nested,
    ...(walk.incomplete ? { nestedIncomplete: true as const } : {}),
    checkedAt: now(),
  };
}
