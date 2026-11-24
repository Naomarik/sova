// The Transport dialog's "That device still needs" (§app.transport/dialog): the other device is asked
// about the folder its preparation uses, the project's repository when the chat's tree is a linked
// worktree, so a device that already has the project lists nothing and one without it lists the clone.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { previewTransport, setSourceDeps, type SourceDeps } from "./source";

after(dropScratchAgentDir);

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A repository with a linked worktree beside it, the chat's folder in the worktree. */
function linkedWorktree(): { repo: string; tree: string } {
  const root = scratchRoot("transport-source-");
  const repo = join(root, "motors");
  mkdirSync(repo);
  run(repo, "init", "-q", "-b", "master");
  writeFileSync(join(repo, "README.md"), "motors\n");
  run(repo, "add", "README.md");
  run(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "first");
  const tree = join(root, ".worktrees", "motors-feat");
  run(repo, "worktree", "add", "-q", "-b", "feat/x", tree);
  return { repo, tree };
}

/** This device, wired to one other device that answers as prepared in exactly `prepared` (absolute folders). */
function wire(cwd: string, prepared: string[]): { asked: string[] } {
  const asked: string[] = [];
  const there = (p: string) => resolve(p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
  const deps: Partial<SourceDeps> = {
    peers: () => [{ id: "peer-1", label: "laptop-b" }],
    updateNeeded: async () => null,
    chat: async (path) => ({ id: "chat-1", path, title: "A chat", cwd, specialKind: null, inTerminal: false }),
    trackedTrees: async () => [],
    inMergeQueue: async () => false,
    helpers: () => [],
    jobs: () => [],
    copies: () => [],
    peerFetch: async (_peer, path, init) => {
      if (path.endsWith("/hello")) return Response.json({ ok: true });
      const folder = there((JSON.parse(String(init?.body)) as { path: string }).path);
      asked.push(folder);
      return Response.json({ needs: prepared.includes(folder) ? [] : [`${folder} doesn't exist: clone its repository there`], models: [], modelDefault: null });
    },
  };
  setSourceDeps(deps as SourceDeps);
  return { asked };
}

test("a chat in a linked worktree: the device that has the project prepared lists nothing, one without it lists the clone", async () => {
  const { repo, tree } = linkedWorktree();

  const ready = wire(tree, [repo]);
  const p = await previewTransport(join(tree, "chat.jsonl"), "peer-1");
  assert.deepEqual(ready.asked, [repo], "asked about the repository its preparation uses, never the worktree folder");
  assert.deepEqual(p.needs, []);

  const bare = wire(tree, []);
  const q = await previewTransport(join(tree, "chat.jsonl"), "peer-1");
  assert.deepEqual(bare.asked, [repo]);
  assert.equal(q.needs.length, 1);
  assert.match(q.needs[0] ?? "", /clone/);
});
