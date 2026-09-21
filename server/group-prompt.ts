import type { BatchPromptResult, BatchRefusal, BatchRefusalCode } from "../shared/protocol";
import { isArchived } from "./archived-sessions";
import { acquireChat, activeConfigFailure, BusyError, ConfigError, heldChat } from "./chat-manager";
import { readLive } from "./live";
import { readAssignments, readGroups } from "./session-groups";
import { idOf, indexedSessionPaths, listSessionFiles } from "./sessions-index";
import { recentForeignWriteAgeSec } from "./write-guard";

/**
 * The shared follow-up of a group workspace (spec/14-workspaces.md §14 "The group composer"):
 * one request, N sessions, and ALL-OR-NOTHING — every member is checked before any of them is
 * prompted, so a refusal leaves zero prompts sent and can name every blocked member at once.
 *
 * All-or-nothing is a PRE-CHECK, not a transaction: a member that breaks between the check and
 * its send (a TUI grabs it in the same second) makes the batch partial, and we say so. A prompt a
 * model is already answering cannot be recalled, and nothing here pretends otherwise.
 *
 * `sent` MEANS ACCEPTED, NOT ANSWERED. The route returns as soon as every member's prompt is
 * queued and never waits for the turns: the SDK's prompt() resolves on turn completion, so
 * awaiting them would run five turns end to end — serializing the one thing a workspace exists to
 * run in parallel, and holding the composer for minutes. A member that is accepted and then fails
 * reports in ITS OWN PANE, over its own socket, where every other turn failure already reports;
 * this response never speaks for a turn it didn't wait for (spec §14, 5f2419d).
 */

/** Everything the batch touches, injected so the logic is testable without an SDK runtime. */
export interface BatchDeps {
  /** The group's members in display order, or null when there is no such group. */
  members(groupId: string): string[] | null;
  /** Session id → path. `ids` is what the caller needs resolved, so an implementation can answer
      from a cache and only touch the disk when one of them is missing from it. */
  paths(ids: readonly string[]): Promise<Map<string, string>>;
  /** Open in a TUI (or any other pi process). */
  live(path: string): boolean;
  archived(id: string): boolean;
  /** A permanent open failure (a stored cwd that is gone). */
  misconfigured(path: string): boolean;
  /** Held here AND mid-agent-turn. */
  streaming(path: string): boolean;
  /** Another process has written this file: the held runtime saw a foreign line, or nobody holds
      it and it was written inside RECENT_WRITE_MS by a writer we can't identify. */
  foreignWriter(path: string): boolean;
  /** ACCEPT the prompt, through the same guards as a /ws/chat prompt: resolves once the turn is
      queued, never when it finishes. Rejects only for an acceptance failure. */
  accept(path: string, text: string): Promise<void>;
}

export const realBatchDeps: BatchDeps = {
  members(groupId) {
    const group = readGroups().find((g) => g.id === groupId);
    if (!group) return null;
    // members is reconciled against the assignments on every read, so it IS the membership.
    return (group.members ?? []).map((m) => m.id);
  },
  async paths(ids) {
    // The index the server already keeps, first: a directory walk per press of Send costs more
    // the more sessions the user has ever made, to answer a question about five of them.
    const known = indexedSessionPaths();
    if (ids.every((id) => known.has(id))) return known;
    // Something isn't in the cache (a cold start, or a session made since the last listing):
    // one walk, rather than calling a live session missing.
    const map = new Map(known);
    for (const path of await listSessionFiles()) map.set(idOf(path), path);
    return map;
  },
  live: (path) => readLive().get(path) !== undefined,
  archived: (id) => isArchived(id),
  misconfigured: (path) => activeConfigFailure(path) !== undefined,
  streaming: (path) => {
    const chat = heldChat(path);
    return !!chat && chat.session.isStreaming;
  },
  foreignWriter: (path) => {
    const chat = heldChat(path);
    return chat ? chat.hasForeignWrites() : recentForeignWriteAgeSec(path) !== null;
  },
  async accept(path, text) {
    const chat = await acquireChat(path);
    // Guards throw here, synchronously, and that is the acceptance failure. The turn itself is
    // deliberately NOT awaited: its failure belongs in that member's own pane.
    const turn = chat.acceptPrompt(text);
    void turn.catch((err) => chat.reportTurnFailure(err));
  },
};

/** The sentence behind each code. The client renders its own copy per code (spec §14/§9); this is
    the server's fallback, and what a non-browser caller reads. */
const SENTENCE: Record<BatchRefusalCode, string> = {
  "mid-turn": "It is mid-turn. A shared prompt is not a steer: wait for it, or stop it in its own pane.",
  "tui-live": "It is open in a terminal, so this server must not write to it.",
  archived: "It is archived.",
  config: "Its working directory is gone, so its runtime cannot be opened.",
  busy: "Another process wrote to it just now.",
  missing: "Its session file no longer exists.",
  // Fanout-only, but the table is the whole code set: a caller must never meet a code with no sentence.
  "old-format": "It is in an older session format. Open it for chat once to update it, then fan out.",
  "stale-leaf": "It has moved on since the dialog opened. Fan out again from its new last message.",
  internal: "It could not be prompted.",
};

const refusal = (id: string, path: string, code: BatchRefusalCode, message = SENTENCE[code]): BatchRefusal => ({ id, path, code, message });

/**
 * Which refusal applies to one member, or null when it can take the message. Order matters only
 * for which reason the user is shown first; each is independently true.
 */
function check(id: string, path: string | undefined, deps: BatchDeps): BatchRefusal | null {
  if (!path) return refusal(id, "", "missing");
  if (deps.live(path)) return refusal(id, path, "tui-live");
  if (deps.archived(id)) return refusal(id, path, "archived");
  if (deps.misconfigured(path)) return refusal(id, path, "config");
  if (deps.streaming(path)) return refusal(id, path, "mid-turn");
  if (deps.foreignWriter(path)) return refusal(id, path, "busy");
  return null;
}

/** A failure raised by the send itself, in the same vocabulary as the pre-check. */
function codeOf(err: unknown): BatchRefusalCode {
  if (err instanceof ConfigError) return "config";
  // BusyError.code is the WS vocabulary: "busy" is a TUI owning the file, "recent" an
  // unidentified writer — not the same words this route uses.
  if (err instanceof BusyError) return err.code === "busy" ? "tui-live" : err.code === "recent" ? "busy" : "internal";
  return "internal";
}

export type BatchResult =
  | { ok: true; result: BatchPromptResult }
  | { ok: false; status: 400 | 404; error: string }
  | { ok: false; status: 409; refused: BatchRefusal[] };

/**
 * POST /api/session-groups/:id/prompt. `subset` is the user's explicit "Send to the rest" choice
 * (session ids, which must be in the group); without it the whole group is the target. Never
 * inferred server-side: the first call always means every member, so a silent partial send can
 * only ever be the user's own decision.
 */
export async function promptGroup(groupId: string, text: string, subset: string[] | undefined, deps: BatchDeps = realBatchDeps): Promise<BatchResult> {
  if (!text.trim()) return { ok: false, status: 400, error: "text must not be blank" };
  const members = deps.members(groupId);
  if (!members) return { ok: false, status: 404, error: "Group not found" };
  if (members.length === 0) return { ok: false, status: 400, error: "Group has no members" };

  let targets = members;
  if (subset !== undefined) {
    const inGroup = new Set(members);
    const stranger = subset.find((id) => !inGroup.has(id));
    if (stranger) return { ok: false, status: 400, error: `Not a member of this group: ${stranger}` };
    if (subset.length === 0) return { ok: false, status: 400, error: "members must name at least one session" };
    const wanted = new Set(subset);
    targets = members.filter((id) => wanted.has(id)); // group order, not the client's
  }

  const paths = await deps.paths(targets);
  const refused: BatchRefusal[] = [];
  for (const id of targets) {
    const r = check(id, paths.get(id), deps);
    if (r) refused.push(r);
  }
  if (refused.length > 0) return { ok: false, status: 409, refused }; // nothing sent

  // Past this line the batch is committed: each member that fails ACCEPTANCE is reported, never
  // rolled back, and never stops the members behind it.
  //
  // CONCURRENTLY. Accepting a member can mean opening a runtime, so one at a time costs the SUM
  // of N opens before the composer clears — the very serialization this route exists to avoid.
  // Every accept is started before any of them is awaited; the results are then read in group
  // order, so the response still reports members in the order the panes are read.
  const outcomes = await Promise.allSettled(targets.map((id) => deps.accept(paths.get(id)!, text)));
  const sent: string[] = [];
  const failed: BatchRefusal[] = [];
  targets.forEach((id, i) => {
    const outcome = outcomes[i]!;
    if (outcome.status === "fulfilled") {
      sent.push(id);
      return;
    }
    // `message` is never blank: an older client that doesn't know a newer `code` shows it
    // verbatim (spec §14), so an Error with no text must still leave a sentence behind.
    const err = outcome.reason;
    const said = (err instanceof Error ? err.message : String(err)).trim();
    const code = codeOf(err);
    failed.push(refusal(id, paths.get(id)!, code, said || SENTENCE[code]));
  });
  // `sent` is never empty: nothing accepted is not a partial send, it is a refusal. "Sent to 0 of
  // 5 members" is a sentence with no meaning, and §9 deliberately has no copy for it.
  if (sent.length === 0) return { ok: false, status: 409, refused: failed };
  return { ok: true, result: { sent, failed } };
}
