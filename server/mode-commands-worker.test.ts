// A worker never runs a project mode's commands or hooks (§chat.mode-menu/project-mode-commands,
// §chat.mode-menu/project-mode-hooks): the explicit guard, `notHereFor`, refuses them even when the
// worker's branch has a mode on, approved, sandbox off and a local folder. The runner is a recording
// stand-in (the unit tier starts no process); the checkout is real, under the OS temp dir.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readProjectMode } from "../pi-config/extensions/mode/project-discovery.ts";
import type { ProjectToolRun, RunProjectToolOptions } from "../pi-config/extensions/mode/project-tools.ts";
import type { ProjectModeSnapshot } from "../shared/project-modes";
import { ModeActions, notHereFor, type ModeChatKind } from "./mode-commands";

const base = mkdtempSync(join(tmpdir(), "sova-mode-worker-"));
after(() => rmSync(base, { recursive: true, force: true }));

function checkout() {
  const root = join(base, "repo");
  const dir = join(root, ".sova", "minor-modes", "rel");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  const commands = JSON.stringify([{ name: "echo_args", description: "Echo", run: ["sh", "./echo.sh"] }]);
  const hooks = JSON.stringify([{ on: "turn.ended", run: ["sh", "./hook.sh"] }]);
  writeFileSync(join(dir, "MODE.md"), `---\ndescription: Release\ncommands: ${commands}\nhooks: ${hooks}\n---\nDo the release.\n`);
  for (const f of ["echo.sh", "hook.sh"]) writeFileSync(join(dir, f), "#!/bin/sh\n");
  return { root, copy: readProjectMode(join(root, ".sova", "minor-modes"), "rel") as ProjectModeSnapshot };
}

const RAN: ProjectToolRun = { exitCode: 0, signal: null, stdout: "ok\n", stderr: "", timedOut: false, aborted: false, truncated: { stdout: false, stderr: false }, durationMs: 1 };

/** A chat with mode `rel` on, approved by the user, sandbox off, in a local folder: `kind` decides the rest. */
function chat(kind: Partial<ModeChatKind>) {
  const c = checkout();
  const calls: RunProjectToolOptions[] = [];
  const k: ModeChatKind = { worker: false, special: false, cwd: c.root, remote: () => false, ...kind };
  const actions = new ModeActions(
    {
      sessionId: () => "sess-w",
      cwd: () => c.root,
      projectOn: () => [{ id: "rel", sha: c.copy.sha }],
      copies: () => new Map([[c.copy.sha, c.copy]]),
      sandboxOn: () => false,
      notHere: () => notHereFor(k),
      approved: () => true,
      approvedByUser: () => true,
    },
    { log: () => {}, run: async (o) => (calls.push(o), RAN) },
  );
  return { actions, calls };
}

const tick = async (k = 3) => {
  for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r));
};

test("the guard: a worker is refused first, whatever else it is; a coding chat in a local folder is not", () => {
  assert.equal(notHereFor({ worker: true, special: false, cwd: "/repo", remote: () => false }), "this chat is a worker.");
  assert.equal(notHereFor({ worker: true, special: true, cwd: undefined, remote: () => true }), "this chat is a worker.");
  assert.equal(notHereFor({ worker: false, special: true, cwd: "/repo", remote: () => false }), "this chat can't run project mode programs.");
  assert.equal(notHereFor({ worker: false, special: false, cwd: "/repo", remote: () => true }), "this chat has no local folder.");
  assert.equal(notHereFor({ worker: false, special: false, cwd: "/repo", remote: () => false }), null);
});

test("a worker with a mode on in its branch: its command is refused (409) and its hook never runs", async () => {
  const w = chat({ worker: true });
  const got = await w.actions.runCommand("rel", "echo_args", {});
  assert.ok(!got.ok);
  assert.equal(got.status, 409);
  assert.equal(got.error, "mode.rel.echo_args wasn't run: this chat is a worker.");
  w.actions.turnStarted();
  w.actions.turnSettled();
  await tick();
  assert.equal(w.calls.length, 0, "nothing ran");
});

test("the same chat not a worker runs both (the rig itself can run them)", async () => {
  const c = chat({});
  assert.ok((await c.actions.runCommand("rel", "echo_args", {})).ok);
  c.actions.turnStarted();
  c.actions.turnSettled();
  await tick();
  assert.equal(c.calls.length, 2);
});
