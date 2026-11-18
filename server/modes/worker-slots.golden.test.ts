// Run: pnpm test -- server/modes/worker-slots.golden.test.ts. A worker's mode files come from one source and
// keep their place (al_1 a6): subagents names them once, as SPEC_WORKER_EXTENSION and
// PROJECT_TOOLS_WORKER_EXTENSION (the latter by the slot token PROJECT_TOOLS_WORKER_SLOT it shares with own-code),
// and own-code maps exactly those
// (modeFileOf, workerModePaths) into Sova's modules in the same position, whatever tree they lie in (a parent on
// older code listing a file this copy no longer has included). The recordings (modes-sova.golden*.ts) show the same
// from outside: each worker's load order, slots named.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PROJECT_TOOLS_WORKER_SLOT } from "../../pi-config/extensions/mode/project-tools.ts";
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
  const count = (file: string) => (code.join("\n").match(new RegExp(`"${file.replace(".", "\\.")}"`, "g")) ?? []).length;
  assert.equal(count("spec-worker.ts"), 1, `"spec-worker.ts" is named once in subagents' code (its constant)`);
  assert.equal(count(PROJECT_TOOLS_WORKER_SLOT), 0, "the project-tools slot is named by the shared token, never spelled out in subagents");
  assert.equal(PROJECT_TOOLS_WORKER_EXTENSION, join(MODE_DIR, PROJECT_TOOLS_WORKER_SLOT), "PROJECT_TOOLS_WORKER_EXTENSION is the token in the mode folder");
  assert.equal(PROJECT_TOOLS_WORKER_SLOT, "project-tools-worker.ts", "the token keeps the name older workers' recorded lists carry");
  assert.equal(modeFileOf(SPEC_WORKER_EXTENSION), "specWorker");
  assert.equal(modeFileOf(PROJECT_TOOLS_WORKER_EXTENSION), "projectToolsWorker");
  assert.equal(modeFileOf(MODE_DIR), "entry");
  assert.equal(modeFileOf(join(MODE_DIR, "index.ts")), "entry");
  assert.equal(modeFileOf(MARKER_EXTENSION), null, "no other extension is a mode file");
});

const listed = [MARKER_EXTENSION, SPEC_WORKER_EXTENSION, join(REPO, "pi-config/extensions/model-levels/index.ts"), PROJECT_TOOLS_WORKER_EXTENSION];

test("each listed mode file maps to Sova's module in its own slot, nothing moves or is added", () => {
  assert.deepEqual(workerModePaths(listed, entries), [MARKER_EXTENSION, entries.specWorker, listed[2], entries.projectToolsWorker]);
  assert.deepEqual(workerModePaths([MARKER_EXTENSION, MODE_DIR], entries), [MARKER_EXTENSION, entries.entry], "a worktree-config worker's mode slot too");
  const retired = "/nowhere/pi-config/extensions/mode/spec-worker.ts";
  assert.deepEqual(workerModePaths([MARKER_EXTENSION, retired], entries), [MARKER_EXTENSION, entries.specWorker], "a file an older parent listed that this copy lacks");
  const saved = "/old/tree/pi-config/extensions/mode/project-tools-worker.ts";
  assert.deepEqual(workerModePaths([MARKER_EXTENSION, saved], entries), [MARKER_EXTENSION, entries.projectToolsWorker], "an older chat's saved project-tools slot");
});
