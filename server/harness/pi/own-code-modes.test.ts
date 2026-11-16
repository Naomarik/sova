// Sova's mode engine in the loader (§chat.mode-menu/sova-runs-modes): the mode slot is recognised by its folder
// (a `mode` folder in an `extensions` folder, by name or through a link, whatever it holds), the first discovered
// one becomes Sova's entry in its own place, always on, any other is dropped, and with none the engine is added
// where a link to it would be found; a worker's listed mode files map in place, whichever tree they lie in.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { isModeSlot, modeFileOf, modesEntries, patchResolve, workerModePaths } from "./own-code";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const REPO_MODE = join(REPO, "pi-config", "extensions", "mode");
const t = realpathSync(mkdtempSync(join(tmpdir(), "own-code-modes-")));
after(() => rmSync(t, { recursive: true, force: true }));
const touch = (p: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "export default () => {};\n");
};
// An older tree's mode folder that has no index.ts at all (what the pi mode extension ships doesn't count).
const bare = join(t, "old", "pi-config", "extensions", "mode");
mkdirSync(bare, { recursive: true });
touch(join(t, "pkg", "a.ts"));
touch(join(t, "elsewhere", "mode", "index.ts")); // a folder named mode outside any extensions folder
touch(join(t, "agent", "extensions", "zeta.ts"));
touch(join(t, "agent", "extensions", "alpha", "index.ts"));
symlinkSync(REPO_MODE, join(t, "agent", "extensions", "mode"));
mkdirSync(join(t, "tree", ".agent", "extensions"), { recursive: true });
symlinkSync(bare, join(t, "tree", ".agent", "extensions", "mode"));
const ENTRY = join(t, "sova", "server", "harness", "pi", "modes-entry.ts");
const entries = { entry: ENTRY, specWorker: join(t, "sova", "spec-w.ts"), projectToolsWorker: join(t, "sova", "pt-w.ts") };

test("the mode slot is its folder: this repo's real one, its index path (an older copy's file), a link to it, a folder with no index.ts; nothing else", () => {
  for (const p of [REPO_MODE, join(REPO_MODE, "index.ts"), join(t, "agent", "extensions", "mode"), join(t, "agent", "extensions", "mode", "index.ts"), bare, join(t, "tree", ".agent", "extensions", "mode")])
    assert.equal(isModeSlot(p), true, p);
  for (const p of [join(REPO, "pi-config", "extensions", "spec"), join(REPO_MODE, "spec-worker.ts"), join(t, "elsewhere", "mode", "index.ts"), join(t, "agent", "extensions", "alpha", "index.ts")])
    assert.equal(isModeSlot(p), false, p);
  assert.equal(modeFileOf(join(REPO_MODE, "spec-worker.ts")), "specWorker");
  assert.equal(modeFileOf(join(REPO_MODE, "project-tools-worker.ts")), "projectToolsWorker");
  assert.equal(modeFileOf(join(t, "agent", "extensions", "mode")), "entry");
  assert.equal(modeFileOf(join(bare, "spec-worker.ts")), "specWorker", "a worker file by its name, though the old tree lacks it");
  assert.equal(modeFileOf(join(REPO, "pi-config", "extensions", "spec", "index.ts")), null);
});

type R = { path: string; enabled: boolean; metadata: Record<string, unknown> };
const auto = (path: string, enabled = true): R => ({ path, enabled, metadata: { source: "auto", scope: "user", origin: "top-level", baseDir: join(t, "agent") } });
const listed = (path: string): R => ({ path, enabled: true, metadata: { source: "local", scope: "user", origin: "top-level" } });

/** resolve() of a fake pi package manager on `agentDir` answering `found`, through Sova's rewrite. */
async function resolved(found: R[], env: NodeJS.ProcessEnv = {}): Promise<R[]> {
  class FakePm {
    agentDir = join(t, "agent");
    async resolve() {
      return { extensions: found.map((r) => ({ ...r })) };
    }
  }
  // The shipped extensions' injection is the loader's own test (own-code.test.ts); here only the mode slot.
  const unpatch = patchResolve(FakePm as never, null, () => {}, { own: join(t, "sova"), entry: ENTRY, env: { PI_CODING_AGENT_DIR: join(t, "agent"), SOVA_OWN_EXTENSIONS: "linked", ...env } });
  try {
    return (await new FakePm().resolve()).extensions as R[];
  } finally {
    unpatch();
  }
}

test("the discovered mode slot becomes Sova's entry in its own place, always on (an /extensions off doesn't stop modes)", async () => {
  for (const enabled of [true, false]) {
    const out = await resolved([auto(join(t, "agent", "extensions", "alpha", "index.ts")), auto(join(t, "agent", "extensions", "mode", "index.ts"), enabled), auto(join(t, "agent", "extensions", "zeta.ts"))]);
    assert.deepEqual(out.map((r) => r.path), [join(t, "agent", "extensions", "alpha", "index.ts"), ENTRY, join(t, "agent", "extensions", "zeta.ts")], "same slot, nothing added or dropped");
    assert.equal(out[1]!.enabled, true, `on, though pi said ${enabled}`);
  }
});

test("only one mode owner: a second mode slot (a listed copy, another tree's) is dropped, never loaded", async () => {
  const out = await resolved([auto(join(t, "agent", "extensions", "mode", "index.ts")), listed(bare), listed(join(t, "pkg", "a.ts"))]);
  assert.deepEqual(out.map((r) => r.path), [ENTRY, join(t, "pkg", "a.ts")]);
});

test("no mode slot at all: the engine is added among the agent dir's own extensions, where a link named mode would sit", async () => {
  const out = await resolved([auto(join(t, "agent", "extensions", "alpha", "index.ts")), auto(join(t, "agent", "extensions", "zeta.ts")), listed(join(t, "pkg", "a.ts"))]);
  assert.deepEqual(out.map((r) => r.path), [join(t, "agent", "extensions", "alpha", "index.ts"), ENTRY, join(t, "agent", "extensions", "zeta.ts"), join(t, "pkg", "a.ts")]);
  assert.equal(out[1]!.enabled, true);
  assert.deepEqual((await resolved([])).map((r) => r.path), [ENTRY], "an empty agent dir too");
});

test("a worktree-config process (another agent dir's state) gets Sova's engine in its tree's mode slot too", async () => {
  const env = { SOVA_CHAT_STATE_ROOT: join(t, "tree", ".agent", "sova") };
  class TreePm {
    agentDir = join(t, "tree", ".agent");
    async resolve() {
      return { extensions: [auto(join(t, "tree", ".agent", "extensions", "mode"))] };
    }
  }
  const unpatch = patchResolve(TreePm as never, null, () => {}, { own: join(t, "sova"), entry: ENTRY, env: { PI_CODING_AGENT_DIR: join(t, "tree", ".agent"), SOVA_OWN_EXTENSIONS: "linked", ...env } });
  try {
    assert.deepEqual((await new TreePm().resolve()).extensions.map((r) => r.path), [ENTRY]);
  } finally {
    unpatch();
  }
});

test("a worker's mode files map in place, order kept, whichever tree they lie in; other paths untouched", () => {
  const list = [join(REPO, "pi-config", "extensions", "spec"), join(t, "agent", "extensions", "mode"), join(REPO_MODE, "spec-worker.ts"), join(REPO_MODE, "project-tools-worker.ts"), "npm:x", join(t, "pkg", "a.ts")];
  assert.deepEqual(workerModePaths(list, entries), [list[0], entries.entry, entries.specWorker, entries.projectToolsWorker, "npm:x", join(t, "pkg", "a.ts")]);
  assert.deepEqual(workerModePaths([join(t, "tree", ".agent", "extensions", "mode"), join(bare, "index.ts"), join(bare, "spec-worker.ts")], entries), [entries.entry, entries.entry, entries.specWorker], "an old tree's mode files, though it lacks them");
  assert.deepEqual(workerModePaths([join(t, "elsewhere", "mode", "index.ts")], entries), [join(t, "elsewhere", "mode", "index.ts")], "a folder named mode outside an extensions folder is no slot");
});

test("the real mode folder has no pi extension in it, and the subagents extension's worker slot paths still map onto Sova's own modules", async () => {
  const { existsSync } = await import("node:fs");
  // By a computed path, as the other tests reach the subagents extension: its pi-typed code stays out of the typecheck.
  const subagents = join(REPO, "pi-config", "extensions", "subagents", "index.ts");
  const { OWN_MODE_EXTENSION, PROJECT_TOOLS_WORKER_EXTENSION, SPEC_WORKER_EXTENSION } = (await import(subagents)) as { OWN_MODE_EXTENSION: string; PROJECT_TOOLS_WORKER_EXTENSION: string; SPEC_WORKER_EXTENSION: string };
  assert.equal(existsSync(join(REPO_MODE, "index.ts")), false, "no index.ts: the folder is texts and rules, no pi extension");
  assert.equal(existsSync(PROJECT_TOOLS_WORKER_EXTENSION), false, "the project-tools slot names a file that no longer exists");
  assert.equal(OWN_MODE_EXTENSION, realpathSync(REPO_MODE));
  const real = modesEntries();
  assert.deepEqual(workerModePaths([OWN_MODE_EXTENSION, SPEC_WORKER_EXTENSION, PROJECT_TOOLS_WORKER_EXTENSION]), [real.entry, real.specWorker, real.projectToolsWorker], "mapped by name, no existence check");
  for (const p of Object.values(real)) assert.equal(existsSync(p), true, `Sova's module exists: ${p}`);
});
