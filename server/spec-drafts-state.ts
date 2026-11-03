import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { draftOfficial } from "../pi-config/extensions/spec/core/official.mjs";

/**
 * Which of a worktree's spec drafts aren't official yet (§chat.worktrees/readiness), by the draft tool's own
 * rule (§tools.spec/draft-official, `official.mjs`), the one the merge queue's docs step reads too: run here
 * on the drafts' files, never as a spec tool or a subprocess. Cached per folder until a stat of anything
 * it read changes.
 */

/** What the cache compares: the modification time and the size, so a rewrite within one tick still shows. */
const stamp = (path: string): string => {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
};

const cache = new Map<string, { stamps: string; names: string[] }>();

/** The names of the drafts in `<dir>/.sova/spec/drafts/` not official (or unreadable), sorted (§chat.worktrees/ready-to-land);
    undefined when the folder has none. */
export function unofficialDrafts(dir: string): string[] | undefined {
  const specRoot = join(dir, ".sova", "spec");
  const draftsDir = join(specRoot, "drafts");
  let names: string[];
  try {
    names = readdirSync(draftsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
  } catch {
    return undefined;
  }
  if (!names.length) return undefined;
  const hit = cache.get(dir);
  if (hit && hit.stamps === stampOf(hit.stamps)) return [...hit.names];
  const left: string[] = [];
  const read: string[] = [draftsDir];
  for (const n of names) {
    const r = draftOfficial(specRoot, join(draftsDir, n), draftsDir);
    // Unreadable: nobody knows its state, so it isn't official (as the merge queue's docs step reads it too).
    if (r) read.push(...r.read);
    else read.push(join(draftsDir, n, "draft.json"));
    if (!r?.official) left.push(n);
  }
  const stamps = JSON.stringify([...new Set(read)].map((p) => [p, stamp(p)]));
  if (cache.size > 200) cache.clear();
  cache.set(dir, { stamps, names: left });
  return [...left];
}

/** Whether `commit` is an ancestor of (or is) `ref` in the repository at `cwd`. */
export type AncestorCheck = (commit: string, ref: string, cwd: string) => Promise<boolean>;

/**
 * The receipt a merge queue landing leaves on a draft it made official (§chat.worktrees/readiness): `draft.json`'s
 * `landed`. The draft stays in the branch folder, whose spec never gets the queue's spec commit, so the draft tool's
 * rule alone can't see it landed there. `commit` is the spec commit, `target` the branch it landed on, `hash` the
 * draft's own hash over its `spec/` (draftsHash's `each`) as it landed.
 */
export interface LandedReceipt {
  commit: string;
  target: string;
  hash: string;
  at: string;
  /** The merge-queue run that landed it, or how the receipt was written (a backfill). */
  by: string;
}

const HEX_SHA = /^[0-9a-f]{40,64}$/;
const HEX256 = /^[0-9a-f]{64}$/;
/** A branch name readiness may hand to git as `refs/heads/<target>`. */
const REF_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** A draft's landing receipt, when it is well formed. */
export function landedReceiptOf(draftDir: string): LandedReceipt | null {
  let d: unknown;
  try {
    d = JSON.parse(readFileSync(join(draftDir, "draft.json"), "utf8"));
  } catch {
    return null;
  }
  const l = (d as { landed?: Partial<LandedReceipt> } | null)?.landed;
  if (!l || typeof l !== "object") return null;
  if (typeof l.commit !== "string" || !HEX_SHA.test(l.commit) || typeof l.hash !== "string" || !HEX256.test(l.hash) || typeof l.target !== "string" || !REF_NAME.test(l.target)) return null;
  return { commit: l.commit, target: l.target, hash: l.hash, at: typeof l.at === "string" ? l.at : "", by: typeof l.by === "string" ? l.by : "" };
}

/** The draft tool's own writer lock (`<drafts>/.lock`, its token, taken with an exclusive create): `fn` runs holding it,
 *  so a chat's `evidence` or `land` never interleaves with it. A lock held past `waitMs` is another writer's, or a dead
 *  one's for `recover`: never taken over, `busy` instead. */
export async function withDraftsLock<T>(draftsDir: string, fn: () => T, waitMs = 3000): Promise<{ busy: true; held: string } | { busy: false; value: T }> {
  const lock = join(draftsDir, ".lock");
  const token = `${process.pid} ${hostname()} ${randomBytes(8).toString("hex")} ${new Date().toISOString()}`;
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() >= end) return { busy: true, held: readOr(lock)?.toString("utf8").trim() ?? "?" };
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  try {
    return { busy: false, value: fn() };
  } finally {
    if (readOr(lock)?.toString("utf8") === token) rmSync(lock, { force: true });
  }
}

/**
 * Write what a landing leaves on the draft in `draftDir` (atomically, a temp file renamed over `draft.json`; the caller
 * holds withDraftsLock): the spec tool's promotion entries `promotions` not there yet, and the `receipt` when given (a
 * target landing; a landing whose docs commit is in the folder needs the promotions alone, official.mjs's own rule).
 * Nothing else in the draft changes. → whether `draft.json` changed (false: already so, or not a readable draft).
 */
export function writeLandedReceipt(draftDir: string, receipt: LandedReceipt | null, promotions: readonly unknown[] = []): boolean {
  const file = join(draftDir, "draft.json");
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  const had = Array.isArray(d.promotions) ? (d.promotions as unknown[]) : [];
  const seen = new Set(had.map((x) => JSON.stringify(x)));
  const more = promotions.filter((x) => !seen.has(JSON.stringify(x)));
  const l = landedReceiptOf(draftDir);
  const same = !receipt || (!!l && l.commit === receipt.commit && l.target === receipt.target && l.hash === receipt.hash);
  if (same && !more.length) return false;
  const next = { ...d, ...(more.length ? { promotions: [...had, ...more] } : {}), ...(same ? {} : { landed: receipt }) };
  const tmp = join(draftDir, `.draft.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, file);
  return true;
}

/** One draft's own hash over its `spec/` files, as draftsHash's `each` computes it; undefined: no such draft. */
export function draftSpecHash(draftsDir: string, name: string): string | undefined {
  if (!DRAFT_NAME.test(name) || !existsSync(join(draftsDir, name))) return undefined;
  return eachHash(draftsDir, name);
}

/**
 * The drafts readiness counts as not landed (§chat.worktrees/readiness): those the draft tool's rule says aren't
 * official in the folder (unofficialDrafts), less each carrying a landing receipt that still speaks for it: its
 * `spec/` unchanged since (by hash) and its spec commit on `refs/heads/<target>`. undefined: the folder has none.
 */
export async function draftsLeft(dir: string, isAncestor: AncestorCheck): Promise<string[] | undefined> {
  const left = unofficialDrafts(dir);
  if (!left?.length) return left;
  const draftsDir = join(dir, ".sova", "spec", "drafts");
  const out: string[] = [];
  for (const n of left) {
    const r = landedReceiptOf(join(draftsDir, n));
    const landed = !!r && draftSpecHash(draftsDir, n) === r.hash && (await isAncestor(r.commit, `refs/heads/${r.target}`, dir).catch(() => false));
    if (!landed) out.push(n);
  }
  return out;
}

/** The same stamps re-read now: equal means nothing that was read has changed. */
function stampOf(stamps: string): string {
  try {
    const list = JSON.parse(stamps) as [string, string][];
    return JSON.stringify(list.map(([p]) => [p, stamp(p)]));
  } catch {
    return "";
  }
}

/** The spec drafts as an approval pins them (§chat.worktrees/landing-answers): one hash over every file under each
    draft's `spec/` (lines `<draft>/<path under spec/> <sha256>`, sorted, joined by "\n"; `draft.json`, where notes,
    evidence and receipts go, apart), each draft's own hash over its lines, and the names. The draft tool's `land`
    and the merge queue compute the same. undefined: no drafts. */
export interface DraftsHash {
  hash: string;
  names: string[];
  each: Record<string, string>;
}

const DRAFT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const readOr = (path: string): Buffer | null => {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
};
/** Every file under `dir`, relative, `/`-separated. */
function filesUnder(dir: string, rel = ""): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

export function draftsHash(dir: string): DraftsHash | undefined {
  const draftsDir = join(dir, ".sova", "spec", "drafts");
  let names: string[];
  try {
    names = readdirSync(draftsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && DRAFT_NAME.test(e.name)).map((e) => e.name).sort();
  } catch {
    return undefined;
  }
  if (!names.length) return undefined;
  const all: string[] = [];
  const each: Record<string, string> = {};
  for (const n of names) {
    const lines = draftLines(draftsDir, n);
    each[n] = hashOf(lines);
    all.push(...lines);
  }
  return { hash: hashOf(all), names, each };
}

const hashOf = (lines: string[]) => createHash("sha256").update([...lines].sort().join("\n")).digest("hex");
/** One draft's lines `<draft>/<path under spec/> <sha256>`. */
function draftLines(draftsDir: string, n: string): string[] {
  const lines: string[] = [];
  for (const rel of filesUnder(join(draftsDir, n, "spec"))) {
    const buf = readOr(join(draftsDir, n, "spec", rel));
    if (buf) lines.push(`${n}/${rel} ${sha(buf)}`);
  }
  return lines;
}
const eachHash = (draftsDir: string, n: string): string => hashOf(draftLines(draftsDir, n));

/** The drafts that changed since an approval recorded `pressed`, sorted; [] when none did. Without per-draft hashes a
    changed whole names every draft. */
export function draftsChanged(pressed: { hash: string; names: string[]; each?: Record<string, string> } | undefined, now: DraftsHash | undefined): string[] {
  if (!pressed || (now?.hash ?? null) === pressed.hash) return [];
  const names = [...new Set([...pressed.names, ...(now?.names ?? [])])].sort();
  if (!pressed.each) return names;
  return names.filter((n) => (pressed.each![n] ?? null) !== (now?.each[n] ?? null));
}
