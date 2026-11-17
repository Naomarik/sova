// The approval list's subfolder walk (server/approvals.ts folderQuickScan), off the main thread's back: the
// instruction files (server/deeper-context.ts) and skills (server/subfolder-skills.ts) every folder below a
// checkout holds, found in one pass of async reads, and kept per checkout so a read never waits on a walk.
//
// pi's own read of each checkout (its context files and skills) is kept the same way (keptRead).
//
// Freshness: a read is answered from the checkout's last walk; when that walk started WALK_TTL_MS or more ago,
// the read also starts one new walk in the background (one at a time per checkout) and the reads after it ends
// see what it found. So a file added or removed below a checkout shows from the first read that begins after a
// walk which itself began after the change. Only the first read of a checkout waits (on async reads, so other
// requests go on). A `fresh` read walks again now and waits for it: approval saves and the setup read asked
// fresh use it, so a save is always judged against the folder as it is. Same answers as the sync walks.
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { projectFileKeeper } from "./context-scope";
import { INSTRUCTION_NAMES, skippedSegment, SUBFOLDER_SCAN_CAP } from "./deeper-context";
import { SKILL_FOLDERS, type SkillsIn, type SubfolderSkill } from "./subfolder-skills";

/** How old a checkout's walk may be before a read starts the next one. */
export const WALK_TTL_MS = 10_000;
/** A checkout no read has asked about for this long is forgotten. */
const FORGET_MS = 10 * 60_000;
/** Folders read at once across every walk: the rest wait, so walks never crowd the async file reads requests make. */
const MAX_PROBES = 6;

export interface SubfolderWalk {
  /** Each folder's instruction file, outermost first (the root's own excluded): absolute, and its folder relative to the root. */
  files: { abs: string; dir: string }[];
  /** Each folder's skills, outermost first, as listSubfolderSkills gives them. */
  skills: SubfolderSkill[];
  /** The walk stopped at its cap. */
  incomplete: boolean;
}

export interface WalkOptions {
  cap?: number;
  /** Reads one skills folder (the harness's reader). */
  read: SkillsIn;
  /** Whether git ignores a skills folder (default: git check-ignore, asynchronously). */
  ignores?: (p: string) => Promise<boolean>;
}

const posix = (p: string) => p.split(sep).join("/");

// ---- one walk -----------------------------------------------------------------------------------------

let probing = 0;
const waiting: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (probing >= MAX_PROBES) await new Promise<void>((go) => waiting.push(go));
  else probing++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else probing--;
  }
}

/** Whether git ignores `path`, as gitIgnores (server/subfolder-skills.ts) answers it, without holding the thread. */
export function gitIgnoresAsync(path: string): Promise<boolean> {
  return new Promise((done) => {
    execFile("git", ["check-ignore", "-q", "--", path], { cwd: dirname(path), timeout: 5000 }, (err) => done(!err));
  });
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const INSTRUCTION_LOWER = new Set(INSTRUCTION_NAMES.map((n) => n.toLowerCase()));
const SKILL_TOPS = new Set(SKILL_FOLDERS.map((s) => s.split("/")[0]!.toLowerCase()));

interface Probe {
  instruction: string | null;
  skills: SubfolderSkill[];
  children: string[];
}

/** One folder: its instruction file and skills (none for the root) and the folders to walk below it. The listing
    only rules out a folder with no candidate name; any candidate is then checked by path, as the sync walks do,
    so a case-insensitive disk answers the same. */
async function probe(dir: string, root: string, o: WalkOptions): Promise<Probe> {
  let entries: Dirent[] | null = null;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // unlistable: still checked by path below, and nothing below it is walked
  }
  const children = entries ? entries.filter((d) => d.isDirectory() && !skippedSegment(d.name)).map((d) => d.name).sort() : [];
  if (dir === root) return { instruction: null, skills: [], children };
  const names = entries ? entries.map((d) => d.name.toLowerCase()) : null;
  let instruction: string | null = null;
  if (!names || names.some((n) => INSTRUCTION_LOWER.has(n))) {
    for (const name of INSTRUCTION_NAMES) {
      if (await isFile(join(dir, name))) {
        instruction = join(dir, name);
        break;
      }
    }
  }
  const skills: SubfolderSkill[] = [];
  if (!names || names.some((n) => SKILL_TOPS.has(n))) {
    const seen = new Set<string>();
    const rel = posix(relative(root, dir));
    for (const sub of SKILL_FOLDERS) {
      const skillsDir = join(dir, sub);
      if (!(await exists(skillsDir)) || (await (o.ignores ?? gitIgnoresAsync)(skillsDir))) continue;
      for (const s of o.read(skillsDir)) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        skills.push({ ...s, dir: rel });
      }
    }
  }
  return { instruction, skills, children };
}

/** Every instruction file and skill in the folders below `top`, breadth first in name order, at most `cap` folders:
    what listSubfolderInstructions and listSubfolderSkills find, in their order, in one pass. */
export async function walkSubfolders(top: string, o: WalkOptions): Promise<SubfolderWalk> {
  const cap = o.cap ?? SUBFOLDER_SCAN_CAP;
  const root = resolve(top);
  const out: SubfolderWalk = { files: [], skills: [], incomplete: false };
  // Real files of the project only, as the loaders take them (server/context-scope.ts).
  const real = projectFileKeeper(root, { home: homedir() });
  const queue: string[] = [root];
  let seen = 0;
  while (queue.length) {
    const batch = queue.splice(0, MAX_PROBES);
    const probes = await Promise.all(batch.map((dir) => limited(() => probe(dir, root, o))));
    // Taken in queue order: past the cap the rest of the queue is dropped, this batch's later folders included.
    walk: for (let k = 0; k < batch.length; k++) {
      const dir = batch[k]!;
      const p = probes[k]!;
      if (p.instruction && real(p.instruction)) out.files.push({ abs: p.instruction, dir: posix(relative(root, dir)) });
      out.skills.push(...p.skills.filter((s) => real(s.filePath)));
      for (const n of p.children) {
        if (++seen > cap) {
          out.incomplete = true;
          queue.length = 0;
          break walk;
        }
        queue.push(join(dir, n));
      }
    }
  }
  return out;
}

// ---- kept per checkout --------------------------------------------------------------------------------

/** A read as kept: `seq` orders reads and decision writes (walkMark) by when they started. */
export interface KeptRead<T> {
  value: T;
  seq: number;
}

/** A walk as kept, its `seq` beside it. */
export type KeptWalk = SubfolderWalk & { seq: number };

interface Slot {
  /** The kept read: one that started earlier never replaces it. */
  value?: KeptRead<unknown>;
  valueAt: number;
  /** The newest read running. */
  pending?: Promise<KeptRead<unknown>>;
  usedAt: number;
}

const kept = new Map<string, Slot>();
const running = new Set<Promise<unknown>>();
let seq = 0;

/** A mark in the order kept reads start: a decision write takes one, and a read with a lower `seq` started before it. */
export function walkMark(): number {
  return ++seq;
}

/** How many kept reads ran, for tests. */
export const walkIo = { walks: 0 };

const newer = <T>(a: KeptRead<T> | undefined, b: KeptRead<T>): KeptRead<T> => (a && a.seq > b.seq ? a : b);

/** The background reads that hold the thread while they run (pi's loader), one after another. */
let serialTail: Promise<unknown> = Promise.resolve();

/** `run` after a timer's turn, behind every serial read queued before it: the reads several checkouts start at
    once never run back to back in one turn, so timers and other requests get in between. */
function inSerial<T>(run: () => Promise<T>): Promise<T> {
  const p = serialTail.then(() => new Promise<void>((go) => setTimeout(go, 0))).then(run);
  serialTail = p.catch(() => {});
  return p;
}

function start<T>(k: Slot, run: () => Promise<T>, now: () => number, behind: false | "turn" | "serial"): Promise<KeptRead<T>> {
  const mine = ++seq;
  const at = now();
  walkIo.walks++;
  // A read started behind another runs in a turn of its own, never on the asking request's.
  const p = (behind === "serial" ? inSerial(run) : behind ? new Promise<void>((go) => setImmediate(go)).then(run) : run()).then((value) => {
    const r = { value, seq: mine };
    if (!k.value || mine > k.value.seq) Object.assign(k, { value: r, valueAt: at });
    return r;
  });
  k.pending = p;
  running.add(p);
  void p
    .finally(() => {
      running.delete(p);
      if (k.pending === p) k.pending = undefined;
    })
    .catch(() => {});
  return p;
}

/**
 * One kept read by the freshness rule above: answered from the last one kept, a new one started behind it once that
 * is WALK_TTL_MS old; the first waits (joined by any other first reader, who gets the newest kept); `fresh` runs one
 * now and gets its own. A read that fails is not kept. `serial`: a read that holds the thread (pi's loader) runs behind
 * the others, one per timer turn (inSerial).
 */
export function keptRead<T>(key: string, run: () => Promise<T>, o: { fresh?: boolean; now?: () => number; serial?: boolean } = {}): Promise<KeptRead<T>> {
  const now = o.now ?? Date.now;
  const t = now();
  for (const [x, k] of kept) if (t - k.usedAt > FORGET_MS && !k.pending) kept.delete(x);
  let k = kept.get(key);
  if (!k) kept.set(key, (k = { valueAt: 0, usedAt: t }));
  k.usedAt = t;
  if (o.fresh) return start(k, run, now, false);
  if (k.value) {
    if (t - k.valueAt >= WALK_TTL_MS && !k.pending) start(k, run, now, o.serial ? "serial" : "turn").catch(() => {});
    return Promise.resolve(k.value as KeptRead<T>);
  }
  const slot = k;
  return ((k.pending as Promise<KeptRead<T>> | undefined) ?? start(k, run, now, false)).then((r) => newer(slot.value as KeptRead<T> | undefined, r));
}

/** The walk below a checkout, kept by the freshness rule above. */
export async function subfolderWalk(top: string, o: WalkOptions & { fresh?: boolean; now?: () => number }): Promise<KeptWalk> {
  const r = await keptRead(`walk\0${o.cap ?? SUBFOLDER_SCAN_CAP}\0${resolve(top)}`, () => walkSubfolders(top, o), o);
  return { ...r.value, seq: r.seq };
}

/** Once every kept read now running has ended (tests). */
export async function folderWalksIdle(): Promise<void> {
  while (running.size) await Promise.allSettled([...running]);
}

/** Forget every kept read (tests). */
export function forgetFolderWalksForTest(): void {
  kept.clear();
}
