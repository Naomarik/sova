import type { SessionSummary } from "../../shared/protocol";
import { reuseUnchanged } from "./summary-diff";

export interface ArchiveMutation {
  commit(deleted?: boolean): void;
  rollback(): void;
}

type Change = { archived: boolean; deleted: boolean; pending: boolean };

/** Local archive intent sits above server lists until a post-settlement poll confirms it.
 * Polls capture revision before requesting: a changed revision invalidates their answer,
 * including an old answer arriving after a newer poll already confirmed the mutation. */
export class OptimisticArchive {
  revision = 0;
  private changes = new Map<string, Change>();
  constructor(private changed: () => void) {}

  begin(session: SessionSummary, archived: boolean): ArchiveMutation {
    const previous = this.changes.get(session.path);
    const before = previous?.archived ?? session.archived;
    const change: Change = { archived, deleted: false, pending: true };
    this.changes.set(session.path, change);
    this.bump();
    const finish = (rollback: boolean, deleted = false) => {
      if (this.changes.get(session.path) !== change) return;
      change.archived = rollback ? before : archived;
      change.deleted = !rollback && deleted;
      change.pending = false;
      this.bump();
    };
    return { commit: (deleted) => finish(false, deleted), rollback: () => finish(true) };
  }

  observe(rows: readonly SessionSummary[], owns: (path: string) => boolean): void {
    const byPath = new Map(rows.map((s) => [s.path, s]));
    let acknowledged = false;
    for (const [path, c] of this.changes) {
      const s = byPath.get(path);
      if (owns(path) && !c.pending && (c.deleted ? !s : !!s && !!s.archived === !!c.archived)) {
        this.changes.delete(path);
        acknowledged = true;
      }
    }
    if (acknowledged) this.revision++;
    // The caller publishes these rows next; notifying before publication would briefly
    // expose the old raw list with its overlay already removed.
  }

  apply(rows: SessionSummary[] | undefined, previous?: SessionSummary[]): SessionSummary[] | undefined {
    if (!rows) return rows;
    if (!this.changes.size) return reuseUnchanged(rows, previous);
    const next = rows.flatMap((s) => {
      const c = this.changes.get(s.path);
      if (!c) return [s];
      if (c.deleted) return [];
      return s.archived === c.archived ? [s] : [{ ...s, archived: c.archived }];
    });
    return reuseUnchanged(next, previous);
  }

  private bump(): void {
    this.revision++;
    this.changed();
  }
}
