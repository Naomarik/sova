// Run: pnpm test -- server/ws-open-retry.test.ts. A chat socket whose chat fails to start
// (§chat.transcript/instant-open, "Nothing typed or sent is lost"): the server tries the start once
// more, still holding what the socket sent, before it refuses anything. A throwaway
// PI_CODING_AGENT_DIR; the chat router is a stand-in whose acquire fails as told.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ChatClient, ChatHandle } from "./chat-handle";

const agentDir = mkdtempSync(join(tmpdir(), "sova-ws-open-retry-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-open-retry--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const ws = await import("./ws");
const { setChatRouter, BusyError } = await import("./chat-handle");
const { getDraft } = await import("./drafts");

const retry = (ws as { openRetry?: { ms: number } }).openRetry;
if (retry) retry.ms = 0;

after(() => {
  setChatRouter(null);
  rmSync(agentDir, { recursive: true, force: true });
});

let seq = 0;
let path = "";
let id = "";
beforeEach(() => {
  id = `open-retry-${++seq}`;
  path = join(sessionsDir, `2026-10-17T00-00-00-000Z_${id}.jsonl`);
});

/** A chat that records what it was handed. */
function fakeChat(got: unknown[]): ChatHandle {
  return {
    attach: (_c: ChatClient) => {},
    detach: (_c: ChatClient) => {},
    clientMessage: (_c: ChatClient, msg: unknown) => void got.push(msg),
  } as unknown as ChatHandle;
}

/** A router whose acquire answers each call from `plan`: an error to throw, or the chat. */
function routeTo(plan: (Error | ChatHandle)[]): { calls: () => number } {
  let calls = 0;
  setChatRouter({
    ready: async () => {},
    get: () => undefined,
    all: () => [],
    acquire: async () => {
      const next = plan[Math.min(calls++, plan.length - 1)]!;
      if (next instanceof Error) throw next;
      return next;
    },
    close: async () => false,
  });
  return { calls: () => calls };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const PROMPT = { type: "prompt", text: "hello there", clientId: "c1" } as const;

test("a start that fails once, then works: the held message goes to the chat, nothing comes back as a draft", async () => {
  const got: unknown[] = [];
  const r = routeTo([new Error("This chat's process didn't start: no hello in time"), fakeChat(got)]);
  ws.deliverFrames(path, [PROMPT]);
  await until(() => got.length > 0 || getDraft(id) !== null);
  assert.equal(r.calls(), 2, "the start was tried again");
  assert.deepEqual(got, [PROMPT]);
  assert.equal(getDraft(id), null, "nothing put back");
});

test("a start that fails on the retry too: the message comes back (here, with no tab, as the draft)", async () => {
  const r = routeTo([new Error("first start failed"), new Error("second start failed")]);
  ws.deliverFrames(path, [PROMPT]);
  await until(() => getDraft(id) !== null);
  assert.equal(r.calls(), 2, "exactly one retry");
  assert.equal(getDraft(id)?.text, "hello there");
});

test("a refusal that no retry can change (busy) is not retried", async () => {
  const r = routeTo([new BusyError("Session is open in a TUI")]);
  ws.deliverFrames(path, [PROMPT]);
  await until(() => getDraft(id) !== null);
  assert.equal(r.calls(), 1);
});
