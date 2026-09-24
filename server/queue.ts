import { randomUUID } from "node:crypto";
import type { QueueGoneReason, QueueItem, QueueRemoveRefusal } from "../shared/protocol";

/**
 * Sova's OWN outgoing queue for one chat.
 *
 * WHY THERE IS ONE AT ALL. The SDK can queue messages (`steer`, `prompt` with a
 * `streamingBehavior`) but it cannot un-queue ONE of them: `AgentSession` exposes `clearQueue()`,
 * `getSteeringMessages()`, `getFollowUpMessages()` and `pendingMessageCount`, and the queues
 * underneath (`PendingMessageQueue`) have enqueue/peek/drain/clear only. Per-item removal is
 * therefore either a reach-in to private fields or an app-side queue. This is the app-side queue,
 * and it uses PUBLIC SDK API only — nothing here reads or splices a private field, so a pin bump
 * cannot silently change what a removal does.
 *
 * THE ONE RULE THAT MAKES IT WORK: an item is handed to the SDK only when the SDK IS HOLDING
 * NOTHING AT ALL (`Agent.hasQueuedMessages()` false — ours or anyone's, either kind). So at most
 * one Sova item is ever inside the SDK, every other item is a plain array element, and removing
 * a middle one, one of three identical texts, or an image-only one is a splice that cannot fail
 * and cannot reorder anything. Steering stays steering: the next item goes in the moment the
 * previous drains, which happens MID-TURN.
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
 *      removal in that window reports success for a message already on its way to the model.
 *
 * So presence is read from the REAL queue, through the ONLY public reader of it that exists in the
 * copy Sova resolves: `Agent.hasQueuedMessages()` (`AgentSession.agent` is public,
 * agent-session.d.ts:196). `Agent.peekQueuedMessages()` would answer far more precisely and is
 * declared in OTHER builds of pi-agent-core — it is NOT in the 0.86.1 nested under
 * pi-coding-agent, in neither the .d.ts nor the .js. Nothing here may depend on it;
 * server/chat-queue-clients.test.ts pins its absence against a real session so a design cannot be
 * built on it again.
 *
 * That leaves ONE BIT — "is anything at all queued, either kind" — and every rule is built from it
 * plus two sound readings of the mirror:
 *   • mirror ≥ its real queue ALWAYS (same synchronous push; the mirror loses the item later), so
 *     a mirror length of ZERO proves that kind's real queue is empty.
 *   • the mirror grows only on an enqueue, so "no bigger than my own earlier reading" proves
 *     nothing new was queued since.
 * Neither reading trusts a non-zero mirror to mean anything, which is what makes them immune to
 * the entries it holds for ever.
 *
 * WHAT IS NOT SOLVED, ON PURPOSE. Removing the HANDED-OFF item needs `clearQueue()`, which empties
 * both SDK queues wholesale. Extensions queue follow-ups of their own (`pi.sendUserMessage(…,
 * {deliverAs:"followUp"})` — wake-nudge, btw, explain, subagents, command-palette), so that call is
 * lossless only when our item is all that is in there. `remove()` checks first and refuses
 * `shared_queue` otherwise. Dropping an extension's queued message to satisfy a removal would be
 * precisely the silent loss this feature exists to prevent, so the refusal is the feature. Every
 * approximation in here is built to fail toward that refusal and never toward a wrong removal.
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
   * exists. It is also ALL the SDK gives us: `peekQueuedMessages()` exists in some builds of
   * pi-agent-core but NOT in the copy Sova resolves (0.86.1 nested under pi-coding-agent — it is
   * in neither the .d.ts nor the .js), so the real queue can be asked whether it is empty and
   * nothing more. Every rule below is built from that one bit plus the mirror.
   */
  hasQueued(): boolean;
  /**
   * `getSteeringMessages().length + getFollowUpMessages().length` — the MIRROR total.
   *
   * Never read as truth about what is queued. It is read as a CHANGE DETECTOR: the mirror grows
   * only when something is enqueued, so "no bigger than it was at our hand-off" proves NOTHING
   * NEW WAS QUEUED SINCE, which is what lets one bit of "something is queued" be attributed to
   * our item. The mirror's two defects — it lags the drain, and it keeps empty-text entries for
   * ever — are both harmless to a comparison against our own earlier reading.
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
   * Read for ONE purpose, in sdkHolds' clause 1: an empty per-kind mirror only proves delivery if
   * nothing could have spliced our entry by mistake, and the SDK's steering-first splice can do
   * exactly that when a message of the other kind carries our text.
   */
  mirrorHas(kind: QueueKind, text: string): boolean;
}

/**
 * Everything outside this module, injected so the rules can be driven without an SDK, a socket or
 * a disk. EACH COMMENT IS A SPECIFICATION a fake gets written against — the same rule fanout's
 * `FanoutDeps` earned: a fake that agrees with a wrong comment proves nothing.
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
  /** AgentSession.clearQueue(): empties BOTH SDK queues and returns what was in them. */
  clearSdkQueue(): { steering: string[]; followUp: string[] };
  /** The write guards (TUI ownership, foreign writers). Throws on refusal. */
  guard(): void;
  /**
   * Start a run for messages THE SDK IS ALREADY HOLDING, adding nothing of our own.
   *
   * Exists for one state, which is reachable and otherwise permanent: a message can be in the
   * SDK's real queue with NO run active, because `steer()` awaits the extension `input` handlers
   * before queueing and the turn it meant to interrupt can end first (CLAUDE.md's vision-delegate
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

const REFUSALS: Record<Exclude<QueueRemoveRefusal, "internal">, string> = {
  consumed: "That message has already been sent.",
  unknown: "That message is not in the queue anymore.",
  shared_queue: "pi queued work of its own alongside this message, so it can't be taken back on its own. Press Stop to clear the queue.",
  busy: "This session is not writable from Sova right now.",
};

const other = (kind: QueueKind): QueueKind => (kind === "steer" ? "followUp" : "steer");

export class WebQueue {
  /** Waiting, in delivery order. Never contains the handed-off item. */
  private held: WebQueueItem[] = [];
  /** The one item the SDK has, or null. It is NOT in `held`. */
  private inFlight: WebQueueItem | null = null;
  /** `pump()` is re-entrant by nature (events fire while it awaits); one runner at a time, with a
      re-run flag, so a wake-up that arrives mid-pump is never lost. */
  private pumping = false;
  private pumpAgain = false;
  private closed = false;
  /**
   * True while `inFlight` is inside `handOff` — the SDK has not been given it yet, because the
   * extension `input` handlers run FIRST and vision-delegate can spend a model call there. During
   * that window the SDK's queue count for it is 0, which looks exactly like "the loop already took
   * it". Removal must not read one as the other, so it waits on `handOffSettled` instead.
   */
  private handing = false;
  private handOffSettled: Promise<void> = Promise.resolve();
  /**
   * The mirror total immediately AFTER `inFlight` was handed over — the baseline every later
   * question is asked against. Infinity while nothing is in flight, so a stale comparison can only
   * answer "unsure" (refuse), never "yes" (remove).
   */
  private mirrorAtHandOff = Number.POSITIVE_INFINITY;
  /**
   * Whether the SDK was already holding someone else's message when `inFlight` was handed over.
   * When it was, "something is queued" can never be attributed to our item, so removal refuses.
   * The alternative to handing over at all in that case is to hold the user's steer until the turn
   * ends, which silently stops it being a steer — a worse trade than a refusable removal.
   */
  private handOffHadForeign = false;
  /**
   * Set when a `queue_update` shows the mirror GROWING while nothing of ours was being handed
   * over — i.e. somebody else queued something after our item went in.
   *
   * A TOTAL cannot answer this on its own: an extension enqueueing (+1) while our item is
   * announced (-1) leaves the total unchanged, and "unchanged" would then be read as "nothing was
   * queued since", which is how a removal could clear an extension's message and call our already
   * delivered one removed. Every enqueue emits a `queue_update` SYNCHRONOUSLY right after the push
   * (`_queueSteer`/`_queueFollowUp`), so every +1 is seen as its own event and one-in-one-out
   * cannot hide inside a single observation.
   */
  private foreignSinceHandOff = false;
  /** The last mirror total a `queue_update` reported, for spotting growth between two of them. */
  private lastMirrorObserved = 0;
  /**
   * Why recently departed items left, so a removal that lost a race is told the truth instead of
   * "unknown" — the difference between "already sent" and "never existed" is the difference
   * between a row that becomes a message and a row that disappears. Bounded: this is a courtesy
   * for in-flight requests, not a history.
   */
  private departed = new Map<string, QueueGoneReason>();

  constructor(private readonly deps: QueueDeps) {}

  /** The wire snapshot: the handed-off item first (it goes out first), then the waiting ones. */
  snapshot(): QueueItem[] {
    const wire = (it: WebQueueItem, state: QueueItem["state"]): QueueItem => ({
      id: it.id,
      kind: it.kind,
      state,
      text: it.text,
      ...(it.images?.length ? { images: it.images.length } : {}),
      origin: it.origin,
    });
    const out: QueueItem[] = [];
    if (this.inFlight) out.push(wire(this.inFlight, "sending"));
    for (const it of this.held) out.push(wire(it, "queued"));
    return out;
  }

  get size(): number {
    return this.held.length + (this.inFlight ? 1 : 0);
  }

  /** Queue one message and start (or wake) the pump. Returns the item's id, which is `clientId`
      when the caller supplied one — the client keys its pending row by it. */
  enqueue(input: { kind: QueueKind; text: string; images?: QueueImage[]; origin: QueueItem["origin"]; id?: string }): string {
    const item: WebQueueItem = {
      id: input.id || randomUUID(),
      kind: input.kind,
      text: input.text,
      ...(input.images?.length ? { images: input.images } : {}),
      origin: input.origin,
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
    if (total > this.lastMirrorObserved && this.inFlight && !this.handing) this.foreignSinceHandOff = true;
    this.lastMirrorObserved = total;
    void this.pump();
  }

  /**
   * Remove one item by id. A WAITING item always goes. The HANDED-OFF item can only go through
   * `clearQueue()`, which is taken only when our item is the sole occupant of both SDK queues —
   * see the class comment for why the alternative is loss, not convenience.
   */
  async remove(itemId: string): Promise<RemoveOutcome> {
    // Two passes at most: the first may find the item still inside `handOff`, in which case it
    // waits that out and looks again. Waiting is the honest answer — the request is simply slower
    // than the input handler it raced.
    for (let pass = 0; pass < 2; pass++) {
      const idx = this.held.findIndex((it) => it.id === itemId);
      if (idx !== -1) {
        const item = this.held.splice(idx, 1)[0]!;
        this.depart(item, "removed");
        this.deps.onChange(this.snapshot());
        return { ok: true, item };
      }
      if (!this.inFlight || this.inFlight.id !== itemId) return this.refuseDeparted(itemId);
      if (this.handing) {
        if (pass > 0) return refuse("internal", "The message could not be taken back.");
        await this.handOffSettled;
        continue; // it is now queued in the SDK, or already gone; look again
      }
      try {
        this.deps.guard();
      } catch {
        return refuse("busy");
      }
      const item = this.inFlight;
      const holds = this.sdkHolds();
      // "no" is the REAL queue being empty, which is the only honest proof of delivery: the loop
      // has taken it and the model is getting it, whether or not `message_start` has been emitted.
      if (holds === "no") {
        this.clearInFlight();
        this.depart(item, "delivered");
        this.deps.onChange(this.snapshot());
        void this.pump();
        return refuse("consumed");
      }
      // "unsure" = something is queued but we cannot prove it is ours (unidentified hand-off, or a
      // foreign steer hiding our follow-up from peek()). Refuse rather than guess: a wrong removal
      // either drops someone else's message or claims to have stopped one already sent.
      if (holds === "unsure") return refuse("shared_queue");
      // "yes" already proves the real queues hold our item and nothing else (see sdkHolds), which
      // is exactly the precondition clearQueue() needs: it empties BOTH queues wholesale.
      this.deps.clearSdkQueue();
      this.clearInFlight();
      this.depart(item, "removed");
      this.deps.onChange(this.snapshot());
      void this.pump();
      return { ok: true, item };
    }
    return refuse("internal", "The message could not be taken back.");
  }

  /** An id this queue no longer holds: say WHY it is gone when we still know, rather than
      "unknown" for everything. A removal that lost a race to delivery is a sent message, and a
      client told "unknown" would drop the row instead of showing it as sent. */
  private refuseDeparted(itemId: string): RemoveOutcome {
    return this.departed.get(itemId) === "delivered" ? refuse("consumed") : refuse("unknown");
  }

  /** Record the departure, then announce it. Both, always, in that order. */
  private depart(item: WebQueueItem, reason: QueueGoneReason): void {
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
   */
  async drain(): Promise<{ steering: string[]; followUp: string[] }> {
    // STOP MUST NOT RACE A HAND-OFF. An item parked in an extension `input` handler is neither in
    // `held` nor in the SDK, so clearing both would report it cleared, hand back no text, and then
    // let the hand-off finish and deliver it AFTER the user pressed Stop. Waiting for the hand-off
    // is what makes "nothing queued survives this" true; the delay is bounded by the same handler
    // the send was already waiting on, and `abort()` follows either way.
    if (this.handing) await this.handOffSettled;
    const sdk = this.deps.clearSdkQueue();
    const held = this.held.splice(0);
    const gone = this.inFlight ? [this.inFlight, ...held] : held;
    this.clearInFlight();
    const ours = (kind: QueueKind) => held.filter((it) => it.kind === kind).map((it) => it.text);
    for (const item of gone) this.depart(item, "cleared");
    this.deps.onChange(this.snapshot());
    return {
      steering: [...sdk.steering, ...ours("steer")],
      followUp: [...sdk.followUp, ...ours("followUp")],
    };
  }

  /** The runtime is going away: stop handing anything over. Nothing is reported — a disposed
      chat's clients are already being told to reconnect. */
  close(): void {
    this.closed = true;
    this.held = [];
    this.clearInFlight();
  }

  /**
   * Hand as many items over as the one-at-a-time rule allows, then stop and wait for an event.
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
      // Sova that is the server: every chat session in it, and every hosted worker spawned by
      // one — the worker-suicide hazard CLAUDE.md documents for the dev-server restart, reached
      // here by a disk error instead. Measured, not reasoned: a synchronously throwing dep gave
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
      // Our handed-off item is gone from the SDK queue once that queue is empty again — a count,
      // not a text match, so three identical messages need no special case.
      if (this.inFlight) {
        // Only an EMPTY REAL QUEUE proves delivery. The mirror lags the drain and keeps empty-text
        // entries for ever, so waiting on it strands the queue (see the class comment).
        if (this.sdkHolds() !== "no") {
          // OUR OWN item can be the one stranded: handed off as a steer, queued after the turn
          // ended, with no run to drain it. Waking is the only way it is ever delivered — and it
          // is delivered, not forgotten, so no false "delivered" and nothing is dropped.
          if (!this.deps.streaming()) this.deps.wake();
          return;
        }
        const done = this.inFlight;
        this.clearInFlight();
        this.depart(done, "delivered");
        this.deps.onChange(this.snapshot());
      }
      const next = this.held[0];
      if (!next) return;
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
      // AND IT IS SAFE EVEN THOUGH THE PER-KIND MIRROR CAN LIE (see sdkHolds: a follow-up delivery
      // can splice the STEERING mirror). Being wrong here only means our item goes in BEHIND
      // something rather than in front of it — the order among our own items is unchanged, and
      // `handOffHadForeign` is set on this path, so sdkHolds can never answer "yes" for it and a
      // removal can only be refused. A false zero costs a refusal; it cannot cost a message.
      // The same reading is refused in sdkHolds precisely because THERE it could cost one.
      const foreignQueued = this.deps.sdk.hasQueued();
      if (foreignQueued && this.deps.sdk.mirrorFor(next.kind) > 0) return;
      this.held.shift();
      this.inFlight = next;
      this.mirrorAtHandOff = Number.POSITIVE_INFINITY;
      this.handOffHadForeign = foreignQueued;
      this.foreignSinceHandOff = false;
      const streaming = this.deps.streaming();
      this.deps.onChange(this.snapshot()); // the row flips to "sending" before we await anything
      // A removal that arrives during the hand-off waits on this instead of reading the SDK's
      // count, which is 0 for an item that has not been given to it YET as well as for one it has
      // already taken. The finally is what makes that promise safe to await: every exit from the
      // block below resolves it, including the `return`s.
      let settle!: () => void;
      this.handOffSettled = new Promise<void>((resolve) => (settle = resolve));
      this.handing = true;
      try {
        try {
          await this.deps.handOff(next, streaming);
        } catch (err) {
          this.clearInFlight();
          this.depart(next, "failed");
          this.deps.onHandOffError(next, err);
          this.deps.onChange(this.snapshot());
          continue;
        }
        if (this.closed) return;
        if (this.deps.sdk.hasQueued()) {
          // Queued. Record the mirror total NOW: from here on, "no bigger than this" is the proof
          // that nothing else was queued behind ours, and therefore that the one queued message
          // the SDK admits to is ours. Read after the await, so it includes our own entry.
          this.mirrorAtHandOff = this.deps.sdk.mirrorTotal();
          this.lastMirrorObserved = this.mirrorAtHandOff; // our own push is not foreign growth
          return; // wait for it to drain
        }
        // Nothing was queued, and the two ways that happens need OPPOSITE things from the client.
        // Idle beforehand ⇒ the hand-off started a turn, so the message IS on its way: "delivered",
        // and a message_start will follow. Streaming beforehand ⇒ it was neither queued nor run as a
        // turn, so an extension `input` handler swallowed it or it was an extension command that
        // executed instead: "dropped", and no message_start will EVER come. A client that inferred
        // either from the snapshot would wait forever in one case and double-count in the other.
        this.clearInFlight();
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
   * Whether the SDK still holds our in-flight item.
   *
   * "no"     — both REAL queues are empty, so it has been drained: committed to the model, whether
   *            or not `message_start` has been emitted yet. The only honest proof of delivery, and
   *            the one the mirror cannot give (it lags the drain, and an empty-text entry never
   *            leaves it at all).
   * "yes"    — something is queued AND nothing has been enqueued since our hand-off, so the
   *            something can only be ours.
   * "unsure" — something is queued and something was also enqueued after ours. Which of them is
   *            still in there is not answerable with `hasQueuedMessages()` alone, so callers must
   *            treat this as "still there": never hand the next item over, and refuse removals.
   *
   * WHY THE SECOND CLAUSE IS SOUND. An item is handed over only when `hasQueued()` is false, so at
   * that moment every previously queued message had already been drained. The mirror grows ONLY on
   * an enqueue. So a mirror total no larger than our own reading from just after the hand-off
   * proves no enqueue happened since — and therefore that the real queues contain at most our one
   * item. The mirror's lag and its empty-text leak both cancel out of a comparison against our own
   * earlier reading of it, which is the only way this module uses it.
   */
  private sdkHolds(): "yes" | "no" | "unsure" {
    const item = this.inFlight;
    if (!item) return "no";
    if (!this.deps.sdk.hasQueued()) return "no";
    // Something is queued, but `hasQueuedMessages()` is BOTH queues at once and 0.86.1 offers
    // nothing finer in public API. Two narrowings:
    //
    // 1. Our KIND's mirror is empty ⇒ its real queue is empty ⇒ ours is gone and what is queued
    //    belongs to someone else. GUARDED, because the bare form is unsound: the SDK splices on
    //    `message_start` by checking the STEERING mirror FIRST for ANY delivered user message,
    //    whatever queue it came from (agent-session.js:389-401, "Check steering queue first"), so
    //    delivering a FOLLOW-UP whose text equals a queued STEER's empties the steering mirror
    //    while the real steering queue still holds ours. Unguarded this reported a still-queued
    //    steer as DELIVERED and let a second item of ours into the SDK. `mirror ≥ real` holds on
    //    TOTALS, never per kind. The guard asks whether our own text also sits in the OTHER lane's
    //    mirror: that is exactly when the mis-splice is possible, and the answer degrades to
    //    "unsure" — refuse, never claim. Normal traffic, where the texts differ, is untouched.
    if (this.deps.sdk.mirrorFor(item.kind) === 0 && !this.deps.sdk.mirrorHas(other(item.kind), item.text)) return "no";
    // 2. Someone else's message was already in there when ours went in, or has been queued since
    //    (seen as GROWTH in a queue_update, which a bare total cannot detect — see
    //    foreignSinceHandOff). Either way "something is queued" cannot be pinned on ours.
    if (this.handOffHadForeign || this.foreignSinceHandOff) return "unsure";
    // 3. Nothing new was queued since ours went in, so the something that is queued is ours.
    return this.deps.sdk.mirrorTotal() <= this.mirrorAtHandOff ? "yes" : "unsure";
  }

  private clearInFlight(): void {
    this.inFlight = null;
    this.mirrorAtHandOff = Number.POSITIVE_INFINITY;
    this.handOffHadForeign = false;
    this.foreignSinceHandOff = false;
  }

}

function refuse(reason: QueueRemoveRefusal, message?: string): RemoveOutcome {
  return { ok: false, reason, message: message ?? REFUSALS[reason as Exclude<QueueRemoveRefusal, "internal">] };
}
