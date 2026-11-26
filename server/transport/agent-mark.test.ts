// The Transport agent's confinement fails closed: the chat keeps its own mark in its
// home, a device record that is gone or can't be read never opens an agent's chat unconfined, and an unreadable record
// is never written over.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { parseParentScope } from "../../pi-config/extensions/sandbox/policy.ts";
import { type AgentScope, agentLaunchFlags, agentScope, agentTidOf, preparedFile } from "./agent-scope";
import { isTransportAgent, markAgent } from "./agent";
import { homesRoot, markerFile, resetHomesMemoForTests } from "../chat-homes/root";

after(dropScratchAgentDir);

/** Where the chat keeps its mark in its home (written out, not imported, so the test reads the layout itself). */
const AGENT_MARK = join("chat", "transport-agent.json");

const READ_ONLY = { sandboxOn: true, sandboxReadOnly: true, cwdNotWritable: true };

/** A state root and a chat `id` with a home of its own (its home.json and its session file's folder). */
function setup(id = "01a0-agent") {
  const root = scratchRoot("transport-agent-mark-");
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const home = join(root, "homes", id);
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "home.json"), JSON.stringify({ v: 1, id }));
  const scope: AgentScope = agentScope({ folder: join(root, "project"), home: root, exists: () => false });
  return { root, state, id, home, path: join(home, "sessions", `${id}.jsonl`), scope };
}

const scopeOfFlags = (flags: ReturnType<typeof agentLaunchFlags>): unknown => {
  assert.ok(flags && "extra" in flags, `confined at its scope, got ${JSON.stringify(flags)}`);
  const parsed = parseParentScope(flags.extra["sandbox-parent"]);
  assert.ok(parsed.ok);
  return parsed.value.writable;
};

test("a homed agent's chat keeps its mark in its home: with the device's record gone, torn or of another shape, it still opens at its own scope and keeps its transport", () => {
  const s = setup();
  markAgent(s.state, s.id, "tr_abc123", 1, s.scope, s.path);
  assert.equal((JSON.parse(readFileSync(join(s.home, AGENT_MARK), "utf8")) as { tid: string }).tid, "tr_abc123", "the mark is in the chat's home");
  for (const broken of [null, '{"v":1,"agents":{"01a0-age', "[]", '{"v":2}']) {
    if (broken === null) rmSync(preparedFile(s.state), { force: true });
    else writeFileSync(preparedFile(s.state), broken);
    assert.deepEqual(scopeOfFlags(agentLaunchFlags(s.state, s.id, s.path)), s.scope.writable, `record ${JSON.stringify(broken)}`);
    assert.equal(agentTidOf(s.state, s.id, s.path), "tr_abc123", "its transport_setup stays");
    assert.equal(isTransportAgent(s.state, s.id, s.home), true, "a transport still refuses it");
  }
});

test("an agent's chat whose scope can't be read is held read-only: its own mark torn, or no mark and only a transport record naming it", () => {
  const s = setup();
  markAgent(s.state, s.id, "tr_abc123", 1, s.scope, s.path);
  // Its own mark torn, the device's record without its scope: read-only, never unconfined.
  writeFileSync(join(s.home, AGENT_MARK), "{");
  writeFileSync(preparedFile(s.state), JSON.stringify({ v: 1, projects: {}, agents: {} }));
  assert.deepEqual(agentLaunchFlags(s.state, s.id, s.path), READ_ONLY);
  // A chat without a home: the device's record unreadable, a transport record naming it as the agent.
  const t = setup("01a0-unhomed");
  const bare = join(t.root, "pi-sessions", "x.jsonl");
  writeFileSync(preparedFile(t.state), "not json");
  mkdirSync(join(t.state, "transport"), { recursive: true });
  writeFileSync(join(t.state, "transport", "tr_abc123.json"), JSON.stringify({ v: 1, tid: "tr_abc123", ext: { agent: { sessionId: t.id } } }));
  assert.deepEqual(agentLaunchFlags(t.state, t.id, bare), READ_ONLY);
  assert.equal(isTransportAgent(t.state, t.id), true);
  // Anyone else's chat is not an agent's, whatever the record's state.
  assert.equal(agentLaunchFlags(t.state, "01a0-someone-else", bare), null);
  assert.equal(agentLaunchFlags(s.state, "01a0-someone-else", join(s.root, "homes", "01a0-someone-else", "sessions", "y.jsonl")), null);
});

test("a device record that can't be read is never written over: recording an agent then throws and leaves it byte for byte", () => {
  const s = setup();
  markAgent(s.state, s.id, "tr_abc123", 1, s.scope, s.path);
  const torn = readFileSync(preparedFile(s.state), "utf8").slice(0, 40);
  writeFileSync(preparedFile(s.state), torn);
  assert.throws(() => markAgent(s.state, "01a0-second", "tr_def456", 2, s.scope), /can't be read/);
  assert.equal(readFileSync(preparedFile(s.state), "utf8"), torn);
});

test("after a Chats folder move, an agent recorded at its old path keeps its mark in the folder it lives in now, the one its chat opens from", () => {
  const s = setup("01a0-moved-agent");
  // The chats are in the current homes folder now; the marker names the one they moved from (kept, as a move keeps it).
  const now = homesRoot();
  mkdirSync(join(now, s.id, "sessions"), { recursive: true });
  writeFileSync(join(now, s.id, "home.json"), JSON.stringify({ v: 1, id: s.id }));
  writeFileSync(markerFile(), JSON.stringify({ v: 1, homes: now, movedFrom: [join(s.root, "homes")] }));
  resetHomesMemoForTests();
  const there = join(now, s.id, "sessions", `${s.id}.jsonl`);
  // The record still names the old path (Allow Downloads re-records its widened scope through it).
  const widened = { ...s.scope, proxyAllow: ["nodejs.org"] };
  markAgent(s.state, s.id, "tr_abc123", 1, widened, s.path);
  assert.equal((JSON.parse(readFileSync(join(now, s.id, AGENT_MARK), "utf8")) as { scope: AgentScope }).scope.proxyAllow?.[0], "nodejs.org", "written in the home it opens from");
  assert.throws(() => readFileSync(join(s.home, AGENT_MARK)), /ENOENT/, "never in the old, kept one");
  const flags = agentLaunchFlags(s.state, s.id, there);
  assert.ok(flags && "extra" in flags);
  assert.deepEqual(JSON.parse(flags.extra["sandbox-parent"]!).proxyAllow, ["nodejs.org"]);
});
