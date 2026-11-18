// GET /api/usage/time end to end: the app's route relays the real helper child's answer, built from the
// files the server and the chats write (Time Spent's attention files, reply timings, tool runs). A
// deleted session's hours survive the helper losing its snapshots and starting again. A throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi untouched.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { UsageTime } from "../../shared/usage/time";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-usage-time-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.SOVA_PRICES_FETCH = "off";
mkdirSync(join(agentDir, "sova"), { recursive: true });

const { TimeSpentStore, keepSessionTimeSpent } = await import("../time-spent");
const { startSharedUsageHelper, stopSharedUsageHelper } = await import("./client");
const { buildApp } = await import("../app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });

after(async () => {
  await stopSharedUsageHelper();
  rmSync(agentDir, { recursive: true, force: true });
});

// A hang guard, never a measure: a loaded host slows the helper, never fails it.
const until = async <T>(fn: () => Promise<T | null>, ms = 60_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail("timed out");
};

const get = async (q = "range=7d&tz=UTC") => {
  const res = await app.request(`/api/usage/time?${q}`);
  return { status: res.status, body: (await res.json()) as UsageTime & { error?: string } };
};

test("GET /api/usage/time: your time, agent time and tool time from the real helper; a deleted session's hours survive a restart without snapshots", async () => {
  const now = Date.now();
  const clock = new TimeSpentStore(join(agentDir, "sova", "attention"));
  clock.report("alive", { pageId: "p", inputAgeMs: 0, slices: [{ row: "typing", sec: 120, ageMs: 0, docs: [] }] }, now - 600_000);
  clock.report("doomed", { pageId: "q", inputAgeMs: 0, slices: [{ row: "reading-transcript", sec: 60, ageMs: 0, docs: [] }] }, now - 300_000);
  const day = new Date(now).toISOString().slice(0, 10);
  mkdirSync(join(agentDir, "usage", "perf", "v1", day), { recursive: true });
  appendFileSync(
    join(agentDir, "usage", "perf", "v1", day, "p1.jsonl"),
    `${JSON.stringify({ v: 1, key: "alive:e1", ts: now - 60_000, device: null, producer: "p1", sid: "alive", entryId: "e1", kind: "main", provider: "zai", model: "glm-5.3", stop: "stop", sentAt: now - 100_000, ttftMs: 1000, thinkingMs: 0, replyMs: 39_000, thinking: { ms: 0, n: 0 }, text: { ms: 39_000, n: 1 }, tool: { ms: 0, n: 0 }, endMs: 40_000, output: 100 })}\n`,
  );
  mkdirSync(join(agentDir, "usage", "tools", "v1", day), { recursive: true });
  appendFileSync(join(agentDir, "usage", "tools", "v1", day, "p1.jsonl"), `${JSON.stringify({ v: 1, key: "alive:c1", sid: "alive", start: now - 60_000, end: now - 30_000, kind: "tool", producer: "p1", device: null, sk: "main" })}\n`);

  assert.equal((await get()).status, 503, "no helper: usage-unavailable, as Costs");
  startSharedUsageHelper({ log: () => {} });
  const t = await until(async () => {
    const r = await get();
    return r.status === 200 ? r.body : null;
  });
  assert.equal(t.totals.you, 180);
  assert.equal(t.totals.agents, 70, "a 40 s reply and a 30 s tool run");
  assert.equal(t.agents.what.tools, 30);
  assert.deepEqual(t.sessions.map((s) => s.sid), ["alive", "doomed"]);
  assert.equal((await get("range=1y&tz=UTC")).status, 400);

  // The session is deleted; the helper notices (its sweep, or the next ask), then loses its snapshots and starts again.
  clock.remove("doomed");
  const afterDelete = await until(async () => {
    const r = await get();
    return r.status === 200 && r.body.sessions.length === 1 ? r.body : null;
  });
  assert.equal(afterDelete.totals.you, 180);
  await stopSharedUsageHelper();
  rmSync(join(agentDir, "sova", "usage-ledger"), { recursive: true, force: true });
  startSharedUsageHelper({ log: () => {} });
  const restarted = await until(async () => {
    const r = await get();
    return r.status === 200 ? r.body : null;
  });
  assert.equal(restarted.totals.you, 180, "the day's You figure is unchanged");
  assert.equal(restarted.days.at(-1)!.you, t.days.at(-1)!.you);

  // A delete while the helper is about to go down: the server asked it to keep the hours first.
  clock.report("late", { pageId: "r", inputAgeMs: 0, slices: [{ row: "typing", sec: 45, ageMs: 0, docs: [] }] }, Date.now());
  await keepSessionTimeSpent("late");
  await stopSharedUsageHelper();
  clock.remove("late");
  startSharedUsageHelper({ log: () => {} });
  const kept = await until(async () => {
    const r = await get();
    return r.status === 200 ? r.body : null;
  });
  assert.equal(kept.totals.you, 225, "the late session's 45 s were kept before its file went");
  assert.equal(kept.sessions.length, 1);
  await stopSharedUsageHelper();
  const t0 = Date.now();
  await keepSessionTimeSpent("whatever");
  assert.ok(Date.now() - t0 < 1_000, "no helper: the delete isn't held");
});
