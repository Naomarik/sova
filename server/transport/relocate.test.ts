// An arrived home points at this device (§app.transport/arrival, "Paths rebuilt"): a worker record's
// conversation, parent, folder, agent dir, extensions and environment; a conversation's header and
// its extensions' state (a tracked worktree, a worker's session file), while what was said stays
// verbatim; a Copy's conversations get ids of their own. Run twice, it changes nothing more.
import "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { findConversation, relocateHome } from "./relocate";

const root = scratchRoot("sova-transport-relocate-");
after(() => rmSync(root, { recursive: true, force: true }));

const OLD_HOME = "/home/a/.local/state/sova/chats/k1/L1";
const OLD_TREE = "/home/a/webapps/.worktrees/x";
const NEW_HOME = "/Users/b/.local/state/sova/chats/k2/L1";
const NEW_TREE = "/Users/b/code/.worktrees/x";
const map = [
  [OLD_HOME, NEW_HOME],
  [OLD_TREE, NEW_TREE],
] as const;
const broad = [
  ["/home/a/.pi/agent", "/Users/b/.pi/agent"],
  ["/home/a", "/Users/b"],
] as const;
const CODE = "/Users/b/sova";

function home(name: string): string {
  const h = join(root, name);
  mkdirSync(join(h, "sessions"), { recursive: true });
  mkdirSync(join(h, "workers"), { recursive: true });
  mkdirSync(join(h, "wakes"), { recursive: true });
  const lead = [
    { type: "session", version: 3, id: "L1", timestamp: "t", cwd: OLD_TREE },
    { type: "message", id: "m1", message: { role: "user", content: `look at ${OLD_TREE}/a.ts` } },
    { type: "custom", customType: "worktrees", data: { trees: [{ path: OLD_TREE, branch: "feat", status: "active", session: "L1" }] } },
    { type: "custom", customType: "subagents-worker", data: { workerId: "ag_01", ref: { kind: "pi-session-file", locator: `${OLD_HOME}/sessions/t_W1.jsonl`, sessionId: "W1" } } },
  ];
  writeFileSync(join(h, "sessions", "t_L1.jsonl"), `${lead.map((e) => JSON.stringify(e)).join("\n")}\n`);
  writeFileSync(join(h, "sessions", "t_W1.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "W1", timestamp: "t", cwd: OLD_TREE, parentSession: `${OLD_HOME}/sessions/t_L1.jsonl` })}\n`);
  const rec = {
    v: 1,
    chatId: "W1",
    path: `${OLD_HOME}/sessions/t_W1.jsonl`,
    key: "k",
    kind: "worker",
    parent: { sessionId: "L1", path: `${OLD_HOME}/sessions/t_L1.jsonl`, workerId: "ag_01" },
    spec: {
      cwd: OLD_TREE,
      agentDir: null,
      extensions: ["/home/a/.pi/agent/sova/chats/code/b7/pi-config/extensions/subagents/index.ts", "/opt/other/ext.ts"],
      env: { SOVA_SHARED_DIR: `${OLD_HOME}/shared`, SOVA_TEAM_ROLE: "coder" },
      parent: { sessionId: "L1", path: `${OLD_HOME}/sessions/t_L1.jsonl`, workerId: "ag_01" },
    },
    state: "idle",
  };
  writeFileSync(join(h, "workers", "W1.json"), `${JSON.stringify(rec)}\n`);
  writeFileSync(join(h, "wakes", "W1.team.json"), `${JSON.stringify({ path: `${OLD_HOME}/sessions/t_W1.jsonl` })}\n`);
  return h;
}

test("a Move: every recorded path points here, what was said stays, a rerun changes nothing", async () => {
  const h = home("move");
  const first = await relocateHome(h, { map, code: CODE, broad });
  assert.deepEqual(first, { conversations: 2, workers: 1, records: 1 });
  const lines = readFileSync(join(h, "sessions", "t_L1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].cwd, NEW_TREE);
  assert.equal(lines[1].message.content, `look at ${OLD_TREE}/a.ts`, "a message keeps its words");
  assert.equal(lines[2].data.trees[0].path, NEW_TREE);
  assert.equal(lines[3].data.ref.locator, `${NEW_HOME}/sessions/t_W1.jsonl`);
  const w = JSON.parse(readFileSync(join(h, "workers", "W1.json"), "utf8"));
  assert.equal(w.path, `${NEW_HOME}/sessions/t_W1.jsonl`);
  assert.equal(w.parent.path, `${NEW_HOME}/sessions/t_L1.jsonl`);
  assert.equal(w.spec.cwd, NEW_TREE);
  assert.deepEqual(w.spec.extensions, [`${CODE}/pi-config/extensions/subagents/index.ts`, "/opt/other/ext.ts"]);
  assert.equal(w.spec.env.SOVA_SHARED_DIR, `${NEW_HOME}/shared`);
  assert.equal(JSON.parse(readFileSync(join(h, "wakes", "W1.team.json"), "utf8")).path, `${NEW_HOME}/sessions/t_W1.jsonl`);
  assert.equal(await findConversation(h, "W1"), join(h, "sessions", "t_W1.jsonl"));
  assert.deepEqual(await relocateHome(h, { map, code: CODE, broad }), { conversations: 0, workers: 0, records: 0 });
});

test("a Copy: each conversation, record and file name takes its new id", async () => {
  const h = home("copy");
  await relocateHome(h, { map, ids: { L1: "N1", W1: "N2" }, code: CODE, broad });
  assert.deepEqual(readdirSync(join(h, "sessions")).sort(), ["t_N1.jsonl", "t_N2.jsonl"]);
  assert.deepEqual(readdirSync(join(h, "workers")), ["N2.json"]);
  const w = JSON.parse(readFileSync(join(h, "workers", "N2.json"), "utf8"));
  assert.equal(w.chatId, "N2");
  assert.equal(w.parent.sessionId, "N1");
  assert.equal(JSON.parse(readFileSync(join(h, "sessions", "t_N1.jsonl"), "utf8").split("\n")[0]!).id, "N1");
});
