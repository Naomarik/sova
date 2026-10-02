// Run: pnpm exec tsx --test server/project-costs.test.ts. A project's cost at API prices
// (§app/project-costs): every source of a fixture org, priced per message by a fake price table.
// A throwaway PI_CODING_AGENT_DIR, workspace and CLAUDE_CONFIG_DIR in the OS temp dir, deleted after.
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ModelRef, PricedUsage, TokenUsage } from "../shared/model-prices/prices";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-costs-")));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
process.env.SOVA_PRICES_FETCH = "off";
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const { seedBuild, seedConflicts } = await import("./org-test-fixtures");
const store = await import("./project-overseer-store");
const costs = await import("./project-costs");
const ledger = await import("./project-costs-ledger");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(tmp, { recursive: true, force: true });
});

// ---- a fake price table: $ per 1M tokens -------------------------------------------------------------

const RATES = { input: 1, output: 10, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 };
/** Over 3M request input: every rate doubled (a context tier). `free/*` is local, `nopr/*` and `jev/*` have no price. */
function fakePrice(ref: ModelRef, u: TokenUsage, _at: number | string): PricedUsage {
  if (ref.provider === "free") return { status: "free", why: "local" };
  if (ref.provider === "nopr" || ref.provider === "jev") return { status: "unpriced", ref: `${ref.provider}/${ref.model}`, why: "No price." };
  // `period/*`: its price doubles at a refresh inside a day (a new period from T0 + 200 s).
  const later = ref.provider === "period" && (typeof _at === "number" ? _at : Date.parse(_at)) >= Date.parse("2026-09-20T10:03:20Z");
  const over = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h > 3_000_000;
  const f = (over ? 2 : 1) * (later ? 2 : 1);
  const usd = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, total: 0 };
  for (const k of ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const) {
    usd[k] = (u[k] * RATES[k] * f) / 1e6;
    usd.total += usd[k];
  }
  return { status: "priced", key: `priced/${ref.responseModel ?? ref.model}`, period: later ? "2026-09-20T10:03:20.000Z" : null, tier: over ? 3_000_000 : null, usd };
}
let clock = Date.parse("2026-09-28T12:00:00Z");
costs.setCostDeps({ name: (k) => (k === "priced/claude-opus-5-5" ? "Claude Opus 5.5" : undefined), price: fakePrice, prices: () => ({ fetchedAt: "2026-09-28T00:00:00.000Z" }), now: () => clock });

// ---- transcript fixtures ----------------------------------------------------------------------------------

const T0 = Date.parse("2026-09-20T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
let seq = 0;
const id = () => `e${(++seq).toString(16).padStart(7, "0")}`;
const usage = (input: number, output = 0, cacheRead = 0, cacheWrite = 0, extra: Record<string, unknown> = {}) => ({ input, output, cacheRead, cacheWrite, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...extra });
const reply = (at: number, provider: string, model: string, u: unknown, extra: Record<string, unknown> = {}) => ({ type: "message", id: id(), timestamp: iso(at), message: { role: "assistant", provider, model, content: [], usage: u, stopReason: "stop", timestamp: at, ...extra } });
const lines = (xs: unknown[]) => xs.map((x) => `${JSON.stringify(x)}\n`).join("");
const header = (at: number, extra: Record<string, unknown> = {}) => ({ type: "session", version: 3, id: id(), timestamp: iso(at), cwd: "/w", ...extra });
const manifest = (workerId: string, ref: Record<string, unknown>, name?: string) => ({
  type: "custom", id: id(), customType: "subagents-worker-manifest", timestamp: iso(T0),
  data: { v: 1, kind: "worker-manifest", workerId, backend: ref.backend, at: T0, ref: { v: 1, ...ref }, ...(name ? { name } : {}) },
});
const ccLine = (msgId: string, at: number, model: string, u: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "assistant", uuid: `${msgId}-${at}`, timestamp: iso(at), isSidechain: false, message: { id: msgId, model, role: "assistant", content: [], usage: u }, ...extra,
});

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
  const pp = store.projectOverseerPaths(project.id);
  const lp = ledger.ledgerPaths(project.id);

  // The overseer's conversation: its marker, a reply and a cache-warm usage entry.
  const poFile = join(ws, "sessions", `2026-09-20T10-00-00-000Z_0199aaaa-0000-7000-8000-000000000001.jsonl`);
  mkdirSync(join(ws, "sessions"), { recursive: true });
  writeFileSync(poFile, lines([
    header(T0),
    { type: "custom", id: id(), customType: "sova-project-overseer", data: { v: 1, projectId: project.id }, timestamp: iso(T0) },
    reply(T0 + 1000, "zai", "glm-5.3", usage(1_000_000, 100_000)),
    { type: "usage", id: id(), kind: "cache_warm", provider: "zai", model: "glm-5.3", usage: usage(0, 0, 0, 1_000_000), timestamp: iso(T0 + 2000) },
  ]));
  // Another project's overseer: never this project's.
  writeFileSync(join(ws, "sessions", `2026-09-20T10-00-00-000Z_0199aaaa-0000-7000-8000-000000000002.jsonl`), lines([
    header(T0),
    { type: "custom", id: id(), customType: "sova-project-overseer", data: { v: 1, projectId: other.id }, timestamp: iso(T0) },
    reply(T0 + 1000, "zai", "glm-5.3", usage(2_500_000)),
  ]));

  // The operator's gathering session with a wrap-up; the overseer's settle session.
  const g = await baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Payroll", goal: "g" });
  appendFileSync(g.path, lines([
    reply(T0 + 10_000, "zai", "glm-5.3", usage(2_000_000)),
    { type: "custom", id: id(), customType: "sova-baton-wrapup", data: { v: 1, phase: "start" }, timestamp: iso(T0 + 20_000) },
    reply(T0 + 21_000, "zai", "glm-5.3", usage(0, 100_000)),
    { type: "custom", id: id(), customType: "sova-baton-wrapup", data: { v: 1, phase: "end", applied: [], refused: [] }, timestamp: iso(T0 + 22_000) },
  ]));
  const sessions = await seedConflicts(org.id, project.id, [{ id: "cf_1", orgId: org.id, projectId: project.id, areaKey: "pay", a: "d1", b: "d2", p: 0.9, routedTo: maria.id, routeReason: "Maria decides pay.", batonSessionId: randomUUID(), state: "open", createdAt: new Date(T0).toISOString() }], { owner: { overseerOf: project.id } });
  const settle = baton.batonById(sessions.cf_1!)!;
  const s = { path: baton.sessionPathOf(settle.dir, settle.row) };
  appendFileSync(s.path, lines([reply(T0 + 30_000, "free", "llama", usage(5_000_000))]));

  // Coding sessions: the overseer's (bridge messages, before and after the bridge fix) with a forked
  // pi worker, a Claude Code worker and a team member listed twice; the operator's with an unpriced model.
  const sess = join(tmp, "agent", "sessions");
  const piWorker = join(sess, "worker.jsonl");
  writeFileSync(piWorker, lines([
    header(T0 + 60_000, { parentSession: "/parent.jsonl" }),
    reply(T0 + 1000, "zai", "glm-5.3", usage(7_000_000)), // copied from its parent: not counted
    { type: "custom", id: id(), customType: "subagents-worker-session", data: { v: 1, workerId: "ag_01" }, timestamp: iso(T0 + 60_001) },
    reply(T0 + 61_000, "zai", "glm-5.3", usage(0, 200_000)),
    { type: "message", id: id(), timestamp: iso(T0 + 62_000), message: { role: "toolResult", toolName: "delegate", content: [], usage: usage(300_000) } },
  ]));
  const member = join(sess, "member.jsonl");
  writeFileSync(member, lines([header(T0), reply(T0 + 70_000, "zai", "glm-5.3", usage(0, 0, 1_000_000))]));
  const CC = "0b7a2b8e-6d0e-4a4e-9f55-3f0b6b1e2a11";
  const ccDir = join(tmp, "claude", "projects", "-w");
  mkdirSync(join(ccDir, CC, "subagents"), { recursive: true });
  const ccUsage = { input_tokens: 2_500_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 400_000, ephemeral_5m_input_tokens: 600_000 } };
  writeFileSync(join(ccDir, `${CC}.jsonl`), lines([ccLine("m1", T0 + 80_000, "claude-opus-5-5", ccUsage), ccLine("m1", T0 + 80_000, "claude-opus-5-5", ccUsage)]));
  writeFileSync(join(ccDir, CC, "subagents", "agent-a.jsonl"), lines([ccLine("m2", T0 + 81_000, "claude-haiku-4-5", { input_tokens: 0, output_tokens: 100_000 }, { isSidechain: true }), ccLine("m1", T0 + 80_000, "claude-opus-5-5", ccUsage)]));

  const codeA = join(sess, "code-a.jsonl");
  writeFileSync(codeA, lines([
    header(T0),
    manifest("ag_01", { backend: "pi", kind: "pi-session-file", locator: piWorker }, "delegate"),
    manifest("ag_02", { backend: "claude-code", kind: "claude-session-id", locator: CC, cwd: "/w" }, "cc"),
    manifest("ag_03", { backend: "pi", kind: "pi-session-file", locator: member, sessionId: "member-1" }, "builder"),
    manifest("ag_04", { backend: "pi", kind: "pi-session-file", locator: member, sessionId: "member-1" }, "builder again"),
    // Before the fix: merged cache writes and only the alias.
    reply(T0 + 90_000, "claude-code-cli", "opus[1m]", usage(0, 0, 0, 1_000_000)),
    // After: the answering model and the 1-hour part.
    reply(T0 + 91_000, "claude-code-cli", "opus[1m]", usage(0, 0, 0, 1_000_000, { cacheWrite1h: 1_000_000 }), { responseModel: "claude-opus-5-5" }),
  ]));
  const codeB = join(sess, "code-b.jsonl");
  writeFileSync(codeB, lines([header(T0), reply(T0 + 100_000, "nopr", "spark", usage(123)), reply(T0 + 101_000, "zai", "glm-5.3", usage(400_000)), reply(T0 + 102_000, "zai", "glm-5.3", usage(3_500_000)), reply(T0 + 103_000, "period", "p", usage(1_000_000)), reply(T0 + 300_000, "period", "p", usage(1_000_000))]));
  await seedBuild(org.id, project.id, { sessionId: "code-a", kind: "coding", path: codeA, title: "Build A", createdAt: T0 });
  await seedBuild(org.id, project.id, { sessionId: "code-b", kind: "operator-coding", path: codeB, title: "Build B", createdAt: T0 });
  // A build on another host with no count in the ledger: nothing to price (the legacy token count went with started.json).
  await seedBuild(org.id, project.id, { sessionId: "code-far", kind: "coding", path: "/elsewhere/far.jsonl", title: "Far", createdAt: T0 });

  // The reconciler: the operator's Reconcile Now and an automatic run.
  ledger.appendUsage(lp, { at: iso(T0), kind: "reconcile", by: "operator", provider: "zai", model: "glm-5.3", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
  ledger.appendUsage(lp, { at: iso(T0), kind: "reconcile", by: "sova", provider: "jev", model: "jev-1", input: 50, output: 5, cacheRead: 0, cacheWrite: 0 });
  appendFileSync(lp.usage, "{torn\n");

  // The expected dollars, by source.
  const PO = 1 + 1 + 1.25; // input $1, output $1, a 5-minute cache warm $1.25
  const GATHER = 2;
  const WRAPUP = 1;
  const PI_WORKER = 2; // 200k output
  const MEMBER = 0.1;
  const CC_WORKER = 2 * (2.5 + 0.6 * 1.25 + 0.4 * 2) + 1; // over the tier: 2.5M input + 600k 5m + 400k 1h, doubled; haiku 100k output
  const CODE_A = 2 + 2; // 1M 1-hour writes each (the first assumed)
  const CODE_B_REAL = 0.4 + 3.5 * 2 + 1 + 2; // one message under the tier, one over it; one each side of a new price period the same day
  const RECONCILE = 1;

  test("every source, priced per message: kinds, starters, models, estimates, unpriced", async () => {
    const c = await costs.projectCost(project.id);
    const kind = (k: string) => c.byKind.find((r) => r.kind === k)?.usd ?? 0;
    approx(kind("overseer"), PO, "overseer");
    approx(kind("gathering"), GATHER, "gathering");
    approx(kind("wrapup"), WRAPUP, "wrap-up apart from its baton");
    assert.equal(kind("settle"), 0);
    assert.ok(c.byKind.some((r) => r.kind === "settle" && r.tokens.input === 5_000_000), "a local model's tokens count at $0");
    approx(kind("coding-overseer"), CODE_A, "coding by the overseer");
    approx(kind("coding-operator"), CODE_B_REAL, "a message over the tier is priced wholly at its rates; one under isn't");
    approx(kind("workers"), PI_WORKER + MEMBER + CC_WORKER, "workers: fork boundary, dedupe by message id and across manifests");
    approx(kind("reconcile"), RECONCILE, "reconciler");
    approx(c.totalUsd, PO + GATHER + WRAPUP + CODE_A + CODE_B_REAL + PI_WORKER + MEMBER + CC_WORKER + RECONCILE, "total");

    const by = (b: string) => c.byStarter.find((r) => r.by === b)?.usd ?? 0;
    approx(by("overseer"), PO + CODE_A + PI_WORKER + MEMBER + CC_WORKER, "the overseer's conversation, its coding session and its workers");
    approx(by("operator"), GATHER + WRAPUP + CODE_B_REAL + RECONCILE, "the operator's baton, wrap-up, coding session and Reconcile Now");
    assert.ok(c.byStarter.some((r) => r.by === "sova" && r.usd === 0 && r.tokens.input === 50), "the automatic run is Sova's own");

    const est = c.estimates.find((e) => e.code === "cache-write-1h-assumed");
    assert.deepEqual([est?.messages, est?.usd], [1, 2], "the merged write priced at the 1-hour rate, marked");
    assert.equal(c.estimates.find((e) => e.code === "model-from-alias")?.messages, 1);

    const unpriced = Object.fromEntries(c.unpriced.map((u) => [u.model, u]));
    assert.equal(unpriced["nopr/spark"]?.tokens, 123);
    assert.equal(unpriced["jev/jev-1"]?.tokens, 55);
    assert.equal(unpriced["zai/glm-5.3"]?.tokens, 300_000, "a tool result's own usage names no model: unpriced");
    assert.equal(unpriced["zai/glm-5.3"]?.why, "A tool's own model calls, with no model recorded.");
    assert.equal(unpriced.unknown, undefined, "no legacy count: a build elsewhere with no ledger row adds nothing");

    const local = c.byModel.find((m) => m.status === "free");
    assert.equal(local?.why, "local");
    const opus = c.byModel.find((m) => m.model === "priced/claude-opus-5-5");
    assert.ok(opus && opus.usdBy.cacheWrite1h > 0, "the answering model names the row");
    assert.equal(opus?.name, "Claude Opus 5.5", "models.dev's name");
    assert.deepEqual([c.top[0]?.sessionId, c.top[1]?.sessionId], ["code-b", CC], "most expensive first");
    assert.deepEqual([c.top[1]?.kind, c.top[1]?.title], ["workers", "cc"]);
    assert.ok(c.top.some((t) => t.kind === "reconcile" && t.path === null));
    assert.equal(c.prices.fetchedAt, "2026-09-28T00:00:00.000Z");
    assert.equal(c.notOnHost, null);
  });

  test("the counts are kept in costs.json; a file gone is shown as last counted; the ledger has no row cap", async () => {
    const snap = ledger.readCostLedger(lp);
    assert.ok(snap.sources["code-a"] && snap.sources["w:claude-code:" + CC] && snap.sources["w:pi:member-1"], Object.keys(snap.sources).join(", "));
    const text = readFileSync(lp.costs, "utf8");
    assert.ok(!text.includes(tmp), "no host path in the repo's ledger");
    const before = await costs.projectCost(project.id);
    unlinkSync(codeB);
    clock += 120_000;
    const c = await costs.projectCost(project.id);
    approx(c.totalUsd, before.totalUsd, "a running cost never shrinks");
    assert.equal(c.notOnHost?.sessions, 1);
    assert.ok(c.top.find((t) => t.sessionId === "code-b")?.countedAt);
  });

  test("the org roll-up: each project's total and the org's", async () => {
    clock += 120_000;
    const r = await orgs.orgCosts(org.id);
    const mine = r.projects.find((p) => p.projectId === project.id)!;
    const theirs = r.projects.find((p) => p.projectId === other.id)!;
    approx(theirs.totalUsd, 2.5, "the other overseer's conversation is its own project's");
    approx(r.totalUsd, mine.totalUsd + theirs.totalUsd);
    assert.ok(mine.unpricedTokens >= 123 + 55 + 300_000);
  });

  test("an unknown project is a 404", async () => {
    await assert.rejects(() => costs.projectCost("prj_nope0000"), (e: any) => e.status === 404);
  });
});
