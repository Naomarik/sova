// Run: pnpm test -- server/sova-modes-workers.test.ts. A worker takes its parent's modes owner at its spawn
// or resume (§chat.mode-menu/sova-runs-modes): the parent's worker host stamps `modes: "sova"` on every start
// it makes for a parent whose modes run on Sova (never trusting the request), and the worker's build puts
// Sova's modules in the mode extension's listed slots, in place, or keeps the list as given.
// A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { WorkerHost, WorkerSpec, WorkerStart } from "../shared/chat-runtime";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-modes-workers-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { modesStamped, workerBuild } = await import("./chat-manager");
const { modesEntries } = await import("./harness/pi/own-code");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODE = join(ROOT, "pi-config", "extensions", "mode");
const SPEC_WORKER = join(MODE, "spec-worker.ts");
const PROJECT_TOOLS = join(MODE, "project-tools-worker.ts");
const OTHER = join(ROOT, "pi-config", "extensions", "provider-limits", "index.ts");

const spec = (extra: Partial<WorkerSpec> = {}): WorkerSpec => ({
  kind: "worker",
  parent: { sessionId: "p", path: "/p.jsonl", workerId: "ag_01" },
  cwd: agentDir,
  model: null,
  thinking: null,
  builtins: null,
  extensions: [OTHER, join(MODE, "index.ts"), SPEC_WORKER, PROJECT_TOOLS],
  flags: { major: "normal", minor: "spec" },
  appendSystemPrompt: null,
  env: {},
  agentDir: null,
  lowered: true,
  ...extra,
});

function recordingHost(): { host: WorkerHost; starts: WorkerStart[] } {
  const starts: WorkerStart[] = [];
  const host: WorkerHost = {
    start: async (req) => {
      starts.push(req);
      return { chatId: "c", sessionId: "s", sessionFile: "/s", workerId: req.spec.parent.workerId, kind: req.spec.kind, pid: null, state: "open" };
    },
    send: async () => ({ queued: true }),
    abort: async () => {},
    stop: async () => {},
    watch: () => () => {},
    list: async () => [],
  };
  return { host, starts };
}

test("a Sova-owned parent's host stamps modes: \"sova\" on every start, spawn and resume alike", async () => {
  const { host, starts } = recordingHost();
  const stamped = modesStamped(host, true);
  await stamped.start({ key: "k1", spec: spec(), session: { new: { dir: "/d" } }, task: "go" });
  await stamped.start({ key: "k2", spec: spec(), session: { resume: { file: "/f" } }, task: null });
  assert.deepEqual(starts.map((s) => s.spec.modes), ["sova", "sova"]);
});

test("an extension-owned parent's host stamps nothing, and drops a modes a request carried", async () => {
  const { host, starts } = recordingHost();
  const stamped = modesStamped(host, false);
  await stamped.start({ key: "k1", spec: spec({ modes: "sova" }), session: { new: { dir: "/d" } }, task: "go" });
  assert.equal("modes" in starts[0]!.spec, false);
  const { host: h2, starts: s2 } = recordingHost();
  await modesStamped(h2, true).start({ key: "k1", spec: spec({ modes: "nonsense" as never }), session: { new: { dir: "/d" } }, task: "go" });
  assert.equal(s2[0]!.spec.modes, "sova", "Sova's word, not the request's");
});

test("a Sova-owned worker's build puts Sova's modules in the mode slots, in place; flags and other paths kept", () => {
  const e = modesEntries();
  const build = workerBuild(spec({ modes: "sova" }), "/w.jsonl");
  assert.deepEqual(build.loader.additionalExtensionPaths, [OTHER, e.entry, e.specWorker, e.projectToolsWorker]);
  assert.deepEqual(build.flags(), { extra: { major: "normal", minor: "spec" } }, "the entry reads the same flags");
});

test("job cards load whichever owner runs modes: Sova's slots in place, one each, the cards file after them", () => {
  const e = modesEntries();
  const cards = join(ROOT, "pi-config", "extensions", "wake-nudge.ts");
  const was = process.env.SOVA_JOB_CARDS;
  process.env.SOVA_JOB_CARDS = "only";
  try {
    assert.deepEqual(workerBuild(spec({ modes: "sova" }), "/w.jsonl").loader.additionalExtensionPaths, [OTHER, e.entry, e.specWorker, e.projectToolsWorker, cards]);
    const w = spec();
    assert.deepEqual(workerBuild(w, "/w.jsonl").loader.additionalExtensionPaths, [...w.extensions, cards]);
  } finally {
    if (was === undefined) delete process.env.SOVA_JOB_CARDS;
    else process.env.SOVA_JOB_CARDS = was;
  }
});

test("an extension-owned worker's build lists exactly what its parent listed", () => {
  const w = spec();
  assert.deepEqual(workerBuild(w, "/w.jsonl").loader.additionalExtensionPaths, w.extensions);
});
