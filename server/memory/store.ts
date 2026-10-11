// A chat's memory sidecar (§chat.memory/log): `<agent dir>/sova/memory/<session id>/`, beside the chat,
// never in its session file. `tree.jsonl` holds the built nodes (append-only; rewritten whole only when a
// rewind or fork drops nodes), `state.json` the saved views and their cached prefixes. Sessions don't sync
// across devices, so neither does this.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentRoot } from "../state-root";
import type { NodeRef, TreeNode } from "./tree";

export const memoryRoot = (): string => join(agentRoot(), "sova", "memory");
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
export function memoryDir(sessionId: string, root = memoryRoot()): string {
  if (!SAFE_ID.test(sessionId)) throw new Error(`not a session id: ${sessionId}`);
  return join(root, sessionId);
}

/** What `state.json` keeps: the view (chat) and the compaction view, each with its batch flag and cached prefix. */
export interface MemoryFileState {
  v: 1;
  view: NodeRef[];
  merging: boolean;
  /** The view lines a turn's stable prefix held, as last sent (the cache split). */
  prefix?: string[];
  /** Tail bytes the turns sent since that prefix was renewed (the cache split's cost so far). */
  prefixSent?: number;
  cview: NodeRef[];
  cmerging: boolean;
  /** The compaction view's lines in the summarizer's system prompt, as last sent. */
  cprefix?: string[];
}

export const emptyState = (): MemoryFileState => ({ v: 1, view: [], merging: false, cview: [], cmerging: false });

const isRef = (v: unknown): v is NodeRef => Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x) && x >= 0);
const isLines = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function parseState(raw: unknown): MemoryFileState {
  const s = emptyState();
  if (!raw || typeof raw !== "object") return s;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.view) && r.view.every(isRef)) s.view = r.view as NodeRef[];
  if (Array.isArray(r.cview) && r.cview.every(isRef)) s.cview = r.cview as NodeRef[];
  s.merging = r.merging === true;
  s.cmerging = r.cmerging === true;
  if (isLines(r.prefix)) s.prefix = r.prefix;
  if (typeof r.prefixSent === "number" && Number.isFinite(r.prefixSent) && r.prefixSent >= 0) s.prefixSent = r.prefixSent;
  if (isLines(r.cprefix)) s.cprefix = r.cprefix;
  return s;
}

function parseNode(line: string): TreeNode | undefined {
  try {
    const n = JSON.parse(line) as Partial<TreeNode>;
    if (!Number.isInteger(n.l) || !Number.isInteger(n.i) || typeof n.text !== "string") return undefined;
    return { l: n.l!, i: n.i!, text: n.text, size: Buffer.byteLength(n.text), ...(typeof n.src === "string" ? { src: n.src } : {}) };
  } catch {
    return undefined;
  }
}

export class MemoryStore {
  constructor(readonly dir: string) {}

  exists(): boolean {
    return existsSync(this.dir);
  }

  /** Every node the file holds; a later line for the same node wins (a rewrite never leaves duplicates). */
  loadNodes(): TreeNode[] {
    let raw: string;
    try {
      raw = readFileSync(join(this.dir, "tree.jsonl"), "utf8");
    } catch {
      return [];
    }
    const out: TreeNode[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const n = parseNode(line);
      if (n) out.push(n);
    }
    return out;
  }

  loadState(): MemoryFileState {
    try {
      return parseState(JSON.parse(readFileSync(join(this.dir, "state.json"), "utf8")));
    } catch {
      return emptyState();
    }
  }

  appendNode(n: TreeNode): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, "tree.jsonl"), `${JSON.stringify({ l: n.l, i: n.i, text: n.text, ...(n.src ? { src: n.src } : {}) })}\n`);
  }

  /** The whole tree again (after dropping nodes), atomically. */
  rewriteNodes(nodes: Iterable<TreeNode>): void {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, "tree.jsonl");
    const tmp = `${file}.tmp-${process.pid}`;
    let text = "";
    for (const n of nodes) text += `${JSON.stringify({ l: n.l, i: n.i, text: n.text, ...(n.src ? { src: n.src } : {}) })}\n`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }

  saveState(state: MemoryFileState): void {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, "state.json");
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`);
    renameSync(tmp, file);
  }
}

/** Remove a chat's memory (its chat was deleted or archived). Best-effort; never throws. */
export function removeMemory(sessionId: string, root = memoryRoot()): void {
  try {
    rmSync(memoryDir(sessionId, root), { recursive: true, force: true });
  } catch {
    /* nothing to remove, or an id that names no directory */
  }
}

/** A fork's memory starts as a copy of its source's (§chat.memory/log); the fork's own branch then keeps
    what still matches it. Nothing happens when the source has none or the fork already has its own. */
export function copyMemory(fromSessionId: string, toSessionId: string, root = memoryRoot()): void {
  try {
    const from = memoryDir(fromSessionId, root);
    const to = memoryDir(toSessionId, root);
    if (!existsSync(from) || existsSync(to)) return;
    cpSync(from, to, { recursive: true });
  } catch {
    /* best-effort: a fork without a copy prepares its memory again */
  }
}
