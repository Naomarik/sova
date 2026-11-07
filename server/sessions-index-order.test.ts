// Run: node scripts/run-tests.mjs server/sessions-index-order.test.ts
// A cold listing reads every open session before any archived one, and still answers with every
// session. Throwaway PI_CODING_AGENT_DIR; ~/.pi is never touched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-sessions-order-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-sessions-order--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { indexedSessionPaths, LIST_READ_LIMIT, listPhases, listSessions } = await import("./sessions-index");
const { setArchived } = await import("./archived-sessions");
after(() => rmSync(agentDir, { recursive: true, force: true }));

const idOfN = (n: number) => `01234567-89ab-7cde-8f01-${n.toString(16).padStart(12, "0")}`;

function session(id: string, title: string): void {
  const head = { type: "session", version: 3, id, timestamp: "2026-09-21T00:00:00.000Z", cwd: "/tmp" };
  const msg = { type: "message", id: "m1", parentId: null, timestamp: "2026-09-21T00:00:01.000Z", message: { role: "user", content: title } };
  writeFileSync(join(sessionsDir, `2026-09-21T00-00-00-000Z_${id}.jsonl`), `${JSON.stringify(head)}\n${JSON.stringify(msg)}\n`);
}

test("every open session is read before any archived one; the listing still holds both", async () => {
  // More of each than one batch of reads, interleaved on disk, so neither kind comes first by accident.
  const n = LIST_READ_LIMIT * 2 + 5;
  const open: string[] = [];
  const archived: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const id = idOfN(i + 1);
    session(id, `session ${i}`);
    if (i % 2) {
      setArchived(id, true);
      archived.push(id);
    } else open.push(id);
  }

  let readWhenOpenDone: Set<string> | null = null;
  listPhases.openRead = () => {
    readWhenOpenDone = new Set(indexedSessionPaths().keys());
  };
  try {
    const rows = await listSessions();
    assert.ok(readWhenOpenDone, "the open phase ended");
    const seen = readWhenOpenDone as Set<string>;
    assert.deepEqual(open.filter((id) => !seen.has(id)), [], "every open session was read by then");
    assert.deepEqual(archived.filter((id) => seen.has(id)), [], "no archived session was read by then");
    assert.deepEqual(rows.filter((r) => !r.archived).map((r) => r.id).sort(), [...open].sort());
    assert.deepEqual(rows.filter((r) => r.archived).map((r) => r.id).sort(), [...archived].sort(), "the archived ones are in the same listing");
  } finally {
    listPhases.openRead = undefined;
  }
});
