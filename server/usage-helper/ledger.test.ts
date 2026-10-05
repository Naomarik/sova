// The usage helper's rollup: exactly-once across restarts (review b3), rows never spanning a price
// change and the history repriced from the records (review b1), closing and compressing days.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { formatUsageRecord, type UsageRecord } from "../../pi-config/extensions/llm-inflight/usage-record";
import { mergeFetched, normalizeModelsDev, priceUsage, EMPTY_TABLE, type Aliases, type PriceTable } from "../../shared/model-prices/prices";
import { ALIASES_FILE } from "./price-book";
import { usageOf } from "./records";
import { createService, type Service } from "./service";

const aliases = JSON.parse(readFileSync(ALIASES_FILE, "utf8")) as Aliases;
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const BOUNDARY = "2026-10-04T09:42:00.000Z";
const at = (hhmm: string, day = "2026-10-04") => Date.parse(`${day}T${hhmm}:00.000Z`);

/** Opus at $4/M input until the boundary, $3/M from it; a 272k context tier on gpt-6-astra. */
function table(boundary = BOUNDARY): PriceTable {
  const api = (opus: number) => ({
    anthropic: { models: { "claude-opus-5-5": { name: "Claude Opus 5.5", cost: { input: opus, output: 20, cache_read: 0.2, cache_write: 5 } } } },
    openai: {
      models: {
        "gpt-6-astra": { cost: { input: 10, output: 50, cache_read: 1, tiers: [{ input: 20, output: 75, cache_read: 2, tier: { type: "context", size: 272000 } }] } },
      },
    },
    zai: { models: { "glm-5.3": { cost: { input: 1, output: 4 } } } },
    deepseek: { models: {} },
    "ollama-cloud": { models: {} },
  });
  const t0 = mergeFetched(EMPTY_TABLE, normalizeModelsDev(api(4), aliases), "2026-09-01T00:00:00.000Z").table;
  return mergeFetched(t0, normalizeModelsDev(api(3), aliases), boundary).table;
}

interface World {
  root: string;
  usageRoot: string;
  stateDir: string;
  pricesPath: string;
  clock: { now: number };
  start(): Service;
  write(rec: Partial<UsageRecord> & { key: string; ts: number }, producer?: string, raw?: string): void;
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "usage-ledger-"));
  dirs.push(root);
  const usageRoot = join(root, "agent", "usage", "v1");
  const stateDir = join(root, "agent", "sova", "usage-ledger");
  const pricesPath = join(root, "agent", "sova", "model-prices.json");
  mkdirSync(join(root, "agent", "sova"), { recursive: true });
  writeFileSync(pricesPath, JSON.stringify(table()));
  const clock = { now: at("12:00") };
  return {
    root,
    usageRoot,
    stateDir,
    pricesPath,
    clock,
    start: () => {
      const s = createService({ usageRoot, stateDir, pricesPath, now: () => clock.now, log: () => {}, prices: { enabled: false } });
      s.ledger.scanAll();
      s.ledger.indexAll();
      return s;
    },
    write(rec, producer = "p1", raw) {
      const full: UsageRecord = {
        v: 1,
        device: null,
        producer,
        src: "pi",
        provider: "anthropic",
        model: "claude-opus-5-5",
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        owner: "s1",
        parent: null,
        kind: "main",
        ...rec,
      };
      const day = new Date(full.ts).toISOString().slice(0, 10);
      mkdirSync(join(usageRoot, day), { recursive: true });
      appendFileSync(join(usageRoot, day, `${producer}.jsonl`), raw ?? formatUsageRecord(full)!);
    },
  };
}

const perCall = (t: PriceTable, recs: { ts: number; input: number; output?: number; model?: string; provider?: string }[]) =>
  recs.reduce((sum, r) => {
    const p = priceUsage(t, aliases, { provider: r.provider ?? "anthropic", model: r.model ?? "claude-opus-5-5" }, { input: r.input, output: r.output ?? 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, r.ts);
    return sum + (p.status === "priced" ? p.usd.total : 0);
  }, 0);

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("b1: calls at 09:41 and 09:43 around a 09:42 price change: the rollup equals the per-call prices, also after the boundary moves", async () => {
  const w = world();
  const calls = [
    { key: "pi:s1:a", ts: at("09:41"), input: 1_000_000 },
    { key: "pi:s1:b", ts: at("09:43"), input: 1_000_000 },
  ];
  for (const c of calls) w.write(c);
  const s = w.start();
  // One 15-minute bucket, two rows: one per period.
  const rows = [...s.ledger.rowsOf("2026-10-04").rows];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.pf).sort(), [BOUNDARY, null].sort());
  const sess = s.queries.session({ sid: "s1" });
  close(sess.total.usd, perCall(table(), calls));
  close(sess.total.usd, 7);
  const costs = s.queries.costs({ range: "7d", providers: [], models: [], tz: "UTC" });
  close(costs.total.usd, 7);
  // A hand edit moves the boundary to 09:44: both calls are now in the first period.
  const moved = table("2026-10-04T09:44:00.000Z");
  writeFileSync(w.pricesPath, JSON.stringify(moved));
  assert.equal(s.prices.reload(), true);
  close(s.queries.session({ sid: "s1" }).total.usd, perCall(moved, calls));
  close(s.queries.session({ sid: "s1" }).total.usd, 8);
  assert.equal([...s.ledger.rowsOf("2026-10-04").rows].length, 1);
  close(s.queries.costs({ range: "7d", providers: [], models: [], tz: "UTC" }).total.usd, 8);
  // And back to 09:40: both in the second.
  const back = table("2026-10-04T09:40:00.000Z");
  writeFileSync(w.pricesPath, JSON.stringify(back));
  s.prices.reload();
  close(s.queries.session({ sid: "s1" }).total.usd, perCall(back, calls));
  close(s.queries.session({ sid: "s1" }).total.usd, 6);
  // The refolded day survives a restart as it is.
  s.ledger.flush();
  close(w.start().queries.session({ sid: "s1" }).total.usd, 6);
});

test("tiers: a row keeps its calls' band (a sum of small calls never reads as one long request)", () => {
  const w = world();
  const calls = [
    { key: "k1", ts: at("10:01"), input: 200_000, provider: "openai", model: "gpt-6-astra" },
    { key: "k2", ts: at("10:02"), input: 200_000, provider: "openai", model: "gpt-6-astra" },
    { key: "k3", ts: at("10:03"), input: 300_000, provider: "openai", model: "gpt-6-astra" },
  ];
  for (const c of calls) w.write(c);
  const s = w.start();
  close(s.queries.session({ sid: "s1" }).total.usd, perCall(table(), calls));
  close(s.queries.session({ sid: "s1" }).total.usd, 0.2 * 10 + 0.2 * 10 + 0.3 * 20);
});

test("b3: stop the helper, create yesterday's unknown producer file, restart today: counted exactly once", () => {
  const w = world();
  w.clock.now = at("12:00", "2026-10-05");
  w.write({ key: "today-1", ts: at("11:00", "2026-10-05") });
  const s1 = w.start();
  s1.ledger.flush();
  assert.equal(s1.queries.session({ sid: "s1" }).total.calls, 1);
  // Helper stopped. A producer we never saw wrote yesterday's file.
  w.write({ key: "yday-1", ts: at("23:59", "2026-10-04"), input: 2_000_000 }, "late-producer");
  const s2 = w.start();
  const t = s2.queries.session({ sid: "s1" }).total;
  assert.equal(t.calls, 2);
  assert.equal(t.tokens.input, 3_000_000);
  s2.ledger.scanAll();
  s2.ledger.flush();
  assert.equal(s2.queries.session({ sid: "s1" }).total.calls, 2, "a second sweep adds nothing");
  const s3 = w.start();
  assert.equal(s3.queries.session({ sid: "s1" }).total.calls, 2, "nor does a restart");
});

test("exactly once: appends after the last save are read on restart; a duplicate key from another producer adds nothing; a partial line waits", () => {
  const w = world();
  w.write({ key: "a", ts: at("10:00") });
  const s1 = w.start();
  s1.ledger.flush();
  w.write({ key: "b", ts: at("10:05") });
  // Not saved: s1 read b but crashed before its next save.
  s1.ledger.scanAll();
  w.write({ key: "b", ts: at("10:05") }, "p2");
  w.write({ key: "c", ts: at("10:06") }, "p1", `${formatUsageRecord({ v: 1, key: "c", ts: at("10:06"), device: null, producer: "p1", src: "pi", provider: "anthropic", model: "claude-opus-5-5", input: 5, output: 0, cacheRead: 0, cacheWrite: 0, owner: "s1", parent: null, kind: "main" })!.slice(0, 20)}`);
  const s2 = w.start();
  assert.equal(s2.queries.session({ sid: "s1" }).total.calls, 2);
  assert.equal(s2.ledger.stats.duplicates, 1);
  // The rest of c's line arrives.
  const line = formatUsageRecord({ v: 1, key: "c", ts: at("10:06"), device: null, producer: "p1", src: "pi", provider: "anthropic", model: "claude-opus-5-5", input: 5, output: 0, cacheRead: 0, cacheWrite: 0, owner: "s1", parent: null, kind: "main" })!;
  appendFileSync(join(w.usageRoot, "2026-10-04", "p1.jsonl"), line.slice(20));
  s2.ledger.scanAll();
  assert.equal(s2.queries.session({ sid: "s1" }).total.calls, 3);
});

test("close: a day ended 2h ago is gzipped and keeps its rows; a file turning up later reopens it, counted once", () => {
  const w = world();
  w.write({ key: "a", ts: at("10:00") });
  w.write({ key: "b", ts: at("11:00") }, "p2");
  w.clock.now = at("01:00", "2026-10-05");
  const s = w.start();
  assert.deepEqual(s.ledger.closeDays(), []);
  w.clock.now = at("02:01", "2026-10-05");
  assert.deepEqual(s.ledger.closeDays(), ["2026-10-04"]);
  assert.deepEqual(readdirSync(join(w.usageRoot, "2026-10-04")).sort(), ["p1.jsonl.gz", "p2.jsonl.gz"]);
  assert.equal(s.queries.session({ sid: "s1" }).total.calls, 2);
  // A late producer (and a late line from p1, whose file is gone now) after the close.
  w.write({ key: "c", ts: at("12:00") }, "p3");
  w.write({ key: "a", ts: at("10:00") }, "p1");
  s.ledger.scanAll();
  assert.equal(s.queries.session({ sid: "s1" }).total.calls, 3);
  s.ledger.closeDays();
  assert.deepEqual(readdirSync(join(w.usageRoot, "2026-10-04")).sort(), ["p1.jsonl.gz", "p2.jsonl.gz", "p3.jsonl.gz"]);
  s.ledger.flush();
  const again = w.start();
  assert.equal(again.queries.session({ sid: "s1" }).total.calls, 3);
  // A price change folds a closed day again from its gzipped records.
  writeFileSync(w.pricesPath, JSON.stringify(table("2026-10-04T10:30:00.000Z")));
  again.prices.reload();
  assert.equal(again.queries.session({ sid: "s1" }).total.calls, 3);
  assert.ok(!existsSync(join(w.usageRoot, "2026-10-04", "p1.jsonl")));
});

test("queries: kinds, workers at any depth, side calls, projects, local days, filters", () => {
  const w = world();
  w.clock.now = at("12:00", "2026-10-05");
  w.write({ key: "m1", ts: at("23:30", "2026-10-04"), owner: "s1", cwd: "/w/a" });
  w.write({ key: "o1", ts: at("09:00", "2026-10-05"), owner: "s1", kind: "oneshot", purpose: "title", provider: "zai", model: "glm-5.3", cwd: "/w/a" });
  w.write({ key: "w1", ts: at("09:10", "2026-10-05"), owner: "w1", parent: "s1", worker: "ag_01", kind: "worker", cwd: "/w/a" });
  w.write({ key: "w2", ts: at("09:20", "2026-10-05"), owner: "w2", parent: "w1", worker: "ag_01", kind: "worker", project: "prj_x" });
  w.write({ key: "d1", ts: at("09:30", "2026-10-05"), owner: null, kind: "oneshot", purpose: "decide", provider: "jev", model: "jev-1" });
  const s = w.start();
  const sess = s.queries.session({ sid: "s1" });
  assert.equal(sess.own.calls, 1);
  assert.equal(sess.oneshots.calls, 1);
  assert.equal(sess.workers.calls, 2);
  assert.equal(sess.total.calls, 4);
  assert.deepEqual(sess.workerList.map((r) => r.sid).sort(), ["w1", "w2"]);
  assert.equal(s.queries.session({ sid: "w1" }).total.calls, 2);
  const c = s.queries.costs({ range: "7d", providers: [], models: [], tz: "UTC" });
  assert.equal(c.total.calls, 5);
  assert.equal(c.main.calls, 1);
  assert.equal(c.workers.calls, 2);
  assert.equal(c.oneshots.calls, 2);
  assert.equal(c.daily.length, 7);
  assert.equal(c.daily.at(-1)!.day, "2026-10-05");
  assert.ok(c.byModel.find((m) => m.provider === "jev")?.status === "unpriced");
  assert.deepEqual(c.byProject.map((p) => p.project ?? p.cwd).sort(), [null, "/w/a", "prj_x"].sort());
  assert.deepEqual(c.topSessions[0]!.sid.length > 0, true);
  // 23:30Z on the 4th is the 5th in Kolkata (+5:30).
  const k = s.queries.costs({ range: "7d", providers: [], models: [], tz: "Asia/Kolkata" });
  assert.equal(k.daily.find((d) => d.day === "2026-10-04")?.tokens ?? 0, 0);
  assert.equal(s.queries.today({ tz: "Asia/Kolkata" }).calls, 5);
  assert.equal(s.queries.today({ tz: "UTC" }).calls, 4);
  const f = s.queries.costs({ range: "7d", providers: ["zai"], models: [], tz: "UTC" });
  assert.equal(f.total.calls, 1);
  assert.deepEqual(f.facets.providers, ["anthropic", "jev", "zai"]);
  const fm = s.queries.costs({ range: "all", providers: [], models: ["anthropic/claude-opus-5-5"], tz: "UTC" });
  assert.equal(fm.total.calls, 3);
  const many = s.queries.sessions({ sids: ["s1", "w1", "nobody"] });
  assert.equal(many.sessions.s1!.total.calls, 4);
  assert.equal(many.sessions.s1!.workers.calls, 2);
  assert.equal(many.sessions.nobody, undefined);
  void usageOf;
});
