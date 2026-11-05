// Run: pnpm test -- server/modes/worker-slots.golden.test.ts. A worker's mode files come from one source and
// keep their place (al_1 a6): subagents names them once, as SPEC_WORKER_EXTENSION and
// PROJECT_TOOLS_WORKER_EXTENSION (its only mention of either file in code), and own-code maps exactly those
// (modeFileOf, workerModePaths) into Sova's modules in the same position. With the switch off, the list stays
// as listed; a parent on older code listing a file this copy no longer has gets Sova's module in its slot.
// The recordings (modes-sova.golden*.ts) show the same from outside: each worker's load order, slots named,
// is the same with the switch on and off.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { modeFileOf, modesEntries, workerModePaths } from "../harness/pi/own-code";

const REPO = join(import.meta.dirname, "../..");
// Imported by a computed path: pi-config's code is typechecked there, not by the server's tsc.
const SUBAGENTS: string = new URL("../../pi-config/extensions/subagents/index.ts", import.meta.url).href;
const { MARKER_EXTENSION, PROJECT_TOOLS_WORKER_EXTENSION, SPEC_WORKER_EXTENSION } = (await import(SUBAGENTS)) as { MARKER_EXTENSION: string; PROJECT_TOOLS_WORKER_EXTENSION: string; SPEC_WORKER_EXTENSION: string };
const MODE_DIR = join(REPO, "pi-config/extensions/mode");
const entries = modesEntries(REPO);

test("subagents names each worker mode file once, in its constant, and own-code knows them by kind", () => {
  const code = readdirSync(join(REPO, "pi-config/extensions/subagents"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(REPO, "pi-config/extensions/subagents", f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n"));
  for (const file of ["spec-worker.ts", "project-tools-worker.ts"]) {
    const uses = code.join("\n").match(new RegExp(`"${file.replace(".", "\\.")}"`, "g")) ?? [];
    assert.equal(uses.length, 1, `"${file}" is named once in subagents' code (its constant), not ${uses.length} times`);
  }
  assert.equal(modeFileOf(SPEC_WORKER_EXTENSION), "specWorker");
  assert.equal(modeFileOf(PROJECT_TOOLS_WORKER_EXTENSION), "projectToolsWorker");
  assert.equal(modeFileOf(MODE_DIR), "entry");
  assert.equal(modeFileOf(join(MODE_DIR, "index.ts")), "entry");
  assert.equal(modeFileOf(MARKER_EXTENSION), null, "no other extension is a mode file");
});

const listed = [MARKER_EXTENSION, SPEC_WORKER_EXTENSION, join(REPO, "pi-config/extensions/model-levels/index.ts"), PROJECT_TOOLS_WORKER_EXTENSION];

test("switch on: each listed mode file maps to Sova's module in its own slot, nothing moves or is added", () => {
  const mapped = workerModePaths(listed, true, entries, null);
  assert.deepEqual(mapped, [MARKER_EXTENSION, entries.specWorker, listed[2], entries.projectToolsWorker]);
  assert.deepEqual(workerModePaths([MARKER_EXTENSION, MODE_DIR], true, entries, null), [MARKER_EXTENSION, entries.entry], "a worktree-config worker's mode slot too");
});

test("switch off: the list stays as listed; only a file this copy lacks (an older parent's) maps, in place", () => {
  assert.deepEqual(workerModePaths(listed, false, entries, null), listed);
  assert.deepEqual(workerModePaths([MARKER_EXTENSION, MODE_DIR], false, entries, null), [MARKER_EXTENSION, MODE_DIR], "the extension itself stays");
  const retired = "/nowhere/pi-config/extensions/mode/spec-worker.ts";
  assert.deepEqual(workerModePaths([MARKER_EXTENSION, retired], false, entries, null), [MARKER_EXTENSION, entries.specWorker]);
});
