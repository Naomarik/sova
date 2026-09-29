import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_PO_CAPS } from "../shared/project-overseer";
import type { SessionInfo } from "./org-engine";
import { countsFrom, heldUse, ledgerOf, projectOfSession, stampEnvelope, withHolds, type HeldAct } from "./org-stamp";

/** A registry as the charts declare it: which acts count against which allowance. */
const ACTS: Record<string, Record<string, { counts?: string }>> = {
  item: { "gather/start": { counts: "gather" }, "build/start": { counts: "create" }, "item/hold": {} },
  baton: { offer: { counts: "gather" }, close: {} },
  build: { "build/prompt": { counts: "prompt" } },
  reconciler: { "decision/promote": { counts: "promote" } },
};
const chartOfId = (sid: string) => sid.split("/")[0] ?? null;
const registry = { chartOf: chartOfId, chartInfo: (name: string) => (ACTS[name] ? { name, version: 1, acts: ACTS[name]! } : null) };
const countsOf = countsFrom(registry);

const O = "org_a";
const P = "prj_a";
function fakeHost(sessions: SessionInfo[], holds: HeldAct[] = []) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return {
    holds: () => holds,
    sessions: (chart?: string) => sessions.filter((s) => !chart || s.chart === chart),
    data: (sid: string) => byId.get(sid)?.data ?? null,
    configuration: (sid: string) => byId.get(sid)?.configuration ?? null,
    chartOf: (sid: string) => byId.get(sid)?.chart ?? chartOfId(sid),
    chartInfo: registry.chartInfo,
  };
}
const s = (id: string, chart: string, configuration: string[], data: Record<string, unknown> = {}): SessionInfo => ({ id, chart, configuration, data });
const settings = { autonomy: "L3" as const, caps: { ...DEFAULT_PO_CAPS }, holdMin: 5 };

describe("stamping an envelope from the charts as they stand", () => {
  const world = () => [
    s(`person/${O}/p_1`, "person", ["left"]),
    s(`person/${O}/p_2`, "person", ["active"]),
    s(`project/${O}/${P}`, "project", ["shelf", "archived"]),
    s(`watch/${O}/${P}`, "watch", ["attach", "paused"], { ledger: { message: { gather: 2 }, day: { gather: 4, promote: 9 } }, looksToday: 7 }),
    s(`baton/${O}/s1`, "baton", ["course", "open", "with-person"], { projectId: P, owner: { overseerOf: P } }),
    s(`build/${O}/${P}/b1`, "build", ["turn", "working"], { projectId: P, kind: "coding" }),
  ];

  test("an unattended overseer act: project facts, the day ledger, looks, at-once and the hold", () => {
    const e = stampEnvelope(fakeHost(world()), O, P, { by: "overseer", attended: false }, () => settings, settings);
    assert.deepEqual([e.rosterActive, e.archived, e.paused], [true, true, true]);
    assert.equal(e.ledger, "day");
    assert.deepEqual(e.allowance.gather, { used: 4, max: DEFAULT_PO_CAPS.gatherPerDay });
    assert.deepEqual(e.looks, { used: 7, max: DEFAULT_PO_CAPS.unattendedPerDay });
    assert.deepEqual([e.atOnce.gatheringsOpen, e.atOnce.codingRunning], [1, 1]);
    assert.equal(e.holdMs, 300_000);
    assert.equal(e.autonomy, "L3");
  });

  test("an attended turn draws on the message ledger", () => {
    const e = stampEnvelope(fakeHost(world()), O, P, { by: "overseer", attended: true }, () => settings, settings);
    assert.deepEqual(e.allowance.gather.used, 2);
  });

  test("nobody active, not archived, not paused, no watch yet: the facts say so and the ledgers are 0", () => {
    const e = stampEnvelope(fakeHost([s(`person/${O}/p_1`, "person", ["proposed"]), s(`project/${O}/${P}`, "project", ["shelf", "active"])]), O, P, { by: "chart", attended: false }, () => settings, settings);
    assert.deepEqual([e.rosterActive, e.archived, e.paused, e.allowance.gather.used, e.looks.used], [false, false, false, 0, 0]);
  });

  test("an org-level act stamps the org's facts only", () => {
    const e = stampEnvelope(fakeHost(world()), O, null, { by: "operator", attended: false }, () => settings, { ...settings, holdMin: 10 });
    assert.deepEqual([e.rosterActive, e.archived, e.paused, e.atOnce.gatheringsOpen, e.holdMs], [true, false, false, 0, 600_000]);
  });

  test("the project of a session: its data's projectId, else a project-scoped id's third segment", () => {
    const h = fakeHost([s(`baton/${O}/s1`, "baton", [], { projectId: P })]);
    assert.equal(projectOfSession(h, `baton/${O}/s1`), P);
    assert.equal(projectOfSession(h, `watch/${O}/${P}`), P);
    assert.equal(projectOfSession(h, `item/${O}/${P}/g_1`), P);
    assert.equal(projectOfSession(h, `person/${O}/p_1`), null);
    assert.equal(projectOfSession(h, `org/${O}`), null);
  });

  test("ledgerOf reads numbers only; anything else is 0", () => {
    assert.deepEqual(ledgerOf(null), { message: {}, day: {}, looksToday: 0 });
    assert.deepEqual(ledgerOf({ ledger: { day: { gather: 1, promote: "x" } }, looksToday: "3" }), { message: {}, day: { gather: 1 }, looksToday: 0 });
  });
});

describe("pending holds count as if they had gone ahead (F2)", () => {
  const h = (id: string, sessionId: string, event: string, data: Record<string, unknown> = {}): HeldAct => ({ id, sessionId, event, data, by: "overseer" });
  const base = { used: { message: { gather: 1 }, day: { gather: 2, promote: 3 }, looksToday: 0 }, gatheringsOpen: 1, codingRunning: 0 };
  const all = () => true;

  test("each kind on the day ledger, promote by its ids; the message ledger untouched", () => {
    const out = withHolds(base, [h("h1", `item/${O}/${P}/g1`, "gather/start"), h("h2", `reconciler/${O}/${P}`, "decision/promote", { ids: ["a", "b", "c"] }), h("h3", `item/${O}/${P}/g1`, "build/start"), h("h4", `build/${O}/${P}/b1`, "build/prompt")], all, null, countsOf);
    assert.deepEqual(out.used.day, { gather: 3, promote: 6, create: 1, prompt: 1 });
    assert.deepEqual(out.used.message, { gather: 1 });
  });

  test("at-once: a held gathering start opens one, a held offer on an existing session does not; a held coding start runs one", () => {
    const out = withHolds(base, [h("h1", `item/${O}/${P}/g1`, "gather/start"), h("h2", `baton/${O}/s1`, "offer"), h("h3", `item/${O}/${P}/g1`, "build/start"), h("h4", `build/${O}/${P}/b1`, "build/prompt")], all, null, countsOf);
    assert.deepEqual([out.gatheringsOpen, out.codingRunning], [2, 1]);
  });

  test("the hold being released is not counted twice; other projects' holds and uncounted acts are not counted", () => {
    const holds = [h("mine", `item/${O}/${P}/g1`, "gather/start"), h("other", `item/${O}/prj_b/g2`, "gather/start"), h("x", `baton/${O}/s1`, "close")];
    const out = withHolds(base, holds, (x) => x.sessionId.includes(`/${P}/`), "mine", countsOf);
    assert.deepEqual([out.used.day.gather, out.gatheringsOpen], [2, 1]);
    assert.equal(heldUse(h("x", `baton/${O}/s1`, "close"), countsOf), null);
    assert.deepEqual(heldUse(h("p", `reconciler/${O}/${P}`, "decision/promote", { ids: "nope" }), countsOf), { kind: "promote", n: 1 });
  });

  test("kinds come from the charts' registry: an act it doesn't declare, an unknown chart or an unknown kind counts nothing", () => {
    assert.equal(countsOf(`item/${O}/${P}/g1`, "item/hold"), null);
    assert.equal(countsOf(`item/${O}/${P}/g1`, "gather/offer"), null);
    assert.equal(countsOf(`nochart/${O}/x`, "gather/start"), null);
    const odd = countsFrom({ chartOf: () => "item", chartInfo: () => ({ name: "item", version: 1, acts: { "gather/start": { counts: "looks" } } }) });
    assert.equal(heldUse(h("q", `item/${O}/${P}/g1`, "gather/start"), odd), null);
  });

  test("stampEnvelope folds its project's holds, and not the one it releases", () => {
    const sessions = [s(`person/${O}/p_2`, "person", ["active"]), s(`watch/${O}/${P}`, "watch", ["attach", "live"], { ledger: { day: { gather: 4 } } })];
    const holds = [h("h1", `item/${O}/${P}/g1`, "gather/start"), h("h2", `item/${O}/${P}/g2`, "gather/start")];
    const e = stampEnvelope(fakeHost(sessions, holds), O, P, { by: "overseer", attended: false }, () => settings, settings, "h2");
    assert.deepEqual([e.allowance.gather.used, e.atOnce.gatheringsOpen], [5, 1]);
  });
});
