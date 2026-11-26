// Run: pnpm test -- server/usage-helper/chat.test.ts
// One chat's usage and time on request (§app.extensions/chat-usage): a row per conversation, agent time with
// overlaps counted once and worker waits left out, your time and waiting on the chat's own row, a total line.
// Fake stores; the waiting figure is read from a transcript branch (server/time-spent-figures.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HEntry } from "../../shared/harness-history";
import type { UsageSpend } from "../../shared/usage/wire";
import { waitingMs } from "../time-spent-figures";
import { chatUsage } from "./chat";
import type { TimeDeps } from "./time";

const spend = (usd: number, calls: number): UsageSpend => ({ usd, tokens: { input: calls * 10, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, usdBy: { input: usd, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, calls, unpricedTokens: 0 });

function deps(): TimeDeps {
  const spends: Record<string, UsageSpend> = { lead: spend(1, 2), w1: spend(0.5, 1) };
  return {
    attention: { refresh() {}, live: () => new Map([["lead", { runs: [{ s: 100, e: 160, r: "reading" }] }]]), *gone() {} },
    perf: { refresh() {}, *records() {
      yield { sid: "lead", sentAt: 0, endMs: 10_000 };
      yield { sid: "lead", sentAt: 5_000, endMs: 10_000 };
      yield { sid: "w1", sentAt: 0, endMs: 4_000 };
      yield { sid: "stranger", sentAt: 0, endMs: 99_000 };
    } },
    tools: { refresh() {}, *records() {
      yield { sid: "lead", start: 20_000, end: 25_000, wait: false };
      yield { sid: "lead", start: 30_000, end: 90_000, wait: true };
    } },
    queries: {
      family: () => new Set(["lead", "w1", "w2"]),
      ownerOf: (sid: string) => (sid === "w2" ? { parent: "w1", worker: "ag_02" } : null),
      ownSpend: (sid: string) => ({ spend: spends[sid] ?? spend(0, 0), models: [] }),
    },
    device: () => "dev1",
    now: () => 1,
  } as unknown as TimeDeps;
}

test("a row per conversation, the chat first; agent time merged, worker waits left out; a total line", () => {
  const u = chatUsage(deps(), { sid: "lead", members: [{ sid: "w1", role: "member", name: "reviewer", parent: "lead" }], waiting: 42.4 });
  assert.deepEqual(u.rows.map((r) => [r.sid, r.role, r.name ?? null, r.agent]), [["lead", "chat", null, 20], ["w1", "member", "reviewer", 4], ["w2", "worker", "ag_02", 0]]);
  assert.equal(u.rows[0]!.you, 60);
  assert.equal(u.rows[0]!.waiting, 42);
  assert.equal(u.rows[1]!.you, undefined, "your time and waiting are the chat's own");
  assert.equal(u.total.spend.usd, 1.5);
  assert.equal(u.total.spend.calls, 3);
  assert.equal(u.total.agent, 24);
  assert.deepEqual(u.device, { id: "dev1", self: true });
});

const at = (s: number) => new Date(s * 1000).toISOString();
const e = (kind: string, s: number, more: object = {}) => ({ kind, at: at(s), blocks: [], ...more }) as unknown as HEntry;

test("waiting: from a turn's end to your next message; a worker's report first starts the agent, so that stretch isn't counted", () => {
  const branch = [
    e("user", 0),
    e("assistant", 5, { stop: "toolUse" }),
    e("tool-result", 8),
    e("assistant", 10, { stop: "stop" }),
    e("user", 70), // waited 60 s
    e("assistant", 80, { stop: "stop" }),
    e("note", 200, { inMessage: true, display: true, content: "report" }), // the agent goes on: no wait for you
    e("assistant", 210, { stop: "stop" }),
    e("note", 215, { inMessage: false, display: false, content: "hidden" }), // a hidden entry changes nothing
    e("user", 230), // waited 20 s
  ];
  assert.equal(waitingMs(branch), 80_000);
});
