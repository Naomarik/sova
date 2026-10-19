import assert from "node:assert/strict";
import { test } from "node:test";
import { removeSessionTours } from "./lifecycle";

test("deletion revokes immediately and bars new work but retains source until actual runner settlement", async () => {
  const events: string[] = [];
  let release!: () => void;
  const settled = new Promise<void>(resolve => { release = resolve; });
  const cleanup = removeSessionTours("source-chat", {
    barrier(id) { assert.equal(id, "source-chat"); events.push("barrier"); },
    revoke() { events.push("revoke"); },
    async settle() { events.push("cancel"); await settled; events.push("settled"); },
    removeSource() { events.push("source"); },
    forgetOwner() { events.push("forget"); },
  });
  assert.deepEqual(events, ["revoke", "barrier", "cancel"], "no await before revoking authority");
  await Promise.resolve();
  assert.equal(events.includes("source"), false, "abort or cancelled phase is not settlement");
  release(); await cleanup;
  assert.deepEqual(events, ["revoke", "barrier", "cancel", "settled", "source", "forget"]);
});

test("barrier or authority errors still cancel and await cleanup, then aggregate observable failures", async () => {
  const events: string[] = [];
  const failures = [new Error("authority"), new Error("barrier"), new Error("private cleanup"), new Error("source cleanup")];
  let release!: () => void;
  const settled = new Promise<void>(resolve => { release = resolve; });
  const cleanup = removeSessionTours("source-chat", {
    barrier() { events.push("barrier"); throw failures[1]; },
    revoke() { events.push("revoke"); throw failures[0]; },
    async settle() { events.push("cancel"); await settled; events.push("settled"); throw failures[2]; },
    removeSource() { events.push("source"); throw failures[3]; },
    forgetOwner() { events.push("forget"); },
  });
  assert.deepEqual(events, ["revoke", "barrier", "cancel"]);
  const rejection = assert.rejects(cleanup, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, failures);
    return true;
  });
  await Promise.resolve();
  assert.equal(events.includes("source"), false);
  release(); await rejection;
  assert.deepEqual(events, ["revoke", "barrier", "cancel", "settled", "source"]);
});

test("each incomplete phase independently preserves private owner retry authority", async () => {
  for (const failedPhase of ["revoke", "barrier", "settle", "source"] as const) {
    const events: string[] = [], failure = new Error(`Incomplete ${failedPhase}`);
    const phase = (name: string) => { events.push(name); if (name === failedPhase) throw failure; };
    await assert.rejects(removeSessionTours("source-chat", {
      revoke() { phase("revoke"); },
      barrier() { phase("barrier"); },
      async settle() { phase("settle"); },
      removeSource() { phase("source"); },
      forgetOwner() { events.push("forget"); },
    }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]); return true;
    });
    assert.deepEqual(events, ["revoke", "barrier", "settle", "source"], `${failedPhase} alone must prevent forgetting, without skipping later cleanup`);
  }
});

test("owner-record cleanup failure is reported only after all other cleanup completed", async () => {
  const events: string[] = [], failure = new Error("Owner authority cleanup failed.");
  await assert.rejects(removeSessionTours("source-chat", {
    revoke() { events.push("revoke"); },
    barrier() { events.push("barrier"); },
    async settle() { events.push("settle"); },
    removeSource() { events.push("source"); },
    forgetOwner() { events.push("forget"); throw failure; },
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]); return true;
  });
  assert.deepEqual(events, ["revoke", "barrier", "settle", "source", "forget"]);
});
