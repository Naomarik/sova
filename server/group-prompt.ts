import type { BatchPromptResult, BatchRefusal, BatchRefusalCode } from "../shared/protocol";
import { isArchived } from "./archived-sessions";
import { acquireChat, activeConfigFailure, BusyError, ConfigError, heldChat } from "./chat-manager";
import { readLive } from "./live";
import { readAssignments, readGroups } from "./session-groups";
import { idOf, listSessionFiles } from "./sessions-index";
import { recentForeignWriteAgeSec } from "./write-guard";

/**
 * The shared follow-up of a group workspace (spec/14-workspaces.md §14 "The group composer"):
 * one request, N sessions, and ALL-OR-NOTHING — every member is checked before any of them is
 * prompted, so a refusal leaves zero prompts sent and can name every blocked member at once.
 *
 * All-or-nothing is a PRE-CHECK, not a transaction: a member that breaks between the check and
 * its send (a TUI grabs it in the same second) makes the batch partial, and we say so. A prompt a
 * model is already answering cannot be recalled, and nothing here pretends otherwise.
 */

/** Everything the batch touches, injected so the logic is testable without an SDK runtime. */
export interface BatchDeps {
  /** The group's members in display order, or null when there is no such group. */
  members(groupId: string): string[] | null;
  /** Session id → path, for every session file that exists. */
  paths(): Promise<Map<string, string>>;
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
  /** Actually send, through the same guards as a /ws/chat prompt. */
  send(path: string, text: string): Promise<void>;
}

export const realBatchDeps: BatchDeps = {
  members(groupId) {
    const group = readGroups().find((g) => g.id === groupId);
    if (!group) return null;
    // members is reconciled against the assignments on every read, so it IS the membership.
    return (group.members ?? []).map((m) => m.id);
  },
  async paths() {
    const map = new Map<string, string>();
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
  async send(path, text) {
    const chat = await acquireChat(path);
    await chat.prompt(text);
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

  const paths = await deps.paths();
  const refused: BatchRefusal[] = [];
  for (const id of targets) {
    const r = check(id, paths.get(id), deps);
    if (r) refused.push(r);
  }
  if (refused.length > 0) return { ok: false, status: 409, refused }; // nothing sent

  // Past this line the batch is committed: each send that fails is reported, never rolled back,
  // and never stops the members behind it.
  const sent: string[] = [];
  const failed: BatchRefusal[] = [];
  for (const id of targets) {
    const path = paths.get(id)!;
    try {
      await deps.send(path, text);
      sent.push(id);
    } catch (err) {
      // `message` is never blank: an older client that doesn't know a newer `code` shows it
      // verbatim (spec §14), so an Error with no text must still leave a sentence behind.
      const said = (err instanceof Error ? err.message : String(err)).trim();
      const code = codeOf(err);
      failed.push(refusal(id, path, code, said || SENTENCE[code]));
    }
  }
  return { ok: true, result: { sent, failed } };
}
