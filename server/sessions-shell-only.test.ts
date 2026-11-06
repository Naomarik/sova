// Run: pnpm test -- server/sessions-shell-only.test.ts. A chat that holds only commands run from shell mode
// (§chat.shell-mode/card) is no empty husk: it is listed (still "Untitled": a command never titles a chat),
// it opens with its command's row, and the empty-husk cleanup keeps it, `!` and `!!` alike, while a
// header-only stub is still left out and deleted. In-process, in a throwaway agent dir.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SessionSummary, TranscriptItem } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-shell-only-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-shell-only--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const { addWebSession } = await import("./web-sessions");
const { canonicalPath } = await import("./paths");
const { cleanupSessions, isZeroInput } = await import("./sessions-index");

after(() => rmSync(agentDir, { recursive: true, force: true }));

let n = 0;
/** A web session file with these entries after its header, last written an hour ago (past the
    just-written guard): its id and path. */
function sessionWith(entries: Record<string, unknown>[]): { id: string; path: string } {
  const id = `0000000${++n}-aaaa-7bbb-8ccc-0123456789ab`;
  const path = join(sessionsDir, `2026-11-06T00-00-0${n}-000Z_${id}.jsonl`);
  const lines = [{ type: "session", version: 3, id, timestamp: "2026-11-06T00:00:00.000Z", cwd: "/tmp" }, ...entries];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  addWebSession(id);
  const then = new Date(Date.now() - 3_600_000);
  utimesSync(path, then, then);
  return { id, path: canonicalPath(path) };
}
const bash = (o: Record<string, unknown> = {}) => ({
  type: "message",
  id: "b1",
  parentId: null,
  timestamp: "2026-11-06T00:00:01.000Z",
  message: { role: "bashExecution", command: "echo hi", output: "hi\n", exitCode: 0, cancelled: false, truncated: false, timestamp: 1, ...o },
});

test("a chat whose only entries are commands is listed, opens with its row, and survives the empty-husk cleanup", async () => {
  const stub = sessionWith([]);
  const shared = sessionWith([bash()]);
  const kept = sessionWith([bash({ command: "env", excludeFromContext: true })]);
  for (const s of [shared, kept]) assert.equal(await isZeroInput(s.path, 4096), false, "a command is something written in it");
  assert.equal(await isZeroInput(stub.path, 4096), true, "the control: a header-only file is a husk");

  const listed = (await (await app.request("/api/sessions")).json()) as SessionSummary[];
  const row = (id: string) => listed.find((s) => s.id === id);
  assert.equal(row(stub.id), undefined, "a stub is still left out");
  for (const s of [shared, kept]) {
    assert.ok(row(s.id), "listed, so a reload finds it");
    assert.equal(row(s.id)!.title, "Untitled", "a command never titles a chat");
  }

  const items = (await (await app.request(`/api/transcript?path=${encodeURIComponent(shared.path)}&wire=2`)).json()) as { items: TranscriptItem[] };
  assert.deepEqual(items.items.map((i) => [i.kind, i.shell?.command]), [["shell", "echo hi"]], "it opens with its command's card");

  const r = await cleanupSessions({ mode: "husks", dryRun: false });
  assert.deepEqual(r.deletedIds, [stub.id], "only the stub goes");
  assert.equal(existsSync(stub.path), false);
  for (const s of [shared, kept]) assert.ok(existsSync(s.path), "its commands are kept");
});
