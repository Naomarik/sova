import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_PO_CAPS, type ProjectOverseerCaps } from "../shared/project-overseer";
import { atOnceCounts, buildEnvelope, type EnvelopeInput, type SessionRead } from "./org-envelope";

const caps: ProjectOverseerCaps = { ...DEFAULT_PO_CAPS, gatherPerTurn: 3, gatherPerDay: 6, promotePerTurn: null, promotePerDay: 60, unattendedPerDay: 12, gatheringsOpen: 5, codingRunning: 2 };
const base = (over: Partial<EnvelopeInput> = {}): EnvelopeInput => ({
  by: "overseer",
  attended: false,
  settings: { autonomy: "L2", caps, holdMin: 10, confirmKinds: ["gather", "promote"] },
  paused: false,
  rosterActive: true,
  archived: false,
  used: { message: { gather: 1, promote: 4 }, day: { gather: 5, promote: 7 }, looksToday: 3 },
  gatheringsOpen: 2,
  codingRunning: 1,
  ...over,
});

describe("buildEnvelope (design §4.1)", () => {
  test("an unattended turn draws on today's ledger, with the per-day limits", () => {
    const e = buildEnvelope(base());
    assert.equal(e.ledger, "day");
    assert.deepEqual(e.allowance.gather, { used: 5, max: 6 });
    assert.deepEqual(e.allowance.promote, { used: 7, max: 60 });
    assert.deepEqual(e.allowance.create, { used: 0, max: caps.createPerDay });
  });

  test("an attended turn draws on the message's ledger, with the per-message limits (Unlimited is null)", () => {
    const e = buildEnvelope(base({ attended: true }));
    assert.equal(e.ledger, "message");
    assert.deepEqual(e.allowance.gather, { used: 1, max: 3 });
    assert.deepEqual(e.allowance.promote, { used: 4, max: null });
  });

  test("looks, at-once counts and caps, the level chosen and the hold in ms", () => {
    const e = buildEnvelope(base());
    assert.deepEqual(e.looks, { used: 3, max: 12 });
    assert.deepEqual(e.atOnce, { gatheringsOpen: 2, gatheringsCap: 5, codingRunning: 1, codingCap: 2 });
    assert.equal(e.autonomy, "L2");
    assert.equal(e.holdMs, 600_000);
    assert.equal(buildEnvelope(base({ settings: { autonomy: "L2", caps, holdMin: 0, confirmKinds: [] } })).holdMs, 0);
    // r8(4): the project's confirmation checklist, as overseer.json has it.
    assert.deepEqual(buildEnvelope(base()).confirmKinds, ["gather", "promote"]);
    assert.deepEqual(buildEnvelope(base({ settings: { autonomy: "L2", caps, holdMin: 0, confirmKinds: [] } })).confirmKinds, []);
  });

  test("the facts pass through as given; optional fields only when set", () => {
    const e = buildEnvelope(base({ paused: true, rosterActive: false, archived: true }));
    assert.deepEqual([e.paused, e.rosterActive, e.archived], [true, false, true]);
    assert.ok(!("via" in e) && !("card" in e) && !("overseerId" in e) && !("turnId" in e));
    const card = { people: ["p_a"], projects: [], sessions: ["s1"] };
    const g = buildEnvelope(base({ by: "operator", via: "overseer", overseerId: "ov", card, turnId: "t1" }));
    assert.deepEqual([g.by, g.via, g.overseerId, g.card, g.turnId], ["operator", "overseer", "ov", card, "t1"]);
  });

  test("a bad count in the ledger reads as 0", () => {
    const e = buildEnvelope(base({ used: { message: {}, day: { gather: -2, promote: 1.5 as number }, looksToday: Number.NaN } }));
    assert.equal(e.allowance.gather.used, 0);
    assert.equal(e.allowance.promote.used, 0);
    assert.equal(e.looks.used, 0);
  });
});

describe("atOnceCounts: from chart states", () => {
  const s = (chart: string, configuration: string[], data: Record<string, unknown>): SessionRead => ({ id: `${chart}-${Math.random()}`, chart, configuration, data });
  const P = "prj_a";
  test("gatherings: this overseer's batons in open, settle ones included; never the operator's, another project's, or ended ones", () => {
    const sessions = [
      s("baton", ["course", "open", "with-person"], { projectId: P, owner: { overseerOf: P } }),
      s("baton", ["course", "open", "offered", "pool"], { projectId: P, owner: { overseerOf: P }, conflict: { id: "c1", area: "x" } }),
      s("baton", ["course", "open", "with-operator"], { projectId: P, owner: "operator" }),
      s("baton", ["course", "done"], { projectId: P, owner: { overseerOf: P } }),
      s("baton", ["course", "open", "with-person"], { projectId: "prj_b", owner: { overseerOf: "prj_b" } }),
    ];
    assert.equal(atOnceCounts(sessions, P).gatheringsOpen, 2);
  });
  test("coding: its own builds whose turn is working or whose workers still run; never operator-coding or idle ones without workers", () => {
    const sessions = [
      s("build", ["turn", "working"], { projectId: P, kind: "coding" }),
      s("build", ["turn", "idle"], { projectId: P, kind: "coding", workers: 2 }),
      s("build", ["turn", "failed"], { projectId: P, kind: "coding", workers: 1 }),
      s("build", ["turn", "idle"], { projectId: P, kind: "coding", workers: 0 }),
      s("build", ["turn", "idle"], { projectId: P, kind: "coding" }),
      s("build", ["turn", "idle"], { projectId: P, kind: "operator-coding", workers: 3 }),
      s("build", ["turn", "idle"], { projectId: P, kind: "coding", running: true }),
      s("build", ["turn", "working"], { projectId: P, kind: "coding", running: false }),
      s("build", ["turn", "working"], { projectId: P, kind: "operator-coding" }),
      s("build", ["turn", "working"], { projectId: "prj_b", kind: "coding" }),
    ];
    assert.deepEqual(atOnceCounts(sessions, P), { gatheringsOpen: 0, codingRunning: 4 });
  });
});
