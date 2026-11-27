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
      env: { SOVA_SHARED_DIR: `${OLD_HOME}/shared`, SOVA_TEAM_ROLE: "coder", PI_SUBAGENTS_TEAM_MEMBER: JSON.stringify({ version: 1, teamId: "team_01", workerId: "ag_01", dir: `${OLD_HOME}/teams/L1/team_01/ag_01` }) },
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
  // A team member's identity is JSON in its environment: the mailbox folder it names points here too.
  assert.equal(JSON.parse(w.spec.env.PI_SUBAGENTS_TEAM_MEMBER).dir, `${NEW_HOME}/teams/L1/team_01/ag_01`);
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

test("a Copy's home holds no file or record keyed by a source id: cards, offers, wakes, usage, workers, meta and index take the new ids", async () => {
  const LEAD = "01a2100b-51be-7340-bf19-6df207807226";
  const HELPER = "01a2100b-6c03-7340-bf19-6df4c009b105";
  const ids = { [LEAD]: "f96f0d22-9656-4343-9d19-48d52ae5ec52", [HELPER]: "73ac762b-59c5-4b0c-9644-b40609db3332" };
  const h = join(root, "copy-keys");
  const put = (rel: string, text: string) => {
    mkdirSync(join(h, rel, ".."), { recursive: true });
    writeFileSync(join(h, rel), text);
  };
  const own = (id: string) => `${JSON.stringify({ v: 1, sessionId: id, path: `${OLD_HOME}/sessions/t_${id}.jsonl`, cards: [] }, null, 2)}\n`;
  put(`sessions/t_${LEAD}.jsonl`, `${JSON.stringify({ type: "session", version: 3, id: LEAD, timestamp: "t", cwd: OLD_TREE })}\n`);
  put(`sessions/t_${HELPER}.jsonl`, `${JSON.stringify({ type: "session", version: 3, id: HELPER, timestamp: "t", cwd: OLD_TREE, parentSession: `${OLD_HOME}/sessions/t_${LEAD}.jsonl` })}\n`);
  put(`chat/cards/${LEAD}.json`, own(LEAD));
  put(`chat/offers/${LEAD}.json`, own(LEAD));
  put("chat/meta.json", `${JSON.stringify({ version: 1, id: LEAD, "web-sessions.json": [LEAD] })}\n`);
  put("chat/seen.json", JSON.stringify({ version: 1, id: LEAD, "seen.json": { [LEAD]: 1 } }));
  put(`workers/${HELPER}.json`, `${JSON.stringify({ v: 1, chatId: HELPER, parent: { sessionId: LEAD, path: `${OLD_HOME}/sessions/t_${LEAD}.jsonl` } })}\n`);
  put(`wakes/cancelled/${LEAD}`, "1795565637371\n");
  put(`wakes/cancelled/${HELPER}`, "1795565637368\n");
  put(`usage/${LEAD}/labels.jsonl`, `${JSON.stringify({ sid: LEAD, label: "x" })}\n`);
  put(`usage/${LEAD}/totals.json`, JSON.stringify({ sid: LEAD }));
  put("index.json", JSON.stringify({ v: 1, layout: 1, chat: LEAD }));
  // What the chat and its helpers wrote in the shared folder is theirs, as named.
  put(`shared/notes-${LEAD}.md`, "mine");
  await relocateHome(h, { map, ids, code: CODE, broad });
  const all: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(h, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else all.push(p);
    }
  };
  walk("");
  const records = all.filter((p) => !p.startsWith("shared/"));
  for (const old of [LEAD, HELPER]) {
    assert.deepEqual(records.filter((p) => p.includes(old)), [], `no file is named by ${old}`);
    assert.deepEqual(records.filter((p) => readFileSync(join(h, p), "utf8").includes(old)), [], `no record names ${old}`);
  }
  assert.ok(all.includes(`chat/cards/${ids[LEAD]}.json`) && all.includes(`chat/offers/${ids[LEAD]}.json`));
  assert.ok(all.includes(`wakes/cancelled/${ids[HELPER]}`) && all.includes(`usage/${ids[LEAD]}/labels.jsonl`));
  assert.equal(JSON.parse(readFileSync(join(h, "chat", "cards", `${ids[LEAD]}.json`), "utf8")).sessionId, ids[LEAD]);
  assert.ok(all.includes(`shared/notes-${LEAD}.md`), "the shared folder's files keep their names");
  // A rerun renames nothing more; a new-id file already there wins over an old-id one left beside it.
  put(`chat/cards/${LEAD}.json`, own(LEAD));
  await relocateHome(h, { map, ids, code: CODE, broad });
  assert.deepEqual(readdirSync(join(h, "chat", "cards")), [`${ids[LEAD]}.json`]);
});
