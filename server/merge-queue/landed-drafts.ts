import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftOfficial } from "../../pi-config/extensions/spec/core/official.mjs";
import { draftSpecHash, landedReceiptOf, withDraftsLock, writeLandedReceipt } from "../spec-drafts-state";
import { type Git, isAncestor } from "./guard";

/** The run folder's record of what its docs step made official: the spec commit and, per draft, its hash as landed
 *  (draftsHash's `each`) and the promotion entries the spec tool wrote for it in the merge copy. */
export const LANDED_DRAFTS_FILE = "docs-landed.json";
export interface LandedDraftsRecord {
  commit: string;
  drafts: Record<string, { hash: string; promotions: unknown[] }>;
}

/**
 * A landing's docs reached the branch's drafts' side: each draft the run's docs step made official gets what the spec
 * tool wrote for it in the merge copy, in the branch folder's `draft.json` (§chat.worktrees/readiness); the drafts stay
 * where they are. Only the drafts the run landed, and only while a draft's `spec/` is still as it landed: one edited
 * since gets nothing (it isn't what landed).
 *
 * `on-target`: the target moved to the tested tip, and the folder never gets that spec commit, so the draft gets the
 * `landed` receipt too. `in-folder`: published (by request or push), the docs commit is on the chat's branch in the
 * folder, so the promotion entries are all the draft tool's own rule needs, however the host merges it.
 *
 * Under the draft tool's lock. Never throws: what it can't write leaves the draft reading as not landed, as before, and
 * scripts/mark-landed-drafts.ts marks it later. → the drafts it wrote onto.
 */
export async function recordLandedDrafts(o: { git: Git; root: string; runDir: string; worktree: string | undefined; docs: "on-target" | "in-folder"; target: string; tip: string; run: string; now: string; log?: (s: string) => void; lockWaitMs?: number }): Promise<string[]> {
  if (!o.worktree || !existsSync(o.worktree)) return [];
  let rec: LandedDraftsRecord;
  try {
    rec = JSON.parse(readFileSync(join(o.runDir, LANDED_DRAFTS_FILE), "utf8"));
  } catch {
    return []; // the run made no spec commit
  }
  if (typeof rec?.commit !== "string" || !rec.drafts || typeof rec.drafts !== "object") return [];
  // The spec commit is what landed: the tip itself or under it.
  if (rec.commit !== o.tip && !(await isAncestor(o.git, o.root, rec.commit, o.tip))) return [];
  const draftsDir = join(o.worktree, ".sova", "spec", "drafts");
  if (!existsSync(draftsDir)) return [];
  const wrote: string[] = [];
  const r = await withDraftsLock(
    draftsDir,
    () => {
      for (const [n, d] of Object.entries(rec.drafts)) {
        try {
          if (!d || typeof d.hash !== "string" || draftSpecHash(draftsDir, n) !== d.hash) continue;
          const receipt = o.docs === "on-target" ? { commit: rec.commit, target: o.target, hash: d.hash, at: o.now, by: `merge-queue ${o.run}` } : null;
          if (writeLandedReceipt(join(draftsDir, n), receipt, Array.isArray(d.promotions) ? d.promotions : [])) wrote.push(n);
        } catch (err) {
          o.log?.(`${n}: the landing receipt couldn't be written: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    o.lockWaitMs,
  ).catch((err: unknown) => ({ busy: true as const, held: err instanceof Error ? err.message : String(err) }));
  if (r.busy) o.log?.(`the drafts in ${o.worktree} weren't marked landed: their lock is held (${r.held})`);
  return wrote;
}

export interface BackfillRow {
  draft: string;
  /** marked: a receipt written (or, without `write`, would be); current: it already has this receipt; not-landed: the
   *  draft isn't official in the spec at the commit (edited since, or never landed there): left alone. */
  state: "marked" | "current" | "not-landed" | "unreadable";
  notOfficial?: string[];
}

/**
 * The landing receipt for drafts that landed before the queue wrote receipts (a one-off, scripts/mark-landed-drafts.ts):
 * each draft in `<worktree>/.sova/spec/drafts/` (or only `names`) that the draft tool's own rule finds official in the
 * spec at `commit` gets `{commit, target, hash}`, its hash as it is now. Idempotent; writes only with `write`, under
 * the draft tool's lock. Refuses (rejects) unless `commit` is a commit on `refs/heads/<target>`, or when that lock is held.
 */
export async function backfillLandedDrafts(o: { worktree: string; commit: string; target: string; names?: string[]; write: boolean; now?: string; lockWaitMs?: number }): Promise<{ commit: string; rows: BackfillRow[] }> {
  const g = (args: string[], input?: Buffer) => spawnSync("git", args, { cwd: o.worktree, ...(input ? { input } : {}), maxBuffer: 256 * 1024 * 1024 });
  const rev = g(["rev-parse", "--verify", "-q", `${o.commit}^{commit}`]);
  const commit = rev.status === 0 ? String(rev.stdout).trim() : "";
  if (!commit) throw new Error(`${o.commit} is not a commit in ${o.worktree}`);
  if (g(["merge-base", "--is-ancestor", commit, `refs/heads/${o.target}`]).status !== 0) throw new Error(`${commit.slice(0, 9)} is not on ${o.target}`);
  const draftsDir = join(o.worktree, ".sova", "spec", "drafts");
  const all = (() => {
    try {
      return readdirSync(draftsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
    } catch {
      return [];
    }
  })();
  const names = o.names?.length ? o.names : all;
  for (const n of names) if (!all.includes(n)) throw new Error(`no draft ${n} in ${draftsDir}`);
  const tmp = mkdtempSync(join(tmpdir(), "sova-landed-spec-"));
  try {
    const tar = g(["archive", "--format=tar", commit, ".sova/spec"]);
    if (tar.status !== 0) throw new Error(`${commit.slice(0, 9)} has no .sova/spec: ${String(tar.stderr).trim()}`);
    const x = spawnSync("tar", ["-x", "-C", tmp], { input: tar.stdout });
    if (x.status !== 0) throw new Error(`unpacking the spec at ${commit.slice(0, 9)} failed: ${String(x.stderr).trim()}`);
    const specAt = join(tmp, ".sova", "spec");
    const rows: BackfillRow[] = [];
    const pass = () => {
      for (const n of names) {
        const dir = join(draftsDir, n);
        const r = draftOfficial(specAt, dir, draftsDir);
        const hash = draftSpecHash(draftsDir, n);
        if (!r || !hash) {
          rows.push({ draft: n, state: "unreadable" });
          continue;
        }
        if (!r.official) {
          rows.push({ draft: n, state: "not-landed", notOfficial: r.notOfficial });
          continue;
        }
        const have = landedReceiptOf(dir);
        if (have && have.commit === commit && have.target === o.target && have.hash === hash) {
          rows.push({ draft: n, state: "current" });
          continue;
        }
        if (o.write) writeLandedReceipt(dir, { commit, target: o.target, hash, at: o.now ?? new Date().toISOString(), by: "backfill (scripts/mark-landed-drafts.ts)" });
        rows.push({ draft: n, state: "marked" });
      }
    };
    if (o.write && names.length) {
      const l = await withDraftsLock(draftsDir, pass, o.lockWaitMs);
      if (l.busy) throw new Error(`${join(draftsDir, ".lock")} is held (${l.held}): another writer may be active, so nothing was written; try again`);
    } else pass();
    return { commit, rows };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
