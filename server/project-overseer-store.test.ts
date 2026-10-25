// readPoMarker's memo: a session list rebuild (every row asks for its file's marker) reads no session
// file whose mtime is unchanged, however many sessions there are.
// A throwaway PI_CODING_AGENT_DIR and session folder in the OS temp dir, deleted after.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "./test-scratch";

const tmp = scratchRoot("sova-po-marker-");
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
after(() => rmSync(tmp, { recursive: true, force: true }));

const { readPoMarker } = await import("./project-overseer-store");

const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w" });
const marker = (projectId: string) => JSON.stringify({ type: "custom", id: "m", customType: "sova-project-overseer", data: { v: 1, projectId }, timestamp: "2026-01-01T00:00:00.000Z" });
// The same length as `marker` for a 4-character project id, so a rewrite keeps the file's size too.
const other = (n: number) => JSON.stringify({ type: "custom", id: "m", customType: "something-else-entirely", data: { v: 1, projectId: String(n).padStart(4, "0") }, timestamp: "2026-01-01T00:00:00.000Z" });

test("a rebuild over more than 500 sessions reads no unchanged session file again; a changed one is read", () => {
  const dir = join(tmp, "sessions");
  mkdirSync(dir, { recursive: true });
  const N = 1_600;
  const files: string[] = [];
  // A whole-second mtime, so setting it back restores it exactly.
  const t = new Date("2026-02-01T00:00:00Z");
  for (let i = 0; i < N; i++) {
    const f = join(dir, `2026_s${i}.jsonl`);
    writeFileSync(f, `${header(`s${i}`)}\n${marker(String(i).padStart(4, "0"))}\n`);
    utimesSync(f, t, t);
    files.push(f);
  }
  // The first listing reads each file once.
  for (let i = 0; i < N; i++) assert.deepEqual(readPoMarker(files[i]!), { v: 1, projectId: String(i).padStart(4, "0") });
  // Each file loses its marker behind the reader's back, its size and mtime kept: a read would see it gone.
  for (let i = 0; i < N; i++) {
    writeFileSync(files[i]!, `${header(`s${i}`)}\n${other(i)}\n`);
    utimesSync(files[i]!, t, t);
  }
  // The next listings answer every file from memory: nothing was read again.
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < N; i++) assert.deepEqual(readPoMarker(files[i]!), { v: 1, projectId: String(i).padStart(4, "0") }, `file ${i} was read again (pass ${pass + 1})`);
  // A file whose mtime moved is read again.
  const later = new Date("2026-02-01T00:00:05Z");
  utimesSync(files[7]!, later, later);
  assert.equal(readPoMarker(files[7]!), null);
  // A file gone reads as nothing.
  rmSync(files[8]!);
  assert.equal(readPoMarker(files[8]!), null);
});
