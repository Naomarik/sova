// Run: pnpm test -- src/lib/reply-slot-answers.test.ts
// The reply place's extension lane (§app.commands/reply-slot): one answer per extension for a whole
// session, keyed by entry, validated per entry, bounded in size, each extension asked on its own with
// a time limit, the user's switch and Sova's mute. The per-answer rules (chips, the frame's wall)
// are src/lib/reply-slot.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ANSWER_ENTRIES_MAX,
  CHIPS_PER_REPLY,
  createReplyAnswers,
  createSlotPolicy,
  MUTE_AFTER,
  readCappedJson,
  validateSessionAnswer,
  type SlotExtension,
  type SlotSource,
  type SlotState,
} from "./reply-slot";

const ext = (id: string, actions: string[] = []): SlotExtension => ({ id, title: id.toUpperCase(), actions });
const chip = (label: string) => ({ label, tone: "info", href: "https://example.test/x" });
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("validateSessionAnswer", () => {
  test("keyed by entry; each entry validated on its own", () => {
    const v = validateSessionAnswer({ entries: { e1: { chips: [chip("Checks ok")] }, e2: { chips: [{ label: "<b>", tone: "info" }] }, e3: {} } }, ext("q"));
    assert.deepEqual([...v.entries.keys()], ["e1"]);
    assert.equal(v.entries.get("e1")!.chips[0]!.label, "Checks ok");
    assert.equal(v.bad, true, "e2's chip was dropped");
  });

  test("anything but {entries: {...}} is bad and draws nothing; odd keys and too many entries are bad", () => {
    for (const raw of [null, [], "x", { entries: [] }, { entries: null }, {}]) {
      const v = validateSessionAnswer(raw, ext("q"));
      assert.equal(v.bad, true);
      assert.equal(v.entries.size, 0);
    }
    assert.equal(validateSessionAnswer({ entries: { "a b": { chips: [chip("x")] } } }, ext("q")).bad, true);
    const many = Object.fromEntries(Array.from({ length: ANSWER_ENTRIES_MAX + 1 }, (_, i) => [`e${i}`, { chips: [chip("x")] }]));
    const v = validateSessionAnswer({ entries: many }, ext("q"));
    assert.equal(v.bad, true);
    assert.equal(v.entries.size, ANSWER_ENTRIES_MAX);
  });
});

describe("readCappedJson", () => {
  test("reads JSON under the cap; past it, or not ok, it throws", async () => {
    assert.deepEqual(await readCappedJson(new Response('{"entries":{}}')), { entries: {} });
    await assert.rejects(readCappedJson(new Response("x".repeat(101)), 100), /too large/);
    await assert.rejects(readCappedJson(new Response("{}", { status: 502 })), /HTTP 502/);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(64));
      },
    });
    await assert.rejects(readCappedJson(new Response(stream), 1000), /too large/, "an endless body is cut at the cap");
  });
});

describe("createReplyAnswers", () => {
  const source = (e: SlotExtension, answer: () => unknown): SlotSource & { asked: number } => {
    const s = { ext: e, asked: 0, ask: async () => (s.asked++, answer()) };
    return s;
  };

  test("draws nothing before an answer, then each extension's additions per entry, in source order", async () => {
    const policy = createSlotPolicy(memory());
    const seen: ReadonlyMap<string, SlotState>[] = [];
    const lane = createReplyAnswers(policy, (m) => seen.push(m));
    const a = source(ext("a"), () => ({ entries: { e1: { chips: [chip("From a")] } } }));
    const b = source(ext("b"), () => ({ entries: { e1: { chips: [chip("From b")] }, e2: { chips: [chip("Only b")] } } }));
    lane.ask([a, b]);
    assert.equal(seen.length, 0, "nothing drawn at the ask: the reply never waits");
    await tick();
    const last = seen.at(-1)!;
    assert.deepEqual(last.get("e1")!.chips.map((c) => c.label), ["From a", "From b"]);
    assert.deepEqual(last.get("e2")!.chips.map((c) => c.label), ["Only b"]);
    assert.equal(a.asked + b.asked, 2, "one ask per extension, never per entry");
    lane.stop();
  });

  test("at most CHIPS_PER_REPLY chips under one entry", async () => {
    const policy = createSlotPolicy(memory());
    let last: ReadonlyMap<string, SlotState> = new Map();
    const lane = createReplyAnswers(policy, (m) => (last = m));
    const three = (p: string) => ({ entries: { e1: { chips: [chip(`${p} 1`), chip(`${p} 2`), chip(`${p} 3`)] } } });
    lane.ask([source(ext("a"), () => three("A")), source(ext("b"), () => three("B")), source(ext("c"), () => three("C"))]);
    await tick();
    assert.equal(last.get("e1")!.chips.length, CHIPS_PER_REPLY);
    lane.stop();
  });

  test("a late answer is dropped and counted; the last good one stays", async () => {
    const policy = createSlotPolicy(memory());
    let last: ReadonlyMap<string, SlotState> = new Map();
    const lane = createReplyAnswers(policy, (m) => (last = m), 20);
    let slow = false;
    const a = source(ext("a"), () => (slow ? new Promise(() => {}) : { entries: { e1: { chips: [chip("Good")] } } }));
    lane.ask([a]);
    await tick();
    slow = true;
    lane.ask([a]);
    await tick(40);
    assert.equal(last.get("e1")!.chips[0]!.label, "Good");
    assert.equal(policy.isMuted("a"), false);
    lane.ask([a]);
    await tick(40);
    lane.ask([a]);
    await tick(40);
    assert.equal(policy.isMuted("a"), true, `${MUTE_AFTER} late answers in a row mute it`);
    assert.equal(last.size, 0, "a muted extension draws nothing, its earlier answers included");
    lane.stop();
  });

  test("a superseded ask is not counted against the extension", async () => {
    const policy = createSlotPolicy(memory());
    const lane = createReplyAnswers(policy, () => {}, 1000);
    // The superseded asks would answer well; the one that speaks answers junk: one miss, not four.
    const a = source(ext("a"), () => new Promise((r) => setTimeout(() => r(a.asked > MUTE_AFTER ? "junk" : { entries: {} }), 30)));
    for (let i = 0; i < MUTE_AFTER + 1; i++) lane.ask([a]);
    await tick(60);
    assert.equal(a.asked, MUTE_AFTER + 1);
    assert.equal(policy.isMuted("a"), false);
    lane.stop();
  });

  test("a throwing or malformed answer counts; the user's switch removes its additions at once", async () => {
    const policy = createSlotPolicy(memory());
    let last: ReadonlyMap<string, SlotState> = new Map();
    const lane = createReplyAnswers(policy, (m) => (last = m));
    const good = source(ext("good"), () => ({ entries: { e1: { chips: [chip("Kept")] } } }));
    const thrower = source(ext("bad"), () => {
      throw new Error("boom");
    });
    lane.ask([good, thrower]);
    await tick();
    assert.equal(last.get("e1")!.chips[0]!.label, "Kept", "one extension's failure never touches another's");
    policy.setOff("good", true);
    assert.equal(last.size, 0, "off: drawn away without a new ask");
    lane.ask([good, thrower]);
    await tick();
    assert.equal(good.asked, 1, "an extension that is off is not asked");
    lane.stop();
  });

  test("an extension no longer listed loses its additions; nothing lands after stop", async () => {
    const policy = createSlotPolicy(memory());
    let last: ReadonlyMap<string, SlotState> = new Map();
    let calls = 0;
    const lane = createReplyAnswers(policy, (m) => ((last = m), calls++));
    const a = source(ext("a"), () => ({ entries: { e1: { chips: [chip("A")] } } }));
    lane.ask([a]);
    await tick();
    lane.ask([]);
    assert.equal(last.size, 0);
    const b = source(ext("b"), () => new Promise((r) => setTimeout(() => r({ entries: { e1: { chips: [chip("B")] } } }), 10)));
    lane.ask([b]);
    lane.stop();
    const before = calls;
    await tick(30);
    assert.equal(calls, before);
  });
});
