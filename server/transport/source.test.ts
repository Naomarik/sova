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

test("Cancel pressed while the chat is opening there (a 409 'publishing'): nothing is called off here, the transport is followed to its end and the Move finishes", async () => {
  const { cancelTransport } = await import("./source");
  const { createTransport, readTransport } = await import("./store");
  const tid = "tr_srccancel1";
  createTransport({ tid, side: "source", mode: "move", chatId: "chat-c1", sourceChatId: "chat-c1", title: "t", peer: "peer-1", peerLabel: "laptop-b", path: "/x.jsonl", folder: "~/x", state: "switching", decided: true, steps: { offered: "t", packed: "t", decided: "t" } });
  let opened = false;
  const moved: string[] = [];
  const deps: Partial<SourceDeps> = {
    peers: () => [{ id: "peer-1", label: "laptop-b" }],
    moved: async (r) => void moved.push(r.tid),
    peerFetch: async (_peer, path) => {
      if (path.endsWith("/cancel")) return Response.json({ error: "It is opening here right now, so it can't be cancelled; it arrives in a moment.", publishing: true }, { status: 409 });
      if (path.endsWith("/commit")) return Response.json({ ok: true });
      // The status: verified until the commit there finishes, then opened.
      return Response.json(opened ? { tid, state: "done", steps: { verified: "t", opened: "t" }, arrivedId: "chat-c1", path: "/there.jsonl" } : { tid, state: "switching", steps: { verified: "t" } });
    },
  };
  setSourceDeps(deps as SourceDeps);
  const res = await cancelTransport(tid);
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error ?? "", /opening on laptop-b/);
  assert.notEqual(readTransport(tid)?.state, "cancelled", "never cancelled here while it goes in there");
  opened = true;
  for (let i = 0; i < 300 && readTransport(tid)?.state !== "done"; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(readTransport(tid)?.state, "done", "the Move finished here");
  assert.deepEqual(moved, [tid], "its Moved mark and retire ran");
});

test("Cancel after the decision that the other device refuses for any other reason is not called off here either", async () => {
  const { cancelTransport } = await import("./source");
  const { createTransport, readTransport, updateTransport } = await import("./store");
  const tid = "tr_srccancel2";
  createTransport({ tid, side: "source", mode: "move", chatId: "chat-c2", sourceChatId: "chat-c2", title: "t", peer: "peer-1", peerLabel: "laptop-b", path: "/y.jsonl", folder: "~/y", state: "switching", decided: true, steps: { offered: "t", packed: "t", decided: "t" } });
  const deps: Partial<SourceDeps> = {
    peers: () => [{ id: "peer-1", label: "laptop-b" }],
    moved: async () => {},
    peerFetch: async (_peer, path) => (path.endsWith("/cancel") ? Response.json({ error: "Forbidden" }, { status: 403 }) : Response.json({ tid, state: "needs-you", steps: { verified: "t" }, needsYou: "x" })),
  };
  setSourceDeps(deps as SourceDeps);
  const res = await cancelTransport(tid);
  assert.equal(res.ok, false);
  assert.notEqual(readTransport(tid)?.state, "cancelled");
  updateTransport(tid, { state: "needs-you" });
});
