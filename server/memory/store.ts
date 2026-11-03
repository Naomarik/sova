// A chat's memory sidecar (§chat.memory/log): `<agent dir>/sova/memory/<session id>/`, beside the chat,
// never in its session file. `tree.jsonl` holds the built nodes (append-only; rewritten whole only when a
// rewind or fork drops nodes), `state.json` the saved views and their cached prefixes, `retry.json` the failed
// summaries' tries and retry times (§chat.memory/recovery). Sessions don't sync across devices, so neither
// does this.
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

/** One node's failed tries and when it is tried again (epoch ms). */
export interface NodeRetry {
  l: number;
  i: number;
  attempts: number;
  retryAt: number;
  /** A leaf's message source, as for a built leaf: whether the tries are still this message's. */
  src?: string;
}

/** The queue's pause after a failure that stops every summary: when it is tried again, the step it waited
    (it doubles), and the status sentence naming the cause. */
export interface MemoryPause {
  until: number;
  step: number;
  problem: string;
}

/** What `retry.json` keeps (§chat.memory/recovery). */
export interface MemoryRetryState {
  v: 1;
  nodes: NodeRetry[];
  pause?: MemoryPause;
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

const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function parseRetry(raw: unknown): MemoryRetryState {
  const out: MemoryRetryState = { v: 1, nodes: [] };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.nodes))
    for (const n of r.nodes as Partial<NodeRetry>[])
      if (n && Number.isInteger(n.l) && n.l! >= 0 && Number.isInteger(n.i) && n.i! >= 0 && Number.isInteger(n.attempts) && n.attempts! > 0 && time(n.retryAt))
        out.nodes.push({ l: n.l!, i: n.i!, attempts: n.attempts!, retryAt: n.retryAt!, ...(typeof n.src === "string" ? { src: n.src } : {}) });
  const p = r.pause as Partial<MemoryPause> | undefined;
  if (p && time(p.until) && time(p.step) && typeof p.problem === "string") out.pause = { until: p.until, step: p.step, problem: p.problem };
  return out;
}

const nodeJson = (n: TreeNode): string => JSON.stringify({ l: n.l, i: n.i, text: n.text, ...(n.src ? { src: n.src } : {}), ...(n.excerpt ? { excerpt: true } : {}) });

function parseNode(line: string): TreeNode | undefined {
  try {
    const n = JSON.parse(line) as Partial<TreeNode>;
    if (!Number.isInteger(n.l) || !Number.isInteger(n.i) || typeof n.text !== "string") return undefined;
    return { l: n.l!, i: n.i!, text: n.text, size: Buffer.byteLength(n.text), ...(typeof n.src === "string" ? { src: n.src } : {}), ...(n.excerpt === true ? { excerpt: true as const } : {}) };
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
    appendFileSync(join(this.dir, "tree.jsonl"), `${nodeJson(n)}\n`);
  }

  /** The whole tree again (after dropping nodes), atomically. */
  rewriteNodes(nodes: Iterable<TreeNode>): void {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, "tree.jsonl");
    const tmp = `${file}.tmp-${process.pid}`;
    let text = "";
    for (const n of nodes) text += `${nodeJson(n)}\n`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }

  saveState(state: MemoryFileState): void {
    this.writeJson("state.json", state);
  }

  loadRetry(): MemoryRetryState {
    try {
      return parseRetry(JSON.parse(readFileSync(join(this.dir, "retry.json"), "utf8")));
    } catch {
      return { v: 1, nodes: [] };
    }
  }

  /** The failed summaries' tries and the pause; an empty one removes the file. */
  saveRetry(retry: MemoryRetryState): void {
    if (!retry.nodes.length && !retry.pause) {
      rmSync(join(this.dir, "retry.json"), { force: true });
      return;
    }
    this.writeJson("retry.json", retry);
  }

  private writeJson(name: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, name);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(value)}\n`);
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
