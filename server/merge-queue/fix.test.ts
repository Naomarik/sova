import assert from "node:assert/strict";
import { test } from "node:test";
import type { BranchFailure } from "../../shared/merge-queue";
import { FIX_ENDING, FIX_NEW_CHAT_HOLD, FIX_NO_CHAT, fixOfferOf, fixText } from "./fix";

const failure = (whose: BranchFailure["whose"]): BranchFailure => ({
  kind: "dry-run",
  run: "mr_1",
  commit: "a".repeat(40),
  whose,
  line: "Unit fails at aaaaaaa: 1 failing test (t.test.ts). This branch's change breaks it.",
  checks: [{ id: "unit", label: "Unit", step: "rerun-tip:unit", whose: whose === "machine" ? "unclear" : whose, tests: [{ file: "t.test.ts", message: "expected 1\ngot 2" }] }],
});

test("Fix's message carries the whole failure and ends by asking the chat to explain, propose and wait", () => {
  const text = fixText({ failure: failure("branch"), branch: "setup/x", target: "master", runPage: "#/projects/p/merge-queue/mr_1", run: null, logs: [{ label: "Unit", path: "/runs/mr_1/logs/u.log", tail: ["FAIL t.test.ts"] }], holdsUp: ["feat/y"] });
  assert.match(text, /^A dry run of setup\/x at aaaaaaa failed Unit\./);
  assert.match(text, /- t\.test\.ts: expected 1 got 2/);
  assert.match(text, /Logs: #\/projects\/p\/merge-queue\/mr_1 · merge\.logs \{run: "mr_1"\}/);
  assert.match(text, /\/runs\/mr_1\/logs\/u\.log\n```\nFAIL t\.test\.ts\n```/);
  assert.match(text, /Whose: This branch's change breaks it\./);
  assert.match(text, /It holds up: feat\/y/);
  assert.ok(text.endsWith(FIX_ENDING), "the ask to wait is last");
  const fresh = fixText({ failure: failure("master"), branch: "setup/x", target: "master", runPage: "p", run: null, logs: [], holdsUp: [], newChat: true });
  assert.match(fresh, /Whose: Fails on master too: not this branch's\./);
  assert.ok(fresh.endsWith(`${FIX_ENDING}\n${FIX_NEW_CHAT_HOLD}`), "a new chat also holds off its worktree note's commit and merge");
});

test("Fix is offered only on an idle chat Sova may write to; Fix in New Chat on a shared failure works from the target", () => {
  const chat = { id: "s1", path: "/p", title: "Setup chat", working: false, live: false };
  assert.deepEqual(fixOfferOf(chat, false, null), { chat: { ok: true, session: "s1" }, newChat: { ok: true, on: "this-branch" } });
  assert.deepEqual(fixOfferOf({ ...chat, working: true }, false, null).chat, { ok: false, why: "Setup chat is working: wait for its turn to end, then press Fix." });
  const live = fixOfferOf({ ...chat, live: true }, false, null);
  assert.deepEqual(live.chat, { ok: false, why: "Setup chat is open in a terminal: Fix can't send to it from here." });
  assert.equal(live.newChat.ok, false, "on this branch, refused like Fix while its chat there is live");
  assert.deepEqual(fixOfferOf(null, true, "master"), { chat: { ok: false, why: FIX_NO_CHAT }, newChat: { ok: true, on: "new-branch" } });
  assert.equal(fixOfferOf({ ...chat, working: true }, true, "master").newChat.ok, true, "a new branch from the target needs nothing of the busy chat");
});
