// The project page's first read never waits on git (§app.project-overseer/coding-worktrees, "Read in
// two steps"; §app.organizations/project-page, "Shows up at once"): with every worktree reading held
// for 2 s, GET …/overseer still answers the overseer's own state (exists, busy) at once, and
// GET …/overseer/worktrees is the read that waits. Wall-clock time is measured, so this is the
// integration tier. A throwaway PI_CODING_AGENT_DIR and git client project in the OS temp dir.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { scratchRoot } from "./test-scratch";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = scratchRoot("sova-po-fast-");
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [resolve(here, "../pi-config/extensions/mode")] }));
process.env.PI_CODING_AGENT_DIR = agentDir;
await import("./testing/in-process-chats");
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const orgs = await import("./orgs");
const po = await import("./project-overseer");
const { readWorktree } = await import("./project-worktrees");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { seedBuild } = await import("./org-test-fixtures");
import type { ProjectOverseerInfo, ProjectWorktrees } from "../shared/project-overseer";

after(async () => {
  po.setWorktreeReaderForTest(null);
  await disposeAllChats();
  await settled(join(tmp, "ws"));
  rmSync(tmp, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const SLOW_MS = 2000;

describe("the project page's first read", async () => {
  const org = await orgs.createOrg({ name: "Fast", dir: join(tmp, "ws") });
  const client = join(tmp, "src", "client");
  mkdirSync(client, { recursive: true });
  writeFileSync(join(client, "README.md"), "hi\n");
  git(client, "init", "-q", "-b", "master");
  git(client, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", "add", "-A");
  git(client, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  const project = await orgs.addProject(org.id, { name: "Portal", root: client });

  test("GET …/overseer answers exists and busy in under 200 ms while every worktree reading takes 2 s", async () => {
    // A New Coding Session (its own worktree) and a few recorded ones: rows a git read would visit.
    const made = await po.startCoding(project.id, {});
    assert.ok(made.worktree, "a worktree was cut");
    const head = git(client, "rev-parse", "HEAD");
    for (let i = 0; i < 4; i++)
      await seedBuild(org.id, project.id, { sessionId: `01a0e321-a85c-74d4-9349-c48f99e8330${i}`, kind: "operator-coding", title: `Row ${i}`, worktree: { path: join(tmp, "src", ".worktrees", `client-r${i}`), branch: `sova/r${i}-abc12${i}`, base: head, target: "master" } });
    // Warm: the routes and the session index are loaded once, as on a running server.
    assert.equal((await app.request(`/api/projects/${project.id}/overseer`)).status, 200);

    let readings = 0;
    po.setWorktreeReaderForTest(async (w, root) => {
      readings++;
      await new Promise((r) => setTimeout(r, SLOW_MS));
      return readWorktree(w, root);
    });
    try {
      const t0 = performance.now();
      const res = await app.request(`/api/projects/${project.id}/overseer`);
      const ms = performance.now() - t0;
      assert.equal(res.status, 200);
      const info = (await res.json()) as ProjectOverseerInfo;
      assert.ok(ms < 200, `the overseer's own state took ${ms.toFixed(0)} ms`);
      assert.equal(readings, 0, "no worktree was read for it");
      assert.equal(typeof info.exists, "boolean");
      assert.equal(typeof info.busy, "boolean");
      const row = info.coding.find((c) => c.sessionId === made.sessionId);
      assert.deepEqual(row && { branch: row.branch, startedBy: row.startedBy }, { branch: made.worktree!.branch, startedBy: "operator" }, "the row and its recorded branch, with no git");
      assert.equal(info.coding.length, 5);
      assert.ok(!("state" in row! || "merged" in row! || "ahead" in row!), "no git facts in the first read");

      // The case being ruled out: the stub is what the branch read waits on.
      const t1 = performance.now();
      const wres = await app.request(`/api/projects/${project.id}/overseer/worktrees`);
      const wms = performance.now() - t1;
      assert.equal(wres.status, 200);
      const wt = (await wres.json()) as ProjectWorktrees;
      assert.ok(wms >= SLOW_MS - 50, `the branch read waited on git (${wms.toFixed(0)} ms)`);
      assert.ok(wms < SLOW_MS * 3, `side by side, not one after another (${wms.toFixed(0)} ms for 5 rows)`);
      assert.equal(readings, 5);
      assert.equal(wt.available, true);
      assert.equal(wt.sessions.find((s) => s.sessionId === made.sessionId)?.state, "open");
    } finally {
      po.setWorktreeReaderForTest(null);
    }
  });
});
