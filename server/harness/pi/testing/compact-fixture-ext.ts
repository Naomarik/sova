// A pi extension for tests that drives pi's REAL compaction with no model (§app/harness, M5's
// behaviour goldens): its `session_before_compact` handler supplies the summary, so pi writes the
// compaction entry through its own `sm.appendCompaction` (manual `compact()` and the automatic
// threshold/overflow path alike) and emits its own compaction events. pi still asks for the
// summarization auth first, so the session must be authenticated (ScriptedModel or a models.json key).
//
// Load it by path (settings.json `extensions`); it is loaded through pi's own loader, in the test's
// process, so the test reaches it through a global: `compactFixture()` returns the one state object.
// Without a fixture set up, the handler returns nothing and pi compacts as it would on its own.

/** What the handler does, and what it saw. */
export interface CompactFixture {
  /** The summary pi writes. */
  summary: string;
  /** Awaited inside the handler before it answers: the compaction is "running" until it resolves. */
  hold?: Promise<void>;
  /** Answer `{cancel: true}` instead (pi's "Compaction cancelled"). */
  cancel?: boolean;
  /** The tokensBefore pi writes, instead of its own estimate (which counts the system prompt). */
  tokensBefore?: number;
  /** Called inside the handler, in pi's order, with what it saw. */
  onCall?: (seen: CompactFixture["seen"][number]) => void;
  /** One record per call, in order. */
  readonly seen: { reason: string; customInstructions?: string; firstKeptEntryId: string; tokensBefore: number }[];
}

const KEY = Symbol.for("sova.test.compact-fixture");

/** The process's fixture state (created on first use). */
export function compactFixture(): CompactFixture {
  const g = globalThis as Record<symbol, CompactFixture | undefined>;
  return (g[KEY] ??= { summary: "Summary of the earlier conversation.", seen: [] });
}

type BeforeCompact = {
  reason: string;
  customInstructions?: string;
  preparation: { firstKeptEntryId: string; tokensBefore: number };
};

export default function (pi: { on(event: "session_before_compact", handler: (e: BeforeCompact) => unknown): void }) {
  pi.on("session_before_compact", async (event) => {
    const g = globalThis as Record<symbol, CompactFixture | undefined>;
    const f = g[KEY];
    if (!f) return undefined;
    const { firstKeptEntryId, tokensBefore } = event.preparation;
    const seen = { reason: event.reason, ...(event.customInstructions ? { customInstructions: event.customInstructions } : {}), firstKeptEntryId, tokensBefore };
    f.seen.push(seen);
    f.onCall?.(seen);
    if (f.hold) await f.hold;
    if (f.cancel) return { cancel: true };
    return { compaction: { summary: f.summary, firstKeptEntryId, tokensBefore: f.tokensBefore ?? tokensBefore } };
  });
}
