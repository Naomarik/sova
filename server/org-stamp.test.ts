import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_PO_CAPS } from "../shared/project-overseer";
import type { SessionInfo } from "./org-engine";
import { ledgerOf, projectOfSession, stampEnvelope } from "./org-stamp";

const O = "org_a";
const P = "prj_a";
function fakeHost(sessions: SessionInfo[]) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return {
    sessions: (chart?: string) => sessions.filter((s) => !chart || s.chart === chart),
    data: (sid: string) => byId.get(sid)?.data ?? null,
    configuration: (sid: string) => byId.get(sid)?.configuration ?? null,
    chartOf: (sid: string) => byId.get(sid)?.chart ?? null,
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
