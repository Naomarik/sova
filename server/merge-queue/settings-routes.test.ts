import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Hono } from "hono";
import { SETTINGS_DIRTY_WORDS, type MergeSettingsChange } from "../../shared/merge-queue-settings";
import { readModels } from "./models";
import { MergeFailure } from "./queue";
import { registerMergeSettingsRoutes, settingsQueueOf, type SettingsQueue } from "./settings-routes";
import { NOT_SERVED } from "./served";
import { scratchRoot } from "../test-scratch";

// §app.merge-queue/settings-save, §app.merge-queue/models

function setup(o: { notPage?: string | null; dirty?: boolean } = {}) {
  const dir = scratchRoot("mq-settings-routes-");
  const saved: MergeSettingsChange[] = [];
  let changed = 0;
  const q: SettingsQueue = {
    store: { dir },
    settings: async () => ({ at: "abc" }) as never,
    async saveSettings(c) {
      if (o.dirty) throw new MergeFailure("invalid-request", SETTINGS_DIRTY_WORDS);
      saved.push(c);
      return { state: "saved", commit: "c0ffee", pushed: false };
    },
    cancelPendingSave: async () => true,
    settingsChanged: () => void changed++,
  };
  const app = new Hono();
  registerMergeSettingsRoutes(app, {
    queueOf: async (id) => (id === "prj_1" ? q : id === "prj_u" ? { unserved: "/unserved" } : null),
    bareSettings: async (root) => (root === "/unserved" ? ({ at: "bare", how: { suggested: { how: "github-pr", why: "origin is on GitHub" } } } as never) : null),
    modelCheck: { defaults: () => ({ model: "claude-code-cli/claude-opus-5-5", thinking: "medium" }), denial: (ref) => (ref === "off/model" ? "off/model is turned off in Settings → Models and can't be used." : null) },
    notPage: () => o.notPage ?? null,
  });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
  return { app, call, saved, dir, changed: () => changed };
}

describe("saving settings", () => {
  test("confirmed: the queue's save answers; unconfirmed, unknown keys and an unknown project are refused", async () => {
    const t = setup();
    const ok = await t.call("POST", "/api/merge-queue/projects/prj_1/settings", { changes: { push: false }, confirm: true });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { state: "saved", commit: "c0ffee", pushed: false });
    assert.deepEqual(t.saved, [{ push: false }]);
    const noConfirm = await t.call("POST", "/api/merge-queue/projects/prj_1/settings", { changes: { push: false } });
    assert.equal(noConfirm.status, 409);
    assert.equal(((await noConfirm.json()) as { error: { code: string } }).error.code, "needs-confirm");
    const bad = await t.call("POST", "/api/merge-queue/projects/prj_1/settings", { changes: { target: "main" }, confirm: true });
    assert.equal(bad.status, 400);
    assert.equal((await t.call("POST", "/api/merge-queue/projects/prj_2/settings", { changes: { push: false }, confirm: true })).status, 404);
    assert.equal(t.saved.length, 1);
  });

  test("a dirty settings file answers its own code with the words", async () => {
    const t = setup({ dirty: true });
    const r = await t.call("POST", "/api/merge-queue/projects/prj_1/settings", { changes: { push: false }, confirm: true });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: { code: "dirty", message: SETTINGS_DIRTY_WORDS } });
  });

  test("writes are the operator's own page's; reads aren't", async () => {
    const t = setup({ notPage: "A chat can't change the merge queue's settings." });
    for (const [m, p, b] of [
      ["POST", "/api/merge-queue/projects/prj_1/settings", { changes: { push: false }, confirm: true }],
      ["PUT", "/api/merge-queue/projects/prj_1/models", { review: null }],
      ["DELETE", "/api/merge-queue/projects/prj_1/settings/pending", undefined],
    ] as const) {
      const r = await t.call(m, p, b);
      assert.equal(r.status, 400, `${m} ${p}`);
      assert.equal(((await r.json()) as { error: { code: string } }).error.code, "forbidden");
    }
    assert.equal(t.saved.length, 0);
    assert.equal((await t.call("GET", "/api/merge-queue/projects/prj_1/settings")).status, 200);
  });

  test("cancel answers whether one waited", async () => {
    const t = setup();
    assert.deepEqual(await (await t.call("DELETE", "/api/merge-queue/projects/prj_1/settings/pending")).json(), { cancelled: true });
  });
});

describe("the models", () => {
  test("set, answered as what the next chat starts on; null clears; a model turned off is refused", async () => {
    const t = setup();
    const r = await t.call("PUT", "/api/merge-queue/projects/prj_1/models", { review: { model: "zai/glm-5.3", thinking: "low" } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      review: { picked: { model: "zai/glm-5.3", thinking: "low" }, effective: { model: "zai/glm-5.3", thinking: "low" } },
      thread: { picked: null, effective: { model: "claude-code-cli/claude-opus-5-5", thinking: "medium" } },
    });
    assert.deepEqual(readModels(t.dir), { review: { model: "zai/glm-5.3", thinking: "low" } });
    assert.equal(t.changed(), 1);
    const off = await t.call("PUT", "/api/merge-queue/projects/prj_1/models", { thread: { model: "off/model" } });
    assert.equal(off.status, 400);
    assert.match(((await off.json()) as { error: { message: string } }).error.message, /turned off/);
    await t.call("PUT", "/api/merge-queue/projects/prj_1/models", { review: null });
    assert.deepEqual(readModels(t.dir), {});
    assert.equal((await t.call("PUT", "/api/merge-queue/projects/prj_1/models", { review: { model: "nope" } })).status, 400);
    assert.equal((await t.call("PUT", "/api/merge-queue/projects/prj_1/models", {})).status, 400);
  });
});

describe("a project the queue doesn't serve yet", () => {
  test("its settings read without a queue (with How it lands' suggestion); every write is refused with NOT_SERVED", async () => {
    const t = setup();
    const g = await t.call("GET", "/api/merge-queue/projects/prj_u/settings");
    assert.equal(g.status, 200);
    assert.deepEqual(await g.json(), { at: "bare", how: { suggested: { how: "github-pr", why: "origin is on GitHub" } } });
    for (const [m, p, b] of [
      ["POST", "/api/merge-queue/projects/prj_u/settings", { changes: { push: false }, confirm: true }],
      ["PUT", "/api/merge-queue/projects/prj_u/models", { review: { model: "zai/glm-5.3" } }],
      ["DELETE", "/api/merge-queue/projects/prj_u/settings/pending", undefined],
    ] as const) {
      const r = await t.call(m, p, b);
      assert.equal(r.status, 400, `${m} ${p}`);
      assert.deepEqual(await r.json(), { error: { code: "unsupported", message: NOT_SERVED } });
    }
    assert.equal(t.saved.length, 0);
  });

  test("settingsQueueOf loads a queue only for a served root", async () => {
    const got: string[] = [];
    const queues = { get: async (root: string) => (got.push(root), {} as SettingsQueue) };
    assert.deepEqual(await settingsQueueOf("/u", { served: async () => false, queues }), { unserved: "/u" });
    assert.deepEqual(got, [], "no queue made for an unserved root");
    await settingsQueueOf("/s", { served: async () => true, queues });
    assert.deepEqual(got, ["/s"]);
    assert.equal(await settingsQueueOf(null, { served: async () => true, queues }), null);
  });
});
