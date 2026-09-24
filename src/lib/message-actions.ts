// Per-message actions: which delivered message gets a
// strip, what that strip offers, what Copy puts on the clipboard, and why an action is off right
// now. Pure decisions only — no DOM, no socket — so the seams that actually bit us (one strip per
// ENTRY when a reply renders as several rows, a reason that is never silently absent) are testable
// without a browser.

import type { TranscriptItem } from "../../shared/protocol";
import { entryIdOf } from "./jump";

export type MessageActionKind = "copy" | "fork" | "rewind" | "regenerate" | "remove";

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
}

/**
 * The strips for a list of rendered rows, in render order.
 *
 * An assistant message renders one row PER CONTENT BLOCK, all sharing an entry id
 * (`<entryId>:<n>`, server/transcript.ts), so a strip per row would put three "Regenerate this
 * reply" buttons under one reply. One strip per entry, drawn after the entry's LAST row that
 * shows text — never after its tool card, which is not a bubble to hang a Copy on. Rows that are
 * neither a user message nor assistant text (wake nudges, tool calls, thinking, info, reports,
 * compactions) get nothing: there is no message there to copy, rewind, regenerate or fork from.
 */
export function messageStrips(rows: readonly TranscriptItem[]): MessageStrip[] {
  const strips: MessageStrip[] = [];
  /** Where an entry's strip already is in `strips`, so a later block of the same entry moves it. */
  const at = new Map<string, number>();
  /** What started the turn these replies belong to: a message the user sent, or a wake nudge. */
  let startedBy: "user" | "wake" = "user";
  rows.forEach((item, index) => {
    if (item.kind === "wake") {
      startedBy = "wake";
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
      strips.push({ index, entryId, role: "assistant", text, ...(startedBy === "wake" ? { fromWake: true } : {}) });
      return;
    }
    // The same reply, one more block: the strip moves down to it and Copy takes both blocks.
    const strip = strips[seen]!;
    strip.index = index;
    strip.text = [strip.text, text].filter((t) => t.trim()).join("\n\n");
  });
  return strips;
}

/** The strips by the row index they hang off, which is how a renderer asks "is there one here?". */
export function stripsByRow(rows: readonly TranscriptItem[]): Map<number, MessageStrip> {
  return new Map(messageStrips(rows).map((s) => [s.index, s]));
}

/**
 * What a strip offers, in order: the safe actions first, then a gap, then the one that changes
 * the branch. `copyable` is false for an images-only message — a Copy that copies "" would claim
 * to have copied the message.
 */
export function actionsFor(role: MessageRole, opts: { copyable: boolean }): LandedActionKind[] {
  const safe: LandedActionKind[] = opts.copyable ? ["copy", "fork"] : ["fork"];
  return [...safe, role === "user" ? "rewind" : "regenerate"];
}

/** Each action's accessible name. Icon-only buttons have nothing else to say what they do. */
export const ACTION_LABEL: Record<MessageActionKind, string> = {
  copy: "Copy message",
  fork: "Fork the session from here",
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
}

export const TUI_LIVE_REASON = "This session is open in a terminal, so Sova won't write to it.";
export const FORK_TUI_LIVE_REASON = "This session is open in a terminal, so Sova won't read it out from under that process.";
export const FORK_MID_TURN_REASON = "This session is mid-turn. Forking reads the file, and we don't read it while it's being written. This enables itself when the turn finishes.";
export const FORK_COMPACTING_REASON = "Wait for the compaction to finish, then fork.";
export const FORK_PENDING_REASON = "A fork is already being made.";

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
    // Fork never writes to THIS session — it reads it — so a model switch or an archived pane
    // doesn't touch it. What stops it is somebody else writing the file.
    case "fork":
      if (s.live) return FORK_TUI_LIVE_REASON;
      if (s.pending) return FORK_PENDING_REASON;
      if (s.streaming) return FORK_MID_TURN_REASON;
      if (s.compacting) return FORK_COMPACTING_REASON;
      return null;
    case "rewind":
    case "regenerate":
      // Permanent before anything else: waiting, stopping or reconnecting never makes a wake
      // nudge into a message you sent.
      if (kind === "regenerate" && s.wake) return REGENERATE_WAKE_REASON;
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

// ---- Fork refusals ------------------------------------------------------------------------------

/**
 * The server's 409 codes, in Sova's own words (the fanout dialog's rule: never parse the
 * server's prose, and never drop a code we don't know — an older client stays honest by passing
 * the server's own sentence through).
 */
export function forkRefusalText(code: string | undefined, message: string): string {
  switch (code) {
    case "tui-live":
      return FORK_TUI_LIVE_REASON;
    case "mid-turn":
      return FORK_MID_TURN_REASON;
    case "busy":
      return "Another program wrote to this session a moment ago. Forking waits until it stops.";
    case "old-format":
      return "This session is in an older session format. Open it for chat once to update it, then fork.";
    case "not-on-branch":
      return "That message isn't on the current branch anymore. Reload the transcript and fork from a message you can see.";
    case "nothing-before":
      return "There's nothing before this message to fork from — it's the first thing in the session.";
    case "missing":
      return "This session's file couldn't be read.";
    case "config":
      return "This session's working directory is gone, so it cannot be opened.";
    default: {
      const detail = message.trim();
      return detail ? `Couldn't fork this session. ${detail}` : "Couldn't fork this session.";
    }
  }
}

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

/** What a fork actually managed to put in the new session's composer. Counted from what was
    staged, never from what the server offered — the sentence below is only as true as this. */
export interface ForkStage {
  /** The message's text went into the draft. */
  text: boolean;
  /** Images now in the CHILD's own attachments — a copy it owns, never the source's file. */
  carried: number;
  /** Images that could not be copied: unreadable, or the upload failed. NEVER silently dropped —
      this is what the sentence has to say out loud. */
  lost: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What the fork says it did, counting only what it actually staged. An image whose file is gone
 * is named, never quietly left behind: "your message is in the composer" while its pictures
 * vanished is the kind of half-truth the user finds out about at send time.
 */
export function forkSentence(stage: ForkStage): string {
  const base = stage.text ? "Forked. Your message is in the new session's composer" : "Forked into a new session";
  const came = stage.carried;
  const total = came + stage.lost;
  // Never a cause. An image can fail to come along because its file was deleted, because it sits
  // somewhere this server won't read from, or because it was too big to re-upload — and
  // `available: false` cannot tell those apart. "couldn't come along" is true of all of them;
  // "gone from disk" would be a guess dressed as a fact.
  const images =
    total === 0
      ? ""
      : stage.lost === 0
        ? `, with ${came === 1 ? "its image" : `its ${came} images`}`
        : came === 0
          ? `, but ${stage.lost === 1 ? "its image" : `its ${stage.lost} images`} couldn't come along`
          : `, with ${came} of ${plural(total, "image")}. The other ${stage.lost} couldn't come along`;
  // A message sitting in a composer is self-evidently unsent; a fork that staged none has to say
  // so in words, or "Forked into a new session." leaves open whether the turn was re-run there.
  // A fork never sends anything, in either shape.
  return `${base}${images}.${stage.text ? "" : " Nothing was sent."}`;
}

/** What lands in the new session's composer after a fork from a USER message (pi's /fork): its
    own text, ahead of anything already drafted there — nothing typed is ever replaced. */
export function forkDraft(editorText: string | undefined, existing: string): string {
  const text = (editorText ?? "").trim() ? editorText! : "";
  if (!text) return existing;
  return existing ? `${text}\n\n${existing}` : text;
}
