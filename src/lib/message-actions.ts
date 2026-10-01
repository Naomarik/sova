// Per-message actions: which delivered message gets a
// strip, what that strip offers, what Copy puts on the clipboard, and why an action is off right
// now. Pure decisions only — no DOM, no socket — so the seams that actually bit us (one strip per
// ENTRY when a reply renders as several rows, a reason that is never silently absent) are testable
// without a browser.

import type { TranscriptItem } from "../../shared/protocol";
import { entryIdOf } from "./jump";

export type MessageActionKind = "copy" | "share" | "rewind" | "regenerate" | "remove";

/** The actions a LANDED message offers. A queued message offers only `remove`, which is about
    the outgoing queue rather than about an entry, and carries its own reason (queueRemoveReason). */
export type LandedActionKind = Exclude<MessageActionKind, "remove">;

/** Whose message the strip belongs to. Only these two kinds of entry get one. */
export type MessageRole = "user" | "assistant";

/**
 * One strip: the rendered row it is drawn after, the ENTRY it acts on, and the text Copy would
 * put on the clipboard.
 *
 * `index` indexes the rows handed in, not the transcript: the caller renders those rows and hangs
 * the strip off that one.
 */
export interface MessageStrip {
  index: number;
  entryId: string;
  role: MessageRole;
  /** "" when the entry has no text to copy (an images-only message): then there is no Copy. */
  text: string;
  /** This reply answered a scheduled WAKE-UP rather than a message the user sent. Replaying it
      would re-send Sova's own nudge text as if the user had typed it, so the server refuses
      (`regenerate_refused` reason "wake") and the button says so before the round trip. */
  fromWake?: boolean;
  /** This reply answered a LINK MESSAGE, a partner's words (§mesh.links/transcript): refused the
      same way (`regenerate_refused` reason "link"). */
  fromLink?: boolean;
  /** This reply answered a TOPIC BATCH, notes other sessions pushed (§chat.topics/row): refused the
      same way (`regenerate_refused` reason "topic"). */
  fromTopic?: boolean;
}

/**
 * The strips for a list of rendered rows, in render order.
 *
 * An assistant message renders one row PER CONTENT BLOCK, all sharing an entry id
 * (`<entryId>:<n>`, server/transcript.ts), so a strip per row would put three "Regenerate this
 * reply" buttons under one reply. One strip per entry, drawn after the entry's LAST row that
 * shows text — never after its tool card, which is not a bubble to hang a Copy on. Rows that are
 * neither a user message nor assistant text (wake nudges, tool calls, thinking, info, reports,
 * compactions) get nothing: there is no message there to copy, rewind or regenerate.
 */
export function messageStrips(rows: readonly TranscriptItem[]): MessageStrip[] {
  const strips: MessageStrip[] = [];
  /** Where an entry's strip already is in `strips`, so a later block of the same entry moves it. */
  const at = new Map<string, number>();
  /** What started the turn these replies belong to: a message the user sent, or a wake nudge. */
  let startedBy: "user" | "wake" | "link" | "topic" = "user";
  rows.forEach((item, index) => {
    if (item.kind === "wake" || item.kind === "link" || item.kind === "topic") {
      startedBy = item.kind;
      return;
    }
    if (item.kind === "user") {
      startedBy = "user";
      strips.push({ index, entryId: entryIdOf(item.id), role: "user", text: item.text ?? "" });
      return;
    }
    if (item.kind !== "assistant-text") return;
    const entryId = entryIdOf(item.id);
    const text = item.text ?? "";
    const seen = at.get(entryId);
    if (seen === undefined) {
      at.set(entryId, strips.length);
      strips.push({ index, entryId, role: "assistant", text, ...(startedBy === "wake" ? { fromWake: true } : startedBy === "link" ? { fromLink: true } : startedBy === "topic" ? { fromTopic: true } : {}) });
      return;
    }
    // The same reply, one more block: the strip moves down to it and Copy takes both blocks.
    const strip = strips[seen]!;
    strip.index = index;
    strip.text = [strip.text, text].filter((t) => t.trim()).join("\n\n");
  });
  return strips;
}

/** Whether two strips offer the same thing: everything but where they hang (`index`), which moves
    whenever rows are added above. A row keeps its strip's object while this holds, so a list
    change that doesn't touch the message doesn't rebuild its buttons. */
export const sameStrip = (a: MessageStrip | undefined, b: MessageStrip | undefined): boolean =>
  a === b ||
  (!!a && !!b && a.entryId === b.entryId && a.role === b.role && a.text === b.text && !!a.fromWake === !!b.fromWake && !!a.fromLink === !!b.fromLink && !!a.fromTopic === !!b.fromTopic);

/** The strips by the row index they hang off, which is how a renderer asks "is there one here?". */
export function stripsByRow(rows: readonly TranscriptItem[]): Map<number, MessageStrip> {
  return new Map(messageStrips(rows).map((s) => [s.index, s]));
}

/**
 * What a strip offers, in order: the safe actions first (Share opens the share page with its
 * start on this message), then a gap, then the one that changes the branch. `copyable` is false
 * for an images-only message — a Copy that copies "" would claim to have copied the message.
 */
export function actionsFor(role: MessageRole, opts: { copyable: boolean }): LandedActionKind[] {
  const safe: LandedActionKind[] = opts.copyable ? ["copy", "share"] : ["share"];
  return [...safe, role === "user" ? "rewind" : "regenerate"];
}

/** Each action's accessible name. Icon-only buttons have nothing else to say what they do. */
export const ACTION_LABEL: Record<MessageActionKind, string> = {
  copy: "Copy message",
  share: "Share from here",
  rewind: "Rewind to before this message",
  regenerate: "Regenerate this reply",
  remove: "Remove this queued message",
};

/** The strip's own accessible name, so a screen reader knows whose message these act on. */
export const stripLabel = (role: MessageRole): string =>
  role === "user" ? "Actions for your message" : "Actions for this reply";

/** The two-step confirm: what the armed button says, and what the user is agreeing to. Both say
    what SURVIVES as well as what goes, because the session file does keep the abandoned branch. */
export const REWIND_CONFIRM = {
  label: "Rewind Here",
  note: "This message and every reply after it leave the branch. The session file keeps them.",
};
/**
 * What a Regenerate actually abandons, in the server's own words (backend settled the boundary).
 * It walks back to the NEAREST user message and moves the leaf to that message's PARENT — and a
 * mid-turn steer IS a user message. In `u1 → a1 → tool → s1 → a2`, regenerating a2 resolves to the
 * steer s1, so s1 and a2 leave while u1, a1 and the tool call stay; regenerating a1 resolves to u1
 * and takes a1, the tool call, s1 AND a2 with it. "The message that started this reply, and
 * everything after it" is exact for both, which is why it beats anything naming "this turn" — and
 * why it must not say "this reply and everything after it", which names only the half after the
 * boundary. A reply to a wake nudge never reaches this copy: it is refused with reason "wake".
 */
export const REGENERATE_CONFIRM = {
  label: "Regenerate Here",
  note: "The message that started this reply, and everything after it, leave the branch. The session file keeps them.",
};

/** A reply to a scheduled wake-up has no message of the user's to send again. */
export const REGENERATE_WAKE_REASON = "That reply answered a scheduled wake-up, not a message you sent, so there's nothing to send again.";
export const REGENERATE_LINK_REASON = "That reply answered a linked session's message, not one you sent, so there's nothing to send again.";
export const REGENERATE_TOPIC_REASON = "That reply answered notes other sessions pushed to a topic, not a message you sent, so there's nothing to send again.";

/** Share from here before the session list has named the session: the share page needs its id. */
export const SHARE_WAIT_REASON = "Sova is still reading this session's details. Share enables itself once they load.";

export const ACTION_CONFIRM: Partial<Record<MessageActionKind, { label: string; note: string }>> = {
  rewind: REWIND_CONFIRM,
  regenerate: REGENERATE_CONFIRM,
};

/** What the world says about this view right now. Everything an action can be blocked by. */
export interface ActionState {
  /** This view can write to the session: an open chat here, not a read-only watch. */
  chat: boolean;
  /** A terminal owns the session file (a live TUI). */
  live: boolean;
  /** A turn is streaming in this session. */
  streaming: boolean;
  /** A compaction is running. */
  compacting: boolean;
  /** One request of this kind is already in flight. */
  pending: boolean;
  /**
   * The chat cannot write at all right now, in the composer's own words (archived, connecting,
   * switching model, saving this turn). Null when it can.
   */
  paused: string | null;
  /** This reply answered a wake nudge: there is no message of yours to send again. */
  wake?: boolean;
  /** This reply answered a link message: the same. */
  link?: boolean;
  /** This reply answered a topic batch: the same. */
  topic?: boolean;
}

export const TUI_LIVE_REASON = "This session is open in a terminal, so Sova won't write to it.";
/**
 * Why an action is off, in user-facing words — or null when it can act. Never hidden: a button
 * that disappears takes its reason with it.
 *
 * Order is deliberate: the structural facts first (this is not a chat; a terminal owns the file),
 * because they hold whatever else is true; then a request of the same kind already out; then the
 * chat being unable to write at all; then the turn's own states.
 */
export function actionReason(kind: LandedActionKind, s: ActionState): string | null {
  const verb = kind === "regenerate" ? "regenerate" : "rewind";
  switch (kind) {
    // Copy takes text already on the screen: nothing can refuse it, watch mode included.
    case "copy":
      return null;
    // Share only opens the share page, which reads: a watch or a live terminal can't refuse it.
    case "share":
      return null;
    case "rewind":
    case "regenerate":
      // Permanent before anything else: waiting, stopping or reconnecting never makes a wake
      // nudge into a message you sent.
      if (kind === "regenerate" && s.wake) return REGENERATE_WAKE_REASON;
      if (kind === "regenerate" && s.link) return REGENERATE_LINK_REASON;
      if (kind === "regenerate" && s.topic) return REGENERATE_TOPIC_REASON;
      if (!s.chat) return `Only a chat open in Sova can ${verb}.`;
      if (s.live) return TUI_LIVE_REASON;
      if (s.pending) return `A ${verb} is already in progress.`;
      if (s.paused) return s.paused;
      if (s.streaming) return "Stop the current turn first.";
      if (s.compacting) return "Wait for the compaction to finish.";
      return null;
  }
}

/** A queued row's own states. `sending` = this tab sent it and the server hasn't said it queued. */
export type QueuedState = "sending" | "queued" | "delivered";

/**
 * Once pi has queued work of its own beside a message, that message can never be taken back on its
 * own — the only public reader of pi's queue answers for both queues at once, so "something is
 * queued" can no longer be attributed to our item. NOT transient: the row's Remove is off from
 * then on, and the sentence offers Stop instead of inviting a retry that cannot succeed.
 */
export const SHARED_QUEUE_REASON = "pi queued work of its own alongside this message, so it can't be taken back on its own. Press Stop to clear the queue.";

/** Why this queued row's Remove is off. Delivered rows never draw one at all. */
export function queueRemoveReason(row: { state: QueuedState; pending: boolean; chat: boolean; sharedQueue?: boolean }): string | null {
  if (!row.chat) return "Only a chat open in Sova can remove a queued message.";
  if (row.sharedQueue) return SHARED_QUEUE_REASON;
  // Truthful about what the server holds: until it acknowledges the message, removing it would
  // be a claim about something that may not be in the queue yet.
  if (row.state === "sending") return "Not queued yet. This can be removed once the server has it.";
  if (row.state === "delivered") return "Already sent. It can't be removed now.";
  if (row.pending) return "Removing…";
  return null;
}

/** Copy's clipboard text for a strip, and whether there is any. */
export const copyable = (strip: Pick<MessageStrip, "text">): boolean => strip.text.trim().length > 0;

/** What the toast says once the clipboard has it. */
export const COPIED = "Copied message.";

/**
 * Why a message left the outgoing queue, as the server broadcasts it (`queue_item_gone`) to every
 * client of the chat. The five reasons want opposite things from the row, and a snapshot that no
 * longer lists the message cannot tell them apart — which is why the broadcast, not the snapshot,
 * is what moves a row.
 */
export type QueueGoneReason = "delivered" | "removed" | "cleared" | "failed" | "dropped";

export interface QueueGoneEffect {
  /** What becomes of the row: it turns into a sent message, or it goes. */
  row: "delivered" | "gone";
  /**
   * Whether the message's text goes back to the composer FROM THIS SIGNAL. True for the two
   * reasons nothing else answers, and only those:
   *
   * - "dropped" — an extension `input` handler took the message, so no `message_start` is ever
   *   coming and no Stop will fire; the row would otherwise sit on "Sending…" for the life of the
   *   pane over text that exists nowhere else.
   * - "failed" — the hand-off was refused, and the message was never sent.
   *
   * Not "cleared": Stop is the sole owner of that restore (`queue_cleared` carries the drained
   * texts), and restoring here as well would paste each of them twice.
   *
   * Not "removed", from either the broadcast or the requester's own ack: DELETE IS A DISCARD.
   * Stop takes the queue back to be edited and re-sent; Delete says this message should never be
   * sent, and quietly re-pasting it into the draft would undo the gesture the user just made. The
   * `text` on those messages names what left the queue; it is not an instruction to put it back.
   */
  restore: boolean;
}

export function queueGoneEffect(reason: string): QueueGoneEffect {
  if (reason === "delivered") return { row: "delivered", restore: false };
  return { row: "gone", restore: reason === "dropped" || reason === "failed" };
}

/**
 * A refused removal, in Sova's words. `shared_queue` is a real, transient state: pulling the
 * head of the SDK queue back is only lossless when nothing else is in it, and pi's own extensions
 * (wake nudges, subagent reports, the remote check) queue follow-ups of their own.
 */
export function queueRemoveRefusalText(reason: string, message: string): string {
  switch (reason) {
    case "consumed":
      return "Already sent. It can't be removed now.";
    case "unknown":
      return "That message isn't in the queue anymore.";
    case "shared_queue":
      return SHARED_QUEUE_REASON;
    case "busy":
      return "The session is busy right now. Try again in a moment.";
    default: {
      const detail = message.trim();
      return detail ? `Couldn't remove it from the queue. ${detail}` : "Couldn't remove it from the queue.";
    }
  }
}
