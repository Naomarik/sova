// A worktree's running copy is torn down before the worktree goes (§app.project-overseer/coding-worktrees):
// the registry lookup, the operator's confirmed teardown and the refusal. A temp PI_CODING_AGENT_DIR, a fake engine.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { VerbResult } from "../../shared/project-contract";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-copy-teardown-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent"), { recursive: true });
mkdirSync(join(root, "wt"));

const { mutateRegistry } = await import("./store");
const { teardownCopyOf, CopyTeardownFailed } = await import("./checkout-teardown");
type Engine = Parameters<typeof teardownCopyOf>[1];

mutateRegistry((r) => {
  const base = { project: join(root, "main"), branch: "b", generation: 1, createdBy: "operator", createdAt: "2026-10-03T00:00:00Z", cutWorktree: false, desired: {}, prints: {}, data: {}, ports: {} };
  r.instances.push({ ...base, id: "main-00000000", checkout: join(root, "main"), slot: 0 }, { ...base, id: "main-11111111", checkout: join(root, "wt"), slot: 1 });
});

function fakeEngine(error?: VerbResult["error"]) {
  const calls: unknown[] = [];
  const engine = { run: async (verb: string, body: unknown, caller: unknown) => (calls.push({ verb, body, caller }), { error }) } as unknown as Engine;
  return { engine, calls };
}

test("the copy running the worktree is torn down as the operator, confirmed; none, or the main checkout's, is left alone", async () => {
  const ok = fakeEngine();
  assert.equal(await teardownCopyOf(join(root, "wt"), ok.engine), "main-11111111");
  assert.deepEqual(ok.calls, [{ verb: "teardown", body: { instance: "main-11111111", confirm: true }, caller: { kind: "operator", confirm: true } }]);
  assert.equal(await teardownCopyOf(join(root, "elsewhere"), ok.engine), null);
  assert.equal(await teardownCopyOf(join(root, "main"), ok.engine), null, "slot 0 is never torn down here");
  assert.equal(ok.calls.length, 1);
});

test("a teardown that fails throws its reason", async () => {
  const bad = fakeEngine({ code: "busy", message: "another verb is running on this instance" });
  await assert.rejects(() => teardownCopyOf(join(root, "wt"), bad.engine), (err: unknown) => err instanceof CopyTeardownFailed && err.message === "Its running copy could not be torn down: busy: another verb is running on this instance");
});
