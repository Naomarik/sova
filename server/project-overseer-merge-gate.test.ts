// POST /api/projects/:pid/overseer/worktrees/merge lands a coding session's branch (a Land once the merge queue serves
// the project): only the user's own page takes it (§app.access/your-click). A script's token in a header, a chat's key
// (blank included), or nothing that shows the page: refused before anything is read. The page passes the gate.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratchRoot } from "./test-scratch";

const root = scratchRoot("sova-po-merge-gate-");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sova"), { recursive: true });

const { Hono } = await import("hono");
const { registerProjectOverseerRoutes } = await import("./project-overseer-routes");
const { PAGE_IS_THE_USERS } = await import("./merge-queue/routes");
const { AUTH_COOKIE, initAuthToken } = await import("./auth");

test("the Overseer's Merge on a coding worktree is the user's page only", async () => {
  const app = new Hono();
  registerProjectOverseerRoutes(app);
  const post = async (headers: Record<string, string>) => {
    const r = await app.request("/api/projects/prj_nosuch/overseer/worktrees/merge", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ sessionId: "s1" }) });
    return { status: r.status, error: ((await r.json()) as { error?: string }).error };
  };
  const token = initAuthToken().token!;
  const cases: Record<string, string>[] = [{ "x-sova-token": token }, { "x-sova-caller": "k" }, { "x-sova-caller": "" }, {}, { "x-sova-caller": "k", cookie: `${AUTH_COOKIE}=${token}` }];
  for (const headers of cases) {
    assert.deepEqual(await post(headers), { status: 403, error: PAGE_IS_THE_USERS }, JSON.stringify(Object.keys(headers)));
  }
  // The page's own cookie passes the gate; the route's own checks answer (no such project).
  const page = await post({ cookie: `${AUTH_COOKIE}=${token}` });
  assert.notEqual(page.status, 403, JSON.stringify(page));
});
