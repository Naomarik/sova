// Run: pnpm test -- server/shell-output.test.ts. A finished command's whole output (§chat.shell-mode/card,
// /lifecycle): GET /api/sessions/shell-output serves every byte of the file the command's own entry names, a
// page at a time, each page ending on a whole character; a command whose output was never cut is its saved
// output; only pi's own output file of this account is read (a link or another name is not); archiving deletes
// the files (removeOutputFiles), and then the answer is `gone`. Peers read it as they read the transcript.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-shell-output-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--shell-output--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const outDir = join(agentDir, "out");
mkdirSync(outDir);
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const { canonicalPath } = await import("./paths");
const { removeOutputFiles, SHELL_OUTPUT_PAGE_BYTES } = await import("./shell-output");
const { classifyRequest } = await import("./mesh/access");

let n = 0;
/** A session whose commands are `cmds`: [entry id, saved output, full-output path or none]. */
function session(cmds: [string, string, string?][]): string {
  const id = `0199eeee-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-11-07T00-00-00-000Z_${id}.jsonl`);
  const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: "2026-11-07T00:00:00.000Z", cwd: "/tmp" }];
  let parent: string | null = null;
  for (const [eid, output, full] of cmds) {
    lines.push({ type: "message", id: eid, parentId: parent, timestamp: "2026-11-07T00:00:01.000Z", message: { role: "bashExecution", command: "make", output, exitCode: 0, cancelled: false, truncated: !!full, ...(full ? { fullOutputPath: full } : {}), timestamp: 0 } });
    parent = eid;
  }
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return canonicalPath(path);
}
const get = async (path: string, entry: string, from?: number) => {
  const r = await app.request(`/api/sessions/shell-output?path=${encodeURIComponent(path)}&entry=${encodeURIComponent(entry)}${from === undefined ? "" : `&from=${from}`}`);
  return { status: r.status, body: (await r.json()) as any };
};

test("every byte of a cut command's file, a page at a time, each page on a whole character", async () => {
  const file = join(outDir, "pi-bash-0123456789abcdef.log");
  // Two-byte characters across the page edge: the page ends before the one it would cut.
  const whole = `${"a".repeat(SHELL_OUTPUT_PAGE_BYTES - 1)}é${"b".repeat(10)}é`;
  writeFileSync(file, whole);
  const path = session([["e1", "the tail", file]]);
  const one = await get(path, "e1");
  assert.equal(one.status, 200);
  assert.equal(one.body.bytes, Buffer.byteLength(whole));
  assert.equal(one.body.from, 0);
  assert.equal(one.body.output, "a".repeat(SHELL_OUTPUT_PAGE_BYTES - 1), "the cut é goes to the next page");
  assert.equal(one.body.next, SHELL_OUTPUT_PAGE_BYTES - 1);
  const two = await get(path, "e1", one.body.next);
  assert.equal(two.body.output, `é${"b".repeat(10)}é`);
  assert.equal(two.body.next, null, "the end");
  assert.equal(one.body.output + two.body.output, whole, "nothing lost or doubled");
});

test("a command whose output was never cut is its saved output; an unknown row is no-command; a bad from is refused", async () => {
  const path = session([["e1", "short output\n"]]);
  assert.deepEqual((await get(path, "e1")).body, { output: "short output\n", from: 0, next: null, bytes: 13 });
  assert.deepEqual(await get(path, "nope"), { status: 404, body: { error: "No such command in this chat.", code: "no-command" } });
  assert.equal((await get(path, "e1", -1)).status, 400);
});

test("only pi's own output file is read: a link, or a file by another name, is gone", async () => {
  const secret = join(outDir, "secret.txt");
  writeFileSync(secret, "not yours");
  const link = join(outDir, "pi-bash-aaaaaaaaaaaaaaaa.log");
  symlinkSync(secret, link);
  const path = session([["l", "tail", link], ["o", "tail", secret]]);
  for (const e of ["l", "o"]) assert.equal((await get(path, e)).body.code, "gone", e);
});

test("archiving deletes a chat's output files, and the answer is gone; the saved output stays", async () => {
  const file = join(outDir, "pi-bash-bbbbbbbbbbbbbbbb.log");
  writeFileSync(file, "x".repeat(100));
  const other = join(outDir, "pi-bash-cccccccccccccccc.log");
  writeFileSync(other, "someone else's");
  const path = session([["e1", "tail", file], ["e2", "short"]]);
  assert.equal(await removeOutputFiles(path), 1);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(other), true, "another chat's file stays");
  assert.deepEqual((await get(path, "e1")).body, { error: "The full output is gone: it is deleted when its chat is archived.", code: "gone" });
  assert.equal((await get(path, "e2")).body.output, "short");
});

test("a connected computer reads it as it reads the transcript: Sessions", () => {
  assert.equal(classifyRequest("GET", "/api/sessions/shell-output").need, classifyRequest("GET", "/api/transcript").need);
  assert.equal(classifyRequest("GET", "/api/sessions/shell-output").need, "sessions");
});
