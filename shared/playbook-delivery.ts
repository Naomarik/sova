/**
 * The playbook inside every fire (§chat.schedules/delivery): what a session already holds of a
 * playbook, folded from its own active branch; whether the next fire sends the entry full, as a
 * change or as unchanged; which detail files it read that changed since; and the block itself.
 * Pure and harness-neutral: it reads Sova's history shapes (shared/harness-history.ts) and takes
 * the hash and the file reads as functions, so the server's keeper and its tests share it.
 */
import type { HBlock, HEntry } from "./harness-history";

/** The tool a session reads the playbook's files with (§chat.schedules/playbook-read). */
export const PLAYBOOK_READ_TOOL = "playbook_read";
/** The note that re-sends the entry after a compaction in the middle of a fired run. */
export const PLAYBOOK_NOTE = "sova-playbook";
/** More than this share of an entry's lines changed: it goes whole, never as a diff. */
export const DIFF_MAX_SHARE = 1 / 3;
/** A diff of files this big (lines × lines) isn't worked out: it goes whole. */
const DIFF_MAX_CELLS = 4_000_000;

export type Load = "full" | "diff" | "unchanged";

/** A playbook as a fire delivers it: its id, its folder (absolute) and its entry file's name. */
export interface BundleRef {
  id: string;
  dir: string;
  entry: string;
}

/** `playbook_read`'s result details: which version of which file this session was given. */
export interface PlaybookReadDetails {
  v: 1;
  playbook: string;
  file: string;
  sha: string;
}

/** What this session holds of a playbook since its branch's newest compaction. */
export interface Held {
  /** The sha of the entry version it last loaded, if any. */
  entry?: string;
  /** Each detail file it read (bundle-relative), with the sha of what it was given. */
  reads: Record<string, string>;
}

export interface FoldOpts {
  hash(text: string): string;
  /** A version Sova kept (a text it gave some session): a plain read of it counts as a whole read. */
  knownVersion(sha: string): boolean;
  /** A tool argument's path, absolute (relative paths resolved against the session's folder). */
  resolve(path: string): string;
}

/** A playbook block's opening tag, parsed. */
export interface BlockTag {
  id: string;
  dir?: string;
  entry?: string;
  sha: string;
  load: Load;
  base?: string;
}

const TAG_RE = /^<playbook ((?:[a-z]+="[^"]*"\s*)+)>$/;
const ATTR_RE = /([a-z]+)="([^"]*)"/g;
const unq = (s: string) => s.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const q = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** Every playbook block's opening tag in a message's text, in order. */
export function parseBlockTags(text: string): BlockTag[] {
  const out: BlockTag[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = TAG_RE.exec(line.trim());
    if (!m) continue;
    const a: Record<string, string> = {};
    for (const x of m[1]!.matchAll(ATTR_RE)) a[x[1]!] = unq(x[2]!);
    if (!a.id || !a.sha || (a.load !== "full" && a.load !== "diff" && a.load !== "unchanged")) continue;
    out.push({ id: a.id, sha: a.sha, load: a.load, ...(a.dir ? { dir: a.dir } : {}), ...(a.entry ? { entry: a.entry } : {}), ...(a.base ? { base: a.base } : {}) });
  }
  return out;
}

const textOf = (blocks: readonly HBlock[]): string => blocks.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("");

const isReadDetails = (d: unknown): d is PlaybookReadDetails => {
  const o = d as PlaybookReadDetails | null;
  return !!o && o.v === 1 && typeof o.playbook === "string" && typeof o.file === "string" && typeof o.sha === "string";
};

/** A path inside `dir`, as `dir`-relative with forward slashes; null outside it. */
export function within(dir: string, abs: string): string | null {
  const d = dir.replace(/\/+$/, "");
  if (!abs.startsWith(`${d}/`)) return null;
  const rel = abs.slice(d.length + 1);
  return rel.split("/").some((p) => p === ".." || p === ".") || !rel ? null : rel;
}

/**
 * What the session holds of `bundle`, from its active branch: only what came after the branch's
 * newest compaction (or context edit) counts. A load is a fire's block (any load: the session then
 * holds that version), the re-prime note, a `playbook_read` result, or a plain `read` whose returned
 * text is a whole version (a kept one, or the file as it is now).
 */
export function foldHeld(branch: readonly HEntry[], bundle: BundleRef, opts: FoldOpts & { currentSha(file: string): string | null }): Held {
  let held: Held = { reads: {} };
  const calls = new Map<string, unknown>();
  for (const h of branch) {
    if (h.kind === "compaction" || h.kind === "context-edit") {
      held = { reads: {} };
      continue;
    }
    if (h.kind === "user") {
      for (const t of parseBlockTags(textOf(h.blocks))) if (t.id === bundle.id) held.entry = t.sha;
    } else if (h.kind === "note" && h.noteType === PLAYBOOK_NOTE) {
      const d = h.details as { v?: number; playbook?: string; sha?: string } | undefined;
      if (d?.v === 1 && d.playbook === bundle.id && typeof d.sha === "string") held.entry = d.sha;
    } else if (h.kind === "assistant") {
      for (const b of h.blocks) if (b.type === "toolCall") calls.set(b.id, b.arguments);
    } else if (h.kind === "tool-result" && !h.isError) {
      if (h.tool === PLAYBOOK_READ_TOOL && isReadDetails(h.details) && h.details.playbook === bundle.id) {
        held.reads[h.details.file] = h.details.sha;
        if (h.details.file === bundle.entry) held.entry = h.details.sha;
      } else if (h.tool === "read" && h.callId) {
        const args = calls.get(h.callId) as { path?: unknown; offset?: unknown; limit?: unknown } | undefined;
        if (typeof args?.path !== "string" || args.offset !== undefined || args.limit !== undefined) continue;
        const rel = within(bundle.dir, opts.resolve(args.path));
        if (!rel) continue;
        // Only the bytes the read actually returned: a whole known version, or the file as it is now.
        const sha = opts.hash(textOf(h.blocks));
        if (!opts.knownVersion(sha) && sha !== opts.currentSha(rel)) continue;
        held.reads[rel] = sha;
        if (rel === bundle.entry) held.entry = sha;
      }
    }
  }
  return held;
}

/** The detail files this session read that changed or went since, listed until read again. */
export function changedReads(held: Held, entry: string, currentSha: (file: string) => string | null): { file: string; removed: boolean }[] {
  const out: { file: string; removed: boolean }[] = [];
  for (const [file, sha] of Object.entries(held.reads)) {
    if (file === entry) continue;
    const now = currentSha(file);
    if (now !== sha) out.push({ file, removed: now === null });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

// ── The line diff ───────────────────────────────────────────────────────────────────────────────

type Op = { k: "=" | "-" | "+"; line: string };

/** The line-by-line edit from `a` to `b` (a longest common subsequence), or null when too big. */
export function lineOps(a: readonly string[], b: readonly string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n * m > DIFF_MAX_CELLS) return null;
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ k: "=", line: a[i]! });
      i++;
      j++;
    } else if (L[(i + 1) * w + j]! >= L[i * w + j + 1]!) ops.push({ k: "-", line: a[i++]! });
    else ops.push({ k: "+", line: b[j++]! });
  }
  while (i < n) ops.push({ k: "-", line: a[i++]! });
  while (j < m) ops.push({ k: "+", line: b[j++]! });
  return ops;
}

const splitLines = (t: string): string[] => (t === "" ? [] : t.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** A unified diff of `ops` with `ctx` lines of context around each change. */
export function unified(ops: readonly Op[], ctx = 2): string {
  const out: string[] = [];
  let k = 0;
  let ai = 1;
  let bi = 1;
  const pos: { a: number; b: number }[] = [];
  for (const o of ops) {
    pos.push({ a: ai, b: bi });
    if (o.k !== "+") ai++;
    if (o.k !== "-") bi++;
  }
  while (k < ops.length) {
    if (ops[k]!.k === "=") {
      k++;
      continue;
    }
    let start = Math.max(0, k - ctx);
    let end = k;
    // Extend over changes closer than 2×ctx apart, so nearby edits share one hunk.
    for (;;) {
      while (end < ops.length && ops[end]!.k !== "=") end++;
      let next = end;
      while (next < ops.length && ops[next]!.k === "=") next++;
      if (next < ops.length && next - end <= 2 * ctx) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + ctx);
    const hunk = ops.slice(start, stop);
    const aLen = hunk.filter((o) => o.k !== "+").length;
    const bLen = hunk.filter((o) => o.k !== "-").length;
    out.push(`@@ -${pos[start]!.a},${aLen} +${pos[start]!.b},${bLen} @@`);
    for (const o of hunk) out.push(`${o.k === "=" ? " " : o.k}${o.line}`);
    k = stop;
    start = stop;
  }
  return out.join("\n");
}

/** How the entry goes: whole, as a change against `old`, or unchanged. */
export function decideLoad(heldSha: string | undefined, now: { sha: string; text: string }, old: string | null, forceFull: boolean): { load: Load; base?: string; body: string } {
  if (forceFull || !heldSha) return { load: "full", body: now.text };
  if (heldSha === now.sha) return { load: "unchanged", base: heldSha, body: "Unchanged since you last loaded it." };
  if (old === null) return { load: "full", body: now.text };
  const a = splitLines(old);
  const b = splitLines(now.text);
  const ops = lineOps(a, b);
  if (!ops) return { load: "full", body: now.text };
  const changed = ops.filter((o) => o.k !== "=").length;
  if (changed / Math.max(a.length, b.length, 1) > DIFF_MAX_SHARE) return { load: "full", body: now.text };
  const diff = unified(ops);
  if (diff.length >= now.text.length) return { load: "full", body: now.text };
  return { load: "diff", base: heldSha, body: `Changed since you last loaded version ${heldSha}:\n${diff}` };
}

/** The block a fire carries (§chat.schedules/delivery). */
export function renderBlock(bundle: BundleRef, sha: string, d: { load: Load; base?: string; body: string }, changed: readonly { file: string; removed: boolean }[]): string {
  const attrs = [`id="${q(bundle.id)}"`, `dir="${q(bundle.dir)}"`, `entry="${q(bundle.entry)}"`, `sha="${sha}"`, `load="${d.load}"`, ...(d.base ? [`base="${d.base}"`] : [])];
  const lines = [`<playbook ${attrs.join(" ")}>`, d.body.replace(/\n+$/, "")];
  if (d.load !== "full") lines.push(`If you no longer have version ${d.base}, call ${PLAYBOOK_READ_TOOL} with file "${bundle.entry}".`);
  if (changed.length) lines.push(`Changed since you read it: ${changed.map((c) => (c.removed ? `${c.file} (removed)` : c.file)).join(", ")}. Call ${PLAYBOOK_READ_TOOL} to read them again.`);
  lines.push("</playbook>");
  return lines.join("\n");
}

/** A fire's instruction line before its block. */
export const deliveryInstruction = (title: string): string => `Run the playbook "${title}": its entry is in the playbook block below.`;

/** The wake card's words for a load (§chat.schedules/delivery). */
export const LOAD_WORDS: Record<Load, string> = { full: "Playbook in full", diff: "Playbook changed", unchanged: "Playbook unchanged" };
