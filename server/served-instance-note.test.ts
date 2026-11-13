import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { servedInstanceNote, servedWorkerTools } from "./chat-handle";
import type { ProjectEngine } from "./project-services/engine";

/**
 * A worker chat in a process of its own asks the server for its instance note (`project.note`). The server
 * reads the worker's session file, whose own sandbox entry reads on for a write-only worker too, so only
 * the launch flags it served the worker's tools under tell a write-only worker (the host's network: it can
 * reach its ports) from an On one (it can't).
 */

const root = mkdtempSync(join(tmpdir(), "sova-served-note-"));
after(() => rmSync(root, { recursive: true, force: true }));
const tree = realpathSync(mkdtempSync(join(root, "tree-")));
execFileSync("git", ["init", "-q", tree]);

const engine = (() => ({
  noteFacts: async (checkout: string) => ({
    kind: "instance",
    checkout,
    branch: "feat/x",
    project: "/home/u/proj",
    instance: "proj-1",
    slot: 1,
    ports: [{ key: "server.http", port: 4840, main: 4800, shared: false }],
    services: [],
    data: [],
    test: null,
  }),
})) as unknown as () => ProjectEngine;

let n = 0;
/** A worker's session file whose sandbox entry reads on, as a write-only worker's own extension writes it. */
function workerSession(): string {
  const id = `01234567-89ab-7cde-8f01-00000000${String(++n).padStart(4, "0")}`;
  const path = join(root, `${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-11-11T00:00:00.000Z", cwd: tree },
    { type: "custom", id: "e1", parentId: null, timestamp: "2026-11-11T00:00:01.000Z", customType: "sandbox", data: { version: 1, on: true, level: "workspace-write", backend: "linux-bwrap", enforcement: "full" } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

const scope = (writeOnly: boolean) => JSON.stringify({ version: 1, level: "workspace-write", workspaceRoot: tree, writable: [tree], ...(writeOnly ? { writeOnly: true } : {}) });
const parent = { sessionId: "parent", path: join(root, "parent.jsonl"), workerId: "ag_01" } as never;
const LINE = /\nYour shell is sandboxed and cannot reach these ports: use project_verbs\.$/;

test("a write-only worker served out of process gets no 'cannot reach these ports' line; an On worker and an unrecorded chat do", async () => {
  const writeOnly = workerSession();
  servedWorkerTools(writeOnly, { flags: { sandbox: "on", "sandbox-parent": scope(true) }, parent });
  const wo = await servedInstanceNote(writeOnly, { sessionId: "w", cwd: tree, leafId: null }, engine);
  assert.match(wo!, /^Sova instance note for /);
  assert.doesNotMatch(wo!, /cannot reach these ports/);

  const on = workerSession();
  servedWorkerTools(on, { flags: { sandbox: "on", "sandbox-parent": scope(false) }, parent });
  assert.match((await servedInstanceNote(on, { sessionId: "o", cwd: tree, leafId: null }, engine))!, LINE);

  // A chat this server served no worker tools to: its own sandbox entry decides, as before.
  assert.match((await servedInstanceNote(workerSession(), { sessionId: "c", cwd: tree, leafId: null }, engine))!, LINE);
});
