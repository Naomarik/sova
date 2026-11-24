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
import { importChatUsage } from "./usage-export";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const T = Date.parse("2026-11-20T10:00:00.000Z");

function device(id: string) {
  const root = mkdtempSync(join(tmpdir(), "usage-export-"));
  dirs.push(root);
  const agent = join(root, "agent");
  mkdirSync(join(agent, "sova"), { recursive: true });
  writeFileSync(join(agent, "sova", "host.json"), JSON.stringify({ id }));
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
  const service = () => {
    const s = createService({ usageRoot, stateDir: join(agent, "sova", "usage-ledger"), pricesPath: join(agent, "sova", "model-prices.json"), labelsDir: join(agent, "sova", "message-labels"), device: () => id, now: () => T + 3_600_000, log: () => {}, prices: { enabled: false } });
    s.ledger.scanAll();
    s.ledger.indexAll();
    return s;
  };
  return { agent, labels: join(agent, "sova", "message-labels"), call, tool, service };
}

test("cut on A, brought in on B: the chat shows it as spent on A, B's own totals don't move, twice counts once", async () => {
  const a = device("h_aaaaaaaa");
  a.call("lead", "k1");
  a.call("w1", "k2", { parent: "lead", worker: "ag_01", kind: "worker" });
  a.call("other", "k3");
  a.tool("lead", "t1");
  mkdirSync(a.labels, { recursive: true });
  writeFileSync(join(a.labels, "lead.jsonl"), '{"m":1}\n');
  const cut = (await a.service().answer({ op: "chat-cut", sid: "lead", members: [] })) as { calls: string[]; tools: string[]; sids: string[]; labels: Record<string, string>; devices: string[] };
  assert.equal(cut.calls.length, 2, "the chat and its helper, not another chat");
  assert.ok(cut.sids.includes("w1"));
  assert.equal(cut.tools.length, 1);
  assert.deepEqual(cut.devices, ["h_aaaaaaaa"]);

  const b = device("h_bbbbbbbb");
  b.call("mine", "kb");
  const before = (await b.service().answer({ op: "today", tz: "UTC" })) as { calls: number };
  const got = importChatUsage(JSON.stringify(cut), b.agent, b.labels);
  assert.deepEqual({ calls: got.calls, tools: got.tools, labels: got.labels }, { calls: 2, tools: 1, labels: 1 });
  importChatUsage(JSON.stringify(cut), b.agent, b.labels);
  const s = b.service();
  assert.equal(((await s.answer({ op: "today", tz: "UTC" })) as { calls: number }).calls, before.calls, "B's own totals are as they were");
  const u = (await s.answer({ op: "chat", sid: "lead", members: [], waiting: 0 })) as ChatUsage;
  const lead = u.rows.find((r) => r.sid === "lead")!;
  assert.equal(lead.spend.calls, 0, "nothing spent here");
  assert.equal(lead.elsewhere?.spend.calls, 1, "once, though brought in twice");
  assert.deepEqual(lead.elsewhere?.devices, ["h_aaaaaaaa"]);
  assert.equal(lead.elsewhere?.agent, 60);
  assert.equal(u.rows.find((r) => r.sid === "w1")?.elsewhere?.spend.calls, 1, "its helper's row, found through the moved records");
  assert.equal(u.total.elsewhere?.spend.calls, 2);
  assert.equal(u.total.spend.calls, 2);

  // Back on A: what A wrote itself is in its own stores already.
  const back = importChatUsage(JSON.stringify((await s.answer({ op: "chat-cut", sid: "lead", members: [] })) as object), a.agent, a.labels);
  assert.equal(back.calls, 0);
  assert.equal(back.own, 3);
});
