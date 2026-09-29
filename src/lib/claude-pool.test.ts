import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudePoolInfo, ClaudePoolLogin } from "../../shared/protocol";
import { deviceLoginChip, holderChip, movingText, poolActions, usageText } from "./claude-pool";

const login = (over: Partial<ClaudePoolLogin> = {}): ClaudePoolLogin => ({
  id: "l-000000a1",
  identity: { email: "one@example.com", accountUuid: "acct-one" },
  addedAt: 1,
  enabled: true,
  holder: { device: "desk", label: "Desk", free: false, stuck: false, since: 1 },
  pin: null,
  standing: { state: "ready" },
  ...over,
});

test("the holder chip: this device, another device, free, stuck — each a different word", () => {
  const words = [
    holderChip(login(), "desk").text,
    holderChip(login(), "phone").text,
    holderChip(login({ holder: { device: "desk", label: "Desk", free: true, stuck: false, since: 1 } }), "phone").text,
    holderChip(login({ holder: { device: "desk", label: "Desk", free: false, stuck: true, since: 1 } }), "phone").text,
  ];
  assert.deepEqual(words, ["This device", "Desk", "Free", "Stuck on Desk"]);
  assert.equal(new Set(words).size, 4);
});

test("actions: Return only for a held login not already leaving; Sign In Again for stuck or signed-out", () => {
  assert.deepEqual(poolActions(login()), { returnable: true, signIn: false });
  assert.deepEqual(poolActions(login({ holder: { device: "desk", label: "Desk", free: true, stuck: false, since: 1 } })), { returnable: false, signIn: false });
  assert.deepEqual(poolActions(login({ holder: { device: "desk", label: "Desk", free: false, stuck: true, since: 1 } })), { returnable: false, signIn: true });
  assert.deepEqual(poolActions(login({ returnAsked: true })), { returnable: false, signIn: false });
  assert.deepEqual(poolActions(login({ standing: { state: "auth" } })), { returnable: true, signIn: true });
});

test("moving and usage words", () => {
  assert.equal(movingText(login()), undefined);
  assert.equal(movingText(login({ returnAsked: true })), "Returning after the current turn");
  assert.match(movingText(login({ moving: { op: "leave", state: "draining", reason: "limit" } }))!, /hit its limit/);
  assert.match(movingText(login({ moving: { op: "leave", state: "sending", reason: "idle" } }))!, /keeper/);
  assert.equal(usageText(login({ usage: { fiveHour: 41.6, sevenDay: 18, at: 1 } })), "5h 42% · weekly 18%");
  assert.equal(usageText(login()), undefined);
});

test("the Mesh page chip names what a device holds, or says it holds none", () => {
  const pool: ClaudePoolInfo = {
    self: "desk",
    keeper: { id: "desk", label: "Desk", up: true },
    devices: [
      { id: "desk", label: "Desk", self: true, up: true, logins: ["l-000000a1"] },
      { id: "phone", label: "Phone", self: false, up: true, logins: [] },
    ],
    logins: [login()],
  };
  assert.equal(deviceLoginChip(pool, "desk").text, "Claude: one@example.com");
  assert.equal(deviceLoginChip(pool, "phone").text, "No Claude login");
});
