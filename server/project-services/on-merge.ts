import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { CONTRACT_FILE, parseDefinition, type ProjectDef, type VerbResult } from "../../shared/project-contract";
import type { Caller } from "./engine";
import { serverCheckout } from "./self-host";
import { readRegistry, servicesRoot, type InstanceRecord } from "./store";

/**
 * onMerge (§app.project-services/on-merge): a service that declares `onMerge: "reload"` is reloaded
 * (`apply`, as the `system` caller) on the main checkout's copy (slot 0) whenever main's HEAD moves:
 * at once after Sova's Merge Branch, else found by a HEAD check every 5 minutes (a hand merge, a
 * release, the operator's own commit). Only services the copy wants running; never on the checkout
 * this Sova server runs from (§app.project-services/self-host: its restart is the operator's).
 *
 * `<state root>/project-services/on-merge.json` `{version: 1, heads: {<root>: sha}, notes: {<root>:
 * [{at, line}]}}`: the HEAD last seen per project (a first sight only records it) and the newest
 * notes, which the project's software feed shows (server/projects/runtime.ts).
 */

export const ON_MERGE_EVERY_MS = 5 * 60_000;
const NOTES_MAX = 10;
export const SYSTEM_ON_MERGE: Caller = { kind: "system", id: "on-merge" };

export interface OnMergeNote {
  at: string;
  line: string;
}
interface OnMergeFile {
  version: 1;
  heads: Record<string, string>;
  notes: Record<string, OnMergeNote[]>;
}

export interface OnMergeDeps {
  run: (verb: string, body: unknown, caller: Caller) => Promise<VerbResult>;
  /** main's HEAD at `root`, or null (not git, no commit). */
  head: (root: string) => Promise<string | null>;
  selfCheckout: () => string | null;
  file: string;
  now: () => number;
}

export const onMergeFile = (): string => join(servicesRoot(), "on-merge.json");

function readFile(file: string): OnMergeFile {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<OnMergeFile>;
    if (raw?.version !== 1) throw new Error("version");
    const heads = raw.heads && typeof raw.heads === "object" ? raw.heads : {};
    const notes = raw.notes && typeof raw.notes === "object" ? raw.notes : {};
    return { version: 1, heads, notes };
  } catch {
    return { version: 1, heads: {}, notes: {} };
  }
}

function writeFile(file: string, f: OnMergeFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`);
  renameSync(tmp, file);
}

const canonical = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The services of `def` that reload when main moves, in declaration order. Pure. */
export const onMergeServices = (def: ProjectDef): string[] => def.services.filter((s) => s.onMerge === "reload").map((s) => s.name);

function definitionAt(checkout: string): ProjectDef | null {
  const file = join(checkout, CONTRACT_FILE);
  if (!existsSync(file)) return null;
  try {
    return parseDefinition(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The project's main checkout copy, by its root at real paths. */
const slot0Of = (root: string): InstanceRecord | null => readRegistry().instances.find((i) => i.slot === 0 && canonical(i.project) === root) ?? null;

/** What a reload did, as the feed says it. Pure. */
export function noteLine(commit: string, names: string[], r: VerbResult): string | null {
  const short = commit.slice(0, 7);
  if (!r.ok) return `Main moved to ${short}: onMerge could not reload ${names.join(", ")}: ${r.error?.message ?? "it failed"}.`;
  const done = r.steps.filter((s) => s.kind === "reload" && s.result === "done").map((s) => s.id.replace(/^reload:/, ""));
  if (!done.length) return null;
  return `Main moved to ${short}: onMerge reloaded ${done.join(", ")} on the main checkout's copy.`;
}

const chains = new Map<string, Promise<unknown>>();

/**
 * Main's HEAD at `root` now: when it moved since last seen, reload its onMerge services. One check per
 * project at a time (Merge Branch and the tick never reload twice for one move). Returns the note
 * written, if any.
 */
export function mainMoved(root: string, deps?: Partial<OnMergeDeps>): Promise<string | null> {
  const key = canonical(root);
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => check(key, deps));
  chains.set(key, next);
  void next.finally(() => chains.get(key) === next && chains.delete(key)).catch(() => {});
  return next;
}

async function check(root: string, given: Partial<OnMergeDeps> = {}): Promise<string | null> {
  const d = await depsOf(given);
  const head = await d.head(root);
  if (!head) return null;
  const f = readFile(d.file);
  const seen = f.heads[root];
  if (seen === head) return null;
  f.heads[root] = head;
  writeFile(d.file, f);
  // A first sight only records where main is.
  if (seen === undefined) return null;
  const rec = slot0Of(root);
  if (!rec) return null;
  const def = definitionAt(rec.checkout);
  if (!def) return null;
  const names = onMergeServices(def).filter((n) => rec.desired[n] === "running");
  if (!names.length) return null;
  let line: string | null;
  const self = d.selfCheckout();
  if (self && canonical(self) === root) line = `Main moved to ${head.slice(0, 7)}: onMerge never reloads the checkout this Sova runs from; apply it from the Services tab.`;
  else {
    try {
      line = noteLine(head, names, await d.run("apply", { instance: rec.id, services: names }, SYSTEM_ON_MERGE));
    } catch (err) {
      line = `Main moved to ${head.slice(0, 7)}: onMerge could not reload ${names.join(", ")}: ${err instanceof Error ? err.message : String(err)}.`;
    }
  }
  if (!line) return null;
  const now = readFile(d.file);
  now.notes[root] = [{ at: new Date(d.now()).toISOString(), line }, ...(now.notes[root] ?? [])].slice(0, NOTES_MAX);
  writeFile(d.file, now);
  console.log(`[on-merge] ${root}: ${line}`);
  return line;
}

async function depsOf(given: Partial<OnMergeDeps>): Promise<OnMergeDeps> {
  return {
    run: given.run ?? (async (verb, body, caller) => (await import("./routes")).projectEngine().run(verb, body, caller)),
    head: given.head ?? (async (root) => {
      const { realGit } = await import("./engine");
      const r = await realGit(["rev-parse", "--verify", "--quiet", "HEAD"], root);
      return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    }),
    selfCheckout: given.selfCheckout ?? serverCheckout,
    file: given.file ?? onMergeFile(),
    now: given.now ?? Date.now,
  };
}

/** The project's onMerge notes, newest first (its software feed shows them). */
export function onMergeNotes(root: string, file = onMergeFile()): OnMergeNote[] {
  return readFile(file).notes[canonical(root)] ?? [];
}

/** The software feed with onMerge's notes among its lines, newest first, at most `max`. Pure. */
export function withOnMerge<T extends OnMergeNote>(feed: T[], notes: readonly T[], max = 20): T[] {
  if (!notes.length) return feed;
  return [...feed, ...notes].sort((a, b) => b.at.localeCompare(a.at)).slice(0, max);
}

/** Every project with a main checkout copy, checked once. */
export async function checkAllHeads(deps?: Partial<OnMergeDeps>): Promise<void> {
  const roots = new Set(readRegistry().instances.filter((i) => i.slot === 0).map((i) => canonical(i.project)));
  for (const root of roots) await mainMoved(root, deps).catch((err) => console.warn(`[on-merge] ${root}: ${err instanceof Error ? err.message : String(err)}`));
}

let tick: ReturnType<typeof setInterval> | null = null;
/** Record every main's HEAD now, then check them every 5 minutes. */
export function startOnMergeTick(): void {
  if (tick) return;
  void checkAllHeads();
  tick = setInterval(() => void checkAllHeads(), ON_MERGE_EVERY_MS);
  tick.unref?.();
}
