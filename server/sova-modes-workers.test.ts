// Run: pnpm test -- server/sova-modes-workers.test.ts. Every worker runs Sova's mode engine (§chat.mode-menu/sova-runs-modes):
// the parent's worker host stamps `modes: "sova"` on every start (never trusting the request; a pi worker on older
// code reads it), and the worker's build puts Sova's modules in the mode files' listed slots, in place, whatever
// tree they lie in and whether or not the start carries the stamp (a parent on older code).
// A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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

test("a parent's host stamps modes: \"sova\" on every start, spawn and resume alike, whatever the request carried", async () => {
  const { host, starts } = recordingHost();
  const stamped = modesStamped(host);
  await stamped.start({ key: "k1", spec: spec(), session: { new: { dir: "/d" } }, task: "go" });
  await stamped.start({ key: "k2", spec: spec(), session: { resume: { file: "/f" } }, task: null });
  await stamped.start({ key: "k3", spec: spec({ modes: "nonsense" as never }), session: { new: { dir: "/d" } }, task: "go" });
  assert.deepEqual(starts.map((s) => s.spec.modes), ["sova", "sova", "sova"], "Sova's word, not the request's");
});

test("a worker's build puts Sova's modules in the mode slots, in place, stamped or not; flags and other paths kept", () => {
  const e = modesEntries();
  for (const w of [spec({ modes: "sova" }), spec()]) {
    const build = workerBuild(w, "/w.jsonl");
    assert.deepEqual(build.loader.additionalExtensionPaths, [OTHER, e.entry, e.specWorker, e.projectToolsWorker], `modes: ${w.modes ?? "none"}`);
    assert.deepEqual(build.flags(), { extra: { major: "normal", minor: "spec" } }, "the entry reads the same flags");
  }
});

test("a worktree-config worker's mode slot (its .agent's link, wherever it leads, or an older tree's mode folder) is Sova's engine", () => {
  const e = modesEntries();
  // A tree's .agent/extensions/mode linking into the tree's own pi-config, and an older tree's mode folder with no index.ts at all.
  const tree = join(agentDir, "tree");
  mkdirSync(join(tree, "pi-config", "extensions", "mode"), { recursive: true });
  mkdirSync(join(tree, ".agent", "extensions"), { recursive: true });
  symlinkSync(join(tree, "pi-config", "extensions", "mode"), join(tree, ".agent", "extensions", "mode"));
  const listed = [OTHER, join(tree, ".agent", "extensions", "mode"), join(tree, "pi-config", "extensions", "mode", "spec-worker.ts")];
  assert.deepEqual(workerBuild(spec({ extensions: listed }), "/w.jsonl").loader.additionalExtensionPaths, [OTHER, e.entry, e.specWorker]);
});

test("job cards load beside Sova's slots: in place, one each, the cards file after them", () => {
  const e = modesEntries();
  const cards = join(ROOT, "pi-config", "extensions", "wake-nudge.ts");
  const was = process.env.SOVA_JOB_CARDS;
  process.env.SOVA_JOB_CARDS = "only";
  try {
    assert.deepEqual(workerBuild(spec(), "/w.jsonl").loader.additionalExtensionPaths, [OTHER, e.entry, e.specWorker, e.projectToolsWorker, cards]);
  } finally {
    if (was === undefined) delete process.env.SOVA_JOB_CARDS;
    else process.env.SOVA_JOB_CARDS = was;
  }
});
