// Run: npx tsx --test server/fork-branch.test.ts
// The half of a fork a fake can only agree with: what the real SDK writes into the child.
//
// Every claim the route makes about a fork — "full history", "same ids", "Forked from", "opens for
// chat without a force" — is a claim about THIS file's output, and all of it is silent when wrong:
// a child with re-issued ids still lists, still opens, still reads like a conversation.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-forkbranch-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-fork--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
after(() => rmSync(agentDir, { recursive: true, force: true }));

// Every import above every test(): a top-level await BETWEEN test registrations makes node:test
// fire this file's root after() hook early and delete the fixture out from under the later tests.
const { realForkDeps } = await import("./fork");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { FANOUT_MEMBER_ENTRY, isFanoutMember, REWIND_ENTRY } = await import("./chat-manager");
const { activeBranch, parseLines } = await import("./transcript");
const { isWebSession } = await import("./web-sessions");

const read = (p: string) => parseLines(readFileSync(p, "utf8"));
const entries = (p: string) => read(p).filter((e) => e.type !== "session");
const header = (p: string) => read(p).find((e) => e.type === "session")!;

/**
 * u1 → a1 → u2 → a2, then a REWIND back to before u2: Sova's marker hangs off a1, so the file's
 * TAIL is the abandoned branch (u2, a2) and the ACTIVE branch is u1 → a1 → marker. This is the
 * shape a fork is most likely to meet — the user has just navigated to the point they want.
 */
function rewoundSource(name: string): string {
  const path = join(sessionsDir, `2026-09-22T00-00-00-000Z_01a0-${name}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: `01a0-${name}`, timestamp: "2026-09-22T00:00:00.000Z", cwd: agentDir },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-09-22T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-22T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "anthropic", model: "opus" } },
    { type: "message", id: "u2", parentId: "a1", timestamp: "2026-09-22T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "second ask" }] } },
    { type: "message", id: "a2", parentId: "u2", timestamp: "2026-09-22T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "second answer" }], provider: "anthropic", model: "opus" } },
    { type: "custom", id: "rw1", parentId: "a1", timestamp: "2026-09-22T00:00:05.000Z", customType: REWIND_ENTRY, data: { targetId: "u2", fromLeafId: "a2" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

test("the child holds root→leaf of the ACTIVE branch, with the source's entry ids intact", async () => {
  const source = rewoundSource("active");
  // The rewind marker is the active leaf, so a fork "at" a1 must give u1 → a1 and NOTHING from the
  // abandoned tail — which is where the file's last two lines live.
  const child = await realForkDeps.branchOff(source, "a1");
  const ids = entries(child).map((e) => e.id);
  assert.deepEqual(ids, ["u1", "a1"], `ids were ${ids.join(", ")}`);
  assert.ok(!ids.includes("u2") && !ids.includes("a2"), "the abandoned branch did not come along");
  // Same ids, not re-issued: lineage, fork markers and Align to Fork all join on them.
  assert.equal(entries(child)[1]?.message?.content?.[0]?.text, "first answer");
});

test("a fork BEFORE a rewound-past message can still reach it: the branch point is the parent", async () => {
  // u2 is on the ABANDONED branch here, so the route refuses it (see fork.test.ts). What this
  // pins is the SDK half: branching through a1 — the parent the "before" rule would pick for a
  // message that IS on the branch — produces the same prefix and no tail.
  const source = rewoundSource("before");
  const child = await realForkDeps.branchOff(source, "a1");
  assert.deepEqual(activeBranch(read(child)).map((e) => e.id), ["u1", "a1"]);
});

test("the child records its parent, which is what 'Forked from' reads", async () => {
  const source = rewoundSource("lineage");
  const child = await realForkDeps.branchOff(source, "a1");
  assert.equal(header(child).parentSession, source, "the header names the source file");
  assert.notEqual(header(child).id, header(source).id, "and the child is its own session");
});

test("the child exists on disk immediately, even with no assistant reply in it", async () => {
  // The SDK writes a branch file straight away only when it contains an assistant message; a fork
  // at a user message would otherwise appear in the sidebar at its first reply and be unopenable
  // until then.
  const source = rewoundSource("early");
  const child = await realForkDeps.branchOff(source, "u1");
  assert.deepEqual(entries(child).map((e) => e.id), ["u1"]);
  assert.equal(header(child).type, "session");
});

/** A source that IS a fanout member, with the marker in the MIDDLE of the branch — the position a
    naive filter breaks on, because every later entry is parented on it. */
function memberSource(name: string, markerParent: string | null = "a1"): string {
  const path = join(sessionsDir, `2026-09-22T00-00-00-000Z_01a0-${name}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: `01a0-${name}`, timestamp: "2026-09-22T00:00:00.000Z", cwd: agentDir },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-09-22T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "ask" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-22T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }], provider: "anthropic", model: "opus" } },
    { type: "custom", id: "fm1", parentId: markerParent, timestamp: "2026-09-22T00:00:03.000Z", customType: FANOUT_MEMBER_ENTRY },
    { type: "message", id: "u2", parentId: "fm1", timestamp: "2026-09-22T00:00:04.000Z", message: { role: "user", content: [{ type: "text", text: "again" }] } },
    { type: "message", id: "a2", parentId: "u2", timestamp: "2026-09-22T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "again answered" }], provider: "anthropic", model: "opus" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

test("forking a FANOUT MEMBER does not hand the child its marker, and re-chains around it", async () => {
  // THE FIXTURE IS THE POINT. An earlier version of this test used a source that never had the
  // marker, so it could only show that fork does not ADD one — the open question was always
  // INHERITANCE, and `createBranchedSession` copies the branch entry by entry, marker included.
  // A member marker on the child makes it open with the topic outline off for the life of the
  // file, and nothing about the child looks wrong: it lists, opens and reads perfectly.
  const source = memberSource("member");
  const child = await realForkDeps.branchOff(source, "a2");
  assert.ok(!entries(child).some((e) => e.type === "custom" && e.customType === FANOUT_MEMBER_ENTRY), "the marker did not come along");
  assert.equal(isFanoutMember(SessionManager.open(child)), false, "and the predicate openSession keys the outline exception on agrees");
  // Removing a link from a parent-chained list is not a filter: u2 must re-parent onto a1, or the
  // active-branch walk stops at the gap and the child silently loses everything before it.
  assert.deepEqual(entries(child).map((e) => e.id), ["u1", "a1", "u2", "a2"], "every message survived");
  assert.deepEqual(activeBranch(read(child)).map((e) => e.id), ["u1", "a1", "u2", "a2"], "and the branch still walks to the root");
});

test("the child is web-owned", async () => {
  const source = rewoundSource("owned");
  const child = await realForkDeps.branchOff(source, "a1");
  // Web ownership is what makes the child open for chat without a `&force=1`: without it the
  // fresh mtime we just made reads as an unidentified writer. The file is a plain array of ids.
  const webSessions: string[] = JSON.parse(readFileSync(join(agentDir, "sova", "web-sessions.json"), "utf8"));
  const id = child.replace(/\.jsonl$/, "").split("_").pop()!;
  assert.ok(Array.isArray(webSessions), "web-sessions.json is an array of ids");
  assert.ok(webSessions.includes(id), `${id} is recorded as web-owned (file holds ${webSessions.join(", ")})`);
  assert.ok(isWebSession(id), "and the module agrees");
});

test("the source is not modified by being forked", async () => {
  const source = rewoundSource("untouched");
  const before = readFileSync(source, "utf8");
  await realForkDeps.branchOff(source, "a1");
  assert.equal(readFileSync(source, "utf8"), before, "no model_change, no newline, no migration");
});

test("two forks of one source are siblings, not a chain", async () => {
  // createBranchedSession REBINDS the manager it is called on, so a shared manager would branch
  // the second fork off the FIRST one. Each call gets its own manager; this is that, observed.
  const source = rewoundSource("siblings");
  const a = await realForkDeps.branchOff(source, "a1");
  const b = await realForkDeps.branchOff(source, "u1");
  assert.equal(header(a).parentSession, source);
  assert.equal(header(b).parentSession, source, "the second fork came off the SOURCE, not off the first fork");
  assert.deepEqual(entries(a).map((e) => e.id), ["u1", "a1"]);
  assert.deepEqual(entries(b).map((e) => e.id), ["u1"]);
});
