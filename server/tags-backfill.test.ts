// Run: npx tsx --test server/tags-backfill.test.ts
// The session tags route: manual tags only. Automatic tags and their backfill are retired
// (§app.decisions/session-tags, §app.decisions/backfill): no backfill route, nothing asked of a
// decision provider. Uses a throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-tags-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const bf = await import("./tags-backfill");
after(() => rmSync(agentDir, { recursive: true, force: true }));

test("routes: manual tags set and clear; the backfill routes are gone", async () => {
  const { Hono } = await import("hono");
  const app = new Hono();
  app.route("/api/sessions/tags", bf.tagRoutes);
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const ok = await post("/api/sessions/tags", { id: "some-id", user: ["#Later", "later"] });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { tags: { user: ["later"] } });
  const cleared = await post("/api/sessions/tags", { id: "some-id", user: null });
  assert.deepEqual(await cleared.json(), { tags: null });
  assert.equal((await post("/api/sessions/tags", { id: "some-id", user: ["no spaces"] })).status, 400);
  assert.equal((await post("/api/sessions/tags", { user: [] })).status, 400);
  assert.equal((await post("/api/sessions/tags", [1])).status, 400);

  assert.equal((await post("/api/sessions/tags/backfill", { scope: "recent" })).status, 404);
  assert.equal((await app.request("/api/sessions/tags/backfill")).status, 404);
  assert.equal((await post("/api/sessions/tags/backfill/cancel", {})).status, 404);
  assert.deepEqual(Object.keys(bf).sort(), ["tagRoutes"], "no tagger, live pass or backfill job left to start");
});
