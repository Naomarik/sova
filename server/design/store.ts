// A chat's designs on disk: <agent root>/design/<session id>/ holds state.json
// (runs, Setup, each design's record, the label counter) and <label>/v<n>.html per finished page.
// Everything the Design card and Gallery tab read comes from here, so a reload or a restart shows
// what was there. Writes are whole-file and atomic; the state of each chat is read once and kept.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { designLabel, isDesignLabel, type DesignChatView, type DesignCoordinatorView, type DesignRecord, type DesignRun, type DesignRunPhase, DESIGN_ASK_ABOVE, DESIGN_BATCH_DEFAULT, DESIGN_BATCH_MAX, DESIGN_CONCURRENT } from "../../shared/design";
import { agentRoot } from "../state-root";

interface DiskState {
  v: 1;
  /** Labels made so far in this chat: never goes down, so a label is never given twice (t14). */
  labels: number;
  runs: DesignRun[];
  designs: DesignRecord[];
  coordinator: DesignCoordinatorView | null;
  /** The page of an unfinished version, per label, until its hand-in. */
  pending?: Record<string, { html: string; at: string }>;
  /** The parent chat's file and folder, so a restart can pick its designs back up. */
  parentPath?: string;
  cwd?: string;
  /** The runner's own notes per label; never shown to the page. */
  internal?: Record<string, DesignInternal>;
}

export interface DesignInternal {
  attempt: number;
  brief: string;
  /** What asked for the page being written. */
  by: "first" | "refine" | "chat" | "coordinator";
  /** The coordinator's words for a design made from others. */
  instructions?: string;
  parentPath?: string;
  /** design_look calls since the last message to the session. */
  looks?: number;
  /** The last settle already acted on. */
  settleKey?: string;
}

export const designRoot = (): string => join(agentRoot(), "design");
const dirOf = (sessionId: string): string => join(designRoot(), encodeURIComponent(sessionId));

const empty = (): DiskState => ({ v: 1, labels: 0, runs: [], designs: [], coordinator: null });

const states = new Map<string, DiskState>();
/** Chats deleted for good while this server ran: a late write never brings their folder back. */
const deleted = new Set<string>();

const changeListeners = new Set<(sessionId: string) => void>();
/** Hear that a chat's designs changed (coalesced by the listener). */
export function onDesignChanged(fn: (sessionId: string) => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function read(sessionId: string): DiskState {
  const have = states.get(sessionId);
  if (have) return have;
  let s = empty();
  try {
    const parsed = JSON.parse(readFileSync(join(dirOf(sessionId), "state.json"), "utf8")) as DiskState;
    if (parsed?.v === 1 && Array.isArray(parsed.runs) && Array.isArray(parsed.designs)) s = { ...empty(), ...parsed };
  } catch {
    // Nothing yet, or a broken file: an empty set of designs reads correctly, and the next write replaces it.
  }
  states.set(sessionId, s);
  return s;
}

function write(sessionId: string): void {
  if (deleted.has(sessionId)) return;
  const dir = dirOf(sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, "state.json");
  writeFileSync(`${f}.tmp`, JSON.stringify(read(sessionId)), { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
  for (const fn of changeListeners) {
    try {
      fn(sessionId);
    } catch (err) {
      console.error("[design] a change listener failed", err);
    }
  }
}

/** Change the chat's state and save it; every change goes through here. */
export function changeDesigns<T>(sessionId: string, fn: (s: DiskState) => T): T {
  const s = read(sessionId);
  const out = fn(s);
  write(sessionId);
  return out;
}

/** The chat's state, for reading only. */
export const readDesigns = (sessionId: string): Readonly<DiskState> => read(sessionId);

export const hasDesigns = (sessionId: string): boolean => read(sessionId).runs.length > 0 || read(sessionId).designs.length > 0;

/** Every chat with designs on disk (the boot's reattach walks these). */
export function designSessions(): string[] {
  try {
    return readdirSync(designRoot()).map((n) => decodeURIComponent(n));
  } catch {
    return [];
  }
}

export function viewOf(sessionId: string): DesignChatView {
  const s = read(sessionId);
  return {
    v: 1,
    sessionId,
    runs: s.runs,
    designs: s.designs,
    coordinator: s.coordinator,
    caps: { batchDefault: DESIGN_BATCH_DEFAULT, askAbove: DESIGN_ASK_ABOVE, batchMax: DESIGN_BATCH_MAX, concurrent: DESIGN_CONCURRENT },
  };
}

export const designOf = (sessionId: string, label: string): DesignRecord | undefined => read(sessionId).designs.find((d) => d.label === label);
export const runOf = (sessionId: string, runId: string): DesignRun | undefined => read(sessionId).runs.find((r) => r.id === runId);

/** Change one design's record. Throws for a label the chat doesn't have. */
export function changeDesign(sessionId: string, label: string, fn: (d: DesignRecord) => void): DesignRecord {
  return changeDesigns(sessionId, (s) => {
    const d = s.designs.find((x) => x.label === label);
    if (!d) throw new Error(`No design ${label} in this chat.`);
    fn(d);
    d.updatedAt = new Date().toISOString();
    return d;
  });
}

export function setRunPhase(sessionId: string, runId: string, phase: DesignRunPhase): void {
  changeDesigns(sessionId, (s) => {
    const r = s.runs.find((x) => x.id === runId);
    if (r) {
      r.phase = phase;
      r.updatedAt = new Date().toISOString();
    }
  });
}

/** Whatever the coordinator's own code gives: this store only keeps it (a2). */
export function setCoordinator(sessionId: string, view: DesignCoordinatorView | null): void {
  changeDesigns(sessionId, (s) => {
    s.coordinator = view;
  });
}

/** The next unused label of a chat: A … Z, then AA … (t14). */
export function nextLabel(s: DiskState): string {
  return designLabel(s.labels++);
}

const pagePath = (sessionId: string, label: string, n: number): string => join(dirOf(sessionId), label, `v${n}.html`);

/** A finished page's text; null when there is no such version. */
export function readPage(sessionId: string, label: string, version?: number): string | null {
  if (!isDesignLabel(label)) return null;
  const n = version ?? designOf(sessionId, label)?.versions.at(-1)?.n;
  if (!n) return null;
  try {
    return readFileSync(pagePath(sessionId, label, n), "utf8");
  } catch {
    return null;
  }
}

export function writePage(sessionId: string, label: string, n: number, html: string): void {
  if (deleted.has(sessionId)) return;
  const f = pagePath(sessionId, label, n);
  mkdirSync(join(dirOf(sessionId), label), { recursive: true, mode: 0o700 });
  writeFileSync(`${f}.tmp`, html, { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
}

/** The unfinished page of a label, written by design_stream and not yet handed in. */
export const pendingPage = (sessionId: string, label: string): string | null => read(sessionId).pending?.[label]?.html ?? null;

export function setPendingPage(sessionId: string, label: string, html: string | null): void {
  changeDesigns(sessionId, (s) => {
    if (html === null) {
      if (s.pending) delete s.pending[label];
    } else (s.pending ??= {})[label] = { html, at: new Date().toISOString() };
  });
}

/** One deleted transcript's designs, whole. Only ever after the real deletion: an archive keeps them. */
export function removeDesignFiles(sessionId: string): void {
  deleted.add(sessionId);
  states.delete(sessionId);
  rmSync(dirOf(sessionId), { recursive: true, force: true });
}

/** Tests: drop the kept copies, so the next read comes from disk (a restart). */
export function forgetDesignCache(): void {
  states.clear();
  deleted.clear();
}

export const designFolderExists = (sessionId: string): boolean => existsSync(dirOf(sessionId));
