// Run: node scripts/run-tests.mjs server/org-history-boot.test.ts. The org's capture runs from its engine's boot on
//: a held act whose time came while the server was down is released at
// the next open, and that release is in the history, triggered by its hold's timer. A throwaway agent dir and
// workspace in the OS temp dir, deleted after.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { scratchRoot } from "./test-scratch";

const tmp = scratchRoot("sova-org-history-boot-");
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const engine = await import("./org-engine");
const store = await import("./project-overseer-store");
const { settled } = await import("./workspace-git");

after(async () => {
  engine.setOrgClockForTest(null);
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(tmp, { recursive: true, force: true });
});

describe("capture from the engine's boot", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(tmp, "ws") });
  mkdirSync(join(tmp, "client"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(tmp, "client") });
  const ana = await orgs.addPerson(org.id, { name: "Ana Diaz", role: "Ops" });
  const s = await baton.createBaton({ orgId: org.id, projectId: project.id, to: ana.id, publicTitle: "Rota", goal: "g" });

  // Waits for the org engine's stamp to work during OrgHost.open (org-engine.ts: `self` is null until open
  // resolves, so a hold due at boot fails its timer with "The org engine stamped before it opened.").
  test("a hold due while the engine was closed: released at open, captured with its timer as the trigger", async () => {
    // A close the overseer's review need not confirm: it goes ahead at its hold's end.
    const paths = store.projectOverseerPaths(project.id);
    store.writePoSettings(paths, { ...store.readPoSettings(paths), confirmKinds: [] });
    const host = engine.hostOf(org.id);
    const sid = baton.batonSid(org.id, s.sessionId);
    // The project overseer closes the gathering on its own: held (unattended).
    const out = await host.act(sid, "baton/close", { reason: "Answered." }, engine.envelopeFor(org.id, project.id, { by: "overseer", attended: false }));
    assert.ok(out.held, `held: ${JSON.stringify(out.refusal)}`);
    const until = out.held!.until;

    // The server stops; it starts again after the hold's time.
    await engine.closeOrgHost(org.id);
    engine.setOrgClockForTest(() => until + 60_000);
    await orgs.openAttachedOrgs();
    assert.deepEqual(engine.hostOf(org.id).problems().filter((x) => x.kind === "timer").map((x) => x.why), [], "its timer fired at open");
    assert.deepEqual(engine.hostOf(org.id).holds(), [], "released, not extended");
    const h = engine.hostOf(org.id).history;
    const items = h.search({ role: "operator" }, {}).items;
    const records = items.map((i) => h.event({ role: "operator" }, i.id)!.record!);
    const created = records.find((r) => r.kind === "hold.created")!;
    assert.ok(created, records.map((r) => r.kind).join(","));
    const closed = records.find((r) => r.kind === "gathering.closed");
    assert.ok(closed, `the released close is in the history: ${records.map((r) => r.kind).join(",")}`);
    assert.deepEqual(closed!.triggeredBy, [{ event: created.id, via: "timer" }]);
    assert.deepEqual(closed!.actors.decidedBy, { kind: "project-overseer", id: project.id });
    const released = records.find((r) => r.kind === "hold.released")!;
    assert.deepEqual(released.triggeredBy, [{ event: created.id, via: "timer" }]);
    engine.setOrgClockForTest(null);
  });

  test("a hold due at boot is re-checked under the level really in force then: an emptied roster caps it at L0, so it is refused", async () => {
    const org2 = await orgs.createOrg({ name: "Gate Two", dir: join(tmp, "ws2") });
    mkdirSync(join(tmp, "client2"));
    const p2 = await orgs.addProject(org2.id, { name: "Ledger", root: join(tmp, "client2") });
    const bo = await orgs.addPerson(org2.id, { name: "Bo Lind", role: "Ops" });
    const paths = store.projectOverseerPaths(p2.id);
    store.writePoSettings(paths, { ...store.readPoSettings(paths), confirmKinds: [] });
    const g = await baton.createBaton({ orgId: org2.id, projectId: p2.id, to: bo.id, publicTitle: "Books", goal: "g" });
    const sid = baton.batonSid(org2.id, g.sessionId);
    const out = await engine.hostOf(org2.id).act(sid, "baton/close", { reason: "Answered." }, engine.envelopeFor(org2.id, p2.id, { by: "overseer", attended: false }));
    assert.ok(out.held, `held at L1: ${JSON.stringify(out.refusal)}`);
    // The roster empties while it waits: the org caps the project at L0 (orgs.ts EMPTY_ROSTER_REASON).
    await orgs.applyChange(org2.id, bo.id, { status: "left" }, { kind: "operator" });
    await engine.closeOrgHost(org2.id);
    engine.setOrgClockForTest(() => out.held!.until + 60_000);
    await orgs.openAttachedOrgs();
    const host = engine.hostOf(org2.id);
    assert.deepEqual(host.problems().filter((x) => x.kind === "timer"), []);
    assert.ok(host.configuration(sid)?.includes("open"), "not closed: refused under the real ceiling");
    const h = host.history;
    const records = h.search({ role: "operator" }, {}).items.map((i) => h.event({ role: "operator" }, i.id)!.record!);
    assert.ok(!records.some((r) => r.kind === "gathering.closed"), records.map((r) => r.kind).join(","));
    const created = records.find((r) => r.kind === "hold.created")!;
    const refused = records.find((r) => r.kind === "act.refused" && r.triggeredBy.some((t) => t.event === created.id));
    assert.ok(refused, `the dropped hold is recorded: ${records.map((r) => `${r.kind}/${r.outcome}`).join(",")}`);
    engine.setOrgClockForTest(null);
  });
});
