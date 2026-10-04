// A project's cost at API prices (§app/project-costs) from the usage ledger: the server names the
// project's sessions, the usage helper (in-process here) counts their records and their workers' at
// any depth, prices them with a fixed price file and keeps costs.json.
// A throwaway PI_CODING_AGENT_DIR and workspace in the OS temp dir, deleted after.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { formatUsageRecord, type UsageRecord } from "../pi-config/extensions/llm-inflight/usage-record";
import type { PriceTable } from "../shared/model-prices/prices";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-costs-")));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.SOVA_PRICES_FETCH = "off";
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const { seedBuild, seedConflicts } = await import("./org-test-fixtures");
const store = await import("./project-overseer-store");
const costs = await import("./project-costs");
const ledger = await import("./project-costs-ledger");
const { settled } = await import("./workspace-git");
const { setUsageAsker } = await import("./usage-helper/client");
const { createService } = await import("./usage-helper/service");

after(async () => {
  setUsageAsker(null);
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(tmp, { recursive: true, force: true });
});

const T0 = Date.parse("2026-09-20T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

// ---- prices: $ per 1M tokens; over 3M request input every rate doubles ----------------------------------

const base = { input: 1, output: 10, cacheRead: 0.1, cacheWrite5m: 1.25 };
const doubled = { input: 2, output: 20, cacheRead: 0.2, cacheWrite5m: 2.5 };
const tier = [{ inputAbove: 3_000_000, rates: doubled }];
const one = (rates: object, tiers?: object) => ({ periods: [{ from: null, until: null, rates, ...(tiers ? { tiers } : {}) }] });
const PERIOD = iso(T0 + 200_000);
const table: PriceTable = {
  version: 1,
  source: "models.dev",
  fetchedAt: "2026-09-28T00:00:00.000Z",
  changedAt: "2026-09-28T00:00:00.000Z",
  models: {
    "zai/glm-5.3": one(base, tier) as PriceTable["models"][string],
    "anthropic/claude-opus-5-5": { name: "Claude Opus 5.5", ...(one({ ...base, cacheWrite1h: 2 }, [{ inputAbove: 3_000_000, rates: { ...doubled, cacheWrite1h: 4 } }]) as PriceTable["models"][string]) },
    "anthropic/claude-haiku-4-5": one(base) as PriceTable["models"][string],
    // Its price doubles at a refresh inside a day.
    "deepseek/deepseek-flash": {
      periods: [
        { from: null, until: PERIOD, rates: base },
        { from: PERIOD, until: null, rates: doubled },
      ],
    },
  },
};
mkdirSync(join(tmp, "agent", "sova"), { recursive: true });
writeFileSync(join(tmp, "agent", "sova", "model-prices.json"), JSON.stringify(table));

let clock = Date.parse("2026-09-28T12:00:00Z");
const svc = createService({
  usageRoot: join(tmp, "agent", "usage", "v1"),
  stateDir: join(tmp, "agent", "sova", "usage-ledger"),
  pricesPath: join(tmp, "agent", "sova", "model-prices.json"),
  device: () => "h_testhost",
  now: () => clock,
  log: () => {},
  prices: { enabled: false },
});
setUsageAsker(async (op, params) => {
  svc.ledger.scanAll();
  try {
    return { status: 200, body: Buffer.from(JSON.stringify(await svc.answer({ ...params, op }))) };
  } catch (err) {
    return { status: 400, body: Buffer.from(JSON.stringify({ error: String(err) })) };
  }
});

// ---- ledger records -------------------------------------------------------------------------------------

let seq = 0;
function call(r: Partial<UsageRecord> & { owner: string | null; ts: number }, producer = "p1"): void {
  const rec: UsageRecord = { v: 1, key: `k${++seq}`, device: null, producer, src: "pi", provider: "zai", model: "glm-5.3", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, parent: null, kind: "main", ...r };
  const dir = join(tmp, "agent", "usage", "v1", iso(rec.ts).slice(0, 10));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${producer}.jsonl`), formatUsageRecord(rec)!);
}

const approx = (a: number, b: number, what = "") => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} ≠ ${b}`);

describe("a project's cost (§app/project-costs)", async () => {
  const org = await orgs.createOrg({ name: "Costs", dir: join(tmp, "ws") });
  const client = join(tmp, "client");
  mkdirSync(client);
  const otherRoot = join(tmp, "client-other");
  mkdirSync(otherRoot);
  const project = await orgs.addProject(org.id, { name: "Portal", root: client });
  const other = await orgs.addProject(org.id, { name: "Other", root: otherRoot });
  const maria = await orgs.addPerson(org.id, { name: "Maria", role: "Payroll" });
  const ws = orgs.orgDir(org.id);
  const lp = ledger.ledgerPaths(project.id);
  const lines = (xs: unknown[]) => xs.map((x) => `${JSON.stringify(x)}\n`).join("");

  // The overseer's conversation (its marker), and another project's.
  mkdirSync(join(ws, "sessions"), { recursive: true });
  const poFile = join(ws, "sessions", `2026-09-20T10-00-00-000Z_0199aaaa-0000-7000-8000-000000000001.jsonl`);
  writeFileSync(poFile, lines([{ type: "session", version: 3, id: "x", timestamp: iso(T0), cwd: "/w" }, { type: "custom", id: "m", customType: "sova-project-overseer", data: { v: 1, projectId: project.id }, timestamp: iso(T0) }]));
  const otherPo = join(ws, "sessions", `2026-09-20T10-00-00-000Z_0199aaaa-0000-7000-8000-000000000002.jsonl`);
  writeFileSync(otherPo, lines([{ type: "session", version: 3, id: "y", timestamp: iso(T0), cwd: "/w" }, { type: "custom", id: "m", customType: "sova-project-overseer", data: { v: 1, projectId: other.id }, timestamp: iso(T0) }]));
  const po = store.sessionIdOfFile(poFile);
  call({ owner: po, kind: "overseer", ts: T0 + 1000, input: 1_000_000, output: 100_000 });
  call({ owner: po, kind: "overseer", purpose: "cache-warm", ts: T0 + 2000, cacheWrite: 1_000_000 });
  call({ owner: store.sessionIdOfFile(otherPo), kind: "overseer", ts: T0 + 1000, input: 2_500_000 });

  // The operator's gathering session with a wrap-up turn; the overseer's settle session on a local model.
  const g = await baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Payroll", goal: "g" });
  const gid = store.sessionIdOfFile(g.path);
  call({ owner: gid, ts: T0 + 10_000, input: 2_000_000 });
  call({ owner: gid, purpose: "wrapup", ts: T0 + 21_000, output: 100_000 });
  const sessions = await seedConflicts(org.id, project.id, [{ id: "cf_1", orgId: org.id, projectId: project.id, areaKey: "pay", a: "d1", b: "d2", p: 0.9, routedTo: maria.id, routeReason: "Maria decides pay.", batonSessionId: "0199bbbb-0000-7000-8000-000000000009", state: "open", createdAt: iso(T0) }], { owner: { overseerOf: project.id } });
  call({ owner: sessions.cf_1!, ts: T0 + 30_000, provider: "ollama", model: "llama", input: 5_000_000 });

  // Coding sessions: the overseer's with a pi worker (and its own worker), a team member and a
  // Claude Code worker whose message also came through a second process; the operator's with an
  // unpriced model, a call over the tier and calls either side of a new price period.
  const codeA = join(tmp, "agent", "sessions", "code-a.jsonl");
  const codeB = join(tmp, "agent", "sessions", "code-b.jsonl");
  writeFileSync(codeA, "{}\n");
  writeFileSync(codeB, "{}\n");
  call({ owner: "code-a", ts: T0 + 91_000, provider: "claude-code-cli", model: "opus[1m]", responseModel: "claude-opus-5-5", cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 });
  call({ owner: "w1", parent: "code-a", worker: "ag_01", kind: "worker", ts: T0 + 61_000, output: 200_000 });
  call({ owner: "w2", parent: "w1", worker: "ag_01", kind: "worker", ts: T0 + 62_000, output: 100_000 });
  call({ owner: "member-1", parent: "code-a", worker: "ag_03", kind: "worker", ts: T0 + 70_000, cacheRead: 1_000_000 });
  const CC = "0b7a2b8e-6d0e-4a4e-9f55-3f0b6b1e2a11";
  const cc = { owner: CC, parent: "code-a", worker: "ag_02", kind: "worker" as const, src: "claude" as const, provider: "claude", model: "claude-opus-5-5", ts: T0 + 80_000, input: 2_500_000, cacheWrite: 1_000_000, cacheWrite1h: 400_000 };
  call({ ...cc, key: "cc:m1" });
  call({ ...cc, key: "cc:m1" }, "p2");
  call({ owner: CC, parent: "code-a", worker: "ag_02", kind: "worker", src: "claude-residual", provider: "claude", model: "claude-haiku-4-5", ts: T0 + 81_000, output: 100_000 });
  call({ owner: "code-b", ts: T0 + 100_000, provider: "nopr", model: "spark", input: 123 });
  call({ owner: "code-b", ts: T0 + 101_000, input: 400_000 });
  call({ owner: "code-b", ts: T0 + 102_000, input: 3_500_000 });
  call({ owner: "code-b", ts: T0 + 103_000, provider: "deepseek", model: "deepseek-flash", input: 1_000_000 });
  call({ owner: "code-b", ts: T0 + 300_000, provider: "deepseek", model: "deepseek-flash", input: 1_000_000 });
  await seedBuild(org.id, project.id, { sessionId: "code-a", kind: "coding", path: codeA, title: "Build A", createdAt: T0 });
  await seedBuild(org.id, project.id, { sessionId: "code-b", kind: "operator-coding", path: codeB, title: "Build B", createdAt: T0 });
  await seedBuild(org.id, project.id, { sessionId: "code-far", kind: "coding", path: "/elsewhere/far.jsonl", title: "Far", createdAt: T0 });

  // The reconciler's calls name the project; another project's don't count here.
  call({ owner: null, kind: "oneshot", purpose: "reconcile", project: project.id, starter: "operator", ts: T0, input: 1_000_000 });
  call({ owner: null, kind: "oneshot", purpose: "reconcile", project: project.id, ts: T0, provider: "jev", model: "jev-1", input: 50, output: 5 });
  call({ owner: null, kind: "oneshot", purpose: "reconcile", project: other.id, ts: T0, input: 9_000_000 });

  const PO = 1 + 1 + 1.25;
  const GATHER = 2;
  const WRAPUP = 1;
  const PI_WORKERS = 2 + 1;
  const MEMBER = 0.1;
  const CC_WORKER = 2 * (2.5 + 0.6 * 1.25 + 0.4 * 2) + 1;
  const CODE_A = 2;
  const CODE_B = 0.4 + 3.5 * 2 + 1 + 2;
  const RECONCILE = 1;

  test("every source, priced per call: kinds, starters, models, unpriced, workers at any depth", async () => {
    const c = await costs.projectCost(project.id);
    const kind = (k: string) => c.byKind.find((r) => r.kind === k)?.usd ?? 0;
    approx(kind("overseer"), PO, "overseer, its cache warm included");
    approx(kind("gathering"), GATHER, "gathering");
    approx(kind("wrapup"), WRAPUP, "wrap-up apart from its baton");
    assert.ok(c.byKind.some((r) => r.kind === "settle" && r.usd === 0 && r.tokens.input === 5_000_000), "a local model's tokens count at $0");
    approx(kind("coding"), CODE_A + CODE_B, "both coding kinds as one card row; a call over the tier priced wholly at its rates; one each side of a new period");
    assert.deepEqual(c.byKind.map((r) => r.kind), ["overseer", "gathering", "settle", "wrapup", "coding", "workers", "reconcile"], "the scope's order");
    approx(kind("workers"), PI_WORKERS + MEMBER + CC_WORKER, "workers at any depth, a message seen twice counted once");
    approx(kind("reconcile"), RECONCILE, "reconciler");
    approx(c.totalUsd, PO + GATHER + WRAPUP + CODE_A + CODE_B + PI_WORKERS + MEMBER + CC_WORKER + RECONCILE, "total");

    const by = (b: string) => c.byStarter.find((r) => r.by === b)?.usd ?? 0;
    approx(by("overseer"), PO + CODE_A + PI_WORKERS + MEMBER + CC_WORKER, "the overseer's conversation, its coding session and its workers");
    approx(by("operator"), GATHER + WRAPUP + CODE_B + RECONCILE, "the operator's baton, wrap-up, coding session and Reconcile Now");
    assert.ok(c.byStarter.some((r) => r.by === "sova" && r.usd === 0 && r.tokens.input === 50), "an automatic run is Sova's own");
    approx(c.allModels.usd, c.totalUsd, "the All models footer");
    assert.equal(c.allModels.tokens.input, c.byModel.reduce((n, m) => n + m.tokens.input, 0));

    const unpriced = Object.fromEntries(c.unpriced.map((u) => [u.model, u]));
    assert.equal(unpriced["nopr/spark"]?.tokens, 123);
    assert.equal(unpriced["jev/jev-1"]?.tokens, 55);
    assert.equal(c.byModel.find((m) => m.status === "free")?.why, "local");
    const opus = c.byModel.find((m) => m.model === "anthropic/claude-opus-5-5");
    assert.equal(opus?.name, "Claude Opus 5.5");
    assert.ok(opus && opus.usdBy.cacheWrite1h > 0);
    assert.deepEqual([c.top[0]?.sessionId, c.top[1]?.sessionId], ["code-b", CC], "most expensive first");
    assert.deepEqual([c.top[1]?.kind, c.top[1]?.title], ["workers", "ag_02"]);
    assert.equal(c.top.find((t) => t.sessionId === "code-b")?.path, codeB);
    assert.equal(c.prices.fetchedAt, "2026-09-28T00:00:00.000Z");
    assert.equal(c.notOnHost, null);
  });

  test("this host's counts are kept in costs.json; another host's rows are shown as last counted", async () => {
    const snap = ledger.readCostLedger(lp);
    assert.ok(snap.sources["code-a"] && snap.sources[`w:${CC}`] && snap.sources["w:w2"] && snap.sources["reconcile:h_testhost:operator"] && snap.sources["reconcile:h_testhost:sova"], Object.keys(snap.sources).join(", "));
    assert.ok(!readFileSync(lp.costs, "utf8").includes(tmp), "no host path in the repo's ledger");
    const before = await costs.projectCost(project.id);
    // Another host counted code-far (its file is there) and an old-style worker key of a worker counted here.
    const far = { sessionId: "code-far", title: "Far", kind: "coding-overseer" as const, by: "overseer" as const, countedAt: "2026-09-27T00:00:00.000Z", buckets: [{ kind: "coding-overseer" as const, provider: "zai", model: "glm-5.3", at: iso(T0), n: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }] };
    const dup = { ...far, sessionId: "w1", kind: "workers" as const, buckets: [{ ...far.buckets[0]!, kind: "workers" as const }] };
    ledger.writeCostLedger(lp, { version: 1, sources: { ...ledger.readCostLedger(lp).sources, "code-far": far, "w:pi:w1": dup } });
    clock += 120_000;
    const c = await costs.projectCost(project.id);
    approx(c.totalUsd, before.totalUsd + 1, "the other host's row adds; the old key of a worker counted here doesn't");
    assert.deepEqual(c.notOnHost, { sessions: 1, countedAt: "2026-09-27T00:00:00.000Z" });
    assert.equal(c.top.find((t) => t.sessionId === "code-far")?.countedAt, "2026-09-27T00:00:00.000Z");
  });

  test("the org roll-up: each project's total and the org's", async () => {
    const r = await orgs.orgCosts(org.id);
    const mine = r.projects.find((p) => p.projectId === project.id)!;
    const theirs = r.projects.find((p) => p.projectId === other.id)!;
    approx(theirs.totalUsd, 2.5 + 9 * 2, "the other overseer's conversation and reconciler are its own project's");
    approx(r.totalUsd, mine.totalUsd + theirs.totalUsd);
    assert.ok(mine.unpricedTokens >= 123 + 55);
  });

  test("an unknown project is a 404", async () => {
    await assert.rejects(() => costs.projectScope("prj_nope0000"), (e: any) => e.status === 404);
  });
});
