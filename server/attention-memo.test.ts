// Run: pnpm exec tsx --test server/attention-memo.test.ts. An org or baton write that lands drops
// the attention digest's memo, so Needs you's re-read right after it is fresh. A throwaway
// PI_CODING_AGENT_DIR and workspaces in the OS temp dir, deleted after; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-attention-memo-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const { onAttentionChanged } = await import("./attention-memo");
const { registerOrgRoutes } = await import("./org-routes");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.orgsInfo().orgs) await settled(o.dir);
  rmSync(root, { recursive: true, force: true });
});

const app = new Hono();
registerOrgRoutes(app);
const send = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("a write that lands drops the digest memo; a read or a refused write doesn't", async () => {
  let drops = 0;
  onAttentionChanged(() => drops++);
  const made = await send("POST", "/api/orgs", { name: "Acme", dir: join(root, "ws-acme") });
  assert.ok(made.ok);
  assert.equal(drops, 1);
  const { id } = (await made.json()) as { id: string };
  assert.equal((await send("GET", `/api/orgs/${id}`)).status, 200);
  assert.equal(drops, 1, "a read changes nothing");
  assert.equal((await send("POST", `/api/orgs/${id}/people`, { name: "" })).status, 400);
  assert.equal(drops, 1, "a refused write changes nothing");
  assert.ok((await send("POST", `/api/orgs/${id}/people`, { name: "Maria Lopez", status: "active" })).ok);
  assert.equal(drops, 2);
});
