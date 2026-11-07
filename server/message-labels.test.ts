// Run: node scripts/run-tests.mjs server/message-labels.test.ts. Message labels (§app.message-labels/labelling): credit by
// the press, the chain's fall-through through a real chain, catching up after a restart, and telling typed text
// from a button after a reload. A throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { DecisionSettings, SessionSummary } from "../shared/protocol";
import { playbookTurnText } from "../shared/playbooks";
import { cardPickLine } from "../shared/transcript-cards";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-message-labels-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-labels--");
mkdirSync(sessionsDir, { recursive: true });

const { createDecisionChain } = await import("./decide-chain");
const { createFakeProvider } = await import("./decide-fake");
const { inputActionOf, sessionOwnMessages } = await import("./message-input");
const { MessageLabeller, labelRequest } = await import("./message-labeller");
const { MessageLabelStore, UNSORTED_BELOW } = await import("./message-labels");
const { attributeMessages, pendingMessages, showsMessages } = await import("./time-spent-messages");
const { acceptAllMessage, composeWithPicks } = await import("../src/lib/align-picks");
const { reviewRequestMessage } = await import("../src/lib/align-review");

after(() => rmSync(agentDir, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const sec = (ms: number) => Math.floor(ms / 1000);
let files = 0;

type Line = Record<string, unknown>;
const user = (id: string, parentId: string | null, text: string, sentAt: number, at = sentAt, extra: unknown[] = []): Line => ({
  type: "message",
  id,
  parentId,
  timestamp: iso(at),
  message: { role: "user", timestamp: sentAt, content: [{ type: "text", text }, ...extra] },
});
const reply = (id: string, parentId: string, text: string, at: number): Line => ({
  type: "message",
  id,
  parentId,
  timestamp: iso(at),
  message: { role: "assistant", timestamp: at, stopReason: "stop", content: [{ type: "text", text }] },
});
const toolResult = (id: string, parentId: string, tool: string, at: number): Line => ({
  type: "message",
  id,
  parentId,
  timestamp: iso(at),
  message: { role: "toolResult", toolName: tool, toolCallId: `c-${id}`, isError: false, timestamp: at, content: [{ type: "text", text: "ok" }] },
});
function sessionFile(lines: Line[], began = T0 - 3_600_000): { path: string; id: string } {
  const id = `s${++files}`;
  const path = join(sessionsDir, `2026-11-07T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, [{ type: "session", version: 3, id, timestamp: iso(began), cwd: "/tmp/labels" }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { path, id };
}
let stores = 0;
const freshStore = () => new MessageLabelStore(join(agentDir, `labels-${++stores}`));
const NO_LABELS = () => ({ labels: new Map(), presses: new Map(), lands: [] as number[], acted: [] as { hash: string; at: number }[] });
const ON = [{ from: T0 - 86_400_000, to: null }];
const rowSeconds = (r: { messages: { rows: { key: string; seconds: number }[] } }) => Object.fromEntries(r.messages.rows.map((x) => [x.key, x.seconds]));
const answer = (choice: string) => ({ label: { probabilities: { directing: 0, steering: 0, reworking: 0, asking: 0, unsorted: 0, [choice]: 1 } } });

const settings = (over: Partial<DecisionSettings["features"]> = { messageLabels: true }): DecisionSettings => ({
  version: 1,
  jev: { enabled: true },
  fallback: null,
  features: { attention: false, tags: false, ...over },
  exclusions: [],
  neverSendTui: false,
});
const row = (s: { path: string; id: string }, at: number, over: Partial<SessionSummary> = {}) =>
  ({ id: s.id, path: s.path, cwd: "/tmp/labels", lastActiveAt: iso(at), origin: "web", live: null, archived: false, ...over }) as unknown as SessionSummary;

describe("credit goes by the press", () => {
  test("two steers taken at one `at`, sentAt 120 s apart: the later gets the 120 s", async () => {
    const taken = T0 + 300_000;
    const s = sessionFile([user("a", null, "first steer", T0, taken), user("b", "a", "second steer", T0 + 120_000, taken)]);
    const own = await sessionOwnMessages(s.path);
    assert.deepEqual(own.map((m) => m.id), ["a", "b"]);
    const r = attributeMessages([{ s: sec(T0), e: sec(T0) + 120, r: "typing" }], own, NO_LABELS(), ON);
    const lines = r.messages.rows.flatMap((x) => x.messages);
    assert.equal(lines.find((m) => m.id === "b")?.seconds, 120, "by `at` both would split nothing and b would have 0");
    assert.equal(lines.find((m) => m.id === "a")?.seconds, 0);
    assert.equal(r.messages.sinceLast, 0);
  });

  test("a press kept beside the session beats the entry's own time", async () => {
    const s = sessionFile([user("a", null, "first", T0 + 10_000), user("b", "a", "held a while", T0 + 200_000)]);
    const labels = { ...NO_LABELS(), presses: new Map([["b", T0 + 50_000]]) };
    const r = attributeMessages([{ s: sec(T0 + 10_000), e: sec(T0 + 110_000), r: "typing" }], await sessionOwnMessages(s.path), labels, ON);
    const b = r.messages.rows.flatMap((x) => x.messages).find((m) => m.id === "b");
    assert.equal(b?.seconds, 40);
    assert.equal(r.messages.sinceLast, 60, "after the press the time is the next message's");
  });

  test("the rows add up to the record's seconds; time with no message yet is Since Your Last Message", async () => {
    const s = sessionFile([user("a", null, "one", T0 + 30_000)]);
    const r = attributeMessages([{ s: sec(T0), e: sec(T0) + 100, r: "typing" }], await sessionOwnMessages(s.path), NO_LABELS(), ON);
    assert.deepEqual(rowSeconds(r), { "not-labelled": 30 });
    assert.equal(r.messages.sinceLast, 70);
  });

  test("Land closes the stretch with no words; a job's end or another session's message closes nothing", async () => {
    const s = sessionFile([
      user("w", null, "[job j1] Background job ended.\nj1: `x`, ran 5m.", T0 + 10_000),
      user("a", "w", "typed after", T0 + 90_000),
    ]);
    const labels = { ...NO_LABELS(), lands: [T0 + 40_000] };
    const r = attributeMessages([{ s: sec(T0), e: sec(T0) + 90, r: "typing" }], await sessionOwnMessages(s.path), labels, ON);
    assert.deepEqual(r.messages.beforeAction, { count: 1, seconds: 40 });
    assert.deepEqual(rowSeconds(r), { "not-labelled": 50 });
  });

  test("a message rewound away from keeps its time", async () => {
    const s = sessionFile([user("a", null, "old road", T0 + 20_000), reply("r", "a", "ok", T0 + 21_000), user("b", null, "new road", T0 + 60_000)]);
    const r = attributeMessages([{ s: sec(T0), e: sec(T0) + 60, r: "typing" }], await sessionOwnMessages(s.path), NO_LABELS(), ON);
    const lines = r.messages.rows.flatMap((x) => x.messages);
    assert.equal(lines.find((m) => m.id === "a")?.seconds, 20);
    assert.equal(lines.find((m) => m.id === "b")?.seconds, 40);
  });

  test("seconds counted with the switch off, or whose next message came with it off, are in no row", async () => {
    const s = sessionFile([user("off", null, "while off", T0 + 20_000), user("on", "off", "while on", T0 + 80_000)]);
    const periods = [{ from: T0 + 40_000, to: null }];
    const r = attributeMessages([{ s: sec(T0), e: sec(T0) + 100, r: "typing" }], await sessionOwnMessages(s.path), NO_LABELS(), periods);
    assert.deepEqual(rowSeconds(r), { "not-labelled": 40 }, "only 40..80 s");
    assert.deepEqual(r.messages.rows[0]!.messages.map((m) => m.id), ["on"]);
    assert.equal(r.messages.sinceLast, 20);
  });

  test("a session you only read shows nothing, however long you read it", async () => {
    const s = sessionFile([user("w", null, "[job j1] Background job ended.\nj1: `x`, ran 5m.", T0), user("step", "w", acceptAllMessage("al_1"), T0 + 1000)]);
    assert.equal(showsMessages(await sessionOwnMessages(s.path), NO_LABELS(), ON), false, "reading, a wake and a click are no typed message");
  });

  test("it shows for a typed message since the switch went on, or a label stored before; not for one sent earlier", async () => {
    const own = await sessionOwnMessages(sessionFile([user("a", null, "typed", T0 + 1000)]).path);
    assert.equal(showsMessages(own, NO_LABELS(), ON), true);
    const later = [{ from: T0 + 1_000_000, to: null }];
    assert.equal(showsMessages(own, NO_LABELS(), later), false);
    const labels = { ...NO_LABELS(), labels: new Map([["a", { label: "asking" as const, confidence: 1, provider: "jev", model: "j", at: 0 }]]) };
    assert.equal(showsMessages(own, labels, later), true, "off and on again: what was stored shows");
  });

  test("Reviewing Screenshots splits by what the next message was labelled, and adds up to the row", async () => {
    const s = sessionFile([user("a", null, "redo it", T0 + 30_000), user("b", "a", "ship it", T0 + 60_000), user("c", "b", "why?", T0 + 90_000)]);
    const label = (l: "reworking" | "directing" | "asking") => ({ label: l, confidence: 1, provider: "jev", model: "j", at: 0 });
    const labels = { ...NO_LABELS(), labels: new Map([["a", label("reworking")], ["b", label("directing")], ["c", label("asking")]]) };
    const r = attributeMessages([{ s: sec(T0), e: sec(T0) + 100, r: "screenshots" }], await sessionOwnMessages(s.path), labels, ON);
    assert.deepEqual(r.screenshots, { reworking: 30, directing: 30, other: 40 });
  });

  test("below the threshold a label reads Unsorted, and moving it re-asks nothing", async () => {
    const s = sessionFile([user("a", null, "hmm", T0 + 30_000)]);
    const labels = { ...NO_LABELS(), labels: new Map([["a", { label: "reworking" as const, confidence: UNSORTED_BELOW - 0.01, provider: "jev", model: "j", at: 0 }]]) };
    const own = await sessionOwnMessages(s.path);
    assert.deepEqual(rowSeconds(attributeMessages([{ s: sec(T0), e: sec(T0) + 30, r: "typing" }], own, labels, ON)), { unsorted: 30 });
    assert.equal(pendingMessages(own, labels, ON).length, 0);
  });
});

describe("a reload tells a button from typing", () => {
  const playbook = playbookTurnText({ title: "Brandmaker", dir: "/p/brand", body: "Do the thing.\n" }, "");

  test("each button's words, as its own composer makes them", () => {
    assert.equal(inputActionOf(playbook), "playbook");
    assert.equal(inputActionOf(playbookTurnText({ title: "B", dir: "/p/b", body: "Do.\n" }, "Brand is Acme")), "playbook");
    assert.equal(inputActionOf(acceptAllMessage("al_3")), "picks");
    assert.equal(inputActionOf(reviewRequestMessage("al_3", "plan")), "review");
    assert.equal(inputActionOf(reviewRequestMessage("al_3", "diff")), "review");
    assert.equal(inputActionOf(composeWithPicks({ al_3: [{ q: "q1" }, { q: "q3" }] } as never, "")), "picks");
    assert.equal(inputActionOf(cardPickLine("cd_4", "Deploy")), "picks");
    assert.equal(inputActionOf("/mode strict"), "command");
  });

  test("picks with words of the user's own, and plain words, are typed", () => {
    assert.equal(inputActionOf(composeWithPicks({ al_3: [{ q: "q1" }] } as never, "and make it blue")), null);
    assert.equal(inputActionOf("al_3 looks fine, go with your recommendations"), null);
    assert.equal(inputActionOf("Playbook: what do you think of it?"), null);
    assert.equal(inputActionOf("/home/me/file.ts is wrong"), null);
  });

  test("a typed message, a playbook step and a card click read back from the file", async () => {
    const s = sessionFile([
      user("typed", null, "make the header smaller", T0 + 10_000),
      reply("r1", "typed", "done", T0 + 11_000),
      user("step", "r1", playbook, T0 + 20_000),
      reply("r2", "step", "ran it", T0 + 21_000),
      user("click", "r2", acceptAllMessage("al_1"), T0 + 30_000),
    ]);
    const own = await sessionOwnMessages(s.path);
    assert.deepEqual(own.map((m) => [m.id, m.action]), [["typed", null], ["step", "playbook"], ["click", "picks"]]);
    assert.deepEqual(pendingMessages(own, NO_LABELS(), ON).map((m) => m.id), ["typed"], "only typed text is ever sent");
    const r = attributeMessages([{ s: sec(T0), e: sec(T0) + 30, r: "typing" }], own, NO_LABELS(), ON);
    assert.deepEqual(rowSeconds(r), { "not-labelled": 10 });
    assert.deepEqual(r.messages.beforeAction, { count: 2, seconds: 20 });
  });

  test("the same words sent again from the same place are a regenerate; a message of images alone is an action", async () => {
    const png = { type: "image", data: "AAAA", mimeType: "image/png" };
    const s = sessionFile([
      user("a", null, "do it", T0 + 10_000),
      reply("r1", "a", "did it", T0 + 11_000),
      { type: "custom", customType: "sova-rewind", id: "rw", parentId: null, timestamp: iso(T0 + 12_000), data: { targetId: "a", fromLeafId: "r1" } },
      user("again", "rw", "do it", T0 + 13_000),
      reply("r2", "again", "did it", T0 + 14_000),
      { type: "message", id: "pic", parentId: "r2", timestamp: iso(T0 + 15_000), message: { role: "user", timestamp: T0 + 15_000, content: [png] } },
    ]);
    const own = await sessionOwnMessages(s.path);
    assert.deepEqual(own.map((m) => [m.id, m.action]), [["a", null], ["again", "regenerate"], ["pic", "no-words"]]);
  });

  test("an offer's answer is known by the note it left, and credits its press", async () => {
    const words = "merge it";
    const store = freshStore();
    const s = sessionFile([user("a", null, words, T0 + 90_000), user("b", "a", words, T0 + 120_000)]);
    store.acted(s.id, words, T0 + 60_000);
    const labels = store.read(s.id);
    const own = await sessionOwnMessages(s.path);
    assert.deepEqual(pendingMessages(own, labels, ON).map((m) => m.id), ["b"], "one note, one message: the typed one stays typed");
    const r = attributeMessages([{ s: sec(T0), e: sec(T0) + 60, r: "typing" }], own, labels, ON);
    assert.deepEqual(r.messages.beforeAction, { count: 1, seconds: 60 });
  });
});

describe("what a check sends", () => {
  test("the head, the previous reply's tail and two flags from code; nothing else", async () => {
    const long = "x".repeat(5000);
    const s = sessionFile([
      user("a", null, "build it", T0),
      reply("r0", "a", `${long} working`, T0 + 1000),
      toolResult("t", "r0", "edit", T0 + 2000),
      reply("r1", "t", `${long}the end of it`, T0 + 3000),
      user("b", "r1", `${long}tail words`, T0 + 4000, T0 + 4000, [{ type: "image", data: "AAAA", mimeType: "image/png" }]),
      reply("r2", "b", "sure", T0 + 5000),
      user("c", "r2", "and this?", T0 + 6000),
    ]);
    const [, b, c] = await sessionOwnMessages(s.path);
    const state = labelRequest(s.id, b!).state as Record<string, unknown>;
    assert.deepEqual(Object.keys(state).sort(), ["attaches_image", "last_turn_delivered_results", "message", "previous_reply_tail"]);
    assert.ok((state.message as string).length <= 600);
    assert.ok(!(state.message as string).includes("tail words"), "the head, not the tail");
    assert.ok((state.previous_reply_tail as string).length <= 1500);
    assert.ok((state.previous_reply_tail as string).endsWith("the end of it"));
    assert.equal(state.last_turn_delivered_results, true, "an edit succeeded in that turn");
    assert.equal(state.attaches_image, true);
    const after = labelRequest(s.id, c!).state as Record<string, unknown>;
    assert.equal(after.last_turn_delivered_results, false, "that turn only talked");
    assert.equal(after.attaches_image, false);
  });

  test("a worker's report and an image shown count as results; a read doesn't", async () => {
    const s = sessionFile([
      user("a", null, "one", T0),
      toolResult("t", "a", "read", T0 + 1000),
      user("b", "t", "two", T0 + 2000),
      { type: "custom_message", id: "n", parentId: "b", timestamp: iso(T0 + 3000), customType: "subagent-complete", content: "done", display: true },
      user("c", "n", "three", T0 + 4000),
    ]);
    const own = await sessionOwnMessages(s.path);
    assert.deepEqual(own.map((m) => m.delivered), [false, false, true]);
  });
});

describe("the chain and catching up", () => {
  const labeller = (o: { s: { path: string; id: string }; store: InstanceType<typeof MessageLabelStore>; provider: () => any; now: () => number; features?: Partial<DecisionSettings["features"]>; over?: Partial<SessionSummary> }) =>
    new MessageLabeller({
      settings: () => settings(o.features),
      provider: o.provider,
      list: async () => [row(o.s, o.now(), o.over)],
      held: () => true,
      read: sessionOwnMessages,
      store: () => o.store,
      now: o.now,
      home: "/nonexistent",
    });
  const sent = (at: number) => sessionFile([user("m", null, "make the header smaller", at)]);

  test("Jev out of quota, a model set: the model answers and the label names it", async () => {
    let now = T0;
    const jev = createFakeProvider({ id: "jev", reply: { fail: "quota" } });
    const model = createFakeProvider({ id: "pi", model: "fake/flash", reply: answer("reworking") });
    const chain = createDecisionChain({ providers: () => [jev, model], now: () => now, log: () => {} });
    const s = sent(T0 + 1000);
    const store = freshStore();
    store.noteSwitch(true, T0);
    now = T0 + 2000;
    assert.equal(await labeller({ s, store, provider: () => chain, now: () => now }).tick(), 1);
    const got = store.read(s.id).labels.get("m");
    assert.equal(got?.label, "reworking");
    assert.equal(got?.provider, "pi");
    assert.equal(got?.model, "fake/flash");
    assert.equal(jev.calls.length, 1, "Jev was tried first");
    const own = await sessionOwnMessages(s.path);
    const r = attributeMessages([{ s: sec(T0), e: sec(T0) + 1, r: "typing" }], own, store.read(s.id), store.periods());
    assert.equal(r.messages.rows[0]?.messages[0]?.labelledBy, "fake/flash", "the line says which model");
  });

  test("Jev answering says nothing about who did", async () => {
    const jev = createFakeProvider({ id: "jev", model: "jev-1", reply: answer("asking") });
    const chain = createDecisionChain({ providers: () => [jev], now: () => T0 + 2000, log: () => {} });
    const s = sent(T0 + 1000);
    const store = freshStore();
    store.noteSwitch(true, T0);
    await labeller({ s, store, provider: () => chain, now: () => T0 + 2000 }).tick();
    const r = attributeMessages([{ s: sec(T0), e: sec(T0) + 1, r: "typing" }], await sessionOwnMessages(s.path), store.read(s.id), store.periods());
    assert.equal(r.messages.rows[0]?.key, "asking");
    assert.equal(r.messages.rows[0]?.messages[0]?.labelledBy, undefined);
  });

  test("Jev out of quota, no model: Not Labelled, and nothing stored", async () => {
    const jev = createFakeProvider({ id: "jev", reply: { fail: "quota" } });
    const chain = createDecisionChain({ providers: () => [jev], now: () => T0 + 2000, log: () => {} });
    const s = sent(T0 + 1000);
    const store = freshStore();
    store.noteSwitch(true, T0);
    assert.equal(await labeller({ s, store, provider: () => chain, now: () => T0 + 2000 }).tick(), 0);
    assert.equal(store.read(s.id).labels.size, 0);
    const r = attributeMessages([{ s: sec(T0), e: sec(T0) + 1, r: "typing" }], await sessionOwnMessages(s.path), store.read(s.id), store.periods());
    assert.equal(r.messages.rows[0]?.key, "not-labelled");
  });

  test("no provider at all: nothing is sent, and the message stays pending", async () => {
    const s = sent(T0 + 1000);
    const store = freshStore();
    store.noteSwitch(true, T0);
    assert.equal(await labeller({ s, store, provider: () => null, now: () => T0 + 2000 }).tick(), 0);
    assert.equal(pendingMessages(await sessionOwnMessages(s.path), store.read(s.id), store.periods()).length, 1);
  });

  test("a provider failing an hour on a fake clock, then a restart: the message gets its label", async () => {
    let now = T0 + 2000;
    const down = createFakeProvider({ id: "jev", reply: { fail: "server" } });
    const chain = createDecisionChain({ providers: () => [down], now: () => now, log: () => {} });
    const s = sent(T0 + 1000);
    const store = freshStore();
    store.noteSwitch(true, T0);
    const first = labeller({ s, store, provider: () => chain, now: () => now });
    for (; now < T0 + 3_600_000; now += 10_000) assert.equal(await first.tick(), 0);
    assert.ok(down.calls.length > 1, "it kept asking");
    assert.ok(down.calls.length < 20, `backing off, not hammering: ${down.calls.length} calls in an hour`);
    assert.equal(store.read(s.id).labels.size, 0);
    // The restart: nothing in memory survives, the store and the file do.
    const up = createFakeProvider({ id: "jev", model: "jev-1", reply: answer("steering") });
    const again = createDecisionChain({ providers: () => [up], now: () => now, log: () => {} });
    const second = labeller({ s, store: new MessageLabelStore(store.dir), provider: () => again, now: () => now });
    assert.equal(await second.tick(), 1);
    assert.equal(store.read(s.id).labels.get("m")?.label, "steering");
    assert.equal(await second.tick(), 0, "asked once");
    assert.equal(up.calls.length, 1);
  });

  test("the switch off sends nothing; a message sent while it was off is never asked; one from before stays asked", async () => {
    const provider = createFakeProvider({ id: "jev", reply: answer("directing") });
    const s = sessionFile([user("before", null, "while on", T0 + 1000), user("off", "before", "while off", T0 + 5000), user("back", "off", "on again", T0 + 9000)]);
    const store = freshStore();
    store.noteSwitch(true, T0);
    store.noteSwitch(false, T0 + 2000);
    assert.equal(await labeller({ s, store, provider: () => provider, now: () => T0 + 3000, features: { messageLabels: false } }).tick(), 0);
    assert.equal(provider.calls.length, 0, "off: nothing sent");
    store.noteSwitch(true, T0 + 8000);
    assert.equal(await labeller({ s, store, provider: () => provider, now: () => T0 + 10_000 }).tick(), 2);
    assert.deepEqual([...store.read(s.id).labels.keys()].sort(), ["back", "before"]);
  });

  test("workers, Overseers, batons and excluded folders are never sent", async () => {
    const provider = createFakeProvider({ id: "jev", reply: answer("directing") });
    const s = sent(T0 + 1000);
    const store = freshStore();
    store.noteSwitch(true, T0);
    for (const over of [{ workerSession: true }, { overseer: true }, { baton: true }, { projectOverseer: true }] as Partial<SessionSummary>[])
      assert.equal(await labeller({ s, store, provider: () => provider, now: () => T0 + 2000, over }).tick(), 0);
    assert.equal(provider.calls.length, 0);
  });

  test("a session in an excluded folder is never sent; one outside it is", async () => {
    const provider = createFakeProvider({ id: "jev", model: "jev-1", reply: answer("directing") });
    const s = sent(T0 + 1000);
    const store = freshStore();
    store.noteSwitch(true, T0);
    const run = (exclusions: string[]) =>
      new MessageLabeller({
        settings: () => ({ ...settings(), exclusions }),
        provider: () => provider,
        list: async () => [row(s, T0 + 2000)],
        held: () => true,
        read: sessionOwnMessages,
        store: () => store,
        now: () => T0 + 2000,
        home: "/nonexistent",
      }).tick();
    assert.equal(await run(["/tmp/labels"]), 0);
    assert.equal(provider.calls.length, 0);
    assert.equal(await run(["/tmp/labels-other"]), 1, "whole path segments: a sibling folder isn't excluded");
  });

  test("the store: removal with the session, a torn line counts for nothing, nothing in the session's file", () => {
    const store = freshStore();
    const s = sent(T0);
    const before = readFileSync(s.path, "utf8");
    store.label(s.id, "m", { label: "asking", confidence: 1, provider: "jev", model: "j", at: 1 });
    writeFileSync(join(store.dir, `${s.id}.jsonl`), `${readFileSync(join(store.dir, `${s.id}.jsonl`), "utf8")}{"id":"x","lab`);
    assert.deepEqual([...store.read(s.id).labels.keys()], ["m"]);
    assert.equal(readFileSync(s.path, "utf8"), before);
    store.remove(s.id);
    assert.equal(store.read(s.id).labels.size, 0);
  });
});

describe("the read route", () => {
  const write = (features: Partial<DecisionSettings["features"]>) => writeFileSync(join(agentDir, "sova", "decisions.json"), JSON.stringify(settings(features)));
  const live = () => new MessageLabelStore(join(agentDir, "sova", "message-labels"));

  test("the switch on shows what was counted, through the record; off hides it all, a typed message and a stored label included", async () => {
    mkdirSync(join(agentDir, "sova"), { recursive: true });
    const { readTimeSpent } = await import("./time-spent-routes");
    const { timeSpentStore } = await import("./time-spent");
    const now = Date.now();
    const s = sessionFile([user("a", null, "pw: hunter22 and the rest", now - 30_000), user("b", "a", "second", now - 10_000)], now - 3_600_000);
    live().noteSwitch(false, now - 7_200_000);
    live().noteSwitch(true, now - 7_200_000);
    live().label(s.id, "a", { label: "reworking", confidence: 0.9, provider: "pi", model: "zai/fake", at: now });
    timeSpentStore().report(s.id, { pageId: "p", inputAgeMs: 0, slices: [{ row: "typing", sec: 60, ageMs: 0, docs: [] }] }, now);

    write({ messageLabels: true });
    const on = await readTimeSpent(s.path, now);
    assert.ok(on.messages, "shows");
    const rows = on.messages!;
    assert.equal(rows.rows.reduce((n, r) => n + r.seconds, 0) + rows.beforeAction.seconds + rows.sinceLast, on.you, "adds up to You");
    assert.deepEqual(rows.rows.map((r) => r.key), ["reworking", "not-labelled"]);
    assert.equal(rows.rows[0]!.messages[0]!.labelledBy, "zai/fake");
    assert.ok(!rows.rows[0]!.messages[0]!.excerpt.includes("hunter22"), "a line shows nothing a decision wouldn't send");

    write({ messageLabels: false });
    const off = await readTimeSpent(s.path, now);
    assert.equal(off.messages, undefined);
    assert.equal(off.screenshots, undefined);
    assert.equal(off.you, on.you, "the record itself stays");
    write({ messageLabels: true });
  });

  test("a session in an excluded folder has no Your Messages, though it has a typed message and a stored label", async () => {
    const { readTimeSpent } = await import("./time-spent-routes");
    const now = Date.now();
    const s = sessionFile([user("a", null, "typed", now - 30_000)], now - 3_600_000);
    live().noteSwitch(true, now - 7_200_000);
    live().label(s.id, "a", { label: "asking", confidence: 1, provider: "jev", model: "j", at: now });
    write({ messageLabels: true });
    assert.ok((await readTimeSpent(s.path, now)).messages, "shows outside the folder");
    writeFileSync(join(agentDir, "sova", "decisions.json"), JSON.stringify({ ...settings(), exclusions: ["/tmp/labels"] }));
    assert.equal((await readTimeSpent(s.path, now)).messages, undefined);
    write({ messageLabels: true });
  });

  test("a session you only read has no Your Messages, though it has counted seconds", async () => {
    const { readTimeSpent } = await import("./time-spent-routes");
    const { timeSpentStore } = await import("./time-spent");
    const now = Date.now();
    const s = sessionFile([reply("r", "x", "just a reply", now - 90_000)], now - 3_600_000);
    live().noteSwitch(true, now - 7_200_000);
    write({ messageLabels: true });
    timeSpentStore().report(s.id, { pageId: "q", inputAgeMs: 0, slices: [{ row: "reading-transcript", sec: 60, ageMs: 0, docs: [] }] }, now + 300_000);
    const r = await readTimeSpent(s.path, now + 300_000);
    assert.equal(r.you, 60);
    assert.equal(r.messages, undefined);
  });
});
