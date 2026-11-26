// The destination's side of a transport (§app.transport/arrival, §app.transport/switch, §app.transport/edge-cases):
// the offer's places all pass the folder check; group membership never travels, the archive mark does; the commit
// runs once at a time and Cancel can't run over it or take back what is in place.
import "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { chatHome, ensureChatHome } from "../chat-homes/root";
import { stateRoot } from "../state-root";
import { cancel, commit, fixManifest, incomingRoot, placesRefusal, setDestinationDeps, takeOffer } from "./destination";
import { releasePause } from "./hooks";
import { createTransport, readTransport } from "./store";

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
let n = 0;
const nextTid = () => `tr_dest${String(++n).padStart(4, "0")}`;
const nextId = () => `0199dddd-0000-7000-8000-${String(n).padStart(12, "0")}`;

const counts = { adopt: 0, opened: 0 };
setDestinationDeps({
  peerFetch: async () => new Response("{}"),
  clickProven: async () => true,
  adopt: () => void counts.adopt++,
  cameBack: () => {},
  openWithNote: async () => void counts.opened++,
  tellHelper: async () => {},
  helperNote: () => "",
  importUsage: () => ({}),
});

const offer = (tid: string, over: Record<string, unknown>) =>
  JSON.stringify({ v: 1, tid, ticket: "x".repeat(40), mode: "copy", chat: { id: nextId(), title: "t" }, folder: join(homedir(), "proj", "wt"), trees: [{ name: "wt", branch: "feat", main: false, rel: "" }], repoRel: "../repo", project: { remotes: [], roots: [] }, ...over });

test("an offer naming a repository or a worktree outside the chosen folder's reach is refused before anything is made", async () => {
  mkdirSync(join(homedir(), "proj"), { recursive: true });
  mkdirSync(join(homedir(), ".ssh"), { recursive: true });
  if (!existsSync(join(homedir(), "proj", "link"))) symlinkSync(join(homedir(), ".ssh"), join(homedir(), "proj", "link"));
  // A link inside the home that points out of it: a path through it is outside, though it reads as inside.
  if (!existsSync(join(homedir(), "proj", "out"))) symlinkSync("/", join(homedir(), "proj", "out"));
  const cases: [string, Record<string, unknown>][] = [
    ["an absolute repository path", { repoRel: join(homedir(), ".config", "x") }],
    ["a repository inside Sova's own state", { repoRel: relative(join(homedir(), "proj"), join(stateRoot(), "evil")) }],
    ["a repository outside this user's home", { repoRel: relative(join(homedir(), "proj"), "/tmp/evil-repo") }],
    ["a worktree under a link that leaves the folder's parent", { trees: [{ name: "wt", branch: "feat", main: false, rel: "" }, { name: "w2", branch: "b", main: false, rel: "link/w" }] }],
    ["a worktree path climbing out", { trees: [{ name: "w2", branch: "b", main: false, rel: "../x" }] }],
    ["a repository through a link leaving the home", { repoRel: "out/var/evil-repo" }],
    ["a chosen folder through a link leaving the home", { folder: join(homedir(), "proj", "out", "var", "evil", "wt"), repoRel: null }],
  ];
  for (const [what, over] of cases) {
    const tid = nextTid();
    const res = await takeOffer({ id: "desk", label: "Desk" }, offer(tid, over), "proof");
    assert.equal(res.status, 400, `${what}: ${JSON.stringify(res.body)}`);
    assert.equal(readTransport(tid), null, `${what}: no transport was made`);
  }
  // The layout Sova's own worktrees have (the repository beside the worktrees' folder) is fine.
  assert.equal(placesRefusal(join(homedir(), "webapps", ".worktrees", "sova-x"), [{ rel: "" }, { rel: "sova-y" }], "../sova"), null);
  assert.equal(placesRefusal(join(homedir(), "proj", "wt"), [{ rel: "" }], null), null);
});

test("an arrived home drops its group membership and keeps its archive mark", async () => {
  const { assignSession, createGroup, readAssignments } = await import("../session-groups");
  const { setArchived } = await import("../archived-sessions");
  const id = nextId();
  const home = ensureChatHome(id);
  const g = createGroup("travels not");
  assert.ok(g.ok);
  assert.deepEqual(assignSession(id, g.group.id), { ok: true });
  setArchived(id, true);
  assert.equal(readAssignments()[id], g.group.id);
  const meta = join(home, "chat", "meta.json");
  const before = JSON.parse(readFileSync(meta, "utf8")) as Record<string, unknown>;
  const field = Object.keys(before).find((k) => JSON.stringify(before[k]).includes(g.group.id));
  assert.ok(field, "the membership is in the home's record");
  await fixManifest(home, id, "move");
  const after = JSON.parse(readFileSync(meta, "utf8")) as Record<string, unknown>;
  assert.ok(!JSON.stringify(after).includes(g.group.id), "no group of the other device's is named any more");
  assert.equal(JSON.stringify(after["archived-sessions.json"]), JSON.stringify(before["archived-sessions.json"]), "the archive mark travels");
});

/** A verified destination transport with its home staged, ready for the source's commit. */
function verified(): { tid: string; id: string } {
  const tid = nextTid();
  const id = nextId();
  const made = ensureChatHome(id);
  writeFileSync(join(made, "sessions", `2026-01-01T00-00-00-000Z_${id}.jsonl`), `${JSON.stringify({ type: "session", id })}\n`);
  mkdirSync(join(incomingRoot(), tid), { recursive: true });
  renameSync(made, join(incomingRoot(), tid, "home"));
  createTransport({
    tid, side: "destination", mode: "move", chatId: id, sourceChatId: id, title: "t", peer: "desk", peerLabel: "Desk", path: "", folder: "/x", state: "switching", arrivedId: id,
    steps: { offered: "t", prepared: "t", pulled: "t", staged: "t", verified: "t" },
    ext: { offer: { trees: [], repoRel: null, project: { remotes: [], roots: [] } } },
  });
  return { tid, id };
}

test("the source's commit posted again while one runs gets that one's answer: it publishes and opens once, and Cancel is refused meanwhile", async () => {
  const { tid, id } = verified();
  const was = { ...counts };
  process.env.SOVA_TRANSPORT_PAUSE_AT = "published";
  let settled = 0;
  try {
    const first = commit({ id: "desk" }, tid, {}).finally(() => settled++);
    // Paused right after the home went in, before the publish is recorded: the window Cancel used to run in.
    for (let i = 0; i < 200 && !existsSync(chatHome(id)); i++) await sleep(10);
    assert.ok(existsSync(chatHome(id)), "the home is in place");
    const again = commit({ id: "desk" }, tid, {}).finally(() => settled++);
    await sleep(50);
    const c = await cancel({ id: "desk" }, tid);
    assert.equal(c.status, 409, JSON.stringify(c.body));
    assert.notEqual(readTransport(tid)?.state, "cancelled");
    for (let i = 0; i < 200 && settled < 2; i++) {
      releasePause(tid);
      await sleep(20);
    }
    const [a, b] = await Promise.all([first, again]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
  } finally {
    delete process.env.SOVA_TRANSPORT_PAUSE_AT;
  }
  assert.equal(counts.adopt - was.adopt, 1, "adopted once");
  assert.equal(counts.opened - was.opened, 1, "opened once");
  assert.equal(readTransport(tid)?.state, "done");
  assert.ok(existsSync(chatHome(id)));
});

test("Cancel after a publish that stopped partway is refused with the reason: the code in place stays, Retry finishes it", async () => {
  const { tid } = verified();
  const target = join(homedir(), "proj", "moved-wt");
  const { updateTransport } = await import("./store");
  // The tree's move began and its stage is gone (it is in its folder): the record of it being done never came.
  updateTransport(tid, { ext: { staged: [{ name: "wt", target, stage: join(homedir(), "proj", `.incoming-${tid}-moved-wt`), branch: "feat", main: false }], publish: { begun: [target], done: [] } } });
  const c = await cancel({ id: "desk" }, tid);
  assert.equal(c.status, 409, JSON.stringify(c.body));
  assert.match(String((c.body as { error?: string }).error), /Retry/);
  assert.equal(readTransport(tid)?.state, "switching");
  assert.ok(existsSync(join(incomingRoot(), tid, "home")), "nothing that arrived was removed");
});

test("Cancel before anything is in place removes what arrived, and a commit after it is refused", async () => {
  const { tid, id } = verified();
  const c = await cancel({ id: "desk" }, tid);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(readTransport(tid)?.state, "cancelled");
  assert.ok(!existsSync(join(incomingRoot(), tid)));
  const res = await commit({ id: "desk" }, tid, {});
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.ok(!existsSync(chatHome(id)), "nothing was published");
});
