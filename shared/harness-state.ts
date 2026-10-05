// The harness contract, per-session state (§app/harness, §app.harness/state). Types only: imports nothing
// but its siblings, emits nothing. The kinds are registered in server/harness/state-kinds.ts, the view over
// a session's entries is server/harness/state-view.ts, and pi's writer is server/harness/pi/state.ts.
import type { EntryId } from "./harness-core";

/** How readers look at a kind by default. It documents the rule; nothing enforces it on write.
    - `newest-on-branch`: the newest well-formed record on the active branch wins (`latest`).
    - `branch-list`: every well-formed record on the branch, oldest first (`list`, `byTarget`).
    - `file-list`: every well-formed record in the file, abandoned branches included.
    - `presence`: whether the file holds one at all, whatever it holds (`has`).
    - `marker`: the first record the file holds, read once (`first`).
    - `write-only`: a record nothing reads back. */
export type StateFold = "newest-on-branch" | "branch-list" | "file-list" | "presence" | "marker" | "write-only";

/** One kind of per-session state. `type` is its name on disk (pi: the custom entry's customType), unchanged. */
export interface StateKind<T> {
  readonly type: string;
  /** "sova", or the pi-config package whose pi-free core owns the shape (e.g. "extension:mode"). */
  readonly owner: "sova" | `extension:${string}`;
  /** Strict read: the value, or null when the record is not a well-formed instance (readers skip it). */
  parse(data: unknown): T | null;
  readonly fold: StateFold;
}

/** One record of a kind, where it sits in the session's tree. */
export interface StateRecord<T> {
  /** null for a record with no id (a legacy linear file, or a malformed line). */
  id: EntryId | null;
  parentId: EntryId | null;
  /** The record's ISO time, as written. */
  at?: string;
  data: T;
}

/** A pure read over one list of entries (an active branch, or a whole file). */
export interface StateView {
  /** The newest well-formed record of the kind, or null. */
  latest<T>(kind: StateKind<T>): StateRecord<T> | null;
  /** Every well-formed record of the kind, oldest first. */
  list<T>(kind: StateKind<T>): StateRecord<T>[];
  /** Whether any record of the kind is there, well-formed or not. */
  has(kind: StateKind<unknown>): boolean;
  /** The oldest record of the kind, parsed; null when there is none or when it is malformed (a marker is
      read once: a later record never stands in for it). */
  first<T>(kind: StateKind<T>): StateRecord<T> | null;
  /** The newest well-formed record of the kind whose `targetId` is `targetId`, or null. */
  byTarget<T extends { targetId: string }>(kind: StateKind<T>, targetId: string): StateRecord<T> | null;
  /** Every record of the kind as written, malformed included, oldest first (id allocation and dedupe,
      which count what any record claims). */
  written(kind: StateKind<unknown>): StateRecord<unknown>[];
}

/** A session's state writer: synchronous, one append per call, the data as given (never copied,
    normalized or flushed). Returns the new record's id; "" when the harness doesn't say (a write from
    inside a running tool). */
export interface SessionStateWriter {
  append<T>(kind: StateKind<T>, data: T): EntryId;
}

/** A held session's state: its active branch, its whole file, and its writer. Reads are live. */
export interface SessionState extends SessionStateWriter {
  branch(): StateView;
  /** Every entry in the file, abandoned branches included (revokes, grant uses, key dedupe, id allocation). */
  file(): StateView;
}
