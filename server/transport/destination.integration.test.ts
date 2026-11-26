// Cancel on the destination while an arrival rebuilds (§app.transport/switch, §app.transport/arrival "One step at a
// time"): it waits for the rebuild, then removes every stage it made beside the chosen folder; nothing is left in
// the project's folder, and the transport stays cancelled.
import "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { cancel, incomingRoot, retry } from "./destination";
import { packWorktrees, surveyWorktree } from "./git-snapshot";
import { releasePause } from "./hooks";
import { PACKAGE_VERSION } from "./package";
import { createTransport, readTransport } from "./store";

const root = scratchRoot("sova-transport-dest-");
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

test("Cancel while an arrival rebuilds waits for it, then removes the stages it made: nothing is left beside the folder", async () => {
  const src = join(root, "proj");
  mkdirSync(src);
  g(src, "init", "-q", "-b", "master");
  writeFileSync(join(src, "a"), "a\n");
  g(src, "add", "a");
  g(src, "commit", "-qm", "a");
  writeFileSync(join(src, "a"), "a\nchanged\n");
  const tid = "tr_cancelarr1";
  const at = join(incomingRoot(), tid);
  mkdirSync(at, { recursive: true });
  // The package as pulled: its code, and a manifest with no home files to check.
  const p = await packWorktrees({ tid, trees: [await surveyWorktree("proj", src)], haves: [], outDir: join(at, "code") });
  const manifest = {
    v: PACKAGE_VERSION, tid, mode: "copy", chat: { id: "0199eeee-0000-7000-8000-000000000001", title: "t", cwd: src, file: "" },
    source: { nodeLabel: "Desk", stateRoot: "/s", agentDir: "/a", home: "/h", homeDir: "/u", codeRoot: "/c" },
    home: {}, worktrees: p.metas.map((meta) => ({ name: meta.name, path: src, meta })), stopped: { jobs: [], copies: [] }, interrupted: [], wrapped: [],
  };
  writeFileSync(join(at, "package.json"), JSON.stringify(manifest));
  const target = join(root, "there", "proj");
  createTransport({
    tid, side: "destination", mode: "copy", chatId: manifest.chat.id, sourceChatId: manifest.chat.id, title: "t", peer: "desk", peerLabel: "Desk", path: "", folder: target, state: "needs-you",
    pkg: { sha256: "a".repeat(64), size: 1 }, steps: { offered: "t", prepared: "t", pulled: "t" },
    ext: { offer: { trees: [{ name: "proj", branch: "master", main: true, rel: "" }], repoRel: null, project: { remotes: [], roots: [] } } },
  });
  const stages = () => (existsSync(dirname(target)) ? readdirSync(dirname(target)).filter((n) => n.includes(tid)) : []);
  process.env.SOVA_TRANSPORT_PAUSE_AT = "staged";
  try {
    retry({ id: "desk" }, tid);
    // Paused right after the rebuild: its stage is beside the folder.
    for (let i = 0; i < 300 && !stages().length; i++) await sleep(10);
    await sleep(300);
    assert.equal(stages().length, 1, "the rebuild made its stage");
    let done = false;
    const c = cancel({ id: "desk" }, tid).finally(() => (done = true));
    for (let i = 0; i < 300 && !done; i++) {
      releasePause(tid);
      await sleep(20);
    }
    const res = await c;
    assert.equal(res.status, 200, JSON.stringify(res.body));
  } finally {
    delete process.env.SOVA_TRANSPORT_PAUSE_AT;
  }
  // The stopped arrival had its last say before this: give a straggler a moment.
  await sleep(200);
  assert.deepEqual(stages(), [], "no stage left beside the folder");
  assert.ok(!existsSync(target));
  assert.ok(!existsSync(at), "what arrived was removed");
  assert.equal(readTransport(tid)?.state, "cancelled");
});
