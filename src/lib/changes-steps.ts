// The change as numbered steps (§chat.changes/steps): which part of a git diff each agent turn
// made. Pure: the viewer hands in the transcript rows and the parsed diff, and gets back steps
// whose hunks partition the diff — every hunk in exactly one step, leftovers in "Other changes".
//
// A turn is attributed a hunk by content first (the lines its edit/write calls added or removed,
// against the hunk's own), then by line range (the edit's patch, when the tool recorded one),
// else nobody claims it. Content survives later edits shifting line numbers; ranges catch hunks
// whose lines are too short to say anything ("}", "") on their own.

import type { ToolContent, TranscriptItem } from "../../shared/protocol";
import { isObj, resultDetails as rowDetails, str, toolCallArgs, toolResultView } from "./message";

/** One hunk of the diff, as the renderer's parser gives it (structural, so either parser fits). */
export interface StepHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  rows: { kind: "add" | "del" | "ctx"; text: string }[];
}

/** One file of the diff. `hunks` null: its patch isn't loaded (or too big); null or empty (a
    rename, mode change or empty file with no line changes), the file is one unit. */
export interface StepFile {
  path: string;
  oldPath?: string;
  hunks: StepHunk[] | null;
}

/** What one edit/write call did to one file, in the tool's own path. */
export interface TurnEdit {
  path: string;
  added: string[];
  removed: string[];
  /** New-side line ranges [first, last] from the tool's recorded patch; empty when it has none. */
  ranges: [number, number][];
  /** A whole-file write: every line of the file came from it. */
  whole?: boolean;
}

/** An agent turn that edited files: the user prompt that started it, and its successful edits. */
export interface Turn {
  id: string;
  title: string;
  edits: TurnEdit[];
}

/** A hunk by file and index; -1 is the whole file (its hunks unknown, or it has none). */
export interface HunkRef {
  path: string;
  hunk: number;
}

export interface Step {
  /** 1-based; "Other changes" has none (0). */
  n: number;
  id: string;
  title: string;
  note?: string;
  hunks: HunkRef[];
  /** Files in diff order, each once. */
  files: string[];
  source: "turn" | "agent" | "other";
  /** Commits that made this step's hunks (full ids), oldest first; empty without origins. */
  commits: string[];
  /** Some of its hunks' commits couldn't be read (timed out, or that patch isn't loaded). */
  commitsUnknown?: true;
  /** An agent step left holding nothing: everything it names is held by earlier steps
      (`heldBy`), or nothing it names is in this diff. */
  empty?: "taken" | "gone";
  /** For `empty: "taken"`: the earlier steps holding what it names, ascending. */
  heldBy?: number[];
}

export interface StepPlan {
  /** Agent steps: every one, at its own number (empty ones included). Turn steps: numbered in order. */
  steps: Step[];
  /** Hunks no step claimed, or null when there are none. */
  other: Step | null;
  /** Step numbers per file path, ascending. */
  byFile: Record<string, number[]>;
}

/** A step as the agent wrote it: the show_changes tool's `details.steps` (pi-config/extensions/show-changes). */
export interface AgentStepInput {
  title: string;
  why?: string;
  /** Older cards carry it; ignored (commits replace it). */
  buildsOn?: number[];
  /** Repo-relative paths; a start is the hunk header's number (`@@ -oldStart +newStart @@`), and a
      ref with neither is every hunk of the file. */
  hunks: { path: string; oldStart?: number; newStart?: number }[];
}

export const OTHER_TITLE = "Other changes";
const TITLE_MAX = 80;
/** A line shorter than this (trimmed) is too common to attribute a hunk by itself. */
const MIN_SIGNAL = 3;
/** Line slack when a hunk's range is compared with an edit's: context and later shifts. */
const RANGE_SLACK = 3;

const EDIT_TOOLS = new Set(["edit", "Edit", "MultiEdit", "multiedit"]);
const WRITE_TOOLS = new Set(["write", "Write"]);

/** "Fix the parser\nand more" → "Fix the parser"; long lines end in "…". */
export function stepTitle(text: string | undefined): string {
  const line = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "Untitled turn";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

const lines = (s: string) => s.split("\n");

/** New-side ranges and changed lines of a unified patch (only what attribution needs). */
export function patchFacts(patch: string): { added: string[]; removed: string[]; ranges: [number, number][] } {
  const added: string[] = [];
  const removed: string[] = [];
  const ranges: [number, number][] = [];
  let inHunk = false;
  for (const l of lines(patch)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      ranges.push([start, start + Math.max(count, 1) - 1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) added.push(l.slice(1));
    else if (l.startsWith("-")) removed.push(l.slice(1));
  }
  return { added, removed, ranges };
}

/** Claude Code's structuredPatch: [{ newStart, newLines, lines: ["+x", "-y", " z"] }]. */
function structuredFacts(sp: unknown[]): { added: string[]; removed: string[]; ranges: [number, number][] } {
  const added: string[] = [];
  const removed: string[] = [];
  const ranges: [number, number][] = [];
  for (const h of sp) {
    if (!isObj(h)) continue;
    const start = typeof h.newStart === "number" ? h.newStart : null;
    const count = typeof h.newLines === "number" ? h.newLines : null;
    if (start !== null && count !== null) ranges.push([start, start + Math.max(count, 1) - 1]);
    if (!Array.isArray(h.lines)) continue;
    for (const l of h.lines) {
      if (typeof l !== "string") continue;
      if (l.startsWith("+")) added.push(l.slice(1));
      else if (l.startsWith("-")) removed.push(l.slice(1));
    }
  }
  return { added, removed, ranges };
}

/** The edit list a pi `edit` or a Claude Code Edit/MultiEdit call carries. */
function editPairs(args: Record<string, unknown>): { oldText: string; newText: string }[] {
  const list: unknown[] = Array.isArray(args.edits) ? args.edits : [args];
  const out: { oldText: string; newText: string }[] = [];
  for (const e of list) {
    if (!isObj(e)) continue;
    const oldText = str(e.oldText) ?? str(e.old_string);
    const newText = str(e.newText) ?? str(e.new_string);
    if (oldText !== undefined && newText !== undefined) out.push({ oldText, newText });
  }
  return out;
}

/** The result's details: pi's `{patch}` or Claude Code's `{structuredPatch}`, if recorded. */
function resultDetails(details: unknown): Record<string, unknown> | undefined {
  return isObj(details) ? details : undefined;
}

const isEditCall = (it: TranscriptItem): boolean => it.kind === "tool-call" && !!it.text && (EDIT_TOOLS.has(it.text) || WRITE_TOOLS.has(it.text));

/**
 * The edit and write calls whose arguments and details their rows don't carry (lib/tool-content):
 * the ones `turnsFromItems` reads, each with its result's row. Failed and unanswered calls are left
 * out, as turnsFromItems leaves them.
 */
export function editCallsToLoad(items: readonly TranscriptItem[]): { rowId: string; resultId: string; size: number }[] {
  const results = new Map<string, TranscriptItem>();
  for (const it of items) if (it.kind === "tool-result" && it.toolCallId) results.set(it.toolCallId, it);
  return items.flatMap((it) => {
    const r = it.toolCallId ? results.get(it.toolCallId) : undefined;
    if (!isEditCall(it) || !r || toolResultView(r).isError || !(it.tool?.lazy || r.tool?.lazy)) return [];
    return [{ rowId: it.id, resultId: r.id, size: (it.tool?.bytes ?? 0) + (r.tool?.bytes ?? 0) }];
  });
}

/** One successful edit/write call as a TurnEdit, or null when it isn't one. */
export function editOf(name: string, args: unknown, details?: Record<string, unknown>): TurnEdit | null {
  if (!isObj(args)) return null;
  const path = str(args.path) ?? str(args.file_path);
  if (!path) return null;
  if (WRITE_TOOLS.has(name)) {
    const content = str(args.content);
    if (content === undefined) return null;
    return { path, added: lines(content), removed: [], ranges: [], whole: true };
  }
  if (!EDIT_TOOLS.has(name)) return null;
  const pairs = editPairs(args);
  const recorded = str(details?.patch)
    ? patchFacts(details!.patch as string)
    : Array.isArray(details?.structuredPatch)
      ? structuredFacts(details!.structuredPatch as unknown[])
      : null;
  if (recorded && (recorded.added.length || recorded.removed.length)) return { path, ...recorded };
  if (pairs.length === 0) return null;
  return {
    path,
    added: pairs.flatMap((p) => lines(p.newText)),
    removed: pairs.flatMap((p) => lines(p.oldText)),
    ranges: recorded?.ranges ?? [],
  };
}

/**
 * The session's agent turns that edited files, in order: each starts at a user (or wake) row and
 * holds the successful edit/write calls until the next one. Failed calls and calls with no result
 * yet change nothing on disk that we can vouch for, so they are left out.
 */
export function turnsFromItems(items: TranscriptItem[], content: ReadonlyMap<string, ToolContent> = new Map()): Turn[] {
  const results = new Map<string, TranscriptItem>();
  for (const it of items) if (it.kind === "tool-result" && it.toolCallId) results.set(it.toolCallId, it);
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const it of items) {
    if (it.kind === "user" || it.kind === "wake") {
      cur = { id: it.id, title: it.kind === "wake" ? "Wake-up" : stepTitle(it.text), edits: [] };
      turns.push(cur);
      continue;
    }
    if (it.kind !== "tool-call" || !it.toolCallId || !it.text) continue;
    const result = results.get(it.toolCallId);
    if (!result || toolResultView(result).isError) continue;
    const got = content.get(it.id);
    // Claude Code records an edit's patch beside the message (`toolUseResult`), not in its details.
    const details = got?.result ? (resultDetails(got.result.details) ?? resultDetails(got.result.toolUseResult)) : resultDetails(rowDetails(result));
    const edit = editOf(it.text, got?.args ?? toolCallArgs(it), details);
    if (!edit) continue;
    if (!cur) {
      cur = { id: it.id, title: "Before the first prompt", edits: [] };
      turns.push(cur);
    }
    cur.edits.push(edit);
  }
  return turns.filter((t) => t.edits.length > 0);
}

/** `a/./b/../c` → `a/c`; keeps a leading "/". */
function normalize(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
}

/**
 * A tool's path as a path in the diff: absolute, or relative to the session's folder, made
 * relative to the repository root. Null when it lies outside the root.
 */
export function repoPath(path: string, cwd: string, root: string): string | null {
  const abs = normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  const r = normalize(root);
  if (abs.startsWith(`${r}/`)) return abs.slice(r.length + 1);
  // A relative path when the root isn't known in absolute terms (tests, or a remote placeholder).
  if (!path.startsWith("/") && !r.startsWith("/")) return normalize(path);
  return null;
}

const signal = (xs: string[]) => new Set(xs.map((l) => l.trim()).filter((l) => l.length >= MIN_SIGNAL));

function hunkRange(h: StepHunk): [number, number] {
  return [h.newStart, h.newStart + Math.max(h.newLines, 1) - 1];
}

const overlaps = (a: [number, number], b: [number, number], slack = 0) => a[0] <= b[1] + slack && b[0] <= a[1] + slack;

/** Index into `candidates` of the turn that made this hunk, or -1. Later turns win ties. */
function attribute(h: StepHunk, candidates: TurnEdit[][]): number {
  const add = signal(h.rows.filter((l) => l.kind === "add").map((l) => l.text));
  const del = signal(h.rows.filter((l) => l.kind === "del").map((l) => l.text));
  let best = -1;
  let bestScore = 0;
  candidates.forEach((edits, i) => {
    let score = 0;
    for (const e of edits) {
      for (const l of signal(e.added)) if (add.has(l)) score++;
      for (const l of signal(e.removed)) if (del.has(l)) score++;
    }
    if (score > 0 && score >= bestScore) {
      best = i;
      bestScore = score;
    }
  });
  if (best >= 0) return best;
  const range = hunkRange(h);
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (candidates[i]!.some((e) => e.ranges.some((r) => overlaps(r, range, RANGE_SLACK)))) return i;
  }
  return -1;
}

/** A file with no hunks to name (unknown, or none: no line changes) is one whole-file unit. */
const isWhole = (file: StepFile) => file.hunks === null || file.hunks.length === 0;

function refsOf(file: StepFile): HunkRef[] {
  return isWhole(file) ? [{ path: file.path, hunk: -1 }] : file.hunks!.map((_, i) => ({ path: file.path, hunk: i }));
}

/**
 * Which commits made each unit, from the patch reads (§chat.changes/steps): per file, one list of
 * commit ids per unit in patch order (a file with no hunks has one, the whole file's), or
 * "unknown" when its history read failed. A file not in `files` hasn't been read.
 */
export interface StepOrigins {
  files: ReadonlyMap<string, readonly (readonly string[])[] | "unknown">;
  commits: ReadonlyMap<string, { subject: string; authorTime: number }>;
}

/** What a patch read with origins carries (DiffFilePatch's fields, structurally). */
export interface PatchOrigins {
  path: string;
  hunkCommits?: number[][];
  commits?: { sha: string; subject: string; authorTime: number }[];
  originsUnknown?: true;
}

/** StepOrigins from patch reads; a read with neither origins nor "unknown" is left out (not read). */
export function stepOrigins(patches: Iterable<PatchOrigins>): StepOrigins {
  const files = new Map<string, string[][] | "unknown">();
  const commits = new Map<string, { subject: string; authorTime: number }>();
  for (const p of patches) {
    if (p.originsUnknown) {
      files.set(p.path, "unknown");
      continue;
    }
    if (!p.hunkCommits || !p.commits) continue;
    const list = p.commits;
    for (const c of list) commits.set(c.sha, { subject: c.subject, authorTime: c.authorTime });
    if (p.hunkCommits.some((u) => u.some((i) => !list[i]))) files.set(p.path, "unknown");
    else files.set(p.path, p.hunkCommits.map((u) => u.map((i) => list[i]!.sha)));
  }
  return { files, commits };
}

/** A step's commits: its units' commits together, no repeats, oldest first (ties as first seen). */
function commitsOf(hunks: HunkRef[], origins: StepOrigins | undefined): Pick<Step, "commits" | "commitsUnknown"> {
  if (!origins) return { commits: [] };
  const seen: string[] = [];
  const add = (shas: readonly string[]) => {
    for (const sha of shas) if (!seen.includes(sha)) seen.push(sha);
  };
  let unknown = false;
  for (const r of hunks) {
    const units = origins.files.get(r.path);
    if (units === undefined || units === "unknown") unknown = true;
    else if (r.hunk < 0) units.forEach(add);
    else if (r.hunk < units.length) add(units[r.hunk]!);
    else unknown = true;
  }
  const time = (sha: string) => origins.commits.get(sha)?.authorTime ?? Number.POSITIVE_INFINITY;
  const commits = seen.map((sha, i) => ({ sha, i })).sort((a, b) => time(a.sha) - time(b.sha) || a.i - b.i).map((c) => c.sha);
  return unknown ? { commits, commitsUnknown: true } : { commits };
}

type Draft = { id: string; title: string; note?: string; hunks: HunkRef[]; source: Step["source"]; empty?: Step["empty"]; heldBy?: number[] };

/** Numbers, files, commits and the per-file index, from claimed hunks in diff order. */
function finish(drafts: Draft[], leftovers: HunkRef[], diffOrder: string[], origins: StepOrigins | undefined): StepPlan {
  const order = new Map(diffOrder.map((p, i) => [p, i]));
  const sortRefs = (refs: HunkRef[]) =>
    refs.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0) || a.hunk - b.hunk);
  const filesOf = (refs: HunkRef[]) => [...new Set(refs.map((r) => r.path))];
  const steps: Step[] = [];
  const byFile: Record<string, number[]> = {};
  for (const d of drafts) {
    const n = steps.length + 1;
    const hunks = sortRefs(d.hunks);
    const files = filesOf(hunks);
    steps.push({
      n,
      id: d.id,
      title: d.title,
      note: d.note,
      hunks,
      files,
      source: d.source,
      ...commitsOf(hunks, origins),
      ...(d.empty ? { empty: d.empty } : {}),
      ...(d.heldBy ? { heldBy: d.heldBy } : {}),
    });
    for (const f of files) (byFile[f] ??= []).push(n);
  }
  const rest = sortRefs(leftovers);
  const other: Step | null = rest.length
    ? { n: 0, id: "other", title: OTHER_TITLE, hunks: rest, files: filesOf(rest), source: "other", ...commitsOf(rest, origins) }
    : null;
  return { steps, other, byFile };
}

/**
 * Steps from the session's turns: each turn that made at least one hunk of this diff is a step,
 * titled from its prompt. Turns whose edits are all gone from the diff (committed before the
 * compared range, or undone) are left out.
 */
export function stepsFromTurns(turns: Turn[], files: StepFile[], cwd: string, root: string, origins?: StepOrigins): StepPlan {
  const claimed = turns.map(() => [] as HunkRef[]);
  const leftovers: HunkRef[] = [];
  const mapped = turns.map((t) => t.edits.map((e) => ({ ...e, repo: repoPath(e.path, cwd, root) })));
  for (const file of files) {
    const names = new Set([file.path, file.oldPath].filter((p): p is string => !!p));
    const touching: number[] = [];
    const edits: TurnEdit[][] = [];
    mapped.forEach((es, i) => {
      const mine = es.filter((e) => e.repo !== null && names.has(e.repo));
      if (mine.length) {
        touching.push(i);
        edits.push(mine);
      }
    });
    if (isWhole(file)) {
      const last = touching.at(-1);
      (last === undefined ? leftovers : claimed[last]!).push({ path: file.path, hunk: -1 });
      continue;
    }
    file.hunks!.forEach((h, hi) => {
      const k = touching.length ? attribute(h, edits) : -1;
      (k < 0 ? leftovers : claimed[touching[k]!]!).push({ path: file.path, hunk: hi });
    });
  }
  const drafts = turns
    .map((t, i) => ({ id: `turn:${t.id}`, title: t.title, hunks: claimed[i]!, source: "turn" as const }))
    .filter((d) => d.hunks.length > 0);
  return finish(drafts, leftovers, files.map((f) => f.path), origins);
}

/** Does an agent's hunk ref name this hunk: the header's own number, else a line inside its range. */
function refMatches(ref: AgentStepInput["hunks"][number], h: StepHunk): boolean {
  const inside = (n: number, start: number, count: number) => n === start || (n >= start && n < start + Math.max(count, 1));
  if (ref.newStart !== undefined) return inside(ref.newStart, h.newStart, h.newLines);
  if (ref.oldStart !== undefined) return inside(ref.oldStart, h.oldStart, h.oldLines);
  return true;
}

/**
 * The agent's own steps, checked against the real diff: each hunk goes to the first step holding
 * a ref that names it (a ref with no start names every hunk of its file; a whole-file unit takes
 * any ref to its file), what nobody names goes to "Other changes". Every step keeps the agent's
 * number; one left holding nothing is `empty`: "taken" when what it names is held by earlier
 * steps, else "gone". Paths are relative to `root`. The agent's buildsOn is ignored.
 */
export function stepsFromAgent(input: AgentStepInput[], files: StepFile[], root: string, origins?: StepOrigins): StepPlan {
  /** Unit key → 1-based number of the step holding it. */
  const owner = new Map<string, number>();
  const key = (r: HunkRef) => `${r.hunk}\u0000${r.path}`;
  const byPath = new Map<string, StepFile>();
  for (const f of files) {
    byPath.set(f.path, f);
    if (f.oldPath) byPath.set(f.oldPath, f);
  }
  const drafts: Draft[] = input.map((s, index) => {
    const hunks: HunkRef[] = [];
    const heldBy = new Set<number>();
    for (const ref of s.hunks) {
      const p = repoPath(ref.path, root, root);
      const file = p === null ? undefined : byPath.get(p);
      if (!file) continue;
      const refs = refsOf(file).filter((r) => r.hunk < 0 || refMatches(ref, file.hunks![r.hunk]!));
      for (const r of refs) {
        const held = owner.get(key(r));
        if (held === undefined) {
          owner.set(key(r), index + 1);
          hunks.push(r);
        } else if (held !== index + 1) heldBy.add(held);
      }
    }
    const draft: Draft = { id: `agent:${index}`, title: stepTitle(s.title), note: s.why?.trim() || undefined, hunks, source: "agent" };
    if (hunks.length === 0) {
      if (heldBy.size) {
        draft.empty = "taken";
        draft.heldBy = [...heldBy].sort((a, b) => a - b);
      } else draft.empty = "gone";
    }
    return draft;
  });
  const leftovers = files.flatMap(refsOf).filter((r) => !owner.has(key(r)));
  return finish(drafts, leftovers, files.map((f) => f.path), origins);
}

/** The hunk indexes of `path` in a step, or null for the whole file (its hunks weren't known). */
export function stepHunksOf(step: Step, path: string): number[] | null {
  const mine = step.hunks.filter((r) => r.path === path);
  return mine.some((r) => r.hunk < 0) ? null : mine.map((r) => r.hunk);
}

/** The step number that holds one hunk of a file, or 0 for "Other changes" / unknown. */
export function stepOfHunk(plan: StepPlan, path: string, hunk: number): number {
  for (const s of plan.steps) if (s.hunks.some((r) => r.path === path && (r.hunk === hunk || r.hunk < 0))) return s.n;
  return 0;
}
