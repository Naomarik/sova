// The group composer's logic (spec/14-workspaces.md "The group composer", copy in §9): who a
// shared follow-up can reach, what the foot says about the ones it can't, and how a refusal reads.
//
// All of it is pure, because all of it is claims about members: the count in the foot has to be
// the count that comes back from the server, or the refusal stops being a confirmation and becomes
// a discovery. The server is still the only authority — this decides what to SAY, never whether to
// send. Send stays enabled while anyone is available, because the client's picture is a snapshot
// and can be stale in both directions.

import type { BatchRefusal, BatchRefusalCode, SessionSummary } from "../../shared/protocol";

/** Why a member can't take a shared message; null when it can. The names match the wire's codes. */
export type MemberBlock = Extract<BatchRefusalCode, "mid-turn" | "tui-live" | "archived" | "busy" | "missing">;

/** What the foot counts, in the order the foot lists them. */
const BLOCK_ORDER: MemberBlock[] = ["mid-turn", "tui-live", "archived", "busy", "missing"];

/** One count's words, singular and plural sharing a phrase (§9 "Group composer targets line"). */
const BLOCK_WORD: Record<MemberBlock, string> = {
  "mid-turn": "mid-turn",
  "tui-live": "open in a terminal",
  archived: "archived",
  busy: "busy",
  missing: "file gone",
};

/**
 * Whether this member can take a shared message, from the session list alone.
 *
 * Deliberately NOT a full mirror of the server's pre-check: `config` (a session that can't be
 * opened) and a foreign writer are known to the PANE, not to the list, so a member in that state
 * is counted available here and refused by the server — which is exactly the case the refusal
 * banner exists for. Claiming certainty the list doesn't have would make the foot lie in the
 * other direction, which is worse: it would hide a member the user can see is fine.
 */
export function memberBlock(s: SessionSummary): MemberBlock | null {
  if (s.live) return "tui-live";
  if (s.archived) return "archived";
  if (s.busy) return "mid-turn";
  return null;
}

export interface Targets {
  /** Members a send would be offered for. */
  available: string[];
  /** Blocked members by reason, in the foot's order. */
  blocked: { code: MemberBlock; ids: string[] }[];
  total: number;
}

/** Splits the group's members into who can take a message and who can't, keeping member order. */
export function targetsOf(members: readonly SessionSummary[]): Targets {
  const available: string[] = [];
  const byCode = new Map<MemberBlock, string[]>();
  for (const s of members) {
    const block = memberBlock(s);
    if (!block) available.push(s.id);
    else byCode.set(block, [...(byCode.get(block) ?? []), s.id]);
  }
  const blocked = BLOCK_ORDER.filter((c) => byCode.has(c)).map((code) => ({ code, ids: byCode.get(code)! }));
  return { available, blocked, total: members.length };
}

/**
 * The same picture with the group's file-gone members folded in (§14 "Member states"). A gone
 * member has no session row, so `targetsOf` cannot see it — but the server's pre-check counts the
 * ASSIGNMENT, and a send is refused on it. The foot's whole job is to be the count that comes
 * back, so the gone ride under `missing` (the wire's own code for them) and in the total, which
 * is the group's size, not the list's.
 */
export function withGone(t: Targets, gone: readonly string[]): Targets {
  if (gone.length === 0) return t;
  const blocked = [...t.blocked];
  const at = blocked.findIndex((b) => b.code === "missing");
  if (at >= 0) blocked[at] = { ...blocked[at]!, ids: [...blocked[at]!.ids, ...gone] };
  else blocked.push({ code: "missing", ids: [...gone] });
  blocked.sort((a, b) => BLOCK_ORDER.indexOf(a.code) - BLOCK_ORDER.indexOf(b.code));
  return { available: t.available, blocked, total: t.total + gone.length };
}

/**
 * The foot's line: "4 of 5 members · 1 mid-turn". With nobody excluded it is the count alone,
 * because "5 of 5" invites the reader to look for the missing one.
 */
export function targetsLine(t: Targets): string {
  const word = t.total === 1 ? "member" : "members";
  if (t.blocked.length === 0) return `${t.total} ${word}`;
  const reasons = t.blocked.map((b) => ` · ${b.ids.length} ${BLOCK_WORD[b.code]}`).join("");
  return `${t.available.length} of ${t.total} ${word}${reasons}`;
}

/** The sentence for one refused member (§9 "Refusal reason per member"), composed from `code`. */
const REFUSAL_CLAUSE: Partial<Record<BatchRefusalCode, (name: string) => string>> = {
  "mid-turn": (n) => `${n} is mid-turn`,
  "tui-live": (n) => `${n} is open in a terminal`,
  archived: (n) => `${n} is archived`,
  config: (n) => `${n} can't be opened`,
  busy: (n) => `${n} is busy`,
  missing: (n) => `${n}'s file is gone`,
  "old-format": (n) => `${n} is in an older session format`,
  "stale-leaf": (n) => `the fork point you picked isn't ${n}'s latest message anymore`,
};

/**
 * One refusal, in Sova's own voice. The server's `message` is shown only when this build has no
 * sentence for the code — `internal` (the server knows something we have no word for) or a code
 * from a newer server — so an older client stays honest instead of dropping the reason. The words
 * are never parsed out of `message`; that would make the server's prose the UI's copy.
 */
export function refusalSentence(refusal: BatchRefusal, name: string): string {
  const clause = REFUSAL_CLAUSE[refusal.code];
  if (clause) return clause(name);
  const detail = refusal.message.trim();
  return detail ? `${name} couldn't be prompted. ${detail}` : `${name} couldn't be prompted.`;
}

/**
 * The refusal banner's body (§9 "Refusal banner"). `rest` is how many members the batch could
 * still go to — the explicit subset "Send to the Rest" would carry, never inferred server-side.
 */
export function refusalBody(sentences: string[], total: number, rest: number): string {
  const n = sentences.length;
  const head = `${n} of ${total} ${total === 1 ? "member" : "members"} can't take a message right now: ${sentences.join(", ")}.`;
  return rest > 0 ? `${head} Wait for them, or send to the other ${rest}.` : head;
}

/**
 * The partial-send banner's body (§9 "Partial send banner"): who missed the message and what the
 * members that got it are doing. One member keeps §9's sentence exactly; several must agree with
 * their own subject ("were", "they"), because a plural that doesn't reads as a bug in the
 * counting rather than a grammar slip.
 */
export function partialBody(names: readonly string[], sent: number): string {
  const one = names.length === 1;
  const verb = one ? "was" : "were";
  const pronoun = one ? "it didn't" : "they didn't";
  return `${names.join(", ")} ${verb} taken by another program between the check and the send, so ${pronoun} get this message. The ${sent} that did are answering now.`;
}

/** One retry button of the partial-send banner: a member that missed the message. */
export interface PartialRetry {
  /** The ONLY member this press re-sends to — the whole `members` array on the wire, never one of
   *      several picked by a shared button. */
  id: string;
  /** `Send to {member}` (§9), naming exactly `id`'s member and nobody else. */
  label: string;
}

/**
 * The partial-send banner's retries (§9): one button per member that didn't get the message. A
 * single button labelled `Send to {first}` while the request carries every failed id promises one
 * member and prompts them all — the label and the subset have to agree per press, and per-member
 * buttons make them agree by construction, in the many-failed case as in the common one.
 */
export function partialRetries(failed: readonly BatchRefusal[], nameOf: (id: string) => string): PartialRetry[] {
  return failed.map((r) => ({ id: r.id, label: `Send to ${nameOf(r.id)}` }));
}

/** The partial-send state the banner carries (`GroupComposer`'s `partial`). */
export interface PartialState {
  failed: BatchRefusal[];
  sent: number;
  text: string;
}

/**
 * What the partial report becomes after a banner retry reached `accepted` of the missed members.
 * The banner is the only record of who never got the message, so a retry to ONE of two stragglers
 * must leave the other on screen — the report survives with exactly the still-missing members
 * and the count moves by exactly who was reached. All of them reached: nothing is missing, the
 * report is done (null). A member broken during the retry's own check reports in its own pane,
 * not here — this state is about the message the report names.
 */
export function partialAfterRetry(was: PartialState, accepted: readonly string[]): PartialState | null {
  const failed = was.failed.filter((r) => !accepted.includes(r.id));
  return failed.length > 0 ? { failed, sent: was.sent + accepted.length, text: was.text } : null;
}

/**
 * The placeholder names the GROUP's size, not how many can take a message this second. The foot
 * carries availability and changes as members start and finish turns; a placeholder that moved
 * with it would rewrite itself under the caret, and "Ask all 3 members…" would become "Ask all 2
 * members…" while someone typed. `members` is the whole group; a group of one asks about "this
 * member" because "all 1 members" is not a sentence.
 */
export function composerPlaceholder(members: number, folded: boolean): string {
  if (members === 1) return "Ask this member…";
  const ask = `Ask all ${members} members…`;
  return folded ? ask : `${ask}—Enter sends, Shift+Enter adds a line`;
}
