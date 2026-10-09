// Run: pnpm test -- server/outreach-health.test.ts. §app.outreach/sender-health: what this host last read
// of each WhatsApp sender, and the Needs you item of no session each one raises. Pure: no sender, no clock.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { UNPAIRED_WHY } from "../shared/outreach";
import { keepReadings, noteSenderState, noteSenderStatus, resetSenderHealth, senderAttention, senderReading } from "./outreach/health";

const T = Date.parse("2026-10-07T09:00:00Z");
const MIN = 60_000;
beforeEach(() => resetSenderHealth());

test("a reading of the same state keeps when it began; another state starts again; off forgets", () => {
  noteSenderStatus("local", { state: "down", why: "a" }, T);
  const s = noteSenderStatus("local", { state: "down", why: "b" }, T + 5 * MIN);
  assert.equal(s.since, new Date(T).toISOString());
  assert.equal(senderReading("local")?.status.why, "b");
  noteSenderStatus("local", { state: "open" }, T + 6 * MIN);
  assert.equal(senderReading("local")?.since, T + 6 * MIN);
  noteSenderStatus("local", { state: "off" }, T + 7 * MIN);
  assert.equal(senderReading("local"), null);
});

test("a state event keeps the last reading's figures and replaces its state, why and next try", () => {
  noteSenderStatus("local", { state: "open", usage: { hour: 1, day: 2 }, me: "…111" }, T);
  noteSenderState("local", { state: "down", why: "w", retryAt: "2026-10-07T10:00:00.000Z", paused: false }, T + MIN);
  const r = senderReading("local")!.status;
  assert.deepEqual([r.state, r.why, r.retryAt, r.me, r.usage?.day], ["down", "w", "2026-10-07T10:00:00.000Z", "…111", 2]);
  noteSenderState("local", { state: "open", paused: false }, T + 2 * MIN);
  assert.equal(senderReading("local")!.status.retryAt, undefined, "an open has no next try");
});

test("Needs you: down, logged out, replaced, blocked and unpaired at once, with the sender's why, opening Settings → Outreach", () => {
  for (const state of ["down", "logged-out", "replaced", "blocked", "unpaired"] as const) {
    resetSenderHealth();
    noteSenderStatus("local", { state, why: `Why ${state}.` }, T);
    const items = senderAttention(T);
    assert.equal(items.length, 1, state);
    assert.deepEqual(
      { tier: items[0]!.tier, kind: items[0]!.kind, path: items[0]!.path, href: items[0]!.href, detail: items[0]!.detail, since: items[0]!.since },
      { tier: "act", kind: "whatsapp-down", path: "", href: "#/settings/outreach", detail: `WhatsApp sending is down for local: ${state === "unpaired" ? UNPAIRED_WHY : `Why ${state}.`}`, since: T },
    );
  }
});

test("never for connecting (a backoff wait included), open or linking; unreachable only after 5 minutes", () => {
  for (const state of ["connecting", "open", "linking"] as const) {
    resetSenderHealth();
    noteSenderStatus("local", { state, retryAt: "2026-10-07T09:01:00.000Z" }, T);
    assert.deepEqual(senderAttention(T + 60 * MIN), [], state);
  }
  resetSenderHealth();
  noteSenderStatus("local", { state: "unreachable", why: "The sender is not running (no socket answers)." }, T);
  noteSenderStatus("local", { state: "unreachable", why: "The sender is not running (no socket answers)." }, T + 4 * MIN);
  assert.deepEqual(senderAttention(T + 4 * MIN + 59_000), [], "a restart takes seconds");
  const items = senderAttention(T + 5 * MIN);
  assert.equal(items[0]?.detail, "WhatsApp sending is down for local: Sova can't reach the sender: The sender is not running (no socket answers).");
  noteSenderStatus("local", { state: "open" }, T + 6 * MIN);
  assert.deepEqual(senderAttention(T + 6 * MIN), [], "it clears once the sender answers");
});

test("a down with a next try still ahead heals itself and never alerts; without one, or once it is overdue, it does", () => {
  noteSenderState("local", { state: "down", why: "The reconnect limit of 3 an hour is reached.", retryAt: new Date(Date.now() + 30 * MIN).toISOString() });
  assert.deepEqual(senderAttention(), [], "a self-healing wait");
  resetSenderHealth();
  noteSenderState("local", { state: "down", why: "The reconnect limit of 3 an hour is reached.", retryAt: new Date(T + 30 * MIN).toISOString() }, T);
  assert.equal(senderAttention(T + 31 * MIN).length, 1, "the next try is overdue: it didn't heal");
  resetSenderHealth();
  noteSenderState("local", { state: "down", why: "No retry." });
  assert.deepEqual(senderAttention().map((i) => i.kind), ["whatsapp-down"]);
});

test("each sender is judged alone: its own item, naming its label; one healing or clearing never touches the other's", () => {
  noteSenderStatus("local", { state: "down", why: "Closed (503)." }, T, "Office");
  noteSenderStatus("local:sales", { state: "logged-out", why: "The phone unlinked this device." }, T, "Sales");
  noteSenderStatus("peer:gw", { state: "open" }, T, "Gateway");
  const items = senderAttention(T);
  assert.deepEqual(
    items.map((i) => [i.id, i.detail]),
    [
      ["whatsapp-sender:local", "WhatsApp sending is down for Office: Closed (503)."],
      ["whatsapp-sender:local:sales", "WhatsApp sending is down for Sales: The phone unlinked this device."],
    ],
  );
  // Office's own wait heals itself: only Office's item goes; Sales still alerts.
  noteSenderState("local", { state: "down", why: "The reconnect limit of 3 an hour is reached.", retryAt: new Date(T + 30 * MIN).toISOString() }, T + MIN);
  assert.deepEqual(senderAttention(T + 2 * MIN).map((i) => i.id), ["whatsapp-sender:local:sales"]);
  // Sales comes back; Office's wait is overdue: only Office alerts again.
  noteSenderStatus("local:sales", { state: "open" }, T + 31 * MIN);
  assert.deepEqual(senderAttention(T + 31 * MIN).map((i) => i.id), ["whatsapp-sender:local"]);
  // A sender no longer in use is forgotten, and its item clears.
  keepReadings(new Set(["local:sales"]));
  assert.deepEqual(senderAttention(T + 31 * MIN), []);
  assert.equal(senderReading("local"), null);
});

test("unpaired says Sova's own sentence, pointing at Settings, never the sender's terminal command", () => {
  noteSenderStatus("local", { state: "unpaired", why: "No device is linked yet: run `sova-whatsapp pair` on this host." }, T, "Office");
  const d = senderAttention(T)[0]!.detail!;
  assert.equal(d, `WhatsApp sending is down for Office: ${UNPAIRED_WHY}`);
  assert.doesNotMatch(d, /sova-whatsapp pair/);
});
