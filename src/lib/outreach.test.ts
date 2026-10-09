// Run: pnpm test -- src/lib/outreach.test.ts. Settings → Outreach's sender panel (§app.settings-dialog/outreach,
// §app.outreach/sender-controls): the state in words, its figures, and which controls the page offers.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutreachInfo, SenderStatus } from "../../shared/outreach";
import { entryChoice, entryPicked, outreachDraftOf, senderActions, senderFacts, senderUse, senderWords } from "./outreach";

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
  assert.deepEqual(local({ state: "down" }), { reconnect: "plain", pause: "pause", start: false, link: false, unlink: true });
  assert.deepEqual(local({ state: "replaced", paused: true }), { reconnect: "plain", pause: "resume", start: false, link: false, unlink: true });
  assert.deepEqual(local({ state: "blocked", paused: true }).reconnect, "blocked");
  assert.equal(local({ state: "connecting", retryAt: at(14, 21) }).reconnect, "plain");
  assert.equal(local({ state: "connecting" }).reconnect, false, "already connecting");
  for (const state of ["open", "logged-out", "unpaired", "linking"] as const) assert.equal(local({ state }).reconnect, false, state);
  assert.deepEqual(via({ state: "down" }), { reconnect: "plain", pause: null, start: false, link: false, unlink: false });
  assert.equal(via({ state: "blocked" }).reconnect, false, "never from another host");
  assert.equal(local({ state: "unreachable" }, { name: "sova-whatsapp.service", active: "inactive" }).start, true);
  assert.equal(local({ state: "unreachable" }, { name: "sova-whatsapp.service", active: "failed" }).start, true);
  assert.equal(local({ state: "unreachable" }, { name: "sova-whatsapp.service", active: "activating" }).start, false);
  assert.deepEqual(local({ state: "unreachable" }), { reconnect: false, pause: null, start: false, link: false, unlink: false });
});

test("Link a Phone and Unlink This Number: only on the sender's own host; link while unpaired, unlink while a device is linked, logged out included", () => {
  const file = (sender: OutreachInfo["file"]["sender"]) => ({ version: 1 as const, sender, acceptFrom: [] as string[], paused: false });
  const at = (sender: OutreachInfo["file"]["sender"], state: SenderStatus["state"]) => senderActions({ file: file(sender), sender: { state } });
  const states = ["off", "unreachable", "unpaired", "linking", "connecting", "open", "logged-out", "replaced", "blocked", "down"] as const;
  const links = states.filter((s) => at({ local: {} }, s).link);
  const unlinks = states.filter((s) => at({ local: {} }, s).unlink);
  assert.deepEqual(links, ["unpaired"]);
  assert.deepEqual(unlinks, ["connecting", "open", "logged-out", "replaced", "blocked", "down"]);
  for (const s of states) {
    for (const r of [{ via: { nodeId: "n" } }, "off"] as const) {
      const a = at(r, s);
      assert.equal(a.link || a.unlink, false, `${JSON.stringify(r)} ${s}: never from another host`);
    }
  }
});

test("not paired and logged out say what to do here, and point a host sending through a peer at the sender's host", () => {
  assert.equal(senderWords({ state: "unpaired" }, now, true).text, "Link a phone to send from: Link a Phone below, or sova-whatsapp pair on this host.");
  assert.equal(senderWords({ state: "unpaired" }, now, false).text, "Link a phone on the sender's host.");
  assert.equal(senderWords({ state: "logged-out" }, now, true).text, "The phone unlinked this device. Unlink this number, then link a phone again.");
  assert.equal(senderWords({ state: "logged-out" }, now, false).text, "Link it again on the sender's host.");
  assert.equal(senderWords({ state: "linking" }, now, true).chip, "Linking");
});

test("the list: each entry's use against its limits, and the setting each one stands for", () => {
  assert.equal(senderUse({ state: "open", usage: { hour: 1, day: 4 }, limits: { gapS: 3, perHour: 20, perDay: 60 } }), "4 of 60 sent in 24 h, 1 of 20 this hour");
  assert.equal(senderUse({ state: "unreachable" }), null);
  const local = { id: "local", where: "local" as const, label: "This host", status: { state: "open" as const }, chosen: true };
  const gate = { id: "peer:nGATE", where: "peer" as const, nodeId: "nGATE", label: "Gateway", status: { state: "open" as const }, chosen: false };
  const viaGate = outreachDraftOf({ version: 1, sender: { via: { nodeId: "nGATE" } }, acceptFrom: [], paused: false });
  assert.equal(entryPicked(gate, viaGate), true);
  assert.equal(entryPicked(local, viaGate), false);
  assert.deepEqual(entryChoice(gate), { sender: "via", viaNodeId: "nGATE" });
  assert.deepEqual(entryChoice(local), { sender: "local", viaNodeId: "" });
});
