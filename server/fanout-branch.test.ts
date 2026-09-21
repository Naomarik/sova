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
