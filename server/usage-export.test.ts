// Run: pnpm test -- server/usage-export.test.ts
// A chat's usage across a Transport (§app.transport/package, §app.extensions/chat-usage): cut on the source from its
// own stores (the chat and its helper, nothing else), brought in on the destination apart from its own stores, so the
// chat shows it marked as spent on the source while the destination's own totals don't move; a second import counts
// once, and a chat that comes back brings in nothing its own device already has.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { formatUsageRecord, type UsageRecord } from "../pi-config/extensions/llm-inflight/usage-record";
import { formatToolRunRecord } from "./tool-run-record";
import { createService } from "./usage-helper/service";
import type { ChatUsage } from "../shared/usage/wire";
import { importChatUsage, usageOrigin } from "./usage-export";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const T = Date.parse("2026-11-20T10:00:00.000Z");

/** A device; `id` null: no host.json, as on every device that never attached an organization. */
function device(id: string | null) {
  const root = mkdtempSync(join(tmpdir(), "usage-export-"));
  dirs.push(root);
  const agent = join(root, "agent");
  mkdirSync(join(agent, "sova"), { recursive: true });
  if (id) writeFileSync(join(agent, "sova", "host.json"), JSON.stringify({ id }));
  const usageRoot = join(agent, "usage", "v1");
  const call = (owner: string, key: string, over: Partial<UsageRecord> = {}) => {
    const r: UsageRecord = { v: 1, key, ts: T, device: id, producer: "p1", src: "pi", provider: "zai", model: "glm-5.3", input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, owner, parent: null, kind: "main", ...over };
    mkdirSync(join(usageRoot, "2026-11-20"), { recursive: true });
    appendFileSync(join(usageRoot, "2026-11-20", "p1.jsonl"), formatUsageRecord(r)!);
  };
  const tool = (sid: string, key: string) => {
    mkdirSync(join(agent, "usage", "tools", "v1", "2026-11-20"), { recursive: true });
    appendFileSync(join(agent, "usage", "tools", "v1", "2026-11-20", "p1.jsonl"), formatToolRunRecord({ v: 1, key, sid, start: T, end: T + 60_000, kind: "tool", producer: "p1", device: id })!);
  };
  const origin = () => usageOrigin(agent);
  const service = () => {
    const s = createService({ usageRoot, stateDir: join(agent, "sova", "usage-ledger"), pricesPath: join(agent, "sova", "model-prices.json"), labelsDir: join(agent, "sova", "message-labels"), device: () => id, now: () => T + 3_600_000, log: () => {}, prices: { enabled: false } });
    s.ledger.scanAll();
    s.ledger.indexAll();
    return s;
  };
  return { agent, labels: join(agent, "sova", "message-labels"), call, tool, service, origin };
}

test("cut on A, brought in on B: the chat shows it as spent on A by its name, B's own totals don't move, twice counts once; neither has a host.json", async () => {
  const a = device(null);
  a.call("lead", "k1");
  a.call("w1", "k2", { parent: "lead", worker: "ag_01", kind: "worker" });
  a.call("other", "k3");
  a.tool("lead", "t1");
  mkdirSync(a.labels, { recursive: true });
  writeFileSync(join(a.labels, "lead.jsonl"), '{"m":1}\n');
  const sa = a.service();
  // A helper's call written after the ledger last read: found by the parent it names.
  a.call("w2", "k4", { parent: "lead", worker: "ag_02", kind: "worker" });
  const late = (await sa.answer({ op: "chat-cut", sid: "lead", members: [], origin: a.origin() })) as { calls: Record<string, string[]>; sids: string[] };
  assert.ok(late.sids.includes("w2") && Object.values(late.calls).flat().some((l) => l.includes('"k4"')), "a helper no index knows yet");
  const cut = (await sa.answer({ op: "chat-cut", sid: "lead", members: [], origin: a.origin() })) as { origin: string; calls: Record<string, string[]>; tools: Record<string, string[]>; sids: string[] };
  assert.match(cut.origin, /^u_[0-9a-f]{8}$/, "a device with no host.json still has an origin of its own");
  assert.equal(a.origin(), cut.origin, "and keeps it");
  assert.equal(cut.calls[cut.origin]!.length, 3, "the chat and its helpers, not another chat");
  assert.ok(cut.sids.includes("w1"));
  assert.equal(cut.tools[cut.origin]!.length, 1);

  const b = device(null);
  b.call("mine", "kb");
  const before = (await b.service().answer({ op: "today", tz: "UTC" })) as { calls: number };
  const opts = { agentDir: b.agent, labelsDir: b.labels, from: "laptop" };
  const got = importChatUsage(JSON.stringify(cut), opts);
  assert.deepEqual({ calls: got.calls, tools: got.tools, labels: got.labels }, { calls: 3, tools: 1, labels: 1 });
  importChatUsage(JSON.stringify(cut), opts);
  const s = b.service();
  assert.equal(((await s.answer({ op: "today", tz: "UTC" })) as { calls: number }).calls, before.calls, "B's own totals are as they were");
  const u = (await s.answer({ op: "chat", sid: "lead", members: [], waiting: 0 })) as ChatUsage;
  const lead = u.rows.find((r) => r.sid === "lead")!;
  assert.equal(lead.spend.calls, 0, "nothing spent here");
  assert.equal(lead.elsewhere?.spend.calls, 1, "once, though brought in twice");
  assert.deepEqual(lead.elsewhere?.devices, ["laptop"], "named as B calls A");
  assert.deepEqual(u.total.elsewhere?.devices, ["laptop"]);
  assert.equal(lead.elsewhere?.agent, 60);
  assert.equal(u.rows.find((r) => r.sid === "w1")?.elsewhere?.spend.calls, 1, "its helper's row, found through the moved records");
  assert.equal(u.total.elsewhere?.spend.calls, 3);
  assert.equal(u.total.spend.calls, 3);

  // Back on A: what A spent itself is in its own stores already; only B's own spend comes in.
  b.call("lead", "kb2");
  const back = importChatUsage(JSON.stringify((await b.service().answer({ op: "chat-cut", sid: "lead", members: [], origin: b.origin() })) as object), { agentDir: a.agent, labelsDir: a.labels, from: "desktop" });
  assert.equal(back.own, 4, "A's three calls and its tool run");
  assert.equal(back.calls, 1, "B's call");
  const ua = (await a.service().answer({ op: "chat", sid: "lead", members: [], waiting: 0 })) as ChatUsage;
  const la = ua.rows.find((r) => r.sid === "lead")!;
  assert.equal(la.spend.calls, 1, "A's own, once");
  assert.equal(la.elsewhere?.spend.calls, 1, "B's, marked");
  assert.deepEqual(la.elsewhere?.devices, ["desktop"]);
});
