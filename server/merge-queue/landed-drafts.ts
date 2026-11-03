import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftOfficial } from "../../pi-config/extensions/spec/core/official.mjs";
import { draftSpecHash, landedReceiptOf, writeLandedReceipt } from "../spec-drafts-state";
import { type Git, isAncestor } from "./guard";

/** The run folder's record of what its docs step made official: the spec commit and, per draft, its hash as landed
 *  (draftsHash's `each`) and the promotion entries the spec tool wrote for it in the merge copy. */
export const LANDED_DRAFTS_FILE = "docs-landed.json";
export interface LandedDraftsRecord {
  commit: string;
  drafts: Record<string, { hash: string; promotions: unknown[] }>;
}

/**
 * After a landing moved the target to the tested tip: each draft the run's docs step made official gets the landing's
 * receipt in the branch folder (`<worktree>/.sova/spec/drafts/<name>/draft.json`), the drafts kept where they are
 * (§chat.worktrees/readiness). Only the drafts the run landed, and only while a draft's `spec/` is still as it
 * landed: one edited since keeps no receipt (it isn't what landed). Never throws: a receipt it can't write leaves the
 * draft reading as not landed, as before. → the drafts it wrote a receipt onto.
 */
export async function recordLandedDrafts(o: { git: Git; root: string; runDir: string; worktree: string | undefined; target: string; tip: string; run: string; now: string; log?: (s: string) => void }): Promise<string[]> {
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
  const wrote: string[] = [];
  for (const [n, d] of Object.entries(rec.drafts)) {
    try {
      if (!d || typeof d.hash !== "string" || draftSpecHash(draftsDir, n) !== d.hash) continue;
      const changed = writeLandedReceipt(join(draftsDir, n), { commit: rec.commit, target: o.target, hash: d.hash, at: o.now, by: `merge-queue ${o.run}` }, Array.isArray(d.promotions) ? d.promotions : []);
      if (changed) wrote.push(n);
    } catch (err) {
      o.log?.(`${n}: the landing receipt couldn't be written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
 * spec at `commit` gets `{commit, target, hash}`, its hash as it is now. Idempotent; writes only with `write`.
 * Refuses (throws) unless `commit` is a commit on `refs/heads/<target>`.
 */
export function backfillLandedDrafts(o: { worktree: string; commit: string; target: string; names?: string[]; write: boolean; now?: string }): { commit: string; rows: BackfillRow[] } {
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
    return { commit, rows };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
