// Run: pnpm exec tsx --test server/build-restart.test.ts. A coding session's turn cut off by a crash (F-049/F-050's twin):
// after the org opens again, its build chart hears the turn ended, so it is idle (never "working" forever). Throwaway
// workspace; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-build-restart-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const { closeOrgHost, hostOf } = await import("./org-engine");
const { seedBuild } = await import("./org-test-fixtures");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.orgsInfo().orgs) await settled(o.dir);
  rmSync(root, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("a crash mid-turn: after the restart the build's turn is over", async () => {
  const org = await orgs.createOrg({ name: "Builds", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  await seedBuild(org.id, project.id, { sessionId: "c-crash", kind: "coding", worktree: { branch: "sova/crash", base: "main", target: "main" } });
  const sid = `build/${org.id}/${project.id}/c-crash`;
  await hostOf(org.id).act(sid, "turn/started", {}, { by: "system" } as never, { settle: true });
  assert.equal(hostOf(org.id).data(sid)!.turn, "working");
  // The process dies mid-turn: nothing ends it. The org opens again.
  await closeOrgHost(org.id);
  await orgs.openAttachedOrgs();
  await waitFor(() => hostOf(org.id).data(sid)?.turn !== "working");
  assert.ok(hostOf(org.id).configuration(sid)!.includes("turn-idle"), hostOf(org.id).configuration(sid)!.join(","));
});
