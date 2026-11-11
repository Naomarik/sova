import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeEntry, MergeHistoryRow, MergeRun } from "../../shared/merge-queue";
import type { QueueFile } from "./store";
import { superseded } from "./view";

/**
 * The merge queue's history, per project: every truly final entry kept for good, beside queue.json:
 *
 *   <state>/merge-queue/<key>/history/YYYY-MM.jsonl   one row per entry (MergeHistoryRow), by the month it first became
 *                                                     truly final; a row is rewritten in place when its entry changes
 *   <state>/merge-queue/<key>/history/backfilled      the one-time backfill from runs/ ran
 *
 * Truly final: landed, cancelled or pushed; a sent-back (needs-fix) or closed entry once a newer entry of its branch
 * stands for it, or git says its commit is in the target. A sent-back entry still waiting on its chat is never final
 * here. Each queue save writes only the months whose rows changed; queue.json keeps the newest KEEP_FINAL of them.
 */

type Stored = QueueFile["entries"][number];

/** Is `e` truly final? `merged`: sent-back entries git says are in the target; `recorded`: the state its history row
 *  was filed with (once filed as final in that state it stays so, even after the entry that superseded it is trimmed). */
export function trulyFinal(entries: readonly Stored[], e: Stored, merged?: ReadonlySet<string>, recorded?: string): boolean {
  if (e.state === "landed" || e.state === "cancelled" || e.state === "pushed") return true;
  if (e.state === "needs-fix" || e.state === "closed") return recorded === e.state || superseded(entries, e) || !!merged?.has(e.id);
  return false;
}

const MONTH_RE = /^(\d{4}-\d{2})\.jsonl$/;
const monthOf = (iso: string): string => (/^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : new Date().toISOString().slice(0, 7));

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** When `e` became truly final, as its records say (never later than `now`): its landing or its last change for the
 *  final states; for one superseded, when the newer entry of its branch was made. Only a new row uses it. */
function finalAtOf(entries: readonly Stored[], e: Stored, now: string): string {
  let at = e.landed?.at ?? e.updatedAt;
  if (e.state === "needs-fix" || e.state === "closed") {
    const newer = entries.filter((o) => o.id !== e.id && o.branch === e.branch && o.target === e.target && o.createdAt > at).map((o) => o.createdAt).sort();
    if (newer[0]) at = newer[0];
  }
  return at && at < now ? at : now;
}

const rowOf = (e: Stored, finalAt: string): MergeHistoryRow => {
  const { seq: _seq, ...entry } = e;
  return { id: e.id, finalAt, branch: e.branch, target: e.target, commit: e.commit, state: e.state, entry: entry as MergeEntry };
};

export class MergeHistory {
  readonly dir: string;
  /** id → where its row is filed (and the state it was filed in); built from the files on first use. */
  private index: Map<string, { month: string; finalAt: string; state?: string }> | null = null;
  /** id → the row's text as last written or read, so an unchanged row is never rewritten. */
  private lines = new Map<string, string>();

  constructor(queueDir: string) {
    this.dir = join(queueDir, "history");
  }

  private file(month: string): string {
    return join(this.dir, `${month}.jsonl`);
  }

  months(): string[] {
    try {
      return readdirSync(this.dir)
        .map((n) => MONTH_RE.exec(n)?.[1])
        .filter((m): m is string => !!m)
        .sort();
    } catch {
      return [];
    }
  }

  /** A month's rows, in file order (a damaged line is skipped). */
  readMonth(month: string): MergeHistoryRow[] {
    let text: string;
    try {
      text = readFileSync(this.file(month), "utf8");
    } catch {
      return [];
    }
    const out: MergeHistoryRow[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as MergeHistoryRow;
        if (r && typeof r.id === "string" && typeof r.finalAt === "string") out.push(r);
      } catch {}
    }
    return out;
  }

  private idx(): Map<string, { month: string; finalAt: string; state?: string }> {
    if (this.index) return this.index;
    const m = new Map<string, { month: string; finalAt: string; state?: string }>();
    for (const month of this.months()) for (const r of this.readMonth(month)) m.set(r.id, { month, finalAt: r.finalAt, ...(r.state ? { state: r.state } : {}) });
    this.index = m;
    return m;
  }

  has(id: string): boolean {
    return this.idx().has(id);
  }

  /** The state an entry's row was filed with, if any. */
  recordedState(id: string): string | undefined {
    return this.idx().get(id)?.state;
  }

  /** An entry's row, or null. */
  get(id: string): MergeHistoryRow | null {
    const at = this.idx().get(id);
    if (!at) return null;
    return this.readMonth(at.month).find((r) => r.id === id) ?? null;
  }

  /** File these rows (upsert by id): each month with a changed row is rewritten once, the rest untouched. */
  upsert(rows: MergeHistoryRow[]): void {
    const idx = this.idx();
    const byMonth = new Map<string, MergeHistoryRow[]>();
    for (const r of rows) {
      const at = idx.get(r.id);
      const month = at?.month ?? monthOf(r.finalAt);
      const row = at ? { ...r, finalAt: at.finalAt } : r;
      const text = JSON.stringify(row);
      if (this.lines.get(r.id) === text) continue;
      if (at && !this.lines.has(r.id)) {
        // Not read since start: compare with what the file holds before rewriting it.
        for (const x of this.readMonth(month)) this.lines.set(x.id, JSON.stringify(x));
        if (this.lines.get(r.id) === text) continue;
      }
      const list = byMonth.get(month) ?? [];
      list.push(row);
      byMonth.set(month, list);
    }
    if (!byMonth.size) return;
    mkdirSync(this.dir, { recursive: true });
    for (const [month, changed] of byMonth) {
      const have = this.readMonth(month);
      const pos = new Map(have.map((r, i) => [r.id, i]));
      for (const r of changed) {
        const i = pos.get(r.id);
        if (i === undefined) {
          pos.set(r.id, have.length);
          have.push(r);
        } else have[i] = r;
      }
      writeAtomic(this.file(month), have.map((r) => `${JSON.stringify(r)}\n`).join(""));
      for (const r of changed) {
        this.lines.set(r.id, JSON.stringify(r));
        idx.set(r.id, { month, finalAt: r.finalAt, ...(r.state ? { state: r.state } : {}) });
      }
    }
  }

  /**
   * File every truly final entry of `entries` (new and changed rows only), and answer the working list a restart
   * would read: the open ones plus the newest `keep` truly final ones (by seq), in their order. An entry leaves it only
   * once its row is filed. A new array when any left (never spliced: a loop over the old one goes on unharmed).
   */
  sync(entries: Stored[], keep: number, opts: { merged?: ReadonlySet<string>; now: string }): Stored[] {
    const final = entries.filter((e) => trulyFinal(entries, e, opts.merged, this.recordedState(e.id)));
    if (!final.length) return entries;
    this.upsert(final.map((e) => rowOf(e, finalAtOf(entries, e, opts.now))));
    const drop = new Set(
      final
        .sort((a, b) => a.seq - b.seq)
        .slice(0, Math.max(0, final.length - keep))
        .map((e) => e.id),
    );
    return drop.size ? entries.filter((e) => !drop.has(e.id)) : entries;
  }

  backfilled(): boolean {
    return existsSync(join(this.dir, "backfilled"));
  }

  /**
   * Once per project (a marker file): partial rows for the entries only runs/ remembers (gone from queue.json and from
   * the history): branch, commit, the newest run's verdict, blame and failures, its times. Idempotent.
   */
  backfill(runs: MergeRun[], known: ReadonlySet<string>, target: string): number {
    if (this.backfilled()) return 0;
    const byEntry = new Map<string, MergeRun[]>();
    for (const r of runs) {
      if (!r?.entry?.startsWith("mq_") || known.has(r.entry) || this.has(r.entry)) continue;
      const list = byEntry.get(r.entry) ?? [];
      list.push(r);
      byEntry.set(r.entry, list);
    }
    const rows: MergeHistoryRow[] = [];
    for (const [id, list] of byEntry) {
      list.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
      const last = list.at(-1)!;
      const failures = last.steps.flatMap((s) => (s.failures ?? []).map((f) => ({ step: s.id, ...f })));
      rows.push({
        id,
        finalAt: last.endedAt ?? last.startedAt,
        branch: last.branch,
        target,
        commit: last.commit,
        partial: true,
        runs: list.map((r) => r.id),
        verdict: last.verdict,
        ...(last.blame ? { blame: last.blame } : {}),
        ...(failures.length ? { failures } : {}),
        startedAt: list[0]!.startedAt,
        ...(last.endedAt ? { endedAt: last.endedAt } : {}),
      });
    }
    rows.sort((a, b) => a.finalAt.localeCompare(b.finalAt));
    if (rows.length) this.upsert(rows);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "backfilled"), `${new Date().toISOString()}\n`, { mode: 0o600 });
    return rows.length;
  }
}

/** Why a verb refuses an entry only the history holds. */
export const historyWords = (r: Pick<MergeHistoryRow, "id" | "branch" | "finalAt" | "state" | "partial">): string =>
  `${r.id} (${r.branch || "unknown branch"}) is finished and kept in the merge queue's history (${r.finalAt.slice(0, 7)}${r.partial ? ", partial" : ""}${r.state ? `, ${r.state}` : ""}): the history is read-only, nothing changes it; Land the branch again for a new entry`;
