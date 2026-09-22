// Run: npx tsx --test server/fanout-branch.test.ts
// Gate #11: the SDK behaviour every fork marker depends on.
//
// createBranchedSession copies the branch WITH ENTRY IDS INTACT (session-manager.js: the copy is
// `{...entry, parentId}`, and the createSessionId() beside it is the SESSION's id, not an entry's).
// seed.leafId is an id from the SOURCE, and the marker is drawn by finding that id in a MEMBER's
// transcript — so if the SDK ever re-issued entry ids on branching, markers would silently stop
// rendering and Align to Fork would find nothing. Nothing would error; the feature would just
// quietly stop telling the truth. Hence a test against the real SDK, not a fake.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-branch-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-branch--");
mkdirSync(sessionsDir, { recursive: true });
after(() => rmSync(agentDir, { recursive: true, force: true }));

// Dynamic imports so PI_CODING_AGENT_DIR (set above) is what they see. BOTH BEFORE ANY test()
// registration: a top-level await BETWEEN test registrations makes node:test fire this file's
// root after() hook (the rmSync above) before the later tests run — deleting the fixture tree
// out from under them with an ENOENT whose stack points at the wrong line. Every import this
// file does lives above every test it defines.
const { realFanoutDeps } = await import("./fanout");
const { isFanoutMember } = await import("./chat-manager");

const LEAF = "entry-assistant-1";

/** A source with a real assistant reply, so the branch is written immediately (hasAssistant). */
function source(): string {
  const path = join(sessionsDir, "2026-09-22T00-00-00-000Z_01a0-branchsrc.jsonl");
  const lines = [
    { type: "session", version: 3, id: "01a0-branchsrc", timestamp: "2026-09-22T00:00:00.000Z", cwd: agentDir },
    { type: "message", id: "entry-user-1", parentId: null, timestamp: "2026-09-22T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    { type: "message", id: LEAF, parentId: "entry-user-1", timestamp: "2026-09-22T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi there" }], provider: "anthropic", model: "opus" } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

test("createBranchedSession keeps entry ids, so seed.leafId is findable in a member", () => {
  const sourcePath = source();
  const sm = SessionManager.open(sourcePath);
  const memberPath = sm.createBranchedSession(LEAF);
  assert.ok(memberPath, "the branch produced a file path");
  assert.notEqual(memberPath, sourcePath, "and it is a different file");

  const entries = readFileSync(memberPath!, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  // THE assertion: the id the group's seed stores is present in the member, unchanged.
  assert.ok(
    entries.some((e) => e.id === LEAF),
    "the source's leaf id appears in the member — a fork marker can find it",
  );
  assert.ok(entries.some((e) => e.id === "entry-user-1"), "and so does the rest of the branch");
});

test("the member's header points back at the source, which is what SessionSummary.parent reads", () => {
  const sourcePath = source();
  const sm = SessionManager.open(sourcePath);
  const memberPath = sm.createBranchedSession(LEAF)!;
  const header = JSON.parse(readFileSync(memberPath, "utf8").split("\n", 1)[0]!);
  assert.equal(header.type, "session");
  assert.equal(header.parentSession, sourcePath, "verbatim, which is why fanout opens a canonical path");
  assert.notEqual(header.id, "01a0-branchsrc", "the SESSION id is new; only the ENTRY ids are kept");
});

test("branching REBINDS the manager: the same manager must never be used twice", () => {
  // The invariant the whole fanout design rests on, asserted rather than trusted.
  const sourcePath = source();
  const sm = SessionManager.open(sourcePath);
  const first = sm.createBranchedSession(LEAF)!;
  assert.equal(sm.getSessionFile(), first, "the manager IS the member now, not the source");
  assert.notEqual(sm.getSessionFile(), sourcePath);
});

// --- the member's model (N1) and the outline-off marker, against the REAL creation paths --------
// SessionManager.create defers persisting until a first assistant reply (session-manager.js
// _persist: no assistant + not flushed ⇒ the entry stays in fileEntries, memory only), so a
// fresh member written header-first used to lose its model_change to that deferral: the file on
// disk was header-only, and the runtime that opened it resolved the server's DEFAULT model —
// caught live as a zai/glm-5.3 plan answering as ollama-cloud/deepseek. These tests read FILE
// BYTES, never the writing manager's in-memory getEntries(): a test that trusts memory passes
// while the member stays header-only on disk, which is precisely the failure being pinned.
const member = (provider: string, modelId: string) => ({ ref: `${provider}/${modelId}`, provider, modelId, label: `${provider}/${modelId}` });
const parse = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("realFanoutDeps.fresh writes the PLANNED model into the file, and a reopened manager sees it", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-web-branch-fresh-"));
  const path = await realFanoutDeps.fresh(workdir, member("zai", "glm-5.3"));
  const entries = parse(path);
  const changes = entries.filter((e) => e.type === "model_change");
  assert.equal(changes.length, 1, "exactly the member's own model change");
  assert.equal(`${changes[0]!.provider}/${changes[0]!.modelId}`, "zai/glm-5.3");
  // What acquireChat opens: the model must survive a fresh read of the file, not just the
  // writing manager's memory. This is the assertion that was false before the write-order fix.
  const reopened = SessionManager.open(path);
  assert.deepEqual(reopened.buildSessionContext().model, { provider: "zai", modelId: "glm-5.3" });
});

test("realFanoutDeps.fork writes the planned model OVER the source's, and the marker rides both paths", async () => {
  const sourcePath = source(); // its conversation carries no model_change of its own
  const path = await realFanoutDeps.fork(sourcePath, LEAF, member("anthropic", "claude-opus-5"));
  const entries = parse(path);
  const changes = entries.filter((e) => e.type === "model_change");
  const last = changes.at(-1);
  assert.ok(last, "the member's own model change is in the file");
  assert.equal(`${last.provider}/${last.modelId}`, "anthropic/claude-opus-5", "and it is the file's last word on the model");
  assert.deepEqual(SessionManager.open(path).buildSessionContext().model, { provider: "anthropic", modelId: "claude-opus-5" });
  // The invisible entry chat-manager keys the outline exception on (FANOUT_MEMBER_ENTRY):
  // present in BOTH creation paths' bytes, and readable from a reopened manager.
  assert.ok(
    entries.some((e) => e.type === "custom" && e.customType === "pi-web-fanout-member"),
    "the fanout-member marker is in the fork member's file",
  );
  assert.ok(isFanoutMember(SessionManager.open(path)), "and the predicate chat-manager runs sees it");
});

test("a fresh member's file carries the fanout-member marker from birth", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-web-branch-marker-"));
  const path = await realFanoutDeps.fresh(workdir, member("zai", "glm-5.3"));
  const reopened = SessionManager.open(path);
  assert.ok(isFanoutMember(reopened), "the marker survives the reopen a later runtime does");
  assert.ok(
    parse(path).some((e) => e.type === "custom" && e.customType === "pi-web-fanout-member"),
    "as bytes on disk, so it holds across restarts — not an in-memory flag",
  );
});
