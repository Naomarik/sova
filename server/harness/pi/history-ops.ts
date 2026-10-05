// History surgery on pi (§app.harness/session-history): a rewind and a compaction, over a pi
// AgentSession. PiHarnessSession.rewindTo/compact call these with the runtime's session of the moment; the
// targets are narrow so tests can drive them with a fake. Every pi member is read at the call.
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CompactHooks, CompactOutcome, CompactRefusal, RewindHooks, RewindOutcome } from "../../../shared/harness";
import { stripImageNotes } from "../../../shared/image-note";
import { withUsageContext } from "../../../pi-config/extensions/llm-inflight/attribution.ts";
import { REWIND } from "../state-kinds";
import { historyOf } from "./reader";
import { piSessionState } from "./state";

/** The members of AgentSession a rewind uses (narrow so tests can drive it with a fake). */
export interface RewindTarget {
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly sessionManager: Pick<SessionManager, "getBranch" | "getLeafId" | "getEntries" | "appendCustomEntry">;
  navigateTree(targetId: string, options: { summarize: boolean }): Promise<{ editorText?: string; cancelled: boolean }>;
}

/**
 * Rewind to just before the user input `entryId` on the active branch: navigateTree moves the leaf
 * to that message's parent (root when it is the first input) and returns its text, then the
 * `sova-rewind` marker (P10: pi takes the file's last line as the leaf on reopen) makes the move
 * durable. `guard` runs the write guards (its throw is a refusal when `refusal` says so);
 * `beforeMarker` flushes the open-time appends. Those are flushed AFTER navigating, not before:
 * flushed first, they would land on the branch being abandoned and the new branch would lose its
 * model/thinking entries. A refusal writes nothing.
 */
export async function rewindSession(session: RewindTarget, entryId: string, hooks: RewindHooks): Promise<RewindOutcome> {
  const check = (): RewindOutcome | null => {
    try {
      hooks.guard();
    } catch (err) {
      const refusal = hooks.refusal(err);
      if (!refusal) throw err;
      return { ok: false, ...refusal };
    }
    if (session.isStreaming) return { ok: false, reason: "streaming", message: "Stop the turn first, then rewind." };
    if (session.isCompacting)
      return { ok: false, reason: "compacting", message: "Wait for the compaction or rewind in progress to finish, then rewind." };
    // NOT covered by the isStreaming check above, and this is the point of having it separately:
    // `steer()` awaits the extension `input` handlers before it queues anything, so a message can
    // still be on its way out after the turn it was meant to interrupt has ended. Moving the leaf
    // now would deliver it into the NEW branch on the next run — the abandoned message reappearing
    // on the branch the user rewound TO. `hooks.queued` answers for Sova's own queue AND the
    // SDK's, ours or an extension's: all three land the same way.
    if (hooks.queued())
      return { ok: false, reason: "queued", message: "A message is still on its way out. Wait for it to send, or press Stop, then rewind." };
    return null;
  };
  try {
    const refused = check();
    if (refused) return refused;
    const sm = session.sessionManager;
    const target = historyOf(sm.getBranch()).find((h) => h.id === entryId);
    if (target?.kind !== "user")
      return { ok: false, reason: "not_on_branch", message: "That input is not on this chat's current branch anymore." };
    const fromLeafId = sm.getLeafId();
    const result = await session.navigateTree(entryId, { summarize: false });
    if (result.cancelled) return { ok: false, reason: "cancelled", message: "An extension cancelled the rewind." };
    // navigateTree awaits extension handlers; a TUI or foreign writer that appeared meanwhile
    // still gets no write. The in-memory leaf has moved, but that runtime is write-refused from
    // here on and a force reconnect reloads it from disk.
    const late = check();
    if (late) return late;
    hooks.beforeMarker();
    piSessionState(sm).append(REWIND, { targetId: entryId, fromLeafId: fromLeafId! }); // the target is on the branch, so a leaf exists
    // Without pi 0.87's image resize notes: the composer gets the text as typed, not the model's copy.
    return { ok: true, editorText: stripImageNotes(result.editorText ?? "", target.blocks) };
  } catch (err) {
    return { ok: false, reason: "internal", message: err instanceof Error ? err.message : String(err) };
  }
}

/** The members of AgentSession a compaction uses (narrow so tests can drive it with a fake). */
export interface CompactTarget {
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly sessionManager: Pick<SessionManager, "getBranch" | "appendCompaction">;
  compact(customInstructions?: string): Promise<{ tokensBefore: number }>;
}

/**
 * Compact the chat now: pi's own `AgentSession.compact(instructions)`, behind the same refusals a
 * rewind has, because pi's compact() would otherwise do two things silently. It calls `abort()`
 * first (agent-session.js compact()), so a compaction started while a turn streams KILLS the turn;
 * and a message still on its way out would land after a summary that never saw it.
 *
 * `guard` runs the write guards and `allowed` the model policy (the summary is a model call on the
 * session's own model); a throw from either is a refusal when `refusal` says so. The ONE write is
 * pi's `appendCompaction`, and it is wrapped for the call's duration (P2): the write guards run
 * again there — a summary can take minutes, and a TUI that grabbed the file meanwhile must get no
 * write — then `beforeWrite` flushes the open-time appends, so they precede the compaction entry
 * exactly as they precede a prompt. Any refusal or failure therefore writes nothing at all,
 * deferred appends included.
 */
export async function compactSession(session: CompactTarget, instructions: string | undefined, hooks: CompactHooks): Promise<CompactOutcome> {
  const refused = (reason: CompactRefusal, message: string): CompactOutcome => ({ ok: false, reason, message });
  const fromError = (err: unknown): CompactOutcome => {
    const refusal = hooks.refusal(err);
    if (refusal) return refused(refusal.reason, refusal.message);
    const message = err instanceof Error ? err.message : String(err);
    // P3: pi's own refusals and its cancel, by the exact text agent-session.js compact() throws.
    if (message === "Already compacted") return refused("already", "Already compacted.");
    if (message.startsWith("Nothing to compact")) return refused("nothing", "Nothing to compact yet.");
    if (message === "Compaction cancelled") return refused("cancelled", "Compaction cancelled.");
    return refused("internal", `Compaction failed: ${message}`);
  };
  try {
    hooks.guard();
    hooks.allowed();
  } catch (err) {
    return fromError(err);
  }
  if (session.isStreaming) return refused("streaming", "Stop the turn first, then compact.");
  if (session.isCompacting) return refused("compacting", "A compaction is already running.");
  // The same window rewindSession's "queued" names: a steer can still be inside the extension
  // `input` handlers after its turn ended.
  if (hooks.queued())
    return refused("queued", "Wait for the queued messages to send, then compact.");
  // pi refuses this too, but only after announcing a compaction_start; saying it here keeps every
  // client's pane from flickering "Compacting" for a no-op.
  if (session.sessionManager.getBranch().at(-1)?.type === "compaction") return fromError(new Error("Already compacted"));
  const sm = session.sessionManager;
  const append = sm.appendCompaction;
  let entryId: string | null = null;
  sm.appendCompaction = (...args: Parameters<typeof append>) => {
    hooks.guard();
    hooks.beforeWrite();
    entryId = append.apply(sm, args);
    return entryId;
  };
  try {
    // Its summary call is the session's own, recorded with purpose `compaction` (usage ledger).
    const result = await withUsageContext({ purpose: "compaction" }, () => session.compact(instructions));
    if (!entryId) return refused("internal", "Compaction failed: pi reported success but wrote no compaction entry.");
    return { ok: true, entryId, tokensBefore: result.tokensBefore };
  } catch (err) {
    return fromError(err);
  } finally {
    sm.appendCompaction = append;
  }
}

/** P3: pi's prompt() refusal while a manual compaction runs (agent-session.js prompt(), 0.87.1). */
export function isCompactionInProgress(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Cannot submit a prompt while compaction is in progress");
}
