import { randomUUID } from "node:crypto";
import type { QueueGoneReason, QueueItem, QueueRemoveRefusal } from "../shared/protocol";

/**
 * Sova's OWN outgoing queue for one chat.
 *
 * WHY THERE IS ONE AT ALL. The SDK can queue messages (`steer`, `prompt` with a
 * `streamingBehavior`) but it cannot un-queue ONE of them: `AgentSession` exposes `clearQueue()`,
 * `getSteeringMessages()`, `getFollowUpMessages()` and `pendingMessageCount`, and the queues
 * underneath (`PendingMessageQueue`) have enqueue/peek/drain/clear only. Items still held here are
 * an app-side queue: removing one is a splice of our own array. A HANDED steer is taken back through
 * the harness (`SdkQueueView.steerTicket`, quirk P29 steer-remove: the pi adapter splices pi's own
 * copies, by the message's identity); nothing in this module reads or splices a pi field itself.
 *
 * THE RULE THAT MAKES IT WORK: a run of our items is handed to the SDK only when the SDK IS HOLDING
 * NOTHING AT ALL (`Agent.hasQueuedMessages()` false — ours or anyone's, either kind), and the items
 * inside it at any time are ALL OF ONE KIND (`handed`, in order). Follow-ups go one at a time, as
 * they always did: the next goes in when the previous drains. STEERS LAND TOGETHER: while pi still
 * holds steers of ours, the next waiting steer is handed over at once, behind them, and pi's
 * steering mode is "all" in Sova's runtimes (quirk P28 steer-all, server/harness/pi/queue-modes.ts),
 * so the agent's next step takes every one of them, each its own message, in the order sent. A
 * steer never joins a follow-up of ours (pi's continue() would take the steer first, P9), and a
 * follow-up never joins steers: the order the messages were sent in is kept.
 *
 * Because pi drains the steering lane WHOLE, "the real queue is empty" still proves every handed
 * item was delivered, so the one-bit reasoning below holds for N items as it did for one. What it
 * cannot prove is a PARTIAL drain: a steer handed while the loop is taking the earlier ones (inside
 * the hand-off's input handlers) lands at the step after them, and until the set drains this module
 * still counts the earlier ones as held (`settleEarlierHanded` catches the case where an event shows
 * the gap). That is a split batch and a late "delivered", never a lost or reordered message.
 *
 * A HANDED STEER STAYS REMOVABLE until the agent takes it (§chat.transcript/a-queued-message). Each
 * steer is handed over with a TICKET (`SdkQueueView.steerTicket`): the harness names the very message
 * the hand-off queued (by identity, never by text, so one of three identical steers is that one and
 * another sender's steer is never it) and takes it out of the agent's queue on its own, synchronously,
 * so it is either still there and goes, or already taken and is a sent message. One asked to go while
 * its hand-off is still running (an image being described) goes the moment pi queues it. When the
 * ticket cannot name one message the removal is refused (`shared_queue`), never guessed. A handed
 * FOLLOW-UP, and a steer that started a turn of its own, cannot be removed: Stop takes them back.
 * Items still held in Sova are a plain array: removing a middle one, one of three identical texts, or
 * an image-only one is a splice that cannot fail and cannot reorder anything.
 *
 * WHICH QUEUE IS READ, AND WHY IT IS NOT THE OBVIOUS ONE. There are TWO structures per kind, and
 * the visible one is the wrong one:
 *
 *   • `Agent.steeringQueue.messages` — the REAL queue. The loop drains it; a drained message is
 *     committed to the model.
 *   • `AgentSession._steeringMessages` (what `getSteeringMessages()` returns) — a MIRROR, spliced
 *     on `message_start` by `indexOf(messageText)` and ONLY `if (messageText)`
 *     (agent-session.js:564-576).
 *
 * Reading the mirror gets two things wrong, both found by the reviewer's counterexamples and both
 * silent:
 *
 *   1. AN IMAGE-ONLY SEND NEVER LEAVES THE MIRROR. `messageText` is "" so the splice is skipped;
 *      the mirror keeps it for the session's life. A queue that waits for the mirror to empty
 *      waits for ever, and every later message is stranded. Sova can queue exactly that today —
 *      the protocol allows images with no text.
 *   2. THE MIRROR SPLICES LATER THAN THE DRAIN. Between the loop taking a message and emitting
 *      `message_start` (prepareNextTurn, which can COMPACT) the mirror still lists it — so a
 *      Stop in that window would hand back, as cleared, a message already on its way to the model.
 *
 * So presence is read from the REAL queue, through the ONLY public reader of it that exists in the
 * copy Sova resolves: `Agent.hasQueuedMessages()` (`AgentSession.agent` is public,
 * agent-session.d.ts:196). `Agent.peekQueuedMessages()` (a preview of the messages selected for the
 * next turn) would answer far more precisely. It was absent from the 0.86.1 this was designed
 * against and arrived with the 0.87.1 pin (pi-agent-core `agent.d.ts:100`); the bump adopted
 * nothing, so nothing here depends on it. server/chat-queue-clients.test.ts pins its presence
 * against a real session, so using it, or losing it again, is a decision rather than a drift.
 *
 * That leaves ONE BIT — "is anything at all queued, either kind" — and every rule is built from it
 * plus two sound readings of the mirror:
 *   • mirror ≥ its real queue ALWAYS (same synchronous push; the mirror loses the item later), so
 *     a mirror length of ZERO proves that kind's real queue is empty.
 *   • the mirror grows only on an enqueue, and pi announces each enqueue synchronously
 *     (`queue_update`), so growth seen during our own hand-off is our item being queued.
 * Neither reading trusts a non-zero mirror to mean anything, which is what makes them immune to
 * the entries it holds for ever.
 *
 * WHAT IS NOT SOLVED, ON PURPOSE. A handed follow-up is never removed one by one (above). Extensions
 * queue follow-ups of their own (`pi.sendUserMessage(…, {deliverAs:"followUp"})` — wake-nudge, btw,
 * explain, subagents, command-palette), so `clearQueue()` is lossless only when ours is all that is
 * in there; Stop clears the lot and hands every text back. Every approximation in here is built to
 * fail toward "still held" and never toward a wrong "delivered".
 */

/** pi's ImageContent, structurally (pi-ai types.d.ts:256) — the shape prompt/steer and storage
    both take. Spelled out rather than imported so this module needs nothing from the SDK. */
export interface QueueImage {
  type: "image";
  data: string;
  mimeType: string;
}

export type QueueKind = QueueItem["kind"];

/** One message waiting to go out, with everything needed to send it LATER: the raw text and the
    image bytes, never an expansion. Expansion and the extension `input` handlers happen at
    hand-off, once, in order — the same handlers as before, at the moment the item reaches the
    front instead of the moment it was typed. */
export interface WebQueueItem {
  id: string;
  kind: QueueKind;
  text: string;
  images?: QueueImage[];
  origin: QueueItem["origin"];
  /** The Overseer sent it (`POST /api/sessions/prompt` with its sender secret): the chat marks
      the user entry it becomes as the Overseer's once it is handed over (§app.overseer/sent-marker). */
  overseer?: { overseerId?: string };
  /** A baton participant sent it (§app.baton/attribution): marked `sova-baton-sent` at hand-off. */
  baton?: { by: string };
  /** Another session sent it (`session_send`, §chat.profiles/delivery): marked `sova-session-sent` at hand-off. */
  session?: { sessionId: string; title: string; hop: number };
  /** A person typed it outside this session's composer (a group batch the user sent): its input
      source is `user` although Sova queued it (inputSourceOf). */
  byPerson?: true;
  /** The Overseer only: a click on the confirm card of this tool call (§app.overseer/org-people-facing). */
  confirm?: string;
  /** The key it was sent under (a worker's steer or follow-up): kept to its hand-off, where the message the
      SDK builds from it is labelled with it (server/send-keys.ts, §app.chat-processes/worker-instructions). */
  key?: string;
}

/**
 * The input source of a message Sova hands to the agent (§app.overseer/input-source): `user` only
 * for what a person typed (this session's composer, a group batch, a baton participant), `queued`
 * for everything Sova sends on its own (briefs, auto-resume, sova_send, another session's or a
 * project overseer's prompt). Never `system`: vision-delegate skips that source, so an image on such
 * a message would go undescribed. Extensions read it in pi's words (`interactive`, `rpc`, `extension`;
 * server/harness/pi/session.ts maps them): wake-nudge restarts its fire limit only on `interactive`.
 */
export function inputSourceOf(item: Pick<WebQueueItem, "origin" | "overseer" | "baton" | "byPerson">): "user" | "queued" {
  if (item.overseer) return "queued";
  return item.origin === "client" || item.baton || item.byPerson ? "user" : "queued";
}

/**
 * The SDK's queues as this module is allowed to see them. Two readers, because they answer
 * different questions and only one of them is trustworthy about delivery.
 */
export interface SdkQueueView {
  /**
   * `Agent.hasQueuedMessages()` — true iff either REAL queue still holds a message.
   *
   * FALSE IS THE ONLY PROOF OF DELIVERY THERE IS, and it is the whole reason this interface
   * exists. It was also ALL the SDK gave us when this was built: `peekQueuedMessages()` was not in
   * the 0.86.1 Sova resolved then (it is in the 0.87.1 pinned now, unused; see the header), so
   * the real queue is asked whether it is empty and nothing more. Every rule below is built from
   * that one bit plus the mirror.
   */
  hasQueued(): boolean;
  /**
   * `getSteeringMessages().length + getFollowUpMessages().length` — the MIRROR total.
   *
   * Never read as truth about what is queued. It is read once, as a hand-off begins, as the
   * baseline for the `queue_update` totals that follow: growth from it during the hand-off is our
   * own item being queued. The mirror's two defects — it lags the drain, and it keeps empty-text
   * entries for ever — are both harmless to a comparison against our own earlier reading.
   */
  mirrorTotal(): number;
  /**
   * The MIRROR length for one kind (`getSteeringMessages().length` or `getFollowUpMessages()`).
   *
   * Used for ONE sound implication and no other: the mirror is never shorter than its real queue
   * (both are pushed in the same synchronous block, and the mirror is the one that loses the item
   * LATER), so a mirror length of ZERO proves that kind's REAL queue is empty. That is what lets a
   * steer be handed over while an extension's follow-up is parked in the other queue — i.e. what
   * keeps a steer a steer. The reverse is never read: a non-zero mirror proves nothing, because of
   * the empty-text and rewritten-text entries it can hold for ever.
   */
  mirrorFor(kind: QueueKind): number;
  /**
   * Whether that kind's mirror currently holds this exact text
   * (`getSteeringMessages().includes(text)` / `getFollowUpMessages()` — both public).
   *
   * Read for ONE purpose, in sdkTookHanded: an empty per-kind mirror only proves delivery if
   * nothing could have spliced our entry by mistake, and the SDK's steering-first splice can do
   * exactly that when a message of the other kind carries our text.
   */
  mirrorHas(kind: QueueKind, text: string): boolean;
  /**
   * A ticket for the steer about to be handed over (shared/harness-session.ts SteerTicket): `run` the
   * hand-off inside it, and `remove()` takes that one message back out of the SDK's queue,
   * synchronously — "removed", "later" (not queued yet: it goes the moment it is), "taken" (the agent
   * already has it) or "unknown" (no one message to name). Absent: handed steers can't be removed.
   */
  steerTicket?(): HandedTicket | undefined;
}

/** shared/harness-session.ts SteerTicket, structurally (this module imports nothing from the harness). */
export interface HandedTicket {
  run<T>(handOff: () => T): T;
  remove(): "removed" | "later" | "taken" | "unknown";
}

/**
 * Everything outside this module, injected so the rules can be driven without an SDK, a socket or
 * a disk. EACH COMMENT IS A SPECIFICATION a fake gets written against: a fake that agrees with a
 * wrong comment proves nothing.
 */
export interface QueueDeps {
  /** The SDK's queues RIGHT NOW. Read again after every await; they change under us. */
  sdk: SdkQueueView;
  /**
   * Hand one item to the SDK. Resolves once the item has been ACCEPTED — queued, executed
   * immediately (an extension command), swallowed by an `input` handler, or used to start a fresh
   * turn — and NEVER waits for a turn to finish. An idle-session `prompt()` resolves at turn end,
   * so that call must be started and not awaited here, or the queue would stall for the whole run.
   */
  handOff(item: WebQueueItem, streaming: boolean): Promise<void>;
  /** Whether a turn is running (AgentSession.isStreaming). */
  streaming(): boolean;
  /**
   * Whether nothing may be handed over at all right now: a compaction is running, and pi refuses
   * every prompt meanwhile ("Cannot submit a prompt while compaction is in progress",
   * agent-session.js prompt()). Held items stay held — still removable, still cleared by Stop —
   * and go in at the next wake after it ends. Absent = never paused.
   */
  paused?(): boolean;
  /**
   * Whether the SDK is settling a run right now (quirk P5): a prompt made now is deferred and runs
   * outside the async context of its hand-off, so a KEYED item would reach the model unlabelled. A
   * keyed item waits until it has passed (looked at again on the next timer tick); others go as
   * before. Absent = never settling.
   */
  settling?(): boolean;
  /** AgentSession.clearQueue(): empties BOTH SDK queues and returns what was in them. */
  clearSdkQueue(): { steering: string[]; followUp: string[] };
  /** The write guards (TUI ownership, foreign writers). Throws on refusal. */
  guard(): void;
  /**
   * Start a run for messages THE SDK IS ALREADY HOLDING, adding nothing of our own.
   *
   * Exists for one state, which is reachable and otherwise permanent: a message can be in the
   * SDK's real queue with NO run active, because `steer()` awaits the extension `input` handlers
   * before queueing and the turn it meant to interrupt can end first (agents/server/harness/overview.md, the vision-delegate
   * window). Nothing drains a queue while the agent is idle, and this queue refuses to hand
   * anything over while the SDK holds something — so without a wake the user's next message waits
   * for ever behind a message that is itself waiting for a run that will never start.
   *
   * MUST NOT be awaited: it resolves at TURN END, like every other run.
   */
  wake(): void;
  /**
   * One item left the queue, and why. Called BEFORE the `onChange` that no longer lists it, and
   * for EVERY departure without exception — the client is told the reason rather than left to
   * infer one from a snapshot diff, which cannot distinguish "sent" from "someone else removed it"
   * from "an input handler ate it". Broadcast, not addressed: a second tab on the same chat must
   * learn about a removal it did not make.
   */
  onGone(item: WebQueueItem, reason: QueueGoneReason): void;
  /** The queue changed: broadcast the snapshot. Called after every mutation, never in the middle. */
  onChange(items: QueueItem[]): void;
  /** Handing `item` to the SDK failed; the item is already out of the queue. */
  onHandOffError(item: WebQueueItem, err: unknown): void;
}

export type RemoveOutcome =
  | { ok: true; item: WebQueueItem }
  | { ok: false; reason: QueueRemoveRefusal; message: string };

/** How many departures are remembered for the sake of a removal that lost its race. */
const DEPARTED_MEMORY = 100;

/** Why a handed item with no ticket can't be removed (a follow-up, or a steer that started a turn;
    §chat.transcript/a-queued-message). Their rows draw no Remove, so only an API caller reads it. */
export const HANDED_REFUSAL = "It's already with the agent, which takes it at its next step. Stop takes it back.";

const REFUSALS: Record<Exclude<QueueRemoveRefusal, "internal">, string> = {
  consumed: "That message has already been sent.",
  unknown: "That message is not in the queue anymore.",
  shared_queue: "pi queued work of its own alongside this message, so it can't be taken back on its own. Press Stop to clear the queue.",
  busy: "This session is not writable from Sova right now.",
};

const other = (kind: QueueKind): QueueKind => (kind === "steer" ? "followUp" : "steer");

export class WebQueue {
  /** Waiting, in delivery order. Never contains a handed item. */
  private held: WebQueueItem[] = [];
  /** The items the SDK has and that are not known delivered yet, in hand-off order, ALL OF ONE KIND
      (several only for steers). None is in `held`. While `handing`, the last is still inside `handOff`. */
  private handed: WebQueueItem[] = [];
  /** `pump()` is re-entrant by nature (events fire while it awaits); one runner at a time, with a
      re-run flag, so a wake-up that arrives mid-pump is never lost. */
  private pumping = false;
  private pumpAgain = false;
  private closed = false;
  /**
   * True while the last of `handed` is inside `handOff` — the SDK has not been given it yet, because
   * the extension `input` handlers run FIRST and vision-delegate can spend a model call there. During
   * that window the SDK's queue count for it is 0, which looks exactly like "the loop already took
   * it". Stop must not read one as the other, so it waits on `handOffSettled` instead.
   */
  private handing = false;
  private handOffSettled: Promise<void> = Promise.resolve();
  /** A Stop is waiting out a hand-off: nothing more is handed over meanwhile. Without it the steer
      behind would join the moment that hand-off settles, before the Stop runs, and land after it. */
  private draining = false;
  /**
   * A `queue_update` showed the mirror GROWING during the current hand-off: our item was queued (pi
   * pushes and announces it synchronously, `_queueSteer`/`_queueFollowUp`). A TOTAL read after the
   * hand-off cannot say so: a steer joining others finds `hasQueued()` true whatever became of it,
   * and one that is pushed and announced (+1) while another is spliced (-1) leaves it unchanged.
   * Every enqueue is its own event, so one-in-one-out cannot hide inside a single observation.
   */
  private grewWhileHanding = false;
  /** The last mirror total a `queue_update` reported (or read when a hand-off began), for spotting
      growth between two of them. */
  private lastMirrorObserved = 0;
  /**
   * Why recently departed items left, so a removal that lost a race is told the truth instead of
   * "unknown" — the difference between "already sent" and "never existed" is the difference
   * between a row that becomes a message and a row that disappears. Bounded: this is a courtesy
   * for in-flight requests, not a history.
   */
  private departed = new Map<string, QueueGoneReason>();
  /** The ticket of each handed steer that has one (by item id): what can still take it back. */
  private tickets = new Map<string, HandedTicket>();
  /** Removals asked for while that item's hand-off was still running: settled when it ends. */
  private removeAfterHandOff = new Set<string>();

  constructor(private readonly deps: QueueDeps) {}

  /** The wire snapshot: the handed items first (they go out first), then the waiting ones. A handed
      steer with a ticket is still "queued": it can be taken back until the agent takes it. */
  snapshot(): QueueItem[] {
    const wire = (it: WebQueueItem, state: QueueItem["state"]): QueueItem => ({
      id: it.id,
      kind: it.kind,
      state,
      text: it.text,
      ...(it.images?.length ? { images: it.images.length } : {}),
      origin: it.origin,
      ...(it.overseer ? { overseer: true as const } : {}),
      ...(it.session ? { fromSession: { sessionId: it.session.sessionId, title: it.session.title } } : {}),
    });
    return [...this.handed.map((it) => wire(it, this.tickets.has(it.id) ? "queued" : "sending")), ...this.held.map((it) => wire(it, "queued"))];
  }

  get size(): number {
    return this.held.length + this.handed.length;
  }

  /** Queue one message and start (or wake) the pump. Returns the item's id, which is `clientId`
      when the caller supplied one — the client keys its pending row by it. */
  enqueue(input: {
    kind: QueueKind;
    text: string;
    images?: QueueImage[];
    origin: QueueItem["origin"];
    id?: string;
    overseer?: WebQueueItem["overseer"];
    baton?: WebQueueItem["baton"];
    session?: WebQueueItem["session"];
    byPerson?: true;
    confirm?: WebQueueItem["confirm"];
    key?: string;
  }): string {
    const item: WebQueueItem = {
      id: input.id || randomUUID(),
      kind: input.kind,
      text: input.text,
      ...(input.images?.length ? { images: input.images } : {}),
      origin: input.origin,
      ...(input.overseer ? { overseer: input.overseer } : {}),
      ...(input.baton ? { baton: input.baton } : {}),
      ...(input.session ? { session: input.session } : {}),
      ...(input.byPerson ? { byPerson: true as const } : {}),
      // A confirm card's click keeps its mark while it waits (§app.overseer/org-people-facing).
      ...(input.confirm ? { confirm: input.confirm } : {}),
      ...(input.key !== undefined ? { key: input.key } : {}),
    };
    this.held.push(item);
    this.deps.onChange(this.snapshot());
    void this.pump();
    return item.id;
  }

  /**
   * An SDK event that may have changed the SDK queue (`queue_update`, `message_start`,
   * `agent_settled`, `agent_end`). Cheap: `pump()` re-reads the counts and does nothing when
   * there is nothing to do.
   */
  onSdkEvent(): void {
    this.settleEarlierHanded();
    void this.pump();
  }

  /**
   * A `queue_update` from the SDK, carrying the mirror's own totals. Growth means SOMEBODY
   * ENQUEUED something; while our own hand-off is in flight that somebody is us, and afterwards it
   * is not. Sticky until the next hand-off, because once we have lost track of whose message is in
   * the queue, nothing later puts it back.
   */
  observeQueueUpdate(steering: number, followUp: number): void {
    const total = steering + followUp;
    if (total > this.lastMirrorObserved && this.handing) this.grewWhileHanding = true;
    this.lastMirrorObserved = total;
    this.settleEarlierHanded();
    void this.pump();
  }

  /**
   * While a steer is being handed in behind others of ours, an empty REAL queue proves the loop took
   * those others (the one being handed is not in it yet, or was taken with them): they are delivered.
   * Without this they would count as held until the new one drains too.
   */
  private settleEarlierHanded(): void {
    if (!this.handing || this.handed.length < 2 || this.deps.sdk.hasQueued()) return;
    const done = this.handed.splice(0, this.handed.length - 1);
    for (const item of done) this.depart(item, "delivered");
    this.deps.onChange(this.snapshot());
  }

  /**
   * Remove one item by id. A WAITING item always goes. A HANDED steer with a ticket goes while the
   * agent has not taken it (its ticket takes exactly that message out of the SDK's queue); one the
   * agent took is refused `consumed`, and one the ticket can't name `shared_queue`. Any other handed
   * item never goes (§chat.transcript/a-queued-message): Stop takes it back.
   */
  async remove(itemId: string): Promise<RemoveOutcome> {
    const idx = this.held.findIndex((it) => it.id === itemId);
    if (idx !== -1) {
      const item = this.held.splice(idx, 1)[0]!;
      this.depart(item, "removed");
      this.deps.onChange(this.snapshot());
      return { ok: true, item };
    }
    const handedItem = this.handed.find((it) => it.id === itemId);
    if (!handedItem) return this.refuseDeparted(itemId);
    const ticket = this.tickets.get(itemId);
    if (ticket) return this.removeHanded(handedItem, ticket);
    // "no" is the REAL queue being empty, which is the only honest proof of delivery: the loop
    // has taken it and the model is getting it, whether or not `message_start` has been emitted.
    if (!this.handing && this.sdkTookHanded()) {
      this.departHanded();
      this.deps.onChange(this.snapshot());
      void this.pump();
      return refuse("consumed");
    }
    return refuse("internal", HANDED_REFUSAL);
  }

  /** A handed steer, by its ticket. Synchronous against the SDK's queue, except while its own hand-off
      runs: then it goes the moment pi queues it, and the answer waits for the hand-off to settle. */
  private async removeHanded(item: WebQueueItem, ticket: HandedTicket): Promise<RemoveOutcome> {
    const out = ticket.remove();
    if (out === "removed") {
      this.dropHanded(item);
      this.depart(item, "removed");
      this.deps.onChange(this.snapshot());
      void this.pump();
      return { ok: true, item };
    }
    if (out === "later") {
      this.removeAfterHandOff.add(item.id);
      while (this.handing && this.handed.at(-1) === item) await this.handOffSettled;
      this.removeAfterHandOff.delete(item.id);
      if (this.departed.get(item.id) === "removed") return { ok: true, item };
      if (this.handed.includes(item)) return this.removeHanded(item, ticket);
      return this.refuseDeparted(item.id);
    }
    if (out === "taken") {
      // pi's lane is first in, first out: what was handed before it was taken with it.
      const done = this.handed.splice(0, this.handed.indexOf(item) + 1);
      for (const it of done) this.depart(it, "delivered");
      this.deps.onChange(this.snapshot());
      void this.pump();
      return refuse("consumed");
    }
    return refuse("shared_queue");
  }

  /** Every handed item has been delivered: each departs so, in order. */
  private departHanded(): void {
    const done = this.handed;
    this.clearHanded();
    for (const item of done) this.depart(item, "delivered");
  }

  /** An id this queue no longer holds: say WHY it is gone when we still know, rather than
      "unknown" for everything. A removal that lost a race to delivery is a sent message, and a
      client told "unknown" would drop the row instead of showing it as sent. */
  private refuseDeparted(itemId: string): RemoveOutcome {
    return this.departed.get(itemId) === "delivered" ? refuse("consumed") : refuse("unknown");
  }

  /** Record the departure, then announce it. Both, always, in that order. */
  private depart(item: WebQueueItem, reason: QueueGoneReason): void {
    this.tickets.delete(item.id);
    this.departed.set(item.id, reason);
    if (this.departed.size > DEPARTED_MEMORY) this.departed.delete(this.departed.keys().next().value!);
    this.deps.onGone(item, reason);
  }

  /**
   * Stop: everything Sova holds AND everything the SDK holds, in delivery order (the SDK's
   * first — they were ahead), so the caller can hand the texts back to the composer exactly as
   * `queue_cleared` has always promised. The SDK's texts are the EXPANDED ones, ours are raw; that
   * difference is pre-existing (a drained steer has always come back expanded) and is why our own
   * items are reported raw rather than re-expanded to match.
   *
   * Handed items the loop has already taken (the real queue is empty) are delivered, not cleared:
   * they depart so and their texts, which pi's mirror may still list, leave `steering`/`followUp`.
   *
   * `keep`: the items it picks are not cleared but handed back whole in `kept`, to be written to
   * the transcript without a turn (a baton move that stops a reply keeps every queued message,
   * §app.baton/hand-off). They depart "delivered" and their texts leave `steering`/`followUp`.
   * A handed item is kept only while the SDK really still holds it: once the loop has taken it, it
   * is the run's message already.
   */
  async drain(keep?: (item: WebQueueItem) => boolean): Promise<{ steering: string[]; followUp: string[]; kept: WebQueueItem[] }> {
    // STOP MUST NOT RACE A HAND-OFF. An item parked in an extension `input` handler is neither in
    // `held` nor in the SDK, so clearing both would report it cleared, hand back no text, and then
    // let the hand-off finish and deliver it AFTER the user pressed Stop. Waiting for the hand-off
    // is what makes "nothing queued survives this" true; the delay is bounded by the same handler
    // the send was already waiting on, and `abort()` follows either way.
    this.draining = true;
    try {
      while (this.handing) await this.handOffSettled;
    } finally {
      this.draining = false;
    }
    // The loop took every handed item already (the real queue is empty, or holds none of ours).
    const taken = this.handed.length && this.sdkTookHanded() ? this.handed : [];
    const inSdk = taken.length ? [] : this.handed;
    // Ours first, then the SDK's: clearing the SDK's queue emits `queue_update` synchronously,
    // which pumps, and a pump that still saw our items would call the handed ones delivered
    // and put the next one into the SDK, past this drain and the abort after it.
    const held = this.held.splice(0);
    this.clearHanded();
    const sdk = this.deps.clearSdkQueue();
    const gone = [...inSdk, ...held];
    // A picked item the loop already took is delivered (its sender mark waits for its message), not kept.
    const kept = keep ? gone.filter(keep) : [];
    const sdkKind = (kind: QueueKind, texts: string[]) => {
      // A taken or kept handed item's (possibly expanded) text leaves the SDK's list (the mirror
      // still lists one the loop has taken): its first match, else, for one item, the only text.
      const out = [...texts];
      const mine = [...taken, ...inSdk.filter((it) => kept.includes(it))].filter((it) => it.kind === kind);
      for (const it of mine) {
        const i = out.indexOf(it.text);
        if (i >= 0) out.splice(i, 1);
        else if (mine.length === 1 && out.length === 1) out.length = 0;
      }
      return out;
    };
    const ours = (kind: QueueKind) => held.filter((it) => it.kind === kind && !kept.includes(it)).map((it) => it.text);
    for (const item of taken) this.depart(item, "delivered");
    for (const item of gone) this.depart(item, kept.includes(item) ? "delivered" : "cleared");
    this.deps.onChange(this.snapshot());
    return {
      steering: [...sdkKind("steer", sdk.steering), ...ours("steer")],
      followUp: [...sdkKind("followUp", sdk.followUp), ...ours("followUp")],
      kept,
    };
  }

  /** The runtime is going away: stop handing anything over. Nothing is reported — a disposed
      chat's clients are already being told to reconnect. */
  close(): void {
    this.closed = true;
    this.held = [];
    this.clearHanded();
    this.tickets.clear();
    if (this.settleRetry) clearTimeout(this.settleRetry);
    this.settleRetry = null;
  }

  /** The pump's look again once a settle window has passed (one at a time). */
  private settleRetry: ReturnType<typeof setTimeout> | null = null;
  private afterSettle(): void {
    if (this.settleRetry || this.closed) return;
    this.settleRetry = setTimeout(() => {
      this.settleRetry = null;
      void this.pump();
    }, 0);
  }

  /**
   * Hand as many items over as the rules allow (one follow-up at a time; every waiting steer while
   * steers of ours are in), then stop and wait for an event.
   *
   * The loop re-reads `counts()` after every await because the agent loop drains between our
   * awaits; nothing here is decided from a value read before one.
   */
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        await this.pumpOnce();
      } while (this.pumpAgain && !this.closed);
    } catch (err) {
      // A DEP THREW SYNCHRONOUSLY, AND WITHOUT THIS THE PROCESS DIES.
      //
      // Every caller does `void this.pump()`, so an escaping rejection is an UNHANDLED REJECTION,
      // and Node's default since v15 (`--unhandled-rejections=throw`) TERMINATES THE PROCESS. For
      // Sova that is the process hosting the chat (a chat process: the chat and its served calls),
      // reached here by a disk error. Measured, not reasoned: a synchronously throwing dep gave
      // "caught by the caller of enqueue(): NO / unhandled rejections observed: 1".
      //
      // The reachable path today is `wake()` → `wakeQueuedRun` → `flushDeferredAppends()`, which
      // WRITES THE SESSION FILE, so ENOSPC/EACCES/EROFS throws synchronously. But the catch is
      // deliberately at the PUMP rather than around that one call: `hasQueued()`, `streaming()`,
      // `onChange`/`onGone` (which broadcast to sockets) and `guard()` can all throw too, and a
      // guard around today's culprit would leave the next one fatal.
      //
      // Swallowed rather than rethrown, and the queue is left usable: `pumping` resets in the
      // finally, held items stay held, nothing is reported delivered or removed, and the next SDK
      // event or send re-pumps. A stalled queue the user can clear with Stop is recoverable; a
      // dead server with its workers is not.
      console.error("[queue] pump failed", err);
    } finally {
      this.pumping = false;
    }
  }

  private async pumpOnce(): Promise<void> {
    while (!this.closed) {
      // Our handed items are gone from the SDK queue once that queue is empty again — a count, not a
      // text match, so three identical messages need no special case.
      if (this.handed.length) {
        // Only an EMPTY REAL QUEUE proves delivery. The mirror lags the drain and keeps empty-text
        // entries for ever, so waiting on it strands the queue (see the class comment).
        if (!this.sdkTookHanded()) {
          // OUR OWN item can be the one stranded: handed off as a steer, queued after the turn
          // ended, with no run to drain it. Waking is the only way it is ever delivered — and it
          // is delivered, not forgotten, so no false "delivered" and nothing is dropped.
          if (!this.deps.streaming()) return this.deps.wake();
          // STEERS LAND TOGETHER: the next waiting steer joins ours inside pi, which takes them all at
          // its next step. Anything else waits for them to drain: a follow-up behind steers, and any
          // steer behind a follow-up of ours (pi's loop would take the steer first, P9).
          // The narrow window: a steer handed after the run's last poll for steers can wait for, or
          // start, a run of its own (the wake above) while the earlier ones run in this one, so a batch
          // can split there. Order still holds and nothing is lost; accepted.
          if (this.held[0]?.kind !== "steer" || this.handed[0]!.kind !== "steer") return;
        } else {
          this.departHanded();
          this.deps.onChange(this.snapshot());
        }
      }
      const next = this.held[0];
      if (!next || this.draining) return;
      if (this.deps.paused?.()) return; // woken again when the compaction ends
      // A keyed item never goes in while the SDK settles a run: its prompt would be deferred past the
      // send that labels it (quirk P5). It goes, labelled, once the window has passed. Each item of a
      // batch is looked at here, before its own hand-off.
      if (next.key !== undefined && this.deps.settling?.()) return this.afterSettle();
      const joining = this.handed.length > 0;
      if (!joining) {

      // IDLE WITH SOMETHING ALREADY QUEUED: wake the SDK instead of going in.
      //
      // This is the deadlock breaker, and it must be a wake rather than "hand ours over and let the
      // run flush both". Handing ours over would start the run with OUR message, and the loop only
      // polls the steering queue AFTER the first assistant turn — so the message that was queued
      // FIRST would be delivered SECOND. A wake runs what is already queued, as its own run, and
      // our item follows normally once a run exists.
      if (this.deps.sdk.hasQueued() && !this.deps.streaming()) {
        this.deps.wake();
        return; // a run is starting; the ordinary path resumes on its events
      }

      // WHEN AN ITEM MAY GO IN. Nothing queued at all is the clean case. Failing that, an empty
      // mirror for its own kind is taken as PERMISSION TO GO IN ANYWAY.
      //
      // That second clause is not an optimisation, it is the difference between a steer and a
      // post-turn message: extensions park follow-ups in the SDK routinely (a subagent reporting,
      // wake-nudge, btw, explain), and waiting for the queues to be globally empty would hold every
      // typed steer until the turn ended.
      //
      // AND IT IS SAFE EVEN THOUGH THE PER-KIND MIRROR CAN LIE (see sdkTookHanded: a follow-up
      // delivery can splice the STEERING mirror). Being wrong here only means our item goes in
      // BEHIND something rather than in front of it — the order among our own items is unchanged.
      // A false zero costs nothing of ours; it cannot cost a message. The same reading is guarded in
      // sdkTookHanded precisely because THERE it could call a message delivered that is not.
      if (this.deps.sdk.hasQueued() && this.deps.sdk.mirrorFor(next.kind) > 0) return;
      }
      this.held.shift();
      this.handed.push(next);
      // Growth from here to the hand-off's end is our own push (observeQueueUpdate).
      this.lastMirrorObserved = this.deps.sdk.mirrorTotal();
      this.grewWhileHanding = false;
      const streaming = this.deps.streaming();
      // A steer into a running turn waits in the SDK's queue for the agent's next step: its ticket keeps
      // it removable until then. One handed to an idle agent starts a turn of its own and gets none.
      const ticket = next.kind === "steer" && streaming ? this.deps.sdk.steerTicket?.() : undefined;
      if (ticket) this.tickets.set(next.id, ticket);
      this.deps.onChange(this.snapshot()); // a row with no ticket flips to "sending" before we await anything
      // A Stop that arrives during the hand-off waits on this instead of reading the SDK's count,
      // which is 0 for an item that has not been given to it YET as well as for one it has already
      // taken. The finally is what makes that promise safe to await: every exit from the block
      // below resolves it, including the `return`s.
      let settle!: () => void;
      this.handOffSettled = new Promise<void>((resolve) => (settle = resolve));
      this.handing = true;
      try {
        try {
          await (ticket ? ticket.run(() => this.deps.handOff(next, streaming)) : this.deps.handOff(next, streaming));
        } catch (err) {
          if (!this.handed.includes(next)) continue; // removed meanwhile (its ticket took it out)
          this.dropHanded(next);
          this.depart(next, "failed");
          this.deps.onHandOffError(next, err);
          this.deps.onChange(this.snapshot());
          continue;
        }
        if (this.closed) return;
        // Removed while its hand-off ran: already gone (pi had queued it), or asked for before pi
        // queued it, in which case the ticket took it out the moment pi did. The removal says which.
        if (!this.handed.includes(next)) continue;
        if (ticket && this.removeAfterHandOff.has(next.id) && ticket.remove() === "removed") {
          this.dropHanded(next);
          this.depart(next, "removed");
          this.deps.onChange(this.snapshot());
          continue;
        }
        // Queued: look again, for it drained already, or another steer may join it. Joining steers of
        // ours, `hasQueued()` is true whatever became of this one: only its own push, seen as growth,
        // says it was queued. Alone, growth also covers a push the loop took at once (the queue is
        // empty again by now), which the next look reports as delivered.
        if (this.grewWhileHanding || (!joining && this.deps.sdk.hasQueued())) continue;
        // Nothing was queued, and the two ways that happens need OPPOSITE things from the client.
        // Idle beforehand ⇒ the hand-off started a turn, so the message IS on its way: "delivered",
        // and a message_start will follow. Streaming beforehand ⇒ it was neither queued nor run as a
        // turn, so an extension `input` handler swallowed it or it was an extension command that
        // executed instead: "dropped", and no message_start will EVER come. A client that inferred
        // either from the snapshot would wait forever in one case and double-count in the other.
        this.dropHanded(next);
        this.depart(next, streaming ? "dropped" : "delivered");
        this.deps.onChange(this.snapshot());
        if (!streaming) return; // a turn is starting; `isStreaming` is not yet true, so wait for an event
      } finally {
        this.handing = false;
        settle();
      }
    }
  }

  /**
   * Whether the SDK has taken every handed item: committed to the model, whether or not
   * `message_start` has been emitted yet. The only honest proof of delivery, and the one the mirror
   * cannot give (it lags the drain, and an empty-text entry never leaves it at all). pi drains the
   * steering lane whole (P28 steer-all), so one answer covers every handed steer at once. False is
   * "still held, as far as can be told", never a claim: with something queued that cannot be pinned
   * on ours or anyone else's, they stay handed until it can.
   */
  private sdkTookHanded(): boolean {
    const first = this.handed[0];
    if (!first) return true;
    if (!this.deps.sdk.hasQueued()) return true;
    const kind = first.kind;
    // Something is queued, but `hasQueuedMessages()` is BOTH queues at once and nothing finer is
    // used (0.87's `peekQueuedMessages()` exists but is not adopted; see the header). One narrowing:
    // our KIND's mirror is empty ⇒ its real queue is empty ⇒ ours are gone and what is queued
    // belongs to someone else. GUARDED, because the bare form is unsound: the SDK splices on
    // `message_start` by checking the STEERING mirror FIRST for ANY delivered user message,
    // whatever queue it came from (agent-session.js:389-401, "Check steering queue first"), so
    // delivering a FOLLOW-UP whose text equals a queued STEER's empties the steering mirror while
    // the real steering queue still holds ours. Unguarded this reported a still-queued steer as
    // DELIVERED and let an item of the other kind in behind it. `mirror ≥ real` holds on TOTALS,
    // never per kind. The guard asks whether one of our texts also sits in the OTHER lane's mirror:
    // that is exactly when the mis-splice is possible, and the answer stays "held". Normal traffic,
    // where the texts differ, is untouched.
    return this.deps.sdk.mirrorFor(kind) === 0 && !this.handed.some((it) => this.deps.sdk.mirrorHas(other(kind), it.text));
  }

  private clearHanded(): void {
    for (const it of this.handed) this.tickets.delete(it.id);
    this.handed = [];
  }

  /** `item` never reached pi's queue (it failed, was swallowed, or started a turn): out of `handed`. */
  private dropHanded(item: WebQueueItem): void {
    const i = this.handed.indexOf(item);
    if (i >= 0) this.handed.splice(i, 1);
    this.tickets.delete(item.id);
    if (!this.handed.length) this.clearHanded();
  }

}

function refuse(reason: QueueRemoveRefusal, message?: string): RemoveOutcome {
  return { ok: false, reason, message: message ?? REFUSALS[reason as Exclude<QueueRemoveRefusal, "internal">] };
}
