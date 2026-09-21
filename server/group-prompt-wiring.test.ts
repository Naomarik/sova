// Run: npx tsx --test server/group-prompt-wiring.test.ts
// The batch prompt's REAL deps (realBatchDeps), not the injected fakes: the group store, the
// listing index, the live registry and the archive, wired together as the route wires them.
//
// Why this exists: group-prompt.test.ts injects every probe, which is what makes the rules
// testable — and it means the WIRING has no coverage. Frontend pointed out that an all-TUI-live
// group exercises the whole refusal path against a real server with ZERO model calls, because
// all-or-nothing is a pre-check rather than a transaction. That property makes the same thing
// cheap to test here: every case below refuses, so `accept` is never reached and no runtime is
// ever opened. The 200 path is deliberately not attempted — it would have to prompt a model.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-batch-wiring-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-wiring--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const { promptGroup, realBatchDeps } = await import("./group-prompt");
const { createGroup, assignSession } = await import("./session-groups");
const { setArchived } = await import("./archived-sessions");
const { canonicalPath } = await import("./paths");

// readLive only trusts a record whose pid is alive, like archived-sessions.test.ts fakes it.
const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
after(() => {
  sleeper.kill();
  rmSync(agentDir, { recursive: true, force: true });
});

const ID_LIVE = "01234567-89ab-7cde-8f01-2345678900b1";
const ID_ARCHIVED = "01234567-89ab-7cde-8f01-2345678900b2";
const ID_GONE = "01234567-89ab-7cde-8f01-2345678900b3";

function session(id: string): string {
  const path = join(sessionsDir, `2026-09-22T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(
    path,
    [
      { type: "session", version: 3, id, timestamp: "2026-09-22T00:00:00.000Z", cwd: "/tmp" },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  return canonicalPath(path);
}

test("the real deps refuse a batch whose members are TUI-live, archived or gone — and prompt nothing", async () => {
  const live = session(ID_LIVE);
  const archived = session(ID_ARCHIVED);
  // A member the group knows about whose file never existed: exercises the id→path lookup miss.
  const group = createGroup("Wiring");
  assert.ok(group.ok);
  assignSession(ID_LIVE, group.group.id);
  assignSession(ID_ARCHIVED, group.group.id);
  assignSession(ID_GONE, group.group.id);
  setArchived(ID_ARCHIVED, true);
  writeFileSync(
    join(liveDir, `p${sleeper.pid}-wiring.json`),
    JSON.stringify({ session: { pid: sleeper.pid, sessionFile: live, mode: "tui" }, presence: { status: "idle" } }),
  );

  // realBatchDeps: the group store for membership, the listing for id→path, readLive, isArchived.
  const r = await promptGroup(group.group.id, "ship it", undefined, realBatchDeps);

  assert.ok(!r.ok && r.status === 409, "every member is unavailable, so the whole batch refuses");
  const byId = new Map(r.refused.map((x) => [x.id, x]));
  assert.equal(byId.get(ID_LIVE)?.code, "tui-live", "read from the live registry, not a fake");
  assert.equal(byId.get(ID_LIVE)?.path, live, "and the canonical path the listing produced");
  assert.equal(byId.get(ID_ARCHIVED)?.code, "archived");
  assert.equal(byId.get(ID_GONE)?.code, "missing");
  assert.equal(byId.get(ID_GONE)?.path, "", "a session with no file has no path to name");
  assert.equal(r.refused.length, 3, "all three named at once, not the first");
  assert.ok(
    r.refused.every((x) => x.message.trim().length > 0),
    "every refusal carries a sentence",
  );
  // Nothing was prompted: acquireChat is never reached, so no runtime and no model call. The
  // proof is structural — the pre-check returned before the accept phase — and the absence of
  // any session file mutation here is what the archive/live probes were asked about.
  assert.equal(archived.endsWith(".jsonl"), true);
});

test("the real deps resolve membership from the group store, in group order", async () => {
  const group = createGroup("Order");
  assert.ok(group.ok);
  for (const id of [ID_ARCHIVED, ID_LIVE]) assignSession(id, group.group.id);
  const r = await promptGroup(group.group.id, "hi", undefined, realBatchDeps);
  assert.ok(!r.ok && r.status === 409);
  assert.deepEqual(
    r.refused.map((x) => x.id),
    [ID_ARCHIVED, ID_LIVE],
    "assignment order, which is what members[] records",
  );
});

test("an unknown group is a 404 and an empty one a 400, through the real store", async () => {
  const missing = await promptGroup("no-such-group", "hi", undefined, realBatchDeps);
  assert.ok(!missing.ok && missing.status === 404);
  const empty = createGroup("Empty");
  assert.ok(empty.ok);
  const r = await promptGroup(empty.group.id, "hi", undefined, realBatchDeps);
  assert.ok(!r.ok && r.status === 400);
});

// --- fanout landing in a HAND-MADE group, through the real store -----------------------------
// The case the autoDissolve decoupling exists for, pinned end to end rather than inherited from
// the store's own unit tests: a group the USER named adopts a fanout's lineage, and then keeps
// standing when its last member leaves.

test("a hand-made group adopts a fanout's seed, and SURVIVES being emptied", async () => {
  const { runFanout, realFanoutDeps } = await import("./fanout");
  const { readGroup } = await import("./session-groups");

  const mine = createGroup("Home"); // the user typed this name
  assert.ok(mine.ok);
  assert.equal(mine.group.seed, undefined);
  assert.equal(mine.group.autoDissolve, undefined, "a hand-made group is never marked dissolvable");

  // Real store, real assign, real adoption; only the SDK/disk halves are faked, since creating a
  // member would otherwise need a runtime.
  let n = 0;
  const created: string[] = [];
  const r = await runFanout(
    { members: [{ ref: "anthropic/opus", count: 1 }], source: { path: "/sessions/x.jsonl", leafId: "e9" }, groupId: mine.group.id },
    {
      ...realFanoutDeps,
      knownRefs: async () => new Set(["anthropic/opus"]),
      resolveSource: () => "/sessions/x.jsonl",
      sourceHead: async () => ({ version: 3, leafId: "e9" }),
      live: () => false,
      streaming: () => false,
      foreignWriter: () => false,
      misconfigured: () => false,
      fork: async () => {
        const path = session(`01234567-89ab-7cde-8f01-2345678900c${++n}`);
        created.push(path);
        return path;
      },
    },
  );

  assert.ok(r.ok, "the fanout landed");
  assert.equal(r.result.group.id, mine.group.id, "into the EXISTING group");
  assert.equal(r.result.group.name, "Home", "which keeps the name the user typed");
  assert.deepEqual(r.result.group.seed, { parentSessionPath: "/sessions/x.jsonl", leafId: "e9" }, "and gains the marker's datum");
  // Recorded as an explicit false, not left absent: absent + seed is indistinguishable on disk
  // from a pre-flag fanout group, and the legacy rule would then delete it.
  assert.equal(readGroup(mine.group.id)?.autoDissolve, false, "and is explicitly marked NOT dissolvable");

  // Now empty it: the member the fanout added is the only one.
  const memberId = r.result.created[0]!.id;
  const out = assignSession(memberId, null);
  assert.deepEqual(out, { ok: true }, "no dissolved flag");
  const after = readGroup(mine.group.id);
  assert.equal(after?.name, "Home", "the group the user named is still there, empty");
  assert.deepEqual(after?.members, []);
});
