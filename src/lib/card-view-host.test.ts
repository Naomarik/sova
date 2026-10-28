import assert from "node:assert/strict";
import { test } from "node:test";
import type { CardInfo } from "../../shared/transcript-cards";
import { answerViewCall, boxHeight, type ViewHostDeps } from "./card-view-host";

// The page's half of the view API (§chat.transcript-cards/view-api): each call answered for its own card.

const card = (over: Partial<CardInfo> = {}): CardInfo => ({
  id: "cd_1", type: "project.chart", title: "Chart", draws: "view", view: { toolkit: 1 }, answerMode: "at-once", placement: "anchored",
  data: {}, at: "2026-10-28T10:00:00.000Z", by: { kind: "agent" }, toolCallId: "t1", state: "open", ...over,
});

function host(over: Partial<ViewHostDeps> = {}, c = card()) {
  const did: string[] = [];
  const deps: ViewHostDeps = {
    card: () => c,
    canAct: () => true,
    setState: async (v) => void did.push(`state ${JSON.stringify(v)}`),
    stage: (t) => void did.push(`stage ${t}`),
    answerNow: async (v) => void did.push(`answer ${JSON.stringify(v)}`),
    pick: (v, t) => void did.push(`pick ${t} ${JSON.stringify(v)}`),
    run: async (cmd, p) => (did.push(`run ${cmd} ${JSON.stringify(p)}`), { ok: true, status: 200, body: { n: 1 } }),
    resize: (h) => void did.push(`resize ${h}`),
    ...over,
  };
  return { did, ask: (m: unknown) => answerViewCall(m, deps) };
}

test("each call answered by its id: state, stage, answer, run; resize takes no answer", async () => {
  const { did, ask } = host();
  assert.deepEqual(await ask({ id: 1, call: "state", args: { value: { n: 2 } } }), { re: 1, ok: true });
  assert.deepEqual(await ask({ id: 2, call: "stage", args: { text: "Look at bar 3" } }), { re: 2, ok: true });
  assert.deepEqual(await ask({ id: 3, call: "answer", args: { text: "3 bars", value: [1, 2, 3] } }), { re: 3, ok: true });
  assert.deepEqual(await ask({ id: 4, call: "run", args: { command: "session.get", params: {} } }), { re: 4, ok: true, value: { ok: true, status: 200, body: { n: 1 } } });
  assert.equal(await ask({ id: 0, call: "resize", args: { height: 240.4 } }), null);
  assert.deepEqual(did, ['state {"n":2}', "stage Look at bar 3", 'answer {"view":{"text":"3 bars","value":[1,2,3]}}', "run session.get {}", "resize 240"]);
});

test("a gathering card stages its pick for the next message instead of recording it", async () => {
  const { did, ask } = host({}, card({ answerMode: "gather" }));
  assert.deepEqual(await ask({ id: 1, call: "answer", args: { text: "b" } }), { re: 1, ok: true });
  assert.deepEqual(did, ['pick b {"view":{"text":"b","value":null}}']);
});

test("refusals: a view that can't act, an answered or answerless card, bad args, an unknown call", async () => {
  const quiet = host({ canAct: () => false });
  assert.match(((await quiet.ask({ id: 1, call: "stage", args: { text: "x" } })) as { error: string }).error, /can't act on its chat/);
  assert.match(((await quiet.ask({ id: 2, call: "answer", args: { text: "x" } })) as { error: string }).error, /can't act on its chat/);
  const answered = host({}, card({ state: "answered", answer: { value: { view: {} }, text: "a", by: "you", at: "x", via: "at-once" } }));
  assert.match(((await answered.ask({ id: 3, call: "answer", args: { text: "x" } })) as { error: string }).error, /already answered: a/);
  const none = host({}, card({ answerMode: "none" }));
  assert.match(((await none.ask({ id: 4, call: "answer", args: { text: "x" } })) as { error: string }).error, /takes no answer/);
  const h = host();
  assert.match(((await h.ask({ id: 5, call: "state", args: { value: "x".repeat(70 * 1024) } })) as { error: string }).error, /larger than 64 KB/);
  assert.match(((await h.ask({ id: 6, call: "navigate", args: {} })) as { error: string }).error, /not something a view can ask/);
  assert.equal(await h.ask({ call: "stage" }), null, "no id: not a call");
  assert.deepEqual(h.did, [], "nothing ran");
  // A refusal from the server (an untrusted project's acting command) is the call's answer, in its words.
  const untrusted = host({ run: async () => Promise.reject(new Error("This card's project isn't trusted to act for you yet.")) });
  assert.deepEqual(await untrusted.ask({ id: 7, call: "run", args: { command: "session.send", params: { text: "hi" } } }), { re: 7, ok: false, error: "This card's project isn't trusted to act for you yet." });
});

test("the box's height: 32 to 1200 px", () => {
  assert.equal(boxHeight(5), 32);
  assert.equal(boxHeight(400.6), 401);
  assert.equal(boxHeight(5000), 1200);
});

test("a drawing only draws: resize is its one call, every other call is refused (§chat.transcript-cards/drawing-kinds)", async () => {
  const { answerDrawingCall, DRAWING_ONLY_DRAWS } = await import("./card-view-host");
  const sizes: (number | null)[] = [];
  assert.equal(answerDrawingCall({ id: 1, call: "resize", args: { height: 210.4 } }, (h) => sizes.push(h)), null);
  assert.deepEqual(sizes, [210]);
  for (const call of ["answer", "stage", "state", "run", "anything"]) assert.deepEqual(answerDrawingCall({ id: 2, call, args: { command: "session.send", text: "x" } }, () => undefined), { re: 2, ok: false, error: DRAWING_ONLY_DRAWS });
  assert.equal(answerDrawingCall({ call: "run" }, () => undefined), null);
});
