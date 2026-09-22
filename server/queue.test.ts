// Run: npx tsx --test server/queue.test.ts (or npm test). No disk, no SDK, no sockets.
//
// THE FAKE MODELS BOTH STRUCTURES, NOT ONE. An earlier version of this file gave each kind a
// single array, and that is exactly why it certified two bugs as correct: pi keeps a REAL queue
// (drained by the loop) and a separate MIRROR (spliced later, on message_start, and only when the
// text is non-empty). A fake with one array cannot express "drained but still mirrored" or "empty
// text, mirrored for ever" — so it agreed with the implementation by construction. The two
// failures it hid are pinned below as `BUG 1` and `BUG 2`, from the reviewer's counterexamples.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChatServerMessage, QueueGoneReason, QueueItem } from "../shared/protocol";
import { type QueueDeps, WebQueue, type WebQueueItem } from "./queue";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Let every pending microtask AND timer settle; the pump is `void`-ed, so nothing awaits it. */
const settle = async () => {
  for (let i = 0; i < 12; i++) await tick(1);
};

interface Handed {
  kind: "steer" | "followUp";
  text: string;
  images: number;
  streaming: boolean;
}

/**
 * A stand-in for `AgentSession`'s queueing half, with pi's TWO structures per kind kept apart.
 *
 * WHAT IT PROMISES, and what a test may therefore read into it:
 * - `realSteering`/`realFollowUp` are `Agent`'s own queues: what `hasQueuedMessages()` reports and
 *   what `drain()` takes from. A drained message is COMMITTED to the model.
 * - `mirrorSteering`/`mirrorFollowUp` are `getSteeringMessages()`/`getFollowUpMessages()`. Pushed
 *   with the real queue; spliced only by `announce()` (message_start), and only when the text is
 *   non-empty — pi's `if (messageText)` hole, reproduced exactly.
 * - `handOff` resolves only after `handlerDelay`, because the real one awaits extension `input`
 *   handlers before anything is queued. A transform returning null is a handler that answered
 *   `{action:"handled"}`: the message is swallowed and NOTHING is queued.
 * - `clearQueue()` empties BOTH kinds, as the real one does. That is the fact `shared_queue` exists for.
 */
class FakeSdk {
  /** The REAL queues: what `Agent.hasQueuedMessages()` reports and what the loop drains. */
  realSteering: string[] = [];
  realFollowUp: string[] = [];
  /** The MIRRORS: `getSteeringMessages()` / `getFollowUpMessages()`. Pushed with the real queue,
      spliced on message_start by indexOf — and ONLY when the text is non-empty
      (agent-session.js:564-576), which is the hole that strands an image-only send for ever. */
  mirrorSteering: string[] = [];
  mirrorFollowUp: string[] = [];
  streaming = true;
  handlerDelay = 0;
  /** Applied at hand-off, like the real input handlers + template expansion. null = swallowed. */
  transform: ((text: string) => string | null) | null = null;
  readonly handed: Handed[] = [];
  /** Texts a non-streaming hand-off started a turn with (never queued). */
  readonly started: string[] = [];
  guardError: Error | null = null;
  /** The SDK emits `queue_update` SYNCHRONOUSLY on every push and every splice
      (`_emitQueueUpdate`). Modelled, because the queue reads GROWTH out of that sequence and a
      fake that stayed silent would hide the one-in-one-out case entirely. */
  onQueueUpdate: ((steering: number, followUp: number) => void) | null = null;

  async handOff(item: WebQueueItem, streaming: boolean): Promise<void> {
    if (this.guardError) throw this.guardError;
    await tick(this.handlerDelay);
    if (this.guardError) throw this.guardError;
    this.handed.push({ kind: item.kind, text: item.text, images: item.images?.length ?? 0, streaming });
    const expanded = this.transform ? this.transform(item.text) : item.text;
    if (expanded === null) return; // an input handler swallowed it
    if (!streaming) {
      this.started.push(expanded);
      this.streaming = true;
      return;
    }
    this.enqueue(item.kind, expanded);
  }

  /** AgentSession._queueSteer/_queueFollowUp: push BOTH structures. */
  enqueue(kind: "steer" | "followUp", text: string): void {
    (kind === "steer" ? this.realSteering : this.realFollowUp).push(text);
    (kind === "steer" ? this.mirrorSteering : this.mirrorFollowUp).push(text);
    this.emitQueueUpdate();
  }

  private emitQueueUpdate(): void {
    this.onQueueUpdate?.(this.mirrorSteering.length, this.mirrorFollowUp.length);
  }

  /** The agent loop taking the front message: it leaves the REAL queue and is committed to the
      model. The mirror still lists it until `announce` — the window BUG 2 lives in. */
  drain(kind: "steer" | "followUp" = "steer"): string | undefined {
    return (kind === "steer" ? this.realSteering : this.realFollowUp).shift();
  }

  /**
   * message_start for the delivered message, with the SDK's own splice rule reproduced exactly —
   * including the two ways it misses, because both are load-bearing:
   *  • `if (messageText)`: an empty-text (image-only) message never leaves the mirror at all;
   *  • THE STEERING MIRROR IS CHECKED FIRST for ANY delivered user message, whatever queue it
   *    actually came from (agent-session.js:389-401). So a FOLLOW-UP whose text equals a queued
   *    STEER's splices the STEERING mirror, and the per-kind mirror then understates that lane.
   *    `kind` is deliberately NOT used to pick the array: using it would model a tidier SDK than
   *    the one pi-web runs, which is exactly how the unsound per-kind rule got written.
   */
  announce(_kind: "steer" | "followUp", text: string | undefined): void {
    if (!text) return;
    const si = this.mirrorSteering.indexOf(text);
    if (si !== -1) {
      this.mirrorSteering.splice(si, 1);
      this.emitQueueUpdate();
      return;
    }
    const fi = this.mirrorFollowUp.indexOf(text);
    if (fi === -1) return; // rewritten text: the SDK's indexOf misses and emits nothing
    this.mirrorFollowUp.splice(fi, 1);
    this.emitQueueUpdate();
  }

  /** The loop delivering one message end to end. */
  deliver(kind: "steer" | "followUp" = "steer"): string | undefined {
    const text = this.drain(kind);
    this.announce(kind, text);
    return text;
  }

  /** An extension queueing work of its own (`pi.sendUserMessage(…, {deliverAs:"followUp"})`). */
  extensionFollowUp(text: string): void {
    this.enqueue("followUp", text);
  }

  hasQueued(): boolean {
    return this.realSteering.length > 0 || this.realFollowUp.length > 0;
  }

  mirrorTotal(): number {
    return this.mirrorSteering.length + this.mirrorFollowUp.length;
  }

  /**
   * `Agent.continue()`: with a run idle, DRAIN the already-queued messages and run THEM — the
   * queued item is delivered, not discarded, and it goes FIRST because it is the run's own input.
   * Modelled faithfully because the ordering is the reason this path exists at all.
   */
  wake(): void {
    if (this.streaming) return;
    const kind = this.realSteering.length ? "steer" : this.realFollowUp.length ? "followUp" : null;
    if (!kind) return;
    this.streaming = true;
    const text = this.drain(kind);
    this.woke.push(text ?? "");
    this.announce(kind, text); // its message_start
  }
  readonly woke: string[] = [];

  clearQueue(): { steering: string[]; followUp: string[] } {
    const drained = { steering: [...this.mirrorSteering], followUp: [...this.mirrorFollowUp] };
    this.realSteering = [];
    this.realFollowUp = [];
    this.mirrorSteering = [];
    this.mirrorFollowUp = [];
    return drained;
  }
}

/** The queue, wired to the fake exactly as `ChatSession` wires it to the real session, and two
    clients behind one broadcast — the fan-out the contract promises for every departure. */
function rig(sdk = new FakeSdk()) {
  const one: ChatServerMessage[] = [];
  const two: ChatServerMessage[] = [];
  const broadcast = (m: ChatServerMessage) => {
    one.push(m);
    two.push(m);
  };
  const errors: { item: WebQueueItem; message: string }[] = [];
  const deps: QueueDeps = {
    sdk: {
      hasQueued: () => sdk.hasQueued(),
      mirrorTotal: () => sdk.mirrorTotal(),
      mirrorFor: (kind) => (kind === "steer" ? sdk.mirrorSteering : sdk.mirrorFollowUp).length,
      mirrorHas: (kind, text) => (kind === "steer" ? sdk.mirrorSteering : sdk.mirrorFollowUp).includes(text),
    },
    streaming: () => sdk.streaming,
    clearSdkQueue: () => sdk.clearQueue(),
    guard: () => {
      if (sdk.guardError) throw sdk.guardError;
    },
    handOff: (item, streaming) => sdk.handOff(item, streaming),
    wake: () => sdk.wake(),
    onGone: (item, reason) => broadcast({ type: "queue_item_gone", itemId: item.id, reason, ...(reason === "delivered" ? {} : { text: item.text }) }),
    onChange: (items) => broadcast({ type: "queue", items }),
    onHandOffError: (item, err) => errors.push({ item, message: err instanceof Error ? err.message : String(err) }),
  };
  const queue = new WebQueue(deps);
  sdk.onQueueUpdate = (steering, followUp) => queue.observeQueueUpdate(steering, followUp);
  const gone = (log: ChatServerMessage[]) =>
    log.filter((m): m is Extract<ChatServerMessage, { type: "queue_item_gone" }> => m.type === "queue_item_gone").map((m) => [m.itemId, m.reason] as [string, QueueGoneReason]);
  const lastSnapshot = (log: ChatServerMessage[]): QueueItem[] => {
    const snaps = log.filter((m): m is Extract<ChatServerMessage, { type: "queue" }> => m.type === "queue");
    return snaps.at(-1)?.items ?? [];
  };
  return { sdk, queue, one, two, errors, gone, lastSnapshot };
}

const ids = (items: QueueItem[]) => items.map((i) => i.id);
const states = (items: QueueItem[]) => items.map((i) => `${i.id}:${i.state}`);

describe("the outgoing queue", () => {
  test("hands exactly one item to the SDK and holds the rest, in order", async () => {
    const r = rig();
    for (const id of ["a", "b", "c"]) r.queue.enqueue({ kind: "steer", text: id, origin: "client", id });
    await settle();
    assert.deepEqual(r.sdk.realSteering, ["a"], "only the head is inside the SDK");
    assert.deepEqual(states(r.lastSnapshot(r.one)), ["a:sending", "b:queued", "c:queued"]);

    r.sdk.deliver("steer"); // the loop takes "a"
    r.queue.onSdkEvent();
    await settle();
    assert.deepEqual(r.sdk.realSteering, ["b"], "the next one goes in as soon as the first drains");
    assert.deepEqual(states(r.lastSnapshot(r.one)), ["b:sending", "c:queued"]);
    assert.deepEqual(r.gone(r.one), [["a", "delivered"]]);
  });

  test("removes a MIDDLE held item without touching the SDK or the order", async () => {
    const r = rig();
    for (const id of ["a", "b", "c"]) r.queue.enqueue({ kind: "steer", text: id, origin: "client", id });
    await settle();

    const outcome = await r.queue.remove("b");
    assert.equal(outcome.ok, true);
    assert.deepEqual(r.sdk.realSteering, ["a"], "the SDK queue is untouched by a held-item removal");
    assert.deepEqual(ids(r.lastSnapshot(r.one)), ["a", "c"]);

    r.sdk.deliver("steer");
    r.queue.onSdkEvent();
    await settle();
    assert.deepEqual(r.sdk.realSteering, ["c"], "c follows a, and b never reaches the model");
    assert.deepEqual(r.sdk.handed.map((h) => h.text), ["a", "c"]);
  });

  test("duplicate texts are removed by id, not by text", async () => {
    const r = rig();
    for (const id of ["1", "2", "3"]) r.queue.enqueue({ kind: "steer", text: "go", origin: "client", id });
    await settle();

    assert.equal((await r.queue.remove("2")).ok, true);
    assert.deepEqual(ids(r.lastSnapshot(r.one)), ["1", "3"], "the SECOND 'go' left; the other two stand");
    // Three identical strings is exactly the case the SDK's own indexOf bookkeeping cannot answer.
    // Here the question never arises: the held list is indexed by id and only one copy is ever
    // inside the SDK at a time.
    r.sdk.deliver("steer");
    r.queue.onSdkEvent();
    await settle();
    assert.deepEqual(r.sdk.realSteering, ["go"]);
    assert.deepEqual(ids(r.lastSnapshot(r.one)), ["3"]);
  });

  test("an image-only message queues and removes like any other", async () => {
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }], origin: "client", id: "pic" });
    r.queue.enqueue({ kind: "steer", text: "", images: [{ type: "image", data: "BBBB", mimeType: "image/png" }], origin: "client", id: "pic2" });
    await settle();
    const held = r.lastSnapshot(r.one);
    assert.deepEqual(held.map((i) => [i.id, i.text, i.images]), [["pic", "", 1], ["pic2", "", 1]]);
    assert.equal((await r.queue.remove("pic2")).ok, true, "empty text is not a reason to refuse");
    assert.deepEqual(ids(r.lastSnapshot(r.one)), ["pic"]);
    assert.equal(r.sdk.handed[0]?.images, 1, "the bytes went with it");
  });

  test("removing the handed-off item takes it back when the SDK holds nothing else", async () => {
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "wait no", origin: "client", id: "a" });
    await settle();
    assert.deepEqual(r.sdk.realSteering, ["wait no"]);

    const outcome = await r.queue.remove("a");
    assert.equal(outcome.ok, true);
    assert.deepEqual(r.sdk.realSteering, [], "clearQueue() was safe here: our item was all that was in there");
    assert.deepEqual(r.gone(r.one), [["a", "removed"]]);
  });

  test("removing the handed-off item is REFUSED when an extension shares the SDK queue", async () => {
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "wait no", origin: "client", id: "a" });
    await settle();
    r.sdk.extensionFollowUp("subagent finished: 3 files changed"); // pi's own work, not ours

    const outcome = await r.queue.remove("a");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, "shared_queue");
    // The point of the refusal, asserted as a state and not as a code: NOTHING was dropped.
    assert.deepEqual(r.sdk.realSteering, ["wait no"]);
    assert.deepEqual(r.sdk.realFollowUp, ["subagent finished: 3 files changed"]);
    assert.deepEqual(r.gone(r.one), [], "and no client was told anything left");

    // AND IT STAYS REFUSED for this item's lifetime, even after the extension's message is gone.
    // Once something else has been in the queue alongside ours, "something is queued" can never be
    // attributed to ours again: the reading that would un-stick it ("the mirror holds exactly one
    // item, of our kind") is satisfied just as well by OURS HAVING BEEN DELIVERED and the foreign
    // one remaining. No public API in 0.86.1 separates those, so the refusal is permanent rather
    // than probabilistic — which is why the copy must not promise "try again in a moment".
    r.sdk.deliver("followUp");
    const after = await r.queue.remove("a");
    assert.equal(after.ok, false, "still refused, and honestly so");
    assert.equal(after.ok === false && after.reason, "shared_queue");
    assert.deepEqual(r.sdk.realSteering, ["wait no"], "and ours is still on its way, untouched");
  });

  test("removing an item the loop already drained is refused as consumed", async () => {
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "too late", origin: "client", id: "a" });
    await settle();
    r.sdk.deliver("steer"); // drained, message_start not emitted yet

    const outcome = await r.queue.remove("a");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, "consumed");
    assert.deepEqual(r.gone(r.one), [["a", "delivered"]], "and the client is told it was SENT, not removed");
  });

  test("a removal DURING the hand-off waits it out instead of calling it consumed", async () => {
    // The bug this test was written for: while `handOff` awaits the extension `input` handlers the
    // SDK's count for the item is 0 — identical to "the loop already took it". Reading the count
    // then answered "consumed" for a message that had not been sent and could still be stopped,
    // which is the one wrong answer this feature must never give.
    const r = rig();
    r.sdk.handlerDelay = 25; // vision-delegate describing an image
    r.queue.enqueue({ kind: "steer", text: "stop stop stop", origin: "client", id: "a" });
    await tick(1); // the hand-off has begun and is awaiting the handler
    assert.deepEqual(r.sdk.realSteering, [], "nothing is in the SDK yet");

    const outcome = await r.queue.remove("a");
    assert.equal(outcome.ok, true, "it was taken back, not declared sent");
    assert.deepEqual(r.sdk.realSteering, []);
    await settle();
    assert.deepEqual(r.sdk.realSteering, [], "and it did not reappear once the handler finished");
    assert.deepEqual(r.gone(r.one), [["a", "removed"]]);
  });

  test("a removal that loses the race to delivery says CONSUMED, not unknown", async () => {
    // The item is not in the queue by the time the request arrives, but "not here" has two very
    // different meanings for the row: a sent message stays as a message, an unknown one disappears.
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "a", origin: "client", id: "a" });
    r.queue.enqueue({ kind: "steer", text: "b", origin: "client", id: "b" });
    await settle();
    r.sdk.deliver("steer");
    r.queue.onSdkEvent();
    await settle(); // "a" is gone and "b" has taken its place

    const outcome = await r.queue.remove("a");
    assert.equal(outcome.ok === false && outcome.reason, "consumed");
    // An id this queue never saw is a different answer, and stays one.
    const never = await r.queue.remove("never-existed");
    assert.equal(never.ok === false && never.reason, "unknown");
  });

  test("an unknown id is refused without disturbing anything", async () => {
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "a", origin: "client", id: "a" });
    await settle();
    const outcome = await r.queue.remove("nope");
    assert.equal(outcome.ok === false && outcome.reason, "unknown");
    assert.deepEqual(r.sdk.realSteering, ["a"]);
  });

  test("a removal is refused while the session is not writable", async () => {
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "a", origin: "client", id: "a" });
    await settle();
    r.sdk.guardError = new Error("a terminal owns this session");
    const busy = await r.queue.remove("a");
    assert.equal(busy.ok, false);
    assert.equal(busy.ok === false && busy.reason, "busy");
  });

  test("a slow input handler cannot reorder the queue", async () => {
    // vision-delegate describes an image for a non-vision model before the message is queued at
    // all; two sends racing through that would be the classic reordering bug.
    const r = rig();
    r.sdk.handlerDelay = 8;
    r.queue.enqueue({ kind: "steer", text: "first", origin: "client", id: "1" });
    r.queue.enqueue({ kind: "steer", text: "second", origin: "client", id: "2" });
    await settle();
    assert.deepEqual(r.sdk.realSteering, ["first"], "the second waited for the first to be accepted");
    r.sdk.deliver("steer");
    r.queue.onSdkEvent();
    await settle();
    assert.deepEqual(r.sdk.handed.map((h) => h.text), ["first", "second"]);
  });

  test("the queued text is the RAW text; the SDK gets the expansion", async () => {
    const r = rig();
    r.sdk.transform = (t) => (t === "/mytemplate x" ? "EXPANDED: do x" : t);
    r.queue.enqueue({ kind: "steer", text: "/mytemplate x", origin: "client", id: "t" });
    r.queue.enqueue({ kind: "steer", text: "after", origin: "client", id: "u" });
    await settle();
    assert.deepEqual(r.sdk.realSteering, ["EXPANDED: do x"]);
    assert.equal(r.lastSnapshot(r.one)[0]?.text, "/mytemplate x", "the row reads as typed");
    assert.equal((await r.queue.remove("u")).ok, true, "and a later item is still removable by id");
  });

  test("a message an input handler swallows is reported DROPPED, not delivered", async () => {
    // The distinction a snapshot diff cannot make: nothing was queued and no message_start will
    // ever arrive, so a client waiting for one would wait forever.
    const r = rig();
    r.sdk.transform = (t) => (t === "eat me" ? null : t);
    r.queue.enqueue({ kind: "steer", text: "eat me", origin: "client", id: "a" });
    r.queue.enqueue({ kind: "steer", text: "keep me", origin: "client", id: "b" });
    await settle();
    assert.deepEqual(r.gone(r.one), [["a", "dropped"]]);
    assert.deepEqual(r.sdk.realSteering, ["keep me"], "and the next item moved up at once");
  });

  test("a hand-off the guards refuse reports FAILED and hands the text back", async () => {
    const r = rig();
    r.sdk.guardError = new Error("Session was opened in another pi process");
    r.queue.enqueue({ kind: "steer", text: "doomed", origin: "client", id: "a" });
    await settle();
    assert.deepEqual(r.gone(r.one), [["a", "failed"]]);
    assert.deepEqual(r.errors.map((e) => [e.item.id, e.message]), [["a", "Session was opened in another pi process"]]);
    assert.deepEqual(r.lastSnapshot(r.one), []);
  });

  test("an idle session starts a turn instead of queueing, and says DELIVERED", async () => {
    const r = rig();
    r.sdk.streaming = false;
    r.queue.enqueue({ kind: "followUp", text: "go", origin: "server", id: "s1" });
    await settle();
    assert.deepEqual(r.sdk.started, ["go"], "it ran as a turn; nothing was queued");
    assert.deepEqual(r.gone(r.one), [["s1", "delivered"]]);
    assert.deepEqual(r.sdk.handed.map((h) => h.streaming), [false]);
  });

  test("a follow-up waits behind an extension's follow-up instead of jumping it", async () => {
    const r = rig();
    r.sdk.extensionFollowUp("wake: the user is back");
    r.queue.enqueue({ kind: "followUp", text: "mine", origin: "client", id: "m" });
    await settle();
    assert.deepEqual(r.sdk.realFollowUp, ["wake: the user is back"], "ours stayed out of the SDK");
    assert.deepEqual(states(r.lastSnapshot(r.one)), ["m:queued"], "so it is still freely removable");

    r.sdk.deliver("followUp");
    r.queue.onSdkEvent();
    await settle();
    assert.deepEqual(r.sdk.realFollowUp, ["mine"]);
  });

  test("an extension's parked follow-up does NOT demote a steer into a post-turn message", async () => {
    // Extensions park follow-ups routinely (a subagent reporting, wake-nudge, btw, explain) and
    // they are drained only at the END of the run. Waiting for the SDK to be globally empty would
    // hold every typed steer until the turn finished — the user's steer would silently stop being
    // a steer. The steering mirror being empty PROVES the real steering queue is empty, so ours
    // still goes in at the front of it.
    const r = rig();
    r.sdk.extensionFollowUp("subagent finished: 3 files changed");
    r.queue.enqueue({ kind: "steer", text: "actually, stop and do X", origin: "client", id: "s" });
    await settle();
    assert.deepEqual(r.sdk.realSteering, ["actually, stop and do X"], "delivered as a steer, mid-turn");
    assert.deepEqual(r.sdk.realFollowUp, ["subagent finished: 3 files changed"], "and the extension's work is untouched");

    // The price, stated as a behaviour: this one can only be REFUSED, never pulled back, because
    // `hasQueuedMessages()` is both queues at once and cannot say which of the two is still there.
    const outcome = await r.queue.remove("s");
    assert.equal(outcome.ok === false && outcome.reason, "shared_queue");
    assert.deepEqual(r.sdk.realSteering, ["actually, stop and do X"], "and nothing was dropped to find out");
  });

  test("a follow-up waits behind OUR OWN in-flight steer, which is what keeps both removable", async () => {
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "s1", origin: "client", id: "s1" });
    r.queue.enqueue({ kind: "followUp", text: "f1", origin: "client", id: "f1" });
    await settle();
    // The one-at-a-time rule is GLOBAL, not per kind. Letting both in would put two of our own
    // messages in the SDK at once, and `clearQueue()` — the only way to take one back out — cannot
    // remove one of two. Both would then be stuck as `shared_queue` until delivery, which is the
    // exact outcome per-item removal exists to avoid.
    assert.deepEqual(r.sdk.realSteering, ["s1"]);
    assert.deepEqual(r.sdk.realFollowUp, [], "the follow-up is still ours to hold");
    assert.deepEqual(states(r.lastSnapshot(r.one)), ["s1:sending", "f1:queued"]);
    assert.equal((await r.queue.remove("s1")).ok, true, "the steer can still be pulled back");
    assert.equal((await r.queue.remove("f1")).ok, true, "and so can the follow-up");
  });

  test("Stop drains everything pi-web holds AND everything the SDK holds, in order", async () => {
    const r = rig();
    r.sdk.extensionFollowUp("extension work");
    for (const id of ["a", "b"]) r.queue.enqueue({ kind: "steer", text: id, origin: "client", id });
    r.queue.enqueue({ kind: "followUp", text: "later", origin: "client", id: "c" });
    await settle();

    const drained = await r.queue.drain();
    assert.deepEqual(drained.steering, ["a", "b"], "the SDK's (expanded) first, then ours (raw)");
    assert.deepEqual(drained.followUp, ["extension work", "later"]);
    assert.deepEqual(r.lastSnapshot(r.one), []);
    assert.deepEqual(
      r.gone(r.one).filter(([, reason]) => reason === "cleared").map(([id]) => id),
      ["a", "b", "c"],
      "every item says why it left, so no client infers 'sent' from an empty snapshot",
    );
    assert.equal(r.queue.size, 0);
  });

  test("every departure reaches EVERY client, not just the one that asked", async () => {
    const r = rig();
    for (const id of ["a", "b"]) r.queue.enqueue({ kind: "steer", text: id, origin: "client", id });
    await settle();
    await r.queue.remove("b");
    r.sdk.deliver("steer");
    r.queue.onSdkEvent();
    await settle();
    // A second tab on the same chat must end up with the same story, event for event.
    assert.deepEqual(r.two, r.one);
    assert.deepEqual(r.gone(r.two), [["b", "removed"], ["a", "delivered"]]);
  });

  test("the snapshot a reconnecting client gets names every item and its state", async () => {
    const r = rig();
    for (const id of ["a", "b", "c"]) r.queue.enqueue({ kind: "steer", text: id, origin: "client", id });
    r.queue.enqueue({ kind: "followUp", text: "server side", origin: "server", id: "s" });
    await settle();
    // What attach() sends. Nothing about it depends on the client having seen earlier events.
    assert.deepEqual(r.queue.snapshot(), [
      { id: "a", kind: "steer", state: "sending", text: "a", origin: "client" },
      { id: "b", kind: "steer", state: "queued", text: "b", origin: "client" },
      { id: "c", kind: "steer", state: "queued", text: "c", origin: "client" },
      // "server side" is a server-originated prompt (a group batch, a remote probe): it queues on
      // the same terms as a client's and waits its turn behind them, rather than skipping the line.
      { id: "s", kind: "followUp", state: "queued", text: "server side", origin: "server" },
    ]);
  });

  // ---------------------------------------------------------------------------------------------
  // The three counterexamples the reviewer (ag_13) produced against the first implementation, kept
  // as regressions. Each one was GREEN in the earlier suite, because the earlier fake modelled one
  // array per kind and so could not express the state that breaks it.
  // ---------------------------------------------------------------------------------------------

  test("BUG 1 — an image-only send is delivered and does NOT strand the queue", async () => {
    // The SDK's mirror splice is skipped for empty text, so an image-only message stays mirrored
    // for the session's life. A queue that waits for the MIRROR to empty waits for ever and every
    // later message is stranded. Presence is read from the REAL queue, so it does not.
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }], origin: "client", id: "img" });
    r.queue.enqueue({ kind: "steer", text: "next", origin: "client", id: "n" });
    await settle();
    assert.deepEqual(r.sdk.realSteering, [""], "the image-only send went in");

    r.sdk.deliver("steer"); // drained AND announced — but the mirror keeps the empty entry
    assert.deepEqual(r.sdk.mirrorSteering, [""], "the mirror still lists it, exactly as pi does");
    r.queue.onSdkEvent();
    await settle();

    assert.deepEqual(r.sdk.realSteering, ["next"], "the queue moved on regardless");
    assert.deepEqual(r.gone(r.one), [["img", "delivered"]]);
    assert.deepEqual(ids(r.lastSnapshot(r.one)), ["n"]);
  });

  test("BUG 2 — a message the loop already took is CONSUMED, never reported removed", async () => {
    // The loop drains before `message_start`, and prepareNextTurn (which can compact) sits in
    // between, so this window is wide. The mirror still lists the message throughout it.
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "too late", origin: "client", id: "a" });
    await settle();
    const taken = r.sdk.drain("steer"); // committed to the model; not yet announced
    assert.equal(taken, "too late");
    assert.deepEqual(r.sdk.mirrorSteering, ["too late"], "the mirror would have said 'still queued'");

    const outcome = await r.queue.remove("a");
    assert.equal(outcome.ok, false, "a removal must never claim to stop a message already sent");
    assert.equal(outcome.ok === false && outcome.reason, "consumed");
    assert.deepEqual(r.gone(r.one), [["a", "delivered"]]);
  });

  test("BUG 3 — Stop during a hand-off returns the text and nothing is delivered after it", async () => {
    // An item parked in an extension input handler is in neither `held` nor the SDK. Clearing both
    // and returning would report it cleared, hand back no text, and then let the hand-off finish
    // and deliver it AFTER Stop.
    const r = rig();
    r.sdk.handlerDelay = 20;
    r.queue.enqueue({ kind: "steer", text: "cancel me", origin: "client", id: "a" });
    await tick(1); // inside handOff, awaiting the handler

    const drained = await r.queue.drain();
    assert.deepEqual(drained.steering, ["cancel me"], "Stop hands the text back");
    await settle();
    assert.deepEqual(r.sdk.realSteering, [], "and nothing was left in the SDK to be delivered later");
    assert.deepEqual(r.gone(r.one), [["a", "cleared"]]);
  });

  test("a foreign message queued behind ours makes removal refuse, never guess", async () => {
    // With only `hasQueuedMessages()` to read, "something is queued" cannot be attributed to our
    // item once anything else has been enqueued since. That is a refusal, not a coin flip.
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "mine", origin: "client", id: "a" });
    await settle();
    r.sdk.extensionFollowUp("subagent finished");

    const outcome = await r.queue.remove("a");
    assert.equal(outcome.ok === false && outcome.reason, "shared_queue");
    assert.deepEqual(r.sdk.realSteering, ["mine"], "ours is untouched");
    assert.deepEqual(r.sdk.realFollowUp, ["subagent finished"], "and so is theirs");
  });

  test("an extension rewriting the message text is a non-event for delivery", async () => {
    // The OTHER way the mirror never sheds an item: an extension `message` handler rewrites the
    // user text before message_start (_replaceMessageInPlace, agent-session.js:530-549), so the
    // SDK's own indexOf splice misses and the entry stays mirrored for ever. Delivery is read from
    // the real queue, so this is invisible here — asserted rather than assumed.
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "original", origin: "client", id: "a" });
    r.queue.enqueue({ kind: "steer", text: "after", origin: "client", id: "b" });
    await settle();
    r.sdk.drain("steer");
    r.sdk.announce("steer", "REWRITTEN BY AN EXTENSION"); // indexOf misses; the mirror keeps "original"
    assert.deepEqual(r.sdk.mirrorSteering, ["original"], "the mirror is stuck, exactly as pi leaves it");

    r.queue.onSdkEvent();
    await settle();
    assert.deepEqual(r.gone(r.one), [["a", "delivered"]]);
    assert.deepEqual(r.sdk.realSteering, ["after"], "and the queue moved on");
  });

  test("ONE IN, ONE OUT: an extension's message is never mistaken for ours", async () => {
    // The hole a TOTALS rule has, and it is not exotic: an extension enqueues (+1) while our item
    // is announced (-1), so the mirror total is exactly what it was at hand-off. Read as "nothing
    // was queued since", that says our item is still in there — and a removal would then clear the
    // extension's message AND report ours, already delivered, as removed. Both failures at once.
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "mine", origin: "client", id: "a" });
    await settle();
    r.sdk.extensionFollowUp("wake nudge"); // +1
    r.sdk.deliver("steer"); // ours drained AND announced: -1. Total unchanged.
    assert.equal(r.sdk.mirrorTotal(), 1, "the total is back where it started, for the wrong reason");

    const outcome = await r.queue.remove("a");
    assert.equal(outcome.ok, false, "ours was delivered; a removal must not claim otherwise");
    assert.equal(outcome.ok === false && outcome.reason, "consumed");
    assert.deepEqual(r.sdk.realFollowUp, ["wake nudge"], "and the extension's message survives a removal it has nothing to do with");
    assert.ok(!r.gone(r.one).some(([id, reason]) => id === "a" && reason === "removed"));
  });

  test("ONE IN, ONE OUT with an image-only item, where the mirror never sheds ours", async () => {
    // The same race, minus the signal that rescues it above: our empty-text item stays in the
    // steering mirror for ever, so "our kind's mirror is empty" never fires. What catches it is
    // the GROWTH seen in the queue_update sequence, which a bare total cannot show.
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }], origin: "client", id: "img" });
    await settle();
    r.sdk.extensionFollowUp("wake nudge");
    r.sdk.deliver("steer"); // delivered; no splice, so the mirror keeps ours
    assert.deepEqual(r.sdk.mirrorSteering, [""], "ours is still mirrored, as pi leaves it");

    const outcome = await r.queue.remove("img");
    assert.equal(outcome.ok, false, "refused rather than guessed");
    assert.equal(outcome.ok === false && outcome.reason, "shared_queue");
    assert.deepEqual(r.sdk.realFollowUp, ["wake nudge"], "nothing of anyone else's was dropped to find out");
  });

  test("a foreign message with BYTE-IDENTICAL text in the same lane is still not mistaken for ours", async () => {
    // The residual the reviewer flagged as unanswerable: any rule that compares STRINGS cannot tell
    // our delivered "check the build" from an extension queueing the very same words a moment
    // later. Nothing here compares strings — the growth is seen as an EVENT, so identical text is
    // not a special case.
    const r = rig();
    r.queue.enqueue({ kind: "followUp", text: "check the build", origin: "client", id: "a" });
    await settle();
    r.sdk.deliver("followUp"); // ours: drained and announced
    r.sdk.extensionFollowUp("check the build"); // an extension queues the SAME text

    const outcome = await r.queue.remove("a");
    assert.equal(outcome.ok, false, "ours was delivered; the identical string is somebody else's");
    assert.deepEqual(r.sdk.realFollowUp, ["check the build"], "and their message is untouched");
  });

  test("a follow-up delivered with OUR STEER'S TEXT must not report our steer delivered", async () => {
    // The SDK splices the STEERING mirror first for any delivered user message, whatever lane it
    // came from. So a follow-up carrying the same words empties the steering mirror while our
    // steer is still really queued. A per-kind mirror reading called that DELIVERED, cleared
    // inFlight, and let a second item of ours into the SDK — breaking the one-item precondition
    // clearQueue() depends on. Presence is never read per kind now.
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "go", origin: "client", id: "a" });
    r.queue.enqueue({ kind: "steer", text: "second", origin: "client", id: "b" });
    await settle();
    assert.deepEqual(r.sdk.realSteering, ["go"], "ours is handed off and still queued");

    r.sdk.extensionFollowUp("go"); // an extension queues a follow-up with the SAME text
    r.sdk.drain("followUp");
    r.sdk.announce("followUp", "go"); // its message_start splices the STEERING mirror
    assert.deepEqual(r.sdk.mirrorSteering, [], "the steering mirror lost an entry it still owns");
    r.queue.onSdkEvent();
    await settle();

    assert.ok(!r.gone(r.one).some(([id, reason]) => id === "a" && reason === "delivered"), "ours was NOT reported delivered");
    assert.deepEqual(r.sdk.realSteering, ["go"], "and nothing of ours went in behind it");
    // Refused rather than guessed: the guard turned the unsound "no" into "unsure", and an
    // unattributable queue is exactly what a refusal is for.
    const outcome = await r.queue.remove("a");
    assert.equal(outcome.ok === false && outcome.reason, "shared_queue");
    assert.deepEqual(r.sdk.realSteering, ["go"], "and nothing was cleared to find out");
  });

  test("A LATE ITEM WITH NO RUN is woken, not waited on, and it goes out FIRST", async () => {
    // The deadlock: `steer()` awaits the extension input handlers, so an item can reach the SDK's
    // real queue after the turn it meant to interrupt has ended. Nothing drains a queue while the
    // agent is idle, and this queue will not hand anything over while the SDK holds something — so
    // the user's next message would wait for ever behind a message waiting for a run that never
    // starts.
    const r = rig();
    r.sdk.streaming = false;
    r.sdk.enqueue("steer", "late steer"); // landed after the turn ended; no run active
    r.queue.enqueue({ kind: "steer", text: "please send me", origin: "client", id: "b" });
    await settle();

    assert.deepEqual(r.sdk.woke, ["late steer"], "the already-queued message was run, not dropped");
    // ORDER IS THE POINT. The late steer was queued first and is delivered first. Handing OUR
    // message over instead would have started the run with it, and the loop only polls the
    // steering queue after the first assistant turn — first-queued would have arrived second.
    assert.deepEqual(r.sdk.handed.map((h) => h.text), ["please send me"]);
    assert.ok(r.sdk.realSteering.includes("please send me"), "and ours followed, as a steer of that run");
    assert.deepEqual(r.gone(r.one), [], "nothing was declared delivered that was not");
  });

  test("OUR OWN item stranded with no run is woken too, and departs as delivered", async () => {
    // The same state, reached from the other side: our hand-off resolved after the turn ended, so
    // OUR message is the one sitting in the SDK with nothing to run it.
    const r = rig();
    r.sdk.handlerDelay = 12;
    r.queue.enqueue({ kind: "steer", text: "mine", origin: "client", id: "a" });
    await tick(1);
    r.sdk.streaming = false; // the turn ends WHILE the input handler is still running
    await settle();

    assert.deepEqual(r.sdk.woke, ["mine"], "it was delivered rather than stranded");
    assert.deepEqual(r.gone(r.one), [["a", "delivered"]], "and only then reported delivered");
    assert.equal(r.queue.size, 0);
  });

  test("a wake is not attempted while a run is active", async () => {
    const r = rig(); // streaming = true
    r.sdk.enqueue("followUp", "extension work");
    r.queue.enqueue({ kind: "followUp", text: "mine", origin: "client", id: "m" });
    await settle();
    assert.deepEqual(r.sdk.woke, [], "a run is already going; the loop will drain it");
    assert.deepEqual(states(r.lastSnapshot(r.one)), ["m:queued"], "ours simply waits its turn");
  });

  test("a wake that FAILS does not spin the pump", async () => {
    // `Agent.continue()` can throw — an empty/all-system transcript, or a run starting in the gap.
    // The tempting catch (report the failure, then re-pump) is a SPIN, because the pump's wake
    // condition is unchanged by the failure: it wakes, throws, reports, and does it again for ever.
    // Measured, not reasoned about: with the re-pump in place this test hung for 60s at 0 pass/0
    // fail. A failed wake must leave the state it found and wait for a REAL change.
    const r = rig();
    r.sdk.streaming = false;
    r.sdk.enqueue("steer", "parked"); // something is queued, so the wake condition holds
    let wakes = 0;
    const deps = (r.queue as unknown as { deps: QueueDeps }).deps;
    deps.wake = () => void wakes++; // a wake that starts nothing, as a throwing one does
    r.queue.enqueue({ kind: "steer", text: "mine", origin: "client", id: "a" });
    await settle();
    assert.ok(wakes <= 2, `one stuck item must not produce a wake storm: ${wakes} attempts`);
    assert.equal(r.queue.size, 1, "and ours is still held, not lost");
  });

  test("a dep that throws SYNCHRONOUSLY does not kill the process", async () => {
    // Every caller does `void this.pump()`, so a throw escaping the pump is an UNHANDLED REJECTION,
    // and Node's default since v15 terminates the process — for pi-web that is the server, every
    // session in it, and every hosted worker. Measured before the fix: "caught by the caller of
    // enqueue(): NO / unhandled rejections observed: 1". A disk error in `flushDeferredAppends`
    // (it writes the session file) is the reachable path, but the guard is at the pump because
    // hasQueued/streaming/onChange/onGone/guard can all throw too.
    const rejections: unknown[] = [];
    const onReject = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onReject);
    try {
      const r = rig();
      r.sdk.streaming = false;
      r.sdk.enqueue("steer", "parked"); // makes the pump take the wake path
      const deps = (r.queue as unknown as { deps: QueueDeps }).deps;
      deps.wake = () => {
        throw new Error("ENOSPC: no space left on device");
      };
      // Must not throw out of enqueue either — the caller is a socket handler, not a supervisor.
      assert.doesNotThrow(() => r.queue.enqueue({ kind: "steer", text: "mine", origin: "client", id: "a" }));
      await settle();
      assert.deepEqual(rejections, [], "no unhandled rejection escaped the pump");
      // And the queue is left USABLE, not wedged: the item is still held, nothing was declared
      // delivered or removed, and a later event can still drive it.
      assert.equal(r.queue.size, 1, "ours is still held");
      assert.deepEqual(r.gone(r.one), [], "and nothing was declared gone");
      r.queue.onSdkEvent();
      await settle();
      assert.equal(r.queue.size, 1, "still recoverable, not wedged");
    } finally {
      process.off("unhandledRejection", onReject);
    }
  });

  test("a closed queue hands nothing else over", async () => {
    const r = rig();
    r.queue.enqueue({ kind: "steer", text: "a", origin: "client", id: "a" });
    r.queue.enqueue({ kind: "steer", text: "b", origin: "client", id: "b" });
    await settle();
    r.queue.close();
    r.sdk.deliver("steer");
    r.queue.onSdkEvent();
    await settle();
    assert.deepEqual(r.sdk.realSteering, [], "b never went in after the runtime went away");
    assert.equal(r.queue.size, 0);
  });
});
