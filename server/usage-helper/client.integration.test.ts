// The real child: started by the client, answers relayed as bytes, restarted after a crash, and a
// file written while it was down counted once (review b3, end to end).
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { formatUsageRecord, type UsageRecord } from "../../pi-config/extensions/llm-inflight/usage-record";
import type { UsageSessionSpend, UsageToday } from "../../shared/usage/wire";
import { startUsageHelper } from "./client";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const rec = (key: string, ts: number, producer = "p1"): UsageRecord => ({
  v: 1,
  key,
  ts,
  device: null,
  producer,
  src: "pi",
  provider: "zai",
  model: "glm-5.3",
  input: 1000,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  owner: "s1",
  parent: null,
  kind: "main",
});

function write(agent: string, r: UsageRecord) {
  const day = new Date(r.ts).toISOString().slice(0, 10);
  const dir = join(agent, "usage", "v1", day);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${r.producer}.jsonl`), formatUsageRecord(r)!);
}

// A hang guard, never a measure: a loaded host slows the helper (a child, its watch, its restart), never fails it.
const until = async (fn: () => Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("timed out");
};

test("the helper answers over its pipe, follows appends, survives a crash and counts a file made while down once", async () => {
  const root = mkdtempSync(join(tmpdir(), "usage-client-"));
  dirs.push(root);
  const agent = join(root, "agent");
  const now = Date.now();
  write(agent, rec("a", now - 1000));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, SOVA_PRICES_FETCH: "off" };
  const h = startUsageHelper({ env, log: () => {} });
  try {
    const calls = async () => {
      const a = await h.request("session", { sid: "s1" });
      return a.status === 200 ? (JSON.parse(a.body.toString()) as UsageSessionSpend).total.calls : -1;
    };
    await until(async () => (await calls()) === 1);
    // Followed live.
    write(agent, rec("b", now));
    await until(async () => (await calls()) === 2);
    const today = await h.request("today", { tz: "UTC" });
    assert.equal(today.status, 200);
    assert.equal((JSON.parse(today.body.toString()) as UsageToday).calls >= 1, true);
    assert.equal((await h.request("costs", { range: "bogus" })).status, 400);
    // Crash: a new producer's file for yesterday appears while it is down.
    const pid = h.pid()!;
    process.kill(pid, "SIGKILL");
    await until(async () => h.pid() !== null && h.pid() !== pid);
    write(agent, rec("c", now - 86_400_000, "late"));
    await until(async () => (await calls()) === 3);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await calls(), 3);
  } finally {
    await h.stop();
  }
  assert.equal(h.running(), false);
});
