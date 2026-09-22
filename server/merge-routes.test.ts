// Merge integration pins. Isolated stores, ephemeral listener, no prompts/model calls.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "pi-web-merge-routes-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PORT = "0";
const { app, server } = await import("./index");
const { assignSession, readGroup } = await import("./session-groups");
const { legacyMountsRoot, targetDir, writeTargets } = await import("./targets");
const { realFanoutDeps } = await import("./fanout");
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  rmSync(dir, { recursive: true, force: true });
});
const request = (method: string, path: string, body: unknown) => app.request(path, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("merge routes: seven required registrations exist exactly once; mount endpoint is absent", () => {
  const required = [
    ["POST", "/api/session-groups/fanout"],
    ["PATCH", "/api/session-groups/:id"],
    ["POST", "/api/session-groups/:id/prompt"],
    ["POST", "/api/session-groups/assign"],
    ["GET", "/api/themes"],
    ["POST", "/api/insights/usage/refresh"],
    ["POST", "/api/sessions"],
    ["GET", "/api/session-groups"],
    ["POST", "/api/session-groups"],
    ["DELETE", "/api/session-groups/:id"],
  ];
  for (const [method, path] of required) {
    assert.equal(app.routes.filter((r) => r.method === method && r.path === path).length, 1, `${method} ${path}`);
  }
  assert.equal(app.routes.filter((r) => r.path === "/api/targets/:name/mount").length, 0);
});

test("merged handlers keep group name/order/labels and fileless assign removal", async () => {
  const created = await request("POST", "/api/session-groups", { name: "Merge group" });
  assert.equal(created.status, 201);
  const group = await created.json() as { id: string };
  // Store-only members: deliberately no file to resolve for the removal gesture.
  assert.ok(assignSession("gone-a", group.id).ok);
  assert.ok(assignSession("gone-b", group.id).ok);
  const patched = await request("PATCH", `/api/session-groups/${group.id}`, {
    name: "Renamed", order: ["gone-b", "gone-a"], labels: [{ id: "gone-b", label: "control" }],
  });
  assert.equal(patched.status, 200);
  assert.equal(readGroup(group.id)?.name, "Renamed");
  assert.deepEqual(readGroup(group.id)?.members, [{ id: "gone-b", label: "control" }, { id: "gone-a" }]);
  for (const extra of [{ groupId: group.id }, { path: "/missing.jsonl" }, { label: "x" }, { index: 0 }]) {
    assert.equal((await request("POST", "/api/session-groups/assign", { id: "gone-b", groupId: null, ...extra })).status, 400);
  }
  assert.equal((await request("POST", "/api/session-groups/assign", { id: "gone-b", groupId: null })).status, 200);
  assert.deepEqual(readGroup(group.id)?.members, [{ id: "gone-a" }]);
  assert.equal((await request("POST", `/api/session-groups/${group.id}/prompt`, { text: "" })).status, 400);
  assert.equal((await request("POST", "/api/session-groups/fanout", {})).status, 400);
});

test("merged sessions use shared cwd refusal and placeholders, never mounted creation", async () => {
  const legacy = join(legacyMountsRoot(), "box", "work");
  assert.equal(existsSync(legacy), false);
  const expected = await realFanoutDeps.validateCwd(legacy);
  assert.match(expected!, /removed sshfs mount/);
  const refused = await request("POST", "/api/sessions", { cwd: legacy });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json() as { error: string }).error, expected);
  assert.equal(existsSync(legacy), false, "refusal never makes a cwd");
  writeTargets([{ name: "box", kind: "docker", docker: { container: "not-executed" } }]);
  const remote = await request("POST", "/api/sessions", { target: "box", remoteCwd: "/work", mounted: true });
  assert.equal(remote.status, 201);
  const summary = await remote.json() as { cwd: string; mounted?: unknown };
  assert.equal(summary.cwd, targetDir("box", "/work"), "unknown mounted field cannot select a removed capability");
  assert.equal("mounted" in summary, false);
  assert.equal((await request("POST", "/api/targets/box/mount", { on: true })).status, 404);
  assert.equal((await request("POST", "/api/sessions", { cwd: dir })).status, 201);
  assert.equal((await app.request("/api/themes")).status, 200);
});
