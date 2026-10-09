// Run: node scripts/run-tests.mjs server/org-history-routes.test.ts. The operator's history routes
//: every list parameter by its one spelling narrows the result,
// an unknown parameter is refused, events/chain/packet/evidence/purge answer as the history does. A throwaway
// agent dir and workspace in the OS temp dir, deleted after.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { EventDetail, HistoryChain, HistoryInput, HistoryPacket, HistoryPage } from "../shared/org-history";
import { scratchRoot } from "./test-scratch";

const tmp = scratchRoot("sova-org-history-routes-");
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const engine = await import("./org-engine");
const { registerOrgHistoryRoutes } = await import("./org-history-routes");
const { OVERSEER_SENDER_HEADER, senderSecret } = await import("./overseer-sender");
const { settled } = await import("./workspace-git");

const app = new Hono();
registerOrgHistoryRoutes(app);
after(async () => {
  engine.setOrgClockForTest(null);
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(tmp, { recursive: true, force: true });
});

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.request(path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, json: (await r.json()) as any };
};

describe("history routes", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(tmp, "ws") });
  mkdirSync(join(tmp, "a"));
  mkdirSync(join(tmp, "b"));
  const pa = await orgs.addProject(org.id, { name: "Portal", root: join(tmp, "a") });
  const pb = await orgs.addProject(org.id, { name: "Ledger", root: join(tmp, "b") });
  const host = engine.hostOf(org.id);
  const T = 2_000_000_000_000;
  const at = async (t: number, inputs: HistoryInput[]) => {
    engine.setOrgClockForTest(() => t);
    const ids = await host.record(inputs);
    engine.setOrgClockForTest(null);
    return ids;
  };
  const ev = (kind: HistoryInput["kind"], outcome: HistoryInput["outcome"], key: string, project: string, more: Partial<HistoryInput> = {}): HistoryInput => ({
    kind,
    outcome,
    projects: { primary: project },
    actors: { initiatedBy: { kind: "operator" }, decidedBy: { kind: "operator" }, recordedBy: { kind: "sova" }, executedBy: { kind: "sova" } },
    source: { adapter: "route-test", version: 1, key },
    ...more,
  });
  const ids = (page: HistoryPage) => new Set(page.items.map((i) => i.id));
  const list = async (qs: string) => {
    const r = await call("GET", `/api/orgs/${org.id}/history${qs}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return ids(r.json as HistoryPage);
  };
  // What the org's own setup recorded (its projects placed), per query, before anything is seeded: each
  // result below is exactly that and the seeded events it names.
  const QUERIES = ["", "?project=PB", "?project=PA,PB", "?kind=gap.filed,build.started", "?outcome=deferred", "?actor=person:p_x", "?initiation=overseer", "?initiation=unknown", `?from=${T + 1500}`, `?to=${T + 500}`, "?q=zebraword", `?asOf=${T + 1500}`];
  const qsOf = (q: string) => q.replace("PA", pa.id).replace("PB", pb.id);
  const baseline = new Map<string, Set<string>>();
  for (const q of QUERIES) baseline.set(qsOf(q), await list(qsOf(q)));
  assert.ok(baseline.get("")!.size > 0, "the setup's own events are listed");
  const seeded = (qs: string, ...xs: (string | undefined)[]) => new Set([...baseline.get(qs)!, ...xs.map((x) => x!)]);
  const [gap] = await at(T, [ev("gap.filed", "recorded", "k1", pa.id, { rationale: { what: "Payment data gap ZEBRAWORD" } })]);
  const [dec] = await at(T + 1000, [
    ev("decision.recorded", "deferred", "k2", pa.id, {
      actors: { initiatedBy: { kind: "project-overseer", id: pa.id }, decidedBy: { kind: "person", id: "p_x" }, recordedBy: { kind: "model" }, executedBy: { kind: "sova" } },
      decision: { disposition: "defer", options: [{ id: "o1", outcome: "deferred" }], authority: { kind: "person", id: "p_x" } },
      triggeredBy: [{ event: gap!, via: "tool-call" }],
      rationale: { what: "Bank sync deferred", reason: { text: "Ledger export unapproved", author: { kind: "person", id: "p_x" }, contemporaneous: true } },
    }),
  ]);
  const [build] = await at(T + 2000, [ev("build.started", "started", "k3", pb.id, { triggeredBy: [{ event: dec!, via: "operator-act" }] })]);
  const [refused] = await at(T + 3000, [ev("act.refused", "refused", "k4", pb.id, { actors: { initiatedBy: { unknown: true }, decidedBy: { kind: "statechart" }, recordedBy: { kind: "sova" }, executedBy: { kind: "sova" } } })]);

  test("everything, then each parameter by its one name narrows it", async () => {
    const check = async (qs: string, ...xs: (string | undefined)[]) => assert.deepEqual(await list(qs), seeded(qs, ...xs), qs);
    await check("", gap, dec, build, refused);
    await check(`?project=${pb.id}`, build, refused);
    await check(`?project=${pa.id},${pb.id}`, gap, dec, build, refused);
    await check("?kind=gap.filed,build.started", gap, build);
    await check("?outcome=deferred", dec);
    await check("?actor=person:p_x", dec);
    await check("?initiation=overseer", dec);
    await check("?initiation=unknown", refused);
    await check(`?from=${T + 1500}`, build, refused);
    await check(`?to=${T + 500}`, gap);
    await check("?q=zebraword", gap);
    await check(`?asOf=${T + 1500}`, gap, dec);
    const one = await call("GET", `/api/orgs/${org.id}/history?limit=1`);
    assert.equal(one.json.items.length, 1);
    assert.equal(one.json.total, baseline.get("")!.size + 4);
    assert.ok(one.json.cursor);
    const next = await call("GET", `/api/orgs/${org.id}/history?limit=1&cursor=${encodeURIComponent(one.json.cursor)}`);
    assert.notEqual(next.json.items[0].id, one.json.items[0].id);
    const grouped = await call("GET", `/api/orgs/${org.id}/history?groupOf=${dec}`);
    assert.equal(grouped.status, 200);
  });

  test("an unknown parameter, a plural spelling or a bad value is refused, never ignored", async () => {
    for (const qs of ["?projects=x", "?kinds=gap.filed", "?text=a", "?actors=operator", "?bogus=1"]) {
      const r = await call("GET", `/api/orgs/${org.id}/history${qs}`);
      assert.equal(r.status, 400, qs);
      assert.match(r.json.error, /^Unknown parameter/);
    }
    assert.equal((await call("GET", `/api/orgs/${org.id}/history?kind=nope`)).status, 400);
    assert.equal((await call("GET", `/api/orgs/${org.id}/history?initiation=automatic`)).status, 400);
    assert.equal((await call("GET", `/api/orgs/${org.id}/history?from=yesterday`)).status, 400);
    assert.equal((await call("GET", `/api/orgs/${org.id}/history?kind=a&kind=b`)).status, 400);
  });

  test("an event, its chain and a packet; an unknown event or org is 404", async () => {
    const d = await call("GET", `/api/orgs/${org.id}/history/events/${dec}`);
    assert.equal(d.status, 200);
    const detail = d.json as EventDetail;
    assert.equal(detail.event.id, dec);
    assert.equal(detail.event.project?.name, "Portal");
    assert.equal(detail.rationale?.reason?.text, "Ledger export unapproved");
    assert.deepEqual(detail.triggeredBy.map((l) => l.event.id), [gap]);
    const chain = (await call("GET", `/api/orgs/${org.id}/history/events/${dec}/chain?hops=2`)).json as HistoryChain;
    assert.deepEqual(new Set(chain.nodes.map((n) => n.id)), new Set([gap, dec, build]));
    assert.equal((await call("GET", `/api/orgs/${org.id}/history/events/${dec}/chain?depth=2`)).status, 400);
    const packet = (await call("GET", `/api/orgs/${org.id}/history/packet?event=${dec}`)).json as HistoryPacket;
    assert.ok(packet.text.length > 0 && packet.text.length <= 12_000);
    assert.ok(packet.events.includes(dec!));
    const byQuery = (await call("GET", `/api/orgs/${org.id}/history/packet?kind=build.started`)).json as HistoryPacket;
    assert.deepEqual(byQuery.events, [build]);
    assert.equal((await call("GET", `/api/orgs/${org.id}/history/packet?event=${dec}&kind=gap.filed`)).status, 400);
    assert.equal((await call("GET", `/api/orgs/${org.id}/history/events/he_${"0".repeat(32)}`)).status, 404);
    assert.equal((await call("GET", `/api/orgs/org_nope/history`)).status, 404);
  });

  test("Purge Reason…: confirmed only, the operator's own; the reason is gone and a purge event says so", async () => {
    assert.equal((await call("POST", `/api/orgs/${org.id}/history/events/${dec}/purge`, {})).status, 400);
    const r = await call("POST", `/api/orgs/${org.id}/history/events/${dec}/purge`, { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.event, /^he_[0-9a-f]{32}$/);
    const d = (await call("GET", `/api/orgs/${org.id}/history/events/${dec}`)).json as EventDetail;
    assert.equal(d.rationale?.reason, undefined);
    assert.equal(d.event.reasonState, "purged");
    assert.equal((await list("?q=ledger")).has(dec!), false, "its words left the index");
    assert.equal((await call("POST", `/api/orgs/${org.id}/history/events/${dec}/purge`, { confirm: true })).status, 409, "nothing left to purge");
    // the global Overseer's own call (the server's sender secret) is never the operator's purge
    const g = await call("POST", `/api/orgs/${org.id}/history/events/${gap}/purge`, { confirm: true }, { [OVERSEER_SENDER_HEADER]: senderSecret() });
    assert.equal(g.status, 403, JSON.stringify(g.json));
  });
});
