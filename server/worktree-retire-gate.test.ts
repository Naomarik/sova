// Which Sova this is: what may retire, what a test copy may remove, and what the screens are told.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { archiveRemovalRefusal, ownTestRoots, retirementAllowed, serverKind, TEST_COPY_CANT_TELL, TEST_COPY_KEEPS } from "./worktree-retire-gate";
import { retirementViewOf } from "./worktree-retire-view";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-gate-")));
after(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");
const realDir = join(home, ".pi", "agent");
const custom = join(root, "srv", "sova-agent");
const hermetic = join(root, "checkout", ".agent");
const tmp = join(root, "os-tmp");
for (const d of [realDir, custom, hermetic, tmp]) mkdirSync(d, { recursive: true });
const facts = (agentDir: string) => ({ agentDir, home, tmp });

describe("which Sova this is", () => {
  test("each kind, by what it is", () => {
    assert.equal(serverKind({}, facts(realDir)), "real");
    assert.equal(serverKind({}, facts(custom)), "install");
    assert.equal(serverKind({}, facts(hermetic)), "test", "a checkout's .agent");
    assert.equal(serverKind({}, facts(join(tmp, "agent"))), "test", "under the temp dir");
    for (const env of [{ SOVA_GIT_MAINTENANCE: "off" }, { SOVA_TEST_HOME: root }, { SOVA_TEST_DATA: root }, { HERMETIC_AGENT_DIR: hermetic }]) assert.equal(serverKind(env, facts(custom)), "test", JSON.stringify(env));
    assert.equal(serverKind({ SOVA_TEST_HOME: root }, facts(realDir)), "test", "a test signal beats the agent dir");
  });

  test("code running from a linked worktree is never the real server, even on the real agent dir; a main checkout's can be", () => {
    const linked = join(root, "linked");
    const main = join(root, "main");
    mkdirSync(linked);
    mkdirSync(join(main, ".git"), { recursive: true });
    writeFileSync(join(linked, ".git"), "gitdir: /x/.git/worktrees/linked\n");
    assert.equal(serverKind({}, { ...facts(realDir), codeRoot: linked }), "test");
    assert.equal(serverKind({}, { ...facts(realDir), codeRoot: main }), "real");
  });

  test("can't read which: unknown, and everything reads it as closed", () => {
    assert.equal(serverKind({}, { agentDir: "", home }), "unknown");
    assert.deepEqual(retirementAllowed({}, { agentDir: "", home }), { on: false, offFor: "unknown", why: "Sova couldn't tell which install this is, so it retires nothing." });
    assert.equal(archiveRemovalRefusal(join(root, "x"), join(root, "x", ".git"), {}, { agentDir: "", home }), TEST_COPY_CANT_TELL);
  });
});

describe("retirement is off everywhere but the real server, and says so", () => {
  test("a custom agent dir is told apart from a test copy, and no setting turns it on", () => {
    assert.deepEqual(retirementAllowed({}, facts(realDir)), { on: true });
    const install = retirementAllowed({}, facts(custom));
    assert.equal(!install.on && install.offFor, "install");
    const copy = retirementAllowed({}, facts(hermetic));
    assert.equal(!copy.on && copy.offFor, "test");
    assert.notEqual(!install.on && install.why, !copy.on && copy.why);
    const off = retirementAllowed({ SOVA_RETIRE: "off" }, facts(realDir));
    assert.equal(!off.on && off.offFor, "setting");
    for (const v of ["on", "1", "true"]) assert.equal(retirementAllowed({ SOVA_RETIRE: v }, facts(custom)).on, false, "nothing turns it on");
  });

  test("the view carries it, read live, with nothing to do with any saved list", () => {
    const pending = { v: 1 as const, repos: {} };
    const gate = retirementAllowed({}, facts(custom));
    assert.deepEqual(retirementViewOf("/p/main", { pending, ledger: [], gate }), { retired: [], retiredTotal: 0, held: [], waiting: 0, off: !gate.on ? gate.why : "", offFor: "install" });
    const view = retirementViewOf("/p/main", { pending, ledger: [], gate: { on: true } });
    assert.equal("off" in view, false);
    assert.equal("offFor" in view, false);
  });
});

describe("what a test copy's archive may remove", () => {
  const repoIn = (base: string) => ({ tree: join(base, "wt"), common: join(base, "repo", ".git") });
  const own = repoIn(hermetic);
  const outside = repoIn(join(root, "real-work"));
  for (const r of [own, outside]) {
    mkdirSync(r.tree, { recursive: true });
    mkdirSync(r.common, { recursive: true });
  }
  test("inside its own test data: allowed; the control that shows the refusals below are about where, not always", () => {
    assert.equal(archiveRemovalRefusal(own.tree, own.common, {}, facts(hermetic)), null);
    assert.equal(archiveRemovalRefusal(outside.tree, outside.common, { SOVA_TEST_DATA: join(root, "real-work") }, facts(hermetic)), null);
  });
  test("a worktree or a repository outside: refused, either one alone", () => {
    assert.equal(archiveRemovalRefusal(outside.tree, outside.common, {}, facts(hermetic)), TEST_COPY_KEEPS);
    assert.equal(archiveRemovalRefusal(own.tree, outside.common, {}, facts(hermetic)), TEST_COPY_KEEPS, "the folder's in, its repository isn't");
    assert.equal(archiveRemovalRefusal(outside.tree, own.common, {}, facts(hermetic)), TEST_COPY_KEEPS);
  });
  test("a symlink into its own data doesn't count as inside", () => {
    assert.equal(archiveRemovalRefusal(join(hermetic, "..", "..", "real-work", "wt"), outside.common, {}, facts(hermetic)), TEST_COPY_KEEPS);
  });
  test("git can't name the repository: refused", () => {
    assert.equal(archiveRemovalRefusal(own.tree, null, {}, facts(hermetic)), TEST_COPY_CANT_TELL);
  });
  test("the real server and a custom install aren't limited: each sees its own chats", () => {
    assert.equal(archiveRemovalRefusal(outside.tree, outside.common, {}, facts(realDir)), null);
    assert.equal(archiveRemovalRefusal(outside.tree, outside.common, {}, facts(custom)), null);
  });
  test("a throwaway root that holds this code, or everything, is no root at all", () => {
    const codeRoot = join(root, "checkout");
    assert.deepEqual(ownTestRoots({ SOVA_TEST_DATA: "/" }, { ...facts(hermetic), codeRoot }), [hermetic]);
    assert.deepEqual(ownTestRoots({ SOVA_TEST_DATA: root }, { ...facts(custom), codeRoot }), [custom], "it holds the code");
    assert.deepEqual(ownTestRoots({ SOVA_TEST_DATA: join(root, "real-work") }, { ...facts(custom), codeRoot }), [custom, join(root, "real-work")], "the control");
  });
});
