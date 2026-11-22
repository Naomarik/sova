import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Hono } from "hono";
import { countFlaky } from "./flaky";
import { MergeFailure } from "./queue";
import { type KnownQueue, registerMergeKnownRoutes } from "./routes-known";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1) + minutes * 60_000).toISOString();
const run = (id: string, minutes: number, branch = "feat/a") => ({ run: id, entry: `mq_${id}`, branch, at: at(minutes) });

describe("the known-state routes", () => {
  function setup(o: { notPage?: string | null } = {}) {
    const calls: string[] = [];
    const tests = countFlaky([], [{ check: "unit", label: "Unit", file: "a.test.ts" }], run("mr_1", 1));
    const q: KnownQueue = {
      async cleanRun(entry) {
        if (entry === "mq_gone") throw new MergeFailure("not-found", "no queue entry mq_gone");
        calls.push(`clean ${entry ?? "next"}`);
        return { project: "prj_1" } as never;
      },
      flaky: { list: () => tests, get: (k) => tests.find((t) => t.key === k) },
      historyPage: (p) => (calls.push(`history ${JSON.stringify(p)}`), { rows: [] }),
      health: (d) => (calls.push(`health ${d}`), { since: "", until: "" }) as never,
    };
    const app = new Hono();
    registerMergeKnownRoutes(app, { queueOf: async (id) => (id === "prj_1" ? q : null), notPage: () => o.notPage ?? null, fixFlaky: async (_p, key) => (calls.push(`fix ${key === tests[0]!.key}`), { session: "s", path: "/p" }) });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    return { call, calls, tests };
  }

  test("each reaches its act; bad values and unknown projects, entries or tests are refused before anything runs", async () => {
    const t = setup();
    assert.equal((await t.call("POST", "/api/merge-queue/projects/prj_1/clean-run", {})).status, 200);
    assert.equal((await t.call("POST", "/api/merge-queue/projects/prj_1/clean-run", { entry: "mq_1" })).status, 200);
    assert.equal((await t.call("POST", "/api/merge-queue/projects/prj_1/clean-run", { entry: "mq_gone" })).status, 404);
    assert.equal((await t.call("POST", "/api/merge-queue/projects/prj_1/clean-run", { entry: 5 })).status, 400);
    assert.equal((await t.call("POST", "/api/merge-queue/projects/nope/clean-run", {})).status, 404);
    assert.deepEqual((await t.call("GET", "/api/merge-queue/projects/prj_1/flaky")).body.tests, JSON.parse(JSON.stringify(t.tests)));
    assert.equal((await t.call("POST", "/api/merge-queue/projects/prj_1/flaky/fix", { key: t.tests[0]!.key })).status, 200);
    assert.equal((await t.call("POST", "/api/merge-queue/projects/prj_1/flaky/fix", { key: "other" })).status, 404);
    assert.equal((await t.call("POST", "/api/merge-queue/projects/prj_1/flaky/fix", {})).status, 400);
    assert.equal((await t.call("GET", "/api/merge-queue/projects/prj_1/history?branch=feat&limit=5&before=2026-11-01T00:00:00.000Z|mq_1")).status, 200);
    for (const bad of ["limit=0", "limit=101", "limit=x", "before=nonsense"]) assert.equal((await t.call("GET", `/api/merge-queue/projects/prj_1/history?${bad}`)).status, 400, bad);
    assert.equal((await t.call("GET", "/api/merge-queue/projects/prj_1/health")).status, 200);
    for (const bad of ["0", "367", "1.5"]) assert.equal((await t.call("GET", `/api/merge-queue/projects/prj_1/health?days=${bad}`)).status, 400, bad);
    assert.deepEqual(t.calls, ["clean next", "clean mq_1", "fix true", `history ${JSON.stringify({ branch: "feat", before: "2026-11-01T00:00:00.000Z|mq_1", limit: 5 })}`, "health 30"]);
  });

  test("Clean Run and Fix in New Chat pass only from the user's own page; the reads stay open", async () => {
    const t = setup({ notPage: "A chat can't start a clean run" });
    for (const [path, body] of [["clean-run", {}], ["flaky/fix", { key: "k" }]] as const) {
      const r = await t.call("POST", `/api/merge-queue/projects/prj_1/${path}`, body);
      assert.equal(r.status, 403);
      assert.equal((r.body.error as { code: string }).code, "forbidden");
    }
    assert.equal((await t.call("GET", "/api/merge-queue/projects/prj_1/flaky")).status, 200);
    assert.deepEqual(t.calls, []);
  });
});
