import assert from "node:assert/strict";
import { test } from "node:test";
import { createSaveQueue } from "./save-queue";

/** A send whose calls the test answers by hand, in any order. */
function harness() {
  const calls: { value: number; resolve(r: string): void; reject(e: unknown): void }[] = [];
  const log: string[] = [];
  let busy = false;
  const q = createSaveQueue<number, string>({
    send: (value) =>
      new Promise<string>((resolve, reject) => {
        log.push(`send ${value}`);
        calls.push({ value, resolve, reject });
      }),
    saved: (r, v) => log.push(`saved ${v} ${r}`),
    failed: (e, v, landed) => log.push(`failed ${v} ${String(e)}${landed ? ` landed ${landed}` : ""}`),
    busy: (b) => {
      busy = b;
      log.push(`busy ${b}`);
    },
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { q, calls, log, tick, busy: () => busy };
}

test("one write at a time, in order, and each is reported when nothing newer waits", async () => {
  const h = harness();
  h.q.push(1);
  assert.deepEqual(h.log, ["busy true", "send 1"]);
  assert.equal(h.q.pending(), true);
  h.calls[0]!.resolve("ok1");
  await h.tick();
  assert.deepEqual(h.log, ["busy true", "send 1", "saved 1 ok1", "busy false"]);
  assert.equal(h.q.pending(), false);
  h.q.push(2);
  h.calls[1]!.resolve("ok2");
  await h.tick();
  assert.deepEqual(h.log.slice(4), ["busy true", "send 2", "saved 2 ok2", "busy false"]);
});

test("pushes during a write coalesce to the newest: the middle values are never sent", async () => {
  const h = harness();
  h.q.push(1);
  h.q.push(2);
  h.q.push(3);
  h.q.push(4);
  assert.equal(h.calls.length, 1, "never two writes in flight");
  h.calls[0]!.resolve("ok1");
  await h.tick();
  assert.deepEqual(
    h.calls.map((c) => c.value),
    [1, 4],
  );
  h.calls[1]!.resolve("ok4");
  await h.tick();
  assert.deepEqual(h.log, ["busy true", "send 1", "send 4", "saved 4 ok4", "busy false"], "1's answer is stale: not reported, and busy stays on between the two");
});

test("a stale response is ignored even when it fails; the newest one decides", async () => {
  const h = harness();
  h.q.push(1);
  h.q.push(2);
  h.calls[0]!.reject("boom");
  await h.tick();
  h.calls[1]!.resolve("ok2");
  await h.tick();
  assert.deepEqual(h.log, ["busy true", "send 1", "send 2", "saved 2 ok2", "busy false"]);
});

test("the newest write's failure is reported with the older success the server still holds", async () => {
  const h = harness();
  h.q.push(1);
  h.q.push(2);
  h.calls[0]!.resolve("ok1");
  await h.tick();
  h.calls[1]!.reject("refused");
  await h.tick();
  assert.deepEqual(h.log, ["busy true", "send 1", "send 2", "failed 2 refused landed ok1", "busy false"]);
  h.q.push(3);
  h.calls[2]!.reject("again");
  await h.tick();
  assert.equal(h.log.at(-2), "failed 3 again", "a landed result is told once, never to a later run");
});

test("idle waits for the queue to drain, and a reset forgets the write in flight", async () => {
  const h = harness();
  await h.q.idle();
  h.q.push(1);
  let drained = false;
  void h.q.idle().then(() => (drained = true));
  await h.tick();
  assert.equal(drained, false);
  h.calls[0]!.resolve("ok1");
  await h.tick();
  assert.equal(drained, true);

  h.q.push(2);
  h.q.push(3);
  h.q.reset();
  assert.equal(h.q.pending(), false);
  assert.equal(h.busy(), false);
  h.calls[1]!.resolve("ok2");
  await h.tick();
  assert.equal(h.calls.length, 2, "3 was dropped with the reset");
  assert.ok(!h.log.some((l) => l.startsWith("saved 2")), "the answer to a write from before the reset is not reported");
});

test("a push from inside a hook waits for the write in hand, and busy stays on until it lands", async () => {
  const log: string[] = [];
  const rejecters: ((e: unknown) => void)[] = [];
  const q = createSaveQueue<number, string>({
    send: (v) => new Promise((_r, reject) => rejecters.push((e) => reject(`${e}${v}`))),
    saved: () => {},
    failed: (_e, v) => {
      log.push(`failed ${v}`);
      if (v === 1) q.push(2); // e.g. again, without the part the server refused
    },
    busy: (b) => log.push(`busy ${b}`),
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  q.push(1);
  rejecters[0]!("no");
  await tick();
  assert.equal(rejecters.length, 2, "the hook's push was sent once the first write settled");
  assert.deepEqual(log, ["busy true", "failed 1"], "no busy false between the two writes");
  assert.equal(q.pending(), true);
  rejecters[1]!("no");
  await tick();
  assert.deepEqual(log, ["busy true", "failed 1", "failed 2", "busy false"]);
});
