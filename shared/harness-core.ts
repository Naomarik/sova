// The harness contract, core identities (§app/harness). Types only: imports nothing, emits nothing.
// Sova code outside server/harness/<harness>/ speaks these shapes, never a harness's own. pi is the
// one harness today; its adapter is server/harness/pi/.

/** Which harness produced a value. Provenance only: nothing outside server/harness/<id>/ branches on it. */
export type HarnessId = "pi" | (string & {});

/** A session's key on the wire and in every Sova store. Opaque: only the adapter parses it.
    pi: the session file's absolute path, byte-identical to today's `path` (server/paths.ts resolveSessionPath). */
export type SessionKey = string;

/** An entry's id inside its session (pi: the JSONL entry id). */
export type EntryId = string;

/** "<provider>/<id>" for pi, as SessionSummary.model and ModelInfo.ref carry it today. */
export type ModelRef = string;

/** Detail only one harness has, namespaced by it (pi: a context_edit's target and replacement, a usage's
    per-kind cost, a stop reason Sova has no word for). Read only under server/harness/<harness>/. */
export interface HarnessExt {
  readonly harness: HarnessId;
  readonly [key: string]: unknown;
}
