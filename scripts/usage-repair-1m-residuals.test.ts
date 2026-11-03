// The one-off repair of the 4–7 Oct doubled `[1m]` residuals: a dry run changes nothing, a write
// backs the days up first, rewrites plain and sealed files without those lines only, and drops the
// days' snapshots; the process check finds a server on this agent dir and no other.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { test } from "node:test";
import { formatUsageRecord, type UsageRecord } from "../pi-config/extensions/llm-inflight/usage-record";
import { EMPTY_TABLE, mergeFetched, normalizeModelsDev, type Aliases } from "../shared/model-prices/prices";
import { ALIASES_FILE } from "../server/usage-helper/price-book";
import { scratchRoot } from "../server/test-scratch";
import { applyRepair, formatPlan, planRepair, runningOn } from "./usage-repair-1m-residuals";

const aliases = JSON.parse(fs.readFileSync(ALIASES_FILE, "utf8")) as Aliases;
// Opus 5.5: in 4, out 20, read 0.2, write 5 ($/M).
const table = mergeFetched(
  EMPTY_TABLE,
  normalizeModelsDev({ anthropic: { models: { "claude-opus-5-5": { cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } } } }, openai: { models: {} }, zai: { models: { "glm-5.3": { cost: { input: 1, output: 4 } } } }, deepseek: { models: {} }, "ollama-cloud": { models: {} } }, aliases),
  "2026-09-01T00:00:00.000Z",
).table;
const prices = { table, aliases };

const rec = (over: Partial<UsageRecord> & { key: string }): string =>
  formatUsageRecord({ v: 1, ts: Date.parse("2026-10-05T10:00:00.000Z"), device: null, producer: "p1", src: "claude", provider: "claude-code-cli", model: "claude-opus-5-5", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, owner: "s1", parent: null, kind: "main", ...over })!;

function fixture() {
  const agent = path.join(scratchRoot("usage-repair-"), "agent");
  const v1 = path.join(agent, "usage", "v1");
  const days = path.join(agent, "sova", "usage-ledger", "days");
  fs.mkdirSync(path.join(v1, "2026-10-05"), { recursive: true });
  fs.mkdirSync(path.join(v1, "2026-10-08"), { recursive: true });
  fs.mkdirSync(days, { recursive: true });
  const sealed = [
    rec({ key: "cc:m1", output: 1_000_000 }),
    rec({ key: "ccr:s:1:claude-opus-5-5[1m]", src: "claude-residual", model: "claude-opus-5-5[1m]", output: 1_000_000, cacheRead: 5_000_000 }),
    rec({ key: "ccr:s:2:claude-opus-5-5", src: "claude-residual", output: 10 }),
  ].join("");
  fs.writeFileSync(path.join(v1, "2026-10-05", "p1.jsonl.gz"), zlib.gzipSync(Buffer.from(sealed)));
  const plain = [rec({ key: "pi:z", provider: "zai", model: "glm-5.3", input: 1_000_000 }), rec({ key: "ccr:t:9:claude-opus-5-5[1m]", src: "claude-residual", model: "claude-opus-5-5[1m]", input: 500_000 })].join("");
  // An unterminated tail (a write in progress when the day closed) stays as it is.
  fs.writeFileSync(path.join(v1, "2026-10-05", "p2.jsonl"), `${plain}{"v":1,"key":"torn`);
  // Another day keeps its doubled-looking line: only 4–7 Oct are repaired.
  const later = rec({ key: "ccr:u:1:claude-opus-5-5[1m]", src: "claude-residual", ts: Date.parse("2026-10-08T10:00:00.000Z"), output: 7 });
  fs.writeFileSync(path.join(v1, "2026-10-08", "p1.jsonl"), later);
  fs.writeFileSync(path.join(days, "2026-10-05.snap"), "snapshot");
  fs.writeFileSync(path.join(days, "2026-10-08.snap"), "other snapshot");
  return { agent, v1, days, sealed, plain, later };
}

const lines = (text: string) => text.split("\n").filter(Boolean);

test("a dry run counts what goes and the drop, and changes nothing", () => {
  const f = fixture();
  const before = fs.readFileSync(path.join(f.v1, "2026-10-05", "p1.jsonl.gz"));
  const plan = planRepair(f.agent, prices);
  assert.deepEqual(plan.days, ["2026-10-05"]);
  assert.equal(plan.records, 2);
  assert.equal(plan.lines, 2);
  // $20 of output and $1 of cache read, then $2 of input.
  assert.ok(Math.abs(plan.dropUsd - 23) < 1e-9, String(plan.dropUsd));
  const opus = (list: typeof plan.before) => list.find((t) => t.model === "claude-code-cli/claude-opus-5-5")!;
  assert.equal(opus(plan.before).calls, 4);
  assert.equal(opus(plan.after).calls, 2);
  assert.deepEqual(plan.after.find((t) => t.model === "zai/glm-5.3"), plan.before.find((t) => t.model === "zai/glm-5.3"), "nothing else moves");
  assert.deepEqual(plan.snapshots.map((s) => path.basename(s)), ["2026-10-05.snap"]);
  assert.match(formatPlan(plan), /Expected drop: \$23\.00/);
  assert.ok(before.equals(fs.readFileSync(path.join(f.v1, "2026-10-05", "p1.jsonl.gz"))));
  assert.ok(fs.existsSync(path.join(f.days, "2026-10-05.snap")));
  assert.deepEqual(fs.readdirSync(path.join(f.agent, "usage")), ["v1"], "no backup on a dry run");
});

test("a write backs up first, removes only the doubled lines, and drops only those days' snapshots", () => {
  const f = fixture();
  const plan = planRepair(f.agent, prices);
  const backup = applyRepair(plan, new Date("2026-10-29T09:30:00.000Z"));
  assert.equal(backup, path.join(f.agent, "usage", "v1-backup-20261029-093000"));
  // The backup is the files as they were, and the snapshot.
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(backup, "2026-10-05", "p1.jsonl.gz"))).toString(), f.sealed);
  assert.equal(fs.readFileSync(path.join(backup, "2026-10-05", "p2.jsonl"), "utf8"), `${f.plain}{"v":1,"key":"torn`);
  assert.equal(fs.readFileSync(path.join(backup, "usage-ledger-days", "2026-10-05.snap"), "utf8"), "snapshot");
  // The sealed file is gzipped again, without its [1m] residual; the plain one keeps its torn tail.
  const sealed = lines(zlib.gunzipSync(fs.readFileSync(path.join(f.v1, "2026-10-05", "p1.jsonl.gz"))).toString());
  assert.deepEqual(sealed.map((l) => JSON.parse(l).key), ["cc:m1", "ccr:s:2:claude-opus-5-5"]);
  const plain = fs.readFileSync(path.join(f.v1, "2026-10-05", "p2.jsonl"), "utf8");
  assert.equal(plain, `${rec({ key: "pi:z", provider: "zai", model: "glm-5.3", input: 1_000_000 })}{"v":1,"key":"torn`);
  // Only the repaired days' snapshots go; another day is untouched.
  assert.ok(!fs.existsSync(path.join(f.days, "2026-10-05.snap")));
  assert.equal(fs.readFileSync(path.join(f.days, "2026-10-08.snap"), "utf8"), "other snapshot");
  assert.equal(fs.readFileSync(path.join(f.v1, "2026-10-08", "p1.jsonl"), "utf8"), f.later);
  assert.deepEqual(fs.readdirSync(path.join(f.v1, "2026-10-05")).sort(), ["p1.jsonl.gz", "p2.jsonl"], "no temporary file left");
  // A second run finds nothing more.
  assert.equal(planRepair(f.agent, prices).records, 0);
  // The same second twice: never over an existing backup.
  assert.throws(() => applyRepair(plan, new Date("2026-10-29T09:30:00.000Z")), /already exists/);
});

test("a write refuses a day with a half-done helper write, and changes nothing", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.v1, "2026-10-05", "p3.jsonl.sealing"), "");
  const plan = planRepair(f.agent, prices);
  assert.throws(() => applyRepair(plan), /half-done write/);
  assert.deepEqual(fs.readdirSync(path.join(f.agent, "usage")), ["v1"]);
});

test("the process check finds a server or usage helper on this agent dir, and no other", () => {
  const f = fixture();
  const proc = path.join(scratchRoot("usage-repair-proc-"), "proc");
  const add = (pid: number, cmd: string[], env: Record<string, string> | null) => {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(proc, String(pid), "cmdline"), `${cmd.join("\0")}\0`);
    if (env) fs.writeFileSync(path.join(proc, String(pid), "environ"), `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\0")}\0`);
  };
  fs.mkdirSync(path.join(proc, "self"), { recursive: true });
  add(1, ["/usr/lib/systemd/systemd"], {});
  for (let i = 2; i < 30; i++) add(i, ["/usr/bin/sleep", "1"], {});
  add(100, ["bun", "server/index.ts"], { PI_CODING_AGENT_DIR: "/somewhere/else", HOME: "/home/x" });
  assert.deepEqual(runningOn(f.agent, proc), [], "another agent dir's server");
  add(101, ["/opt/bun", "/srv/sova/server/usage-helper/main.ts"], { PI_CODING_AGENT_DIR: f.agent });
  assert.deepEqual(runningOn(f.agent, proc)?.map((p) => p.pid), [101]);
  add(102, ["bun", "server/index.ts"], null);
  assert.deepEqual(runningOn(f.agent, proc)?.map((p) => p.pid).sort(), [101, 102], "an environment it can't read counts");
  // A sandbox's own pid namespace: it can't tell.
  add(1, ["/usr/bin/bwrap", "--ro-bind", "/", "/"], {});
  assert.equal(runningOn(f.agent, proc), null);
});
