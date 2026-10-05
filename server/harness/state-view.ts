// The view over a session's state (§app.harness/state): pure, pi-free, no I/O. It reads the `state` entries
// of any HEntry list (an active branch, a whole file, a held session's live read) by kind, and folds them
// as today's readers do: the newest well-formed record wins, lists run oldest first over well-formed
// records, presence ignores what a record holds, a marker is the first record written. Raw pi entries
// reach it only through the adapter (server/harness/pi/state.ts `stateViewOf`).
import type { HEntry, StateKind, StateRecord, StateView } from "../../shared/harness";

type StateEntry = Extract<HEntry, { kind: "state" }>;

const recordOf = <T>(e: StateEntry, data: T): StateRecord<T> => {
  const r: StateRecord<T> = { id: e.id, parentId: e.parentId, data };
  if (e.at !== undefined) r.at = e.at;
  return r;
};

/** A view over `entries` (any order the caller means: file order, or a branch root first). Entries of other
    kinds are ignored. The entries are indexed by type on the first read; the view never copies a record's
    data, so a reader gets the parse's value (for most kinds, the object as written). */
export function stateView(entries: readonly HEntry[]): StateView {
  let byType: Map<string, StateEntry[]> | null = null;
  const of = (type: string): StateEntry[] => {
    if (!byType) {
      byType = new Map();
      for (const e of entries) {
        if (e.kind !== "state") continue;
        const list = byType.get(e.key);
        if (list) list.push(e);
        else byType.set(e.key, [e]);
      }
    }
    return byType.get(type) ?? [];
  };
  const newest = <T>(kind: StateKind<T>, keep: (data: T) => boolean): StateRecord<T> | null => {
    const list = of(kind.type);
    for (let i = list.length - 1; i >= 0; i--) {
      const data = kind.parse(list[i]!.data);
      if (data !== null && keep(data)) return recordOf(list[i]!, data);
    }
    return null;
  };
  return {
    latest: (kind) => newest(kind, () => true),
    list(kind) {
      const out = [];
      for (const e of of(kind.type)) {
        const data = kind.parse(e.data);
        if (data !== null) out.push(recordOf(e, data));
      }
      return out;
    },
    has: (kind) => of(kind.type).length > 0,
    first(kind) {
      const e = of(kind.type)[0];
      if (!e) return null;
      const data = kind.parse(e.data);
      return data === null ? null : recordOf(e, data);
    },
    byTarget: (kind, targetId) => newest(kind, (data) => data.targetId === targetId),
    written: (kind) => of(kind.type).map((e) => recordOf<unknown>(e, e.data)),
  };
}
