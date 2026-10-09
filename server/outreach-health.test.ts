// Run: pnpm test -- server/outreach-health.test.ts. §app.outreach/sender-health: what this host last read
// of the WhatsApp sender, and the one Needs you item of no session it raises. Pure: no sender, no clock.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { noteSenderState, noteSenderStatus, resetSenderHealth, senderAttention, senderReading } from "./outreach/health";

const T = Date.parse("2026-10-07T09:00:00Z");
const MIN = 60_000;
beforeEach(() => resetSenderHealth());

test("a reading of the same state keeps when it began; another state starts again; off forgets", () => {
  noteSenderStatus({ state: "down", why: "a" }, T);
  const s = noteSenderStatus({ state: "down", why: "b" }, T + 5 * MIN);
  assert.equal(s.since, new Date(T).toISOString());
  assert.equal(senderReading()?.status.why, "b");
  noteSenderStatus({ state: "open" }, T + 6 * MIN);
  assert.equal(senderReading()?.since, T + 6 * MIN);
  noteSenderStatus({ state: "off" }, T + 7 * MIN);
  assert.equal(senderReading(), null);
});

test("a state event keeps the last reading's figures and replaces its state, why and next try", () => {
  noteSenderStatus({ state: "open", usage: { hour: 1, day: 2 }, me: "…111" }, T);
  noteSenderState({ state: "down", why: "w", retryAt: "2026-10-07T10:00:00.000Z", paused: false }, T + MIN);
  const r = senderReading()!.status;
  assert.deepEqual([r.state, r.why, r.retryAt, r.me, r.usage?.day], ["down", "w", "2026-10-07T10:00:00.000Z", "…111", 2]);
  noteSenderState({ state: "open", paused: false }, T + 2 * MIN);
  assert.equal(senderReading()!.status.retryAt, undefined, "an open has no next try");
});

test("Needs you: down, logged out, replaced, blocked and unpaired at once, with the sender's why, opening Settings → Outreach", () => {
  for (const state of ["down", "logged-out", "replaced", "blocked", "unpaired"] as const) {
    resetSenderHealth();
    noteSenderStatus({ state, why: `Why ${state}.` }, T);
    const items = senderAttention(T);
    assert.equal(items.length, 1, state);
    assert.deepEqual(
      { tier: items[0]!.tier, kind: items[0]!.kind, path: items[0]!.path, href: items[0]!.href, detail: items[0]!.detail, since: items[0]!.since },
      { tier: "act", kind: "whatsapp-down", path: "", href: "#/settings/outreach", detail: `WhatsApp sending is down: Why ${state}.`, since: T },
    );
  }
});

test("never for connecting (a backoff wait included), open or linking; unreachable only after 5 minutes", () => {
  for (const state of ["connecting", "open", "linking"] as const) {
    resetSenderHealth();
    noteSenderStatus({ state, retryAt: "2026-10-07T09:01:00.000Z" }, T);
    assert.deepEqual(senderAttention(T + 60 * MIN), [], state);
  }
  resetSenderHealth();
  noteSenderStatus({ state: "unreachable", why: "The sender is not running (no socket answers)." }, T);
  noteSenderStatus({ state: "unreachable", why: "The sender is not running (no socket answers)." }, T + 4 * MIN);
  assert.deepEqual(senderAttention(T + 4 * MIN + 59_000), [], "a restart takes seconds");
  const items = senderAttention(T + 5 * MIN);
  assert.equal(items[0]?.detail, "WhatsApp sending is down: Sova can't reach the sender: The sender is not running (no socket answers).");
  noteSenderStatus({ state: "open" }, T + 6 * MIN);
  assert.deepEqual(senderAttention(T + 6 * MIN), [], "it clears once the sender answers");
});

test("a down with a next try still ahead heals itself and never alerts; without one, or once it is overdue, it does", () => {
  noteSenderState({ state: "down", why: "The reconnect limit of 3 an hour is reached.", retryAt: new Date(Date.now() + 30 * MIN).toISOString() });
  assert.deepEqual(senderAttention(), [], "a self-healing wait");
  resetSenderHealth();
  noteSenderState({ state: "down", why: "The reconnect limit of 3 an hour is reached.", retryAt: new Date(T + 30 * MIN).toISOString() }, T);
  assert.equal(senderAttention(T + 31 * MIN).length, 1, "the next try is overdue: it didn't heal");
  resetSenderHealth();
  noteSenderState({ state: "down", why: "No retry." });
  assert.deepEqual(senderAttention().map((i) => i.kind), ["whatsapp-down"]);
});
