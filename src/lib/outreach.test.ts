// Run: pnpm test -- src/lib/outreach.test.ts. Settings → Outreach's sender panel (§app.settings-dialog/outreach,
// §app.outreach/sender-controls): the state in words, its figures, and which controls the page offers.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutreachInfo, SenderStatus } from "../../shared/outreach";
import { senderActions, senderFacts, senderWords } from "./outreach";

const now = new Date(2026, 9, 9, 14, 20).getTime();
const at = (h: number, m: number) => new Date(2026, 9, 9, h, m).toISOString();

test("down with a next try says when it reconnects on its own and why it stopped; without one, that it won't", () => {
  const w = senderWords({ state: "down", why: "WhatsApp closed the connection (503). The reconnect limit of 3 an hour is reached.", retryAt: at(14, 32) }, now);
  assert.equal(w.chip, "Down");
  assert.equal(w.text, "Waiting until 2:32 PM, in 12m to reconnect. WhatsApp closed the connection (503). The reconnect limit of 3 an hour is reached.");
  assert.equal(senderWords({ state: "down", why: "update the sender." }, now).text, "update the sender. It won't reconnect on its own: reconnect it.");
  assert.equal(senderWords({ state: "connecting", why: "WhatsApp closed the connection (428).", retryAt: at(14, 21) }, now).text, "WhatsApp closed the connection (428). It tries again at 2:21 PM, in 1m.");
  assert.equal(senderWords({ state: "open", paused: true }, now).chip, "Paused");
  assert.match(senderWords({ state: "blocked", why: "WhatsApp refused this account (403)." }, now).text, /Sending stays paused until the sender is resumed\.$/);
  assert.equal(
    senderWords({ state: "blocked", why: "WhatsApp refused this account (403), possibly a ban. Sending is paused." }, now).text,
    "WhatsApp refused this account (403), possibly a ban. Sending stays paused until the sender is resumed.",
    "the sender's own pause sentence is said once",
  );
});

test("the figures: since when, the number, sends and automatic reconnects against their limits", () => {
  const s: SenderStatus = { state: "down", since: at(14, 5), me: "…111", usage: { hour: 1, day: 4 }, limits: { gapS: 3, perHour: 20, perDay: 60 }, reconnects: { hour: 3, day: 3, perHour: 3, perDay: 10 } };
  assert.deepEqual(senderFacts(s, now), ["Since 2:05 PM", "Number …111", "Sends: 1 of 20 this hour, 4 of 60 in 24 h", "Automatic reconnects: 3 of 3 this hour, 3 of 10 in 24 h"]);
  assert.deepEqual(senderFacts({ state: "open", since: at(14, 5) }, now), [], "open needs no since");
});

test("controls: Reconnect for down, replaced and a backoff wait, from either route; blocked only here, behind its warning; Pause and Start only here", () => {
  const local = (sender: SenderStatus, unit?: OutreachInfo["unit"]) => senderActions({ file: { version: 1, sender: { local: {} }, acceptFrom: [], paused: false }, sender, ...(unit ? { unit } : {}) });
  const via = (sender: SenderStatus) => senderActions({ file: { version: 1, sender: { via: { nodeId: "n" } }, acceptFrom: [], paused: false }, sender });
  assert.deepEqual(local({ state: "down" }), { reconnect: "plain", pause: "pause", start: false });
  assert.deepEqual(local({ state: "replaced", paused: true }), { reconnect: "plain", pause: "resume", start: false });
  assert.deepEqual(local({ state: "blocked", paused: true }).reconnect, "blocked");
  assert.equal(local({ state: "connecting", retryAt: at(14, 21) }).reconnect, "plain");
  assert.equal(local({ state: "connecting" }).reconnect, false, "already connecting");
  for (const state of ["open", "logged-out", "unpaired", "linking"] as const) assert.equal(local({ state }).reconnect, false, state);
  assert.deepEqual(via({ state: "down" }), { reconnect: "plain", pause: null, start: false });
  assert.equal(via({ state: "blocked" }).reconnect, false, "never from another host");
  assert.equal(local({ state: "unreachable" }, { name: "sova-whatsapp.service", active: "inactive" }).start, true);
  assert.equal(local({ state: "unreachable" }, { name: "sova-whatsapp.service", active: "failed" }).start, true);
  assert.equal(local({ state: "unreachable" }, { name: "sova-whatsapp.service", active: "activating" }).start, false);
  assert.deepEqual(local({ state: "unreachable" }), { reconnect: false, pause: null, start: false });
});
