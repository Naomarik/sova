// The Time Spent tab's counting in the usage helper: your time re-read from the attention files as
// the server rewrites them, kept for deleted sessions across a snapshot loss, agent time from replies
// and tool runs with worker waits apart, While You Were Away, Your Messages, and the `time` op.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { formatUsageRecord, type UsageRecord } from "../../pi-config/extensions/llm-inflight/usage-record";
import type { TimeSpentRow } from "../../shared/time-spent";
import type { UsageTime } from "../../shared/usage/time";
import { TimeSpentStore } from "../time-spent";
import { AttentionStore } from "./attention";
import { parseLabels } from "./labels";
import { BadRequest, createService } from "./service";
import { Spans } from "./time";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const H = 3_600_000;

function world(now = NOW) {
  const root = mkdtempSync(join(tmpdir(), "usage-time-"));
  dirs.push(root);
  const agent = join(root, "agent");
  const state = join(agent, "sova");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "model-prices.json"), "{}");
  const clock = { now };
  const usageRoot = join(agent, "usage", "v1");
  const start = () => {
    const s = createService({ usageRoot, stateDir: join(state, "usage-ledger"), pricesPath: join(state, "model-prices.json"), now: () => clock.now, log: () => {}, prices: { enabled: false } });
    s.ledger.scanAll();
    s.ledger.indexAll();
    return s;
  };
  const clockStore = () => new TimeSpentStore(join(state, "attention"));
  let n = 0;
  const reply = (o: { sid: string; sentAt: number; endMs: number; thinkingMs?: number; replyMs?: number; kind?: string; model?: string }) => {
    const ts = o.sentAt + o.endMs;
    const day = new Date(ts).toISOString().slice(0, 10);
    mkdirSync(join(agent, "usage", "perf", "v1", day), { recursive: true });
    const thinkingMs = o.thinkingMs ?? 0;
    const replyMs = o.replyMs ?? 0;
    appendFileSync(
      join(agent, "usage", "perf", "v1", day, "p1.jsonl"),
      `${JSON.stringify({
        v: 1, key: `${o.sid}:e${++n}`, ts, device: null, producer: "p1", sid: o.sid, entryId: `e${n}`, ...(o.kind ? { kind: o.kind } : {}), provider: "zai", model: o.model ?? "glm-5.3", stop: "stop",
        sentAt: o.sentAt, ttftMs: 100, thinkingMs, replyMs, thinking: { ms: thinkingMs, n: thinkingMs ? 1 : 0 }, text: { ms: replyMs, n: 1 }, tool: { ms: 0, n: 0 }, endMs: o.endMs, output: 10,
      })}\n`,
    );
  };
  const tool = (o: { sid: string; start: number; end: number; kind?: "tool" | "worker-wait"; sk?: string }) => {
    const day = new Date(o.end).toISOString().slice(0, 10);
    mkdirSync(join(agent, "usage", "tools", "v1", day), { recursive: true });
    appendFileSync(join(agent, "usage", "tools", "v1", day, "p1.jsonl"), `${JSON.stringify({ v: 1, key: `${o.sid}:c${++n}`, sid: o.sid, start: o.start, end: o.end, kind: o.kind ?? "tool", producer: "p1", device: null, ...(o.sk ? { sk: o.sk } : {}) })}\n`);
  };
  const call = (rec: Partial<UsageRecord> & { owner: string; ts: number }) => {
    const full: UsageRecord = { v: 1, key: `pi:${rec.owner}:${++n}`, device: null, producer: "p1", src: "pi", provider: "zai", model: "glm-5.3", input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, parent: null, kind: "main", ...rec } as UsageRecord;
    const day = new Date(full.ts).toISOString().slice(0, 10);
    mkdirSync(join(usageRoot, day), { recursive: true });
    appendFileSync(join(usageRoot, day, "p1.jsonl"), formatUsageRecord(full)!);
  };
  const label = (sid: string, line: object) => {
    mkdirSync(join(state, "message-labels"), { recursive: true });
    appendFileSync(join(state, "message-labels", `${sid}.jsonl`), `${JSON.stringify(line)}\n`);
  };
  return { root, agent, state, clock, start, clockStore, reply, tool, call, label };
}

const ask = async (s: ReturnType<ReturnType<typeof world>["start"]>, q: Record<string, unknown> = {}) => (await s.answer({ op: "time", range: "7d", tz: "UTC", ...q })) as UsageTime;
const slice = (row: TimeSpentRow, sec: number, ageMs = 0, id?: number) => ({ row, sec, ageMs, docs: [], ...(id !== undefined ? { id } : {}) });

test("your time: the helper re-reads a file the server grows in place and cuts, and its total is the server's sum", async () => {
  const w = world();
  const clock = w.clockStore();
  const s = w.start();
  // A run, then the same page continuing it: the server grows the last line in place.
  clock.report("one", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 20)] }, NOW - 60_000);
  assert.equal((await ask(s)).totals.you, clock.sums("one").you);
  clock.report("one", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 20)] }, NOW - 40_000);
  let t = await ask(s);
  assert.equal(clock.sums("one").you, 40, "one line grown to 40 s");
  assert.equal(t.totals.you, 40, "the grown line is read again");
  // Another page with newer input takes some of those seconds back from session one.
  clock.report("two", { pageId: "q", inputAgeMs: 0, slices: [slice("reading-transcript", 10, 25_000)] }, NOW - 30_000);
  assert.equal(clock.sums("one").you, 35, "5 s taken back from session one");
  t = await ask(s);
  const server = clock.sums("one").you + clock.sums("two").you;
  assert.equal(t.totals.you, server, "after a take-back the helper's total is the server's");
  assert.deepEqual(t.you, { typing: 35, "reading-transcript": clock.sums("two").you });
  assert.equal(t.days.at(-1)!.you, server);
  assert.equal(t.days.length, 7, "every day of the range, zero days too");
});

test("a deleted session's hours stay: rollup outside the snapshots, read again after a restart", async () => {
  const w = world();
  const clock = w.clockStore();
  w.call({ owner: "gone", ts: NOW - 2 * H, cwd: "/tmp/elsewhere/proj" });
  let s = w.start();
  clock.report("gone", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 300)] }, NOW - H);
  clock.report("kept", { pageId: "q", inputAgeMs: 0, slices: [slice("scrolling", 60)] }, NOW - 2 * H);
  const before = await ask(s);
  assert.equal(before.totals.you, 360);
  assert.equal(before.sessions.length, 2);
  clock.remove("gone");
  const after1 = await ask(s);
  assert.equal(after1.totals.you, 360, "the vanished session's buckets moved to the rollup");
  assert.deepEqual(after1.sessions.map((x) => x.sid), ["kept"], "its Top Sessions row goes");
  // The helper's snapshots are dropped (a migration), and it starts again.
  rmSync(join(w.state, "usage-ledger"), { recursive: true, force: true });
  s = w.start();
  const restarted = await ask(s);
  assert.equal(restarted.totals.you, 360, "the day's You figure is unchanged");
  assert.equal(restarted.days.at(-1)!.you, 360);
  assert.equal(restarted.you.typing, 300);
});

test("settled buckets are kept while the session lives, once, and never doubled with its runs", () => {
  const w = world();
  const clock = w.clockStore();
  clock.report("a", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 120)] }, NOW - 5 * H);
  const rollupPath = join(w.state, "usage-time", "you-v1.jsonl");
  const now = { t: NOW };
  const att = new AttentionStore({ dir: join(w.state, "attention"), rollupPath, now: () => now.t });
  att.refresh();
  assert.equal([...att.gone()].length, 0);
  now.t = NOW + 3 * H;
  att.refresh();
  att.refresh();
  const again = new AttentionStore({ dir: join(w.state, "attention"), rollupPath, now: () => now.t });
  again.refresh();
  const lines = readFileSync(rollupPath, "utf8").trim().split("\n");
  assert.equal(lines.reduce((t, l) => t + JSON.parse(l).sec, 0), 120, "written once across reads and restarts");
  assert.equal([...again.gone()].length, 0, "a living session counts from its runs, not its rollup");
});

test("agent time: a parent waiting 2 h on a worker replying 2 h is 2 h of agents, the wait apart", async () => {
  const w = world();
  w.call({ owner: "parent", ts: NOW - 4 * H, cwd: "/tmp/x" });
  w.call({ owner: "worker", parent: "parent", kind: "worker", ts: NOW - 4 * H, cwd: "/tmp/x" });
  w.tool({ sid: "parent", start: NOW - 3 * H, end: NOW - H, kind: "worker-wait", sk: "main" });
  w.reply({ sid: "worker", sentAt: NOW - 3 * H, endMs: 2 * H, thinkingMs: H / 2, replyMs: H, kind: "worker" });
  const t = await ask(w.start());
  assert.equal(t.totals.agents, 7200, "2 h, not 4 h");
  assert.equal(t.totals.workerWait, 7200, "the wait on its own line");
  assert.deepEqual(t.agents.who, { worker: 7200, main: 0, overseer: 0 });
  assert.deepEqual(t.agents.what, { thinking: 1800, writing: 3600, tools: 0, waiting: 1800 });
  assert.deepEqual(t.agents.models, [{ provider: "zai", model: "glm-5.3", seconds: 7200, replies: 1 }]);
  assert.equal(t.days.at(-1)!.agents, 7200);
  assert.equal(t.days.at(-1)!.workerWait, 7200);
});

test("a 30 s tool run then a stop is 30 s of Running Tools; no tool records reads as none", async () => {
  const w = world();
  w.reply({ sid: "s", sentAt: NOW - 120_000, endMs: 10_000, replyMs: 10_000 });
  let s = w.start();
  let t = await ask(s);
  assert.equal(t.since.tools, null, "chats on older code: no tool time, no failure");
  assert.equal(t.agents.what.tools, 0);
  w.tool({ sid: "s", start: NOW - 110_000, end: NOW - 80_000 });
  t = await ask(s);
  assert.equal(t.agents.what.tools, 30);
  assert.equal(t.totals.agents, 40);
  assert.equal(t.since.tools, NOW - 110_000);
});

test("While You Were Away: agent seconds outside every moment you were at any session", async () => {
  const w = world();
  const clock = w.clockStore();
  // You: [NOW-100 s, NOW-40 s) on another session.
  clock.report("me", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 60)] }, NOW - 40_000);
  // A reply [NOW-120 s, NOW-20 s): 60 s with you, 40 s away.
  w.reply({ sid: "agent", sentAt: NOW - 120_000, endMs: 100_000, replyMs: 100_000 });
  const t = await ask(w.start());
  assert.equal(t.totals.agents, 100);
  assert.equal(t.totals.away, 40);
  assert.equal(t.totals.ratio, 100 / 60);
  assert.equal(t.totals.daysYou, 1);
});

test("Spans: merged, and the overlap of a window by binary search", () => {
  const sp = new Spans([[50, 60], [0, 10], [5, 20], [100, 200]]);
  assert.equal(sp.overlap(0, 300), 20 + 10 + 100);
  assert.equal(sp.overlap(15, 55), 5 + 5);
  assert.equal(sp.overlap(20, 50), 0);
});

test("Your Messages: totals by label from the label lines, placed by send time, older ones by labelled time", async () => {
  const w = world();
  const clock = w.clockStore();
  clock.report("m", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 30)] }, NOW - 100_000);
  clock.report("m", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 20)] }, NOW - 50_000);
  w.label("m", { id: "a", label: "specifying", confidence: 0.9, provider: "x", model: "y", at: NOW - 60_000, sentAt: NOW - 99_000 });
  w.label("m", { id: "b", label: "steering", confidence: 0.9, provider: "x", model: "y", at: NOW - 49_000 });
  w.label("m", { id: "c", label: "asking", confidence: 0.9, provider: "x", model: "y", at: NOW - 1_000, sentAt: NOW - 2_000 });
  w.label("m", { id: "d", program: true });
  w.label("m", { id: "d", label: "asking", confidence: 1, provider: "x", model: "y", at: NOW - 500 });
  const t = await ask(w.start());
  assert.deepEqual(t.messages.rows, [
    { label: "specifying", count: 1, seconds: 30 },
    { label: "directing", count: 1, seconds: 20 },
    { label: "asking", count: 1, seconds: 0 },
  ]);
  assert.equal(t.messages.byLabelTime, true);
  assert.equal(t.since.labels, NOW - 99_000);
  assert.equal(t.messages.enabled, false, "the switch as the server sent it");
  assert.equal((await ask(w.start(), { labels: true })).messages.enabled, true);
  assert.equal(parseLabels("torn{\n").messages.length, 0);
});

test("Your Messages: a Land press or a button's press closes time as a message does, and a button's message isn't counted", async () => {
  const w = world();
  const clock = w.clockStore();
  clock.report("m", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 60)] }, NOW - 100_000);
  w.label("m", { land: NOW - 130_000 });
  w.label("m", { id: "a", label: "reworking", confidence: 1, provider: "x", model: "y", at: NOW - 90_000, sentAt: NOW - 95_000 });
  w.label("m", { acted: "hash", at: NOW - 80_000 });
  w.label("m", { id: "b", label: "asking", confidence: 1, provider: "x", model: "y", at: NOW - 79_000, sentAt: NOW - 80_000 });
  const t = await ask(w.start());
  assert.deepEqual(t.messages.rows, [{ label: "reworking", count: 1, seconds: 30 }], "30 s after the Land press; the button's message is an action");
});

test("Top Sessions: a worker's time, agent hours and cost are its top-level session's; it has no row", async () => {
  const w = world();
  const clock = w.clockStore();
  w.call({ owner: "top", ts: NOW - 3 * H, cwd: "/tmp/p" });
  w.call({ owner: "w1", parent: "top", kind: "worker", ts: NOW - 3 * H, cwd: "/tmp/p" });
  w.call({ owner: "w2", parent: "w1", kind: "worker", ts: NOW - 3 * H, cwd: "/tmp/p" });
  clock.report("top", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 100)] }, NOW - 2 * H);
  clock.report("w2", { pageId: "p", inputAgeMs: 0, slices: [slice("reading-workers", 50)] }, NOW - H);
  w.reply({ sid: "w2", sentAt: NOW - H, endMs: 60_000, replyMs: 60_000, kind: "worker" });
  w.reply({ sid: "top", sentAt: NOW - H / 2, endMs: 30_000, replyMs: 30_000 });
  const t = await ask(w.start());
  assert.equal(t.sessions.length, 1);
  assert.equal(t.sessions[0]!.sid, "top");
  assert.equal(t.sessions[0]!.you, 150);
  assert.equal(t.sessions[0]!.agents, 90);
  assert.equal(t.agents.who.worker, 60);
});

test("the time op: By project grouped as Costs, the filter, ranges and a bad range", async () => {
  const w = world();
  const clock = w.clockStore();
  w.call({ owner: "a", ts: NOW - 2 * H, cwd: "/srv/proj-a" });
  w.call({ owner: "b", ts: NOW - 2 * H, cwd: "/srv/proj-b" });
  clock.report("a", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 100)] }, NOW - H);
  clock.report("b", { pageId: "q", inputAgeMs: 0, slices: [slice("typing", 50)] }, NOW - H + 200_000);
  w.reply({ sid: "a", sentAt: NOW - H, endMs: 60_000, replyMs: 60_000 });
  const s = w.start();
  const fold = { projects: [{ id: "prj_a", name: "A", root: "/srv/proj-a" }], overseer: [] };
  const t = await ask(s, { fold });
  const a = t.projects.find((p) => p.key === "p:prj_a")!;
  assert.equal(a.name, "A");
  assert.equal(a.you, 100);
  assert.equal(a.agents, 60);
  assert.equal(a.ratio, 0.6);
  assert.ok(a.usd >= 0);
  const only = await ask(s, { fold, project: "p:prj_a" });
  assert.equal(only.totals.you, 100);
  assert.equal(only.projects.length, t.projects.length, "the rows ignore the filter: they are its choices");
  assert.deepEqual(only.sessions.map((x) => x.sid), ["a"]);
  const all = await ask(s, { fold, range: "all" });
  assert.equal(all.from, "2026-11-07");
  assert.equal(all.days.length, 1);
  await assert.rejects(ask(s, { range: "1y" }), BadRequest);
  const empty = await ask(world().start());
  assert.equal(empty.totals.you, 0);
  assert.equal((await ask(world().start(), { range: "all" })).from, null, "nothing recorded: no first day");
});
