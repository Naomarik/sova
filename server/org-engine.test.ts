import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { actOrThrow, closeOrgHost, hostOf, isOrgHostOpen, onOrgChange, onOrgHostOpened, openOrgHost, refusalError, resetOrgHostsForTest, setOrgHostOpener, type ActResult, type HostChange, type OrgHostApi } from "./org-engine";
import { OrgError } from "./orgs";

/** A host that records what it was asked and answers `next`. */
function fakeHost(next: () => ActResult = () => ({ taken: true, refusal: null, result: {} })) {
  const calls: unknown[][] = [];
  const kinds: string[] = [];
  let changed: ((c: HostChange) => void) | null = null;
  let closed = 0;
  const host = {
    effects: { register: (kind: string) => void kinds.push(kind) },
    invocations: { register: () => {} },
    act: async (...a: unknown[]) => (calls.push(a), next()),
    start: async () => ({}),
    setState: async () => next(),
    trial: () => next(),
    enabledEvents: () => [],
    configuration: () => null,
    data: () => null,
    sessions: () => [],
    holds: () => [],
    chartOf: () => null,
    problems: () => [],
    logAct: async () => {},
    onChange: (fn: (c: HostChange) => void) => void (changed = fn),
    close: async () => void closed++,
  } satisfies OrgHostApi;
  return { host, calls, kinds, fire: (c: HostChange) => changed?.(c), closed: () => closed };
}

const opts = (orgId: string) => ({ orgId, workspaceDir: `/ws/${orgId}`, stateDir: "/state" });

describe("org engines: one host per org", () => {
  beforeEach(() => resetOrgHostsForTest());

  test("an org's host is opened once, even when asked twice at the same time", async () => {
    let opened = 0;
    const f = fakeHost();
    setOrgHostOpener(async () => (opened++, f.host));
    const [a, b] = await Promise.all([openOrgHost(opts("org_a")), openOrgHost(opts("org_a"))]);
    assert.equal(a, b);
    assert.equal(opened, 1);
    assert.equal(hostOf("org_a"), f.host);
  });

  test("a host that is not open answers 409; after close it is gone", async () => {
    assert.throws(() => hostOf("org_x"), (e: unknown) => e instanceof OrgError && e.status === 409);
    const f = fakeHost();
    setOrgHostOpener(async () => f.host);
    await openOrgHost(opts("org_x"));
    assert.ok(isOrgHostOpen("org_x"));
    await closeOrgHost("org_x");
    assert.equal(f.closed(), 1);
    assert.ok(!isOrgHostOpen("org_x"));
    await closeOrgHost("org_x"); // nothing to close: fine
  });

  test("handlers register on hosts opened before and after they are added", async () => {
    const f1 = fakeHost();
    const f2 = fakeHost();
    const queue = [f1.host, f2.host];
    setOrgHostOpener(async () => queue.shift()!);
    await openOrgHost(opts("org_1"));
    onOrgHostOpened((h) => h.effects.register("mint-link", async () => ({})));
    await openOrgHost(opts("org_2"));
    assert.deepEqual([f1.kinds, f2.kinds], [["mint-link"], ["mint-link"]]);
  });

  test("a failed open leaves nothing half open, and a later open can succeed", async () => {
    setOrgHostOpener(async () => {
      throw new Error("journal does not parse");
    });
    await assert.rejects(openOrgHost(opts("org_j")), /journal/);
    assert.ok(!isOrgHostOpen("org_j"));
    const f = fakeHost();
    setOrgHostOpener(async () => f.host);
    await openOrgHost(opts("org_j"));
    assert.ok(isOrgHostOpen("org_j"));
  });

  test("the host gets a stamp: a chart's own act (or a named actor's), unattended, from the project's settings file", async () => {
    const f = fakeHost();
    let stamp: ((sid: string, e: string, p: Record<string, unknown>, who?: { by?: "overseer" }) => { by: string; attended: boolean; holdMs: number }) | null = null;
    setOrgHostOpener(async (o) => ((stamp = o.stamp), f.host));
    assert.equal(stamp, null);
    await openOrgHost({ orgId: "org_s", workspaceDir: "/nonexistent-ws", stateDir: "/state" });
    const e = stamp!("watch/org_s/prj_s", "gather/start", {});
    assert.deepEqual([e.by, e.attended, e.holdMs], ["chart", false, 600_000]);
    assert.equal(stamp!("item/org_s/prj_s/g_1", "gather/start", {}, { by: "overseer" }).by, "overseer");
  });

  test("changes fan out with the org id; a throwing listener stops nothing", async () => {
    const f = fakeHost();
    setOrgHostOpener(async () => f.host);
    await openOrgHost(opts("org_c"));
    const seen: string[] = [];
    onOrgChange(() => {
      throw new Error("boom");
    });
    onOrgChange((orgId, c) => seen.push(`${orgId}:${c.sessions.join(",")}`));
    f.fire({ sessions: ["baton/org_c/s1"], steps: [] });
    assert.deepEqual(seen, ["org_c:baton/org_c/s1"]);
  });
});

describe("refusals as the routes answer them", () => {
  beforeEach(() => resetOrgHostsForTest());

  test("the chart's status and sentence (and code) pass through; no or odd status is 409", () => {
    const e = refusalError({ sentence: "Someone else is answering right now.", status: 409, code: "taken" });
    assert.deepEqual([e.status, e.message, e.code], [409, "Someone else is answering right now.", "taken"]);
    assert.equal(refusalError({ sentence: "This link has expired.", status: 410 }).status, 410);
    assert.equal(refusalError({ sentence: "No such change", status: 404 }).status, 404);
    assert.equal(refusalError({ sentence: "x", status: 400 }).status, 400);
    assert.equal(refusalError({ sentence: "x" }).status, 409);
    assert.equal(refusalError({ sentence: "x", status: 500 }).status, 409);
  });

  test("actOrThrow sends to the org's host and throws a refusal", async () => {
    let answer: ActResult = { taken: true, refusal: null, result: { ok: 1 } };
    const f = fakeHost(() => answer);
    setOrgHostOpener(async () => f.host);
    await openOrgHost(opts("org_r"));
    const out = await actOrThrow("org_r", "person/org_r/p_1", "person/approve", { personId: "p_1" }, { by: "operator" });
    assert.deepEqual(out.result, { ok: 1 });
    assert.deepEqual(f.calls[0], ["person/org_r/p_1", "person/approve", { personId: "p_1" }, { by: "operator" }]);
    answer = { taken: false, refusal: { sentence: "Ana is not waiting for approval.", status: 409 }, result: null };
    await assert.rejects(actOrThrow("org_r", "person/org_r/p_1", "person/approve", {}, { by: "operator" }), (e: unknown) => e instanceof OrgError && e.status === 409 && e.message === "Ana is not waiting for approval.");
    answer = { taken: false, refusal: null, result: null };
    await assert.rejects(actOrThrow("org_r", "s", "e", {}, {}), /That can't be done now\./);
  });
});
