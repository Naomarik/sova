// What fills one chat's context window now: GET /api/sessions/context-view (shared/protocol.ts
// SessionContextView), the session pane's Context tab. Read-only and never cached; it keeps no record.
//
// Every part is one Sova already reads elsewhere:
//  - the instruction files and skills: /api/sessions/context's read (server/session-setup.ts);
//  - the mode, rules and docs: the held chat's system prompt by section (`promptSections`), and its tools as
//    declared (`declaredTools`), so they are unknown (`prompt: false`) for a chat this server doesn't hold;
//  - the instruction files below cwd: the deeper-context engine's own walk (server/deeper-context.ts);
//  - the skills below cwd: the same walk's sibling, and the blocks on the branch (server/subfolder-skills.ts);
//  - the total and the window: the transcript head's rule (contextOfBranch, resolveContext).
// The conversation is estimated from the branch's messages since the latest compaction, and tallied by
// kind (`talk`); a skill counts as read when server/skills.ts's rules find all of its SKILL.md loaded in what
// the model still sees, and as read in part with the count of its lines that were. What a skill loaded is that
// SKILL.md's loads plus every read of another file under its folder (server/skills.ts collectFileReads), each
// sized by the lines reached: a note on the row (loadedTokens, loadedFiles), never added to a total.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { HBlock, HEntry, HarnessToolInfo } from "../shared/harness";
import { CHARS_PER_TOKEN, type SessionContextLoadedFile, type SessionContextNested, type SessionContextPart, type SessionContextTalk, type SessionContextView, type SessionSetup } from "../shared/protocol";
import type { SpecialSpec } from "../shared/chat-runtime";
import { chatHandle } from "./chat-handle";
import { deeperContextAllow } from "./chat-special";
import { listSubfolderInstructions, resolveToolPath, visiblePart } from "./deeper-context";
import { resolveContext } from "./models";
import { estimateTokens, getSessionSetup, measureFile, skillListingTokens } from "./session-setup";
import { toolTokens } from "./session-tools";
import { fileLinesOf, type LineChain, linesLoaded } from "./skill-lines";
import { collectFileReads, collectSkillLoads, type FileRead, type SkillLoad, skillLinesOf } from "./skills";
import { inProjectHere, skillDescentAllowed } from "./skill-descent";
import { listSubfolderSkills, offeredSkills } from "./subfolder-skills";
import { readBranch } from "./harness/pi/reader";
import { piSkillsIn } from "./harness/pi/skill-sources";
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
  nestedSkills?: (cwd: string) => ReturnType<typeof listSubfolderSkills>;
  /** Whether the chat looks below its folder at all (server/skill-descent.ts; default: its folder's git and
      projects now, from the home folder). */
  descends?: (cwd: string) => boolean;
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

/** The skills loaded in what the model still sees, by name and by resolved SKILL.md path: server/skills.ts's
    evidence (a read, an invocation, or a shell command reading the file), since the latest compaction.
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

/**
 * The folder whose files count as one skill's: its SKILL.md's folder, resolved against `cwd`. None for a skill
 * that is a lone `.md` file (its folder is a skills folder, holding other skills), nor for one whose folder
 * holds the chat's own: the chat works there, so what it reads is its work, not the skill.
 */
export function skillFolderOf(skillPath: string, cwd: string): string | null {
  if (basename(skillPath) !== "SKILL.md") return null;
  const dir = dirname(resolveToolPath(cwd, skillPath));
  const here = resolve(cwd);
  return here === dir || here.startsWith(dir + sep) ? null : dir;
}

/**
 * The reads of files under each skill folder, by folder, then by file (resolved), in the order first read,
 * with every chain that reached it. A file under two folders (a skill inside another's folder) is the
 * deepest one's. A folder's own SKILL.md is left out: its loads are the skill's (skillsRead), counted once.
 */
export function folderReads(reads: readonly FileRead[], folders: Iterable<string>, cwd: string): Map<string, Map<string, LineChain[]>> {
  const dirs = [...new Set(folders)].sort((a, b) => b.length - a.length);
  const out = new Map<string, Map<string, LineChain[]>>();
  for (const r of reads) {
    const abs = resolveToolPath(r.cwd ?? cwd, r.path);
    const dir = dirs.find((d) => abs.startsWith(d + sep));
    if (!dir || abs === `${dir}${sep}SKILL.md`) continue;
    const files = out.get(dir) ?? new Map<string, LineChain[]>();
    files.set(abs, [...(files.get(abs) ?? []), ...r.chains]);
    out.set(dir, files);
  }
  return out;
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i;

/** What the lines `chains` reach of one file put in front of the model, against the file as it is now
    (`"whole"`: all of it, an invocation's body). null when it reached none or the file can't be read. An
    image costs pi's flat estimate, whatever part was asked for. */
export async function loadedFileOf(path: string, label: string, chains: readonly LineChain[] | "whole", readText: (path: string) => Promise<string>): Promise<SessionContextLoadedFile | null> {
  if (IMAGE_FILE.test(path)) return { path, label, tokens: tokensOf(IMAGE_CHARS) };
  const text = await readText(path).catch(() => null);
  if (text === null) return null;
  const file = fileLinesOf(text);
  if (chains === "whole") return file.count > 0 ? { path, label, tokens: estimateTokens(text) } : null;
  const reached = linesLoaded(chains, file);
  if (reached.size === 0) return null;
  if (reached.size >= file.count) return { path, label, tokens: estimateTokens(text) };
  const lines = text.split("\n");
  let chars = 0;
  for (const n of reached) chars += (lines[n - 1] ?? "").length + 1;
  return { path, label, tokens: tokensOf(chars), linesRead: reached.size, lines: file.count };
}

/** What one skill's loads put in context: its SKILL.md by its own loads (`own`), then each other file of its
    folder the chat read (`others`). Empty when nothing was. */
export async function skillLoaded(
  path: string,
  own: readonly SkillLoad[],
  others: ReadonlyMap<string, readonly LineChain[]> | undefined,
  readText: (path: string) => Promise<string>,
  folder: string | null,
): Promise<Pick<SessionContextPart, "loadedTokens" | "loadedFiles">> {
  const label = (p: string) => (folder ? relative(folder, p).split(sep).join("/") : basename(p));
  const files: SessionContextLoadedFile[] = [];
  if (own.length > 0) {
    const whole = own.some((u) => !u.chains);
    const f = await loadedFileOf(path, label(path), whole ? "whole" : own.flatMap((u) => u.chains!), readText);
    if (f) files.push(f);
  }
  for (const [p, chains] of others ?? []) {
    const f = await loadedFileOf(p, label(p), chains, readText);
    if (f) files.push(f);
  }
  return files.length ? { loadedTokens: files.reduce((n, f) => n + f.tokens, 0), loadedFiles: files } : {};
}

/** A skill's read state on this chat's branch, by its name and SKILL.md path (`lines`: the file's length, if
    known), with what it loaded from its folder. */
type SkillReadStateOf = (name: string, path: string, lines?: number) => Promise<Pick<SessionContextPart, "read" | "linesRead" | "lines" | "loadedTokens" | "loadedFiles">>;

/** The skills of folders below `cwd` as the tab lists them: each one the walk finds (or the branch's blocks
    still hold, should its file have gone or the walk stopped short), offered or not, read or not. A file the
    chat's starting list has isn't one. `same`: names more than one row has, which match by path alone.
    Sizes: an offered one its listing, as it is in the window; one not offered yet what it would add; a
    manual-only one its whole text. */
export async function nestedSkillParts(
  cwd: string,
  branch: readonly HEntry[],
  walk: ReturnType<typeof listSubfolderSkills>,
  startingPaths: ReadonlySet<string>,
  readStateOf: SkillReadStateOf,
): Promise<SessionContextPart[]> {
  const offered = new Map(offeredSkills(branch).map((s) => [s.filePath, s]));
  const rows = new Map<string, { name: string; description: string; filePath: string; dir: string; manualOnly: boolean }>();
  for (const s of walk.skills) if (!startingPaths.has(s.filePath)) rows.set(s.filePath, s);
  for (const s of offered.values()) if (!rows.has(s.filePath)) rows.set(s.filePath, { ...s, manualOnly: false });
  return Promise.all([...rows.values()].map(async (s) => {
    const isOffered = offered.has(s.filePath);
    const state = await readStateOf(s.name, s.filePath);
    const whole = measureFile(s.filePath)?.tokens;
    const tokens = s.manualOnly ? (whole ?? 0) : !isOffered && state.read ? 0 : skillListingTokens(s.name, s.description, s.filePath);
    return {
      id: `skill:${s.filePath}`,
      label: s.name,
      ...(s.description ? { detail: s.description.trim() } : {}),
      path: s.filePath,
      tokens,
      ...state,
      ...(!s.manualOnly && whole !== undefined ? { fileTokens: whole } : {}),
      folder: s.dir,
      offered: isOffered,
      ...(s.manualOnly ? { manualOnly: true as const } : {}),
    };
  }));
}

export async function getContextView(path: string, deps: ContextViewDeps = {}): Promise<SessionContextView> {
  const now = deps.now ?? Date.now;
  const setup = await (deps.setup ?? ((p) => getSessionSetup(p)))(path);
  if (setup.state === "remote") return { state: "remote", cwd: setup.cwd, checkedAt: now() };
  if (setup.state !== "ok") return { state: "unavailable", cwd: setup.cwd, reason: setup.reason, checkedAt: now() };
  const cwd = setup.cwd;

  const [held, branch] = await Promise.all([(deps.held ?? heldPrompt)(path), (deps.branch ?? readBranch)(path).catch(() => [] as HEntry[])]);
  const ctx = await (deps.context ?? resolveContext)(contextOfBranch(branch));

  // What loads at the start only: a row the folder's scan lists for a decision (scanOnly) isn't loaded there.
  const instructions: SessionContextPart[] = setup.context
    .filter((f) => !f.off && !f.scanOnly)
    .map((f) => ({ id: `file:${f.path}`, label: labelOf(cwd, f.path), path: f.path, tokens: f.tokens ?? Math.ceil(f.bytes / CHARS_PER_TOKEN) }));
  const loads = skillsRead(branch, cwd);
  // The skills a folder below cwd has, for a chat that gets them: none where it loads no skills, or where its
  // tools can't both touch a file and read one (§chat.subfolder-skills/offering).
  const toolNames = held ? new Set(held.tools.map((t) => t.name)) : null;
  // None at all where the chat doesn't look below its folder (server/skill-descent.ts): its hook offers none.
  const descends = deps.descends ? deps.descends(cwd) : skillDescentAllowed(cwd, { home: homedir(), inProject: await inProjectHere(cwd) });
  const getsNested = descends && !held?.loader?.noSkills && (!toolNames || (["read", "edit", "write"].some((t) => toolNames.has(t)) && ["read", "bash"].some((t) => toolNames.has(t))));
  const skillWalk = getsNested ? (deps.nestedSkills ?? ((c) => listSubfolderSkills(c, piSkillsIn)))(cwd) : { skills: [], incomplete: false };
  const startingPaths = new Set(setup.skills.filter((k) => !k.scanOnly).map((k) => k.path));
  // A name two rows share matches by path alone: reading one of them says nothing of the other.
  const uses = new Map<string, number>();
  for (const n of [...setup.skills.filter((k) => !k.off && !k.scanOnly).map((k) => k.name), ...skillWalk.skills.filter((s) => !startingPaths.has(s.filePath)).map((s) => s.name), ...offeredSkills(branch).filter((s) => !skillWalk.skills.some((w) => w.filePath === s.filePath)).map((s) => s.name)]) uses.set(n, (uses.get(n) ?? 0) + 1);
  // Each file read once per view, however many rows ask for it.
  const texts = new Map<string, Promise<string>>();
  const readRaw = deps.readText ?? ((p: string) => readFile(p, "utf8"));
  const readText = (p: string): Promise<string> => {
    let t = texts.get(p);
    if (!t) texts.set(p, (t = readRaw(p)));
    return t;
  };
  // What the chat read of each skill's other files: every row's folder, so a file is the deepest one's.
  const listedPaths = [
    ...setup.skills.filter((k) => !k.off && !k.scanOnly).map((k) => k.path),
    ...skillWalk.skills.filter((s) => !startingPaths.has(s.filePath)).map((s) => s.filePath),
    ...offeredSkills(branch).map((s) => s.filePath),
  ];
  const byFolder = folderReads(collectFileReads(skillLinesOf(visiblePart(branch), cwd)), listedPaths.map((p) => skillFolderOf(p, cwd)).filter((d): d is string => d !== null), cwd);
  const readStateOf: SkillReadStateOf = async (name, path, lines) => {
    const byPath = loads.paths.get(resolveToolPath(cwd, path)) ?? [];
    // A load found by name and by path is one load, not two.
    const mine = (uses.get(name) ?? 0) <= 1 ? [...new Set([...(loads.names.get(name) ?? []), ...byPath])] : byPath;
    const text = mine.length > 0 ? await readText(path).catch(() => null) : null;
    const folder = skillFolderOf(path, cwd);
    return { ...skillReadState(mine, text, lines), ...(await skillLoaded(path, mine, folder ? byFolder.get(folder) : undefined, readText, folder)) };
  };
  const skills: SessionContextPart[] = await Promise.all(
    setup.skills
      .filter((k) => !k.off && !k.scanOnly)
      .map(async (k) => ({
        id: `skill:${k.name}`,
        label: k.name,
        ...(k.description ? { detail: k.description } : {}),
        path: k.path,
        tokens: k.manualOnly ? (k.tokens ?? Math.ceil(k.bytes / CHARS_PER_TOKEN)) : (k.listingTokens ?? skillListingTokens(k.name, k.description, k.path)),
        ...(await readStateOf(k.name, k.path, k.lines)),
        ...(!k.manualOnly && k.tokens !== undefined ? { fileTokens: k.tokens } : {}),
        ...(k.manualOnly ? { manualOnly: true as const } : {}),
      })),
  );
  const nestedSkills = getsNested ? await nestedSkillParts(cwd, branch, skillWalk, startingPaths, readStateOf) : [];
  // What the blocks on the branch add to Conversation is counted under Skills offered.
  const offeredListed = nestedSkills.reduce((n, s) => n + (s.offered ? s.tokens : 0), 0);

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
  const allow = !descends ? null : held?.loader ? deeperContextAllow(held.loader) : () => true;
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
    conversation: Math.max(0, conversationTokens(branch) - loadedNested - offeredListed),
    talk: conversationTalk(branch, loadedNested + offeredListed),
    nested,
    ...(nestedSkills.length ? { nestedSkills } : {}),
    ...(walk.incomplete || skillWalk.incomplete ? { nestedIncomplete: true as const } : {}),
    checkedAt: now(),
  };
}
