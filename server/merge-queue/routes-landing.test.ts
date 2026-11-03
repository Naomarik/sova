import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Hono } from "hono";
import type { LandHow, MergeEntry } from "../../shared/merge-queue";
import { MergeFailure } from "./queue";
import { type LandingQueue, registerMergeLandingRoutes } from "./routes-landing";

function setup(o: { notPage?: string | null; dirty?: boolean } = {}) {
  const calls: string[] = [];
  const q: LandingQueue = {
    async updateLocalMain() {
      if (o.dirty) throw new MergeFailure("invalid-request", "/p has uncommitted changes (1 file: a.txt): commit or put them away, then Update Local Main again");
      calls.push("update");
      return { kind: "updated", head: "abc" };
    },
    async publish(id, t) {
      calls.push(`publish ${id} ${t.title} ${t.draft}`);
      return { id, state: "requested" } as unknown as MergeEntry;
    },
    async setLandHow(how: LandHow, where) {
      calls.push(`how ${how} ${where}`);
      return { state: "saved" };
    },
    async clearLandHowOverride() {
      calls.push("clear");
    },
    view: async () => ({ project: "prj_1" }) as never,
  };
  const app = new Hono();
  registerMergeLandingRoutes(app, { queueOf: async (id) => (id === "prj_1" ? q : null), queueOfEntry: async (id) => (id === "mq_1" ? q : null), notPage: () => o.notPage ?? null });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { call, calls };
}

describe("the routes of how a branch lands", () => {
  test("each reaches its queue act; bad values, unknown projects and entries are refused before anything runs", async () => {
    const t = setup();
    assert.equal((await t.call("POST", "/api/merge-queue/projects/prj_1/update-local-main")).status, 200);
    assert.equal((await t.call("POST", "/api/merge-queue/entries/mq_1/publish", { title: " T ", body: "B", draft: false })).status, 200);
    assert.equal((await t.call("PUT", "/api/merge-queue/projects/prj_1/land-how", { how: "github-pr", where: "computer" })).status, 200);
    assert.equal((await t.call("DELETE", "/api/merge-queue/projects/prj_1/land-how/override")).status, 200);
    assert.deepEqual(t.calls, ["update", "publish mq_1 T false", "how github-pr computer", "clear"]);
    assert.equal((await t.call("PUT", "/api/merge-queue/projects/prj_1/land-how", { how: "pr", where: "computer" })).status, 400);
    assert.equal((await t.call("PUT", "/api/merge-queue/projects/prj_1/land-how", { how: "local", where: "repo" })).status, 400);
    assert.equal((await t.call("POST", "/api/merge-queue/entries/mq_1/publish", { title: "", body: "B" })).status, 400);
    assert.equal((await t.call("POST", "/api/merge-queue/entries/mq_9/publish", { title: "T", body: "B" })).status, 404);
    assert.equal((await t.call("POST", "/api/merge-queue/projects/prj_9/update-local-main")).status, 404);
    assert.equal(t.calls.length, 4);
  });

  test("a dirty main folder: Update Local Main answers the reason; anyone but the operator's page is refused", async () => {
    const d = await setup({ dirty: true }).call("POST", "/api/merge-queue/projects/prj_1/update-local-main");
    assert.equal(d.status, 400);
    assert.match(String((d.body.error as { message: string }).message), /uncommitted changes/);
    const t = setup({ notPage: "A chat can't publish a request or change how branches land: do it yourself on the Merge Queue tab." });
    for (const [m, p, b] of [
      ["POST", "/api/merge-queue/projects/prj_1/update-local-main", undefined],
      ["POST", "/api/merge-queue/entries/mq_1/publish", { title: "T", body: "B" }],
      ["PUT", "/api/merge-queue/projects/prj_1/land-how", { how: "local", where: "computer" }],
      ["DELETE", "/api/merge-queue/projects/prj_1/land-how/override", undefined],
    ] as const) assert.equal((await t.call(m, p, b)).status, 403);
    assert.deepEqual(t.calls, []);
  });
});
