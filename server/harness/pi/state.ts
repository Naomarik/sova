// Sova's per-session state as pi custom entries (§app.harness/state): the one place in server/ that writes
// them. A write is pi's `appendCustomEntry(kind.type, data)` with the caller's data as given (never copied,
// normalized or flushed), so the line pi writes is byte-identical to the direct call it replaces, at the same
// moment: a file opened from disk is written at once, one made by `SessionManager.create` waits, as before, for
// its first user or assistant message (P11), and the deferred open-time appends stay the caller's to flush. A
// direct append emits nothing (a caller broadcasts its own row); a write from inside a running tool goes through pi's
// extension API (`toolStateWriter`), which announces it (`entry_appended`).
//
// Set SOVA_STATE_ASSERT=1 to have a write throw when its data doesn't parse as its kind, or its kind isn't
// registered (a check for tests; off, a write never throws a new error).
import { writeFileSync } from "node:fs";
import { SessionManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EntryId, HEntry, SessionState, SessionStateWriter, StateKind } from "../../../shared/harness";
import { stateKindOf } from "../state-kinds";
import { rawOf } from "./reader";
import { stateViewOf } from "./state-view-of";

export { stateViewOf };

type Manager = Pick<SessionManager, "appendCustomEntry" | "getBranch" | "getEntries">;

function checked<T>(kind: StateKind<T>, data: T): void {
  if (process.env.SOVA_STATE_ASSERT !== "1") return;
  if (stateKindOf(kind.type) !== kind) throw new Error(`SessionState: ${kind.type} is not a registered state kind (server/harness/state-kinds.ts)`);
  if (kind.parse(data) === null) throw new Error(`SessionState: the data written as ${kind.type} doesn't parse as one`);
}

/** The custom entries behind `state` HEntries, as pi wrote them, for a pi-config core that folds pi's own entry
    shape itself (the subagents extension's worker manifests and restore). Other entries are left out. */
export function extensionEntries(entries: readonly HEntry[]): Record<string, any>[] {
  return entries.filter((h) => h.kind === "state").map(rawOf);
}

/** A pi session manager's state. Each call asks the manager again (a test's patch of its methods holds). */
export function piSessionState(sm: Manager): SessionState {
  return {
    append<T>(kind: StateKind<T>, data: T): EntryId {
      checked(kind, data);
      return sm.appendCustomEntry(kind.type, data);
    },
    branch: () => stateViewOf(sm.getBranch()),
    file: () => stateViewOf(sm.getEntries()),
  };
}

/**
 * TEMPORARY (M4 to M5): a bare AgentSession's state (the Overseer's watched session). Counted as a reach by
 * the boundary's reader ratchet; the driving session's own `state` replaces it. Reads `session.sessionManager`
 * on every call.
 */
export function stateOf(session: Pick<AgentSession, "sessionManager">): SessionState {
  return {
    append: (kind, data) => piSessionState(session.sessionManager).append(kind, data),
    branch: () => piSessionState(session.sessionManager).branch(),
    file: () => piSessionState(session.sessionManager).file(),
  };
}

/** The writer for a tool or hook in one of Sova's inline extensions: pi's `appendEntry`, which appends the same
    line and announces it (`entry_appended`). pi doesn't return the id, so `append` returns "". */
export function toolStateWriter(pi: Pick<ExtensionAPI, "appendEntry">): SessionStateWriter {
  return {
    append<T>(kind: StateKind<T>, data: T): EntryId {
      checked(kind, data);
      pi.appendEntry(kind.type, data);
      return "";
    },
  };
}

export interface NewSessionFile {
  /** The session's working directory (pi's header `cwd`). */
  cwd: string;
  /** Where the file goes; pi's default sessions directory for `cwd` when absent. */
  sessionsDir?: string;
  /** The session id; pi mints one when absent. */
  id?: string;
  parentSession?: string;
  /** State records the file starts with, in order, each parented on the one before. */
  seed?: readonly (readonly [StateKind<any>, unknown])[];
}

/**
 * A new session file, written now and whole (pi defers a new session's write to its first user or assistant
 * message, P11): the header, then each seed record, one per line, created exclusively (an existing file throws). Returns the
 * file as pi named it (not canonicalized) and the session id; marking it owned or seen stays the caller's.
 */
export function createSessionFile(opts: NewSessionFile): { path: string; id: string } {
  const sm = SessionManager.create(opts.cwd, opts.sessionsDir, {
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    ...(opts.parentSession !== undefined ? { parentSession: opts.parentSession } : {}),
  });
  const raw = sm.getSessionFile();
  const header = sm.getHeader();
  if (!raw || !header) throw new Error("SessionManager did not produce a session file");
  const state = piSessionState(sm);
  for (const [kind, data] of opts.seed ?? []) state.append(kind, data);
  writeFileSync(raw, `${[JSON.stringify(header), ...sm.getEntries().map((e) => JSON.stringify(e))].join("\n")}\n`, { flag: "wx" });
  return { path: raw, id: header.id };
}

/** One record appended to a session file no runtime holds (pi opens it, appends, and writes at once). */
export function appendToClosedFile<T>(path: string, kind: StateKind<T>, data: T): EntryId {
  return piSessionState(SessionManager.open(path)).append(kind, data);
}
