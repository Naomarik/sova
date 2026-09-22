// Run: npx tsx --test server/sessions-parent.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// SessionSummary.parent: the header's `parentSession` (the file a branched session was forked
// from), surfaced only while that file is still there.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-parent-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-parent-test--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { getSessionSummary } = await import("./sessions-index");
const { canonicalPath } = await import("./paths");

after(() => rmSync(agentDir, { recursive: true, force: true }));

/** A listable session (header + one user message), with whatever `parentSession` the test wants. */
function session(id: string, parentSession?: unknown): string {
  const path = join(sessionsDir, `2026-09-20T00-00-00-000Z_${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: "2026-09-20T00:00:00.000Z", cwd: "/tmp", ...(parentSession === undefined ? {} : { parentSession }) };
  const user = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } };
  writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`);
  return canonicalPath(path);
}

const ROOT = "01234567-89ab-7cde-8f01-2345678900a0";
const FORK = "01234567-89ab-7cde-8f01-2345678900a1";
const ORPHAN = "01234567-89ab-7cde-8f01-2345678900a2";
const PLAIN = "01234567-89ab-7cde-8f01-2345678900a3";
const ODD = "01234567-89ab-7cde-8f01-2345678900a4";
const ORPHAN_FORK = "01234567-89ab-7cde-8f01-2345678900a5";

test("a fork's parent is its parentSession path, plus that session's id, while the file exists", async () => {
  const root = session(ROOT);
  const fork = session(FORK, root);
  const s = await getSessionSummary(fork);
  assert.equal(s?.parent, root); // canonical: the same string the parent's own summary carries
  assert.equal(s?.parent, (await getSessionSummary(root))?.path);
  assert.equal(s?.parentId, ROOT);
});

test("a session with no parentSession has no parent", async () => {
  const s = await getSessionSummary(session(PLAIN));
  assert.ok(!("parent" in s!), "the field is left out, not set to undefined");
  assert.ok(!("parentId" in s!));
});

test("a parentSession whose file is gone is left out", async () => {
  const gone = session(ORPHAN);
  const fork = session(ORPHAN_FORK, gone);
  unlinkSync(gone);
  const s = await getSessionSummary(fork);
  assert.equal(s?.parent, undefined);
  assert.equal(s?.parentId, undefined);
});

test("a parentSession that is not a session file is ignored, cwd paths included", async () => {
  // Nothing outside the (always local) sessions dir is ever stat'ed: a cwd under a target's
  // mount point would freeze the event loop.
  const outside = join(agentDir, "not-a-session.jsonl");
  writeFileSync(outside, "");
  const cases = [7, null, "sessions/relative.jsonl", "", outside, join(sessionsDir, "not-jsonl.txt"), "/mnt/target/some/cwd"];
  for (const [i, bad] of cases.entries()) {
    const s = await getSessionSummary(session(`${ODD.slice(0, 35)}${i}`, bad)); // one file each: the summary cache is keyed by path
    assert.equal(s?.parent, undefined, `parentSession ${JSON.stringify(bad)}`);
  }
});
