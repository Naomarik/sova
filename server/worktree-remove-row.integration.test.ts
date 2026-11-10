// §chat.worktrees/pane: Remove on a Worktrees row, only where retirement is off for this install, only with nothing
// left, through the one removal step. Real git on a temp repository; the server decides, whatever a screen shows.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Fixture, git } from "./merge-queue/testing/repo";
import { readLedger } from "./removed-worktrees";
import { removeFinished, retirementAllowed } from "./worktree-retire";
import { plainRetireDeps } from "./worktree-retire-deps.integration.fixture";
import { removeOffered } from "./worktree-retire-gate";

const fixtures: Fixture[] = [];
after(() => {
  for (const f of fixtures) f.dispose();
});

const HOME = "/home/u";
const INSTALL = retirementAllowed({}, { agentDir: "/srv/sova-agent", home: HOME, tmp: "/tmp" });
const REAL = retirementAllowed({}, { agentDir: `${HOME}/.pi/agent`, home: HOME, tmp: "/tmp" });
const TEST = retirementAllowed({}, { agentDir: "/w/checkout/.agent", home: HOME, tmp: "/tmp" });
const SETTING = retirementAllowed({ SOVA_RETIRE: "off" }, { agentDir: `${HOME}/.pi/agent`, home: HOME, tmp: "/tmp" });

function world() {
  const fx = new Fixture({ remote: false });
  fixtures.push(fx);
  return { fx, deps: plainRetireDeps({ project: fx.project, target: fx.target, state: fx.state }), ledger: () => readLedger(join(fx.state, "removed-worktrees.json")) };
}
function finished(fx: Fixture, name: string) {
  const b = fx.branch(name, { [`${name}.txt`]: `${name}\n` });
  git(fx.project, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
  return b;
}
const branches = (fx: Fixture) => git(fx.project, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);

describe("whether a row offers it", () => {
  test("only with nothing left, on an install where retirement is off for that reason", () => {
    assert.equal(removeOffered("nothing", INSTALL), true);
    for (const gate of [REAL, TEST, SETTING]) assert.equal(removeOffered("nothing", gate), false, JSON.stringify(gate));
    assert.equal(removeOffered("drafts", INSTALL), false);
    assert.equal(removeOffered(undefined, INSTALL), false);
  });
});

describe("the server refuses, whatever a screen shows", () => {
  for (const [name, gate] of [["a real install", REAL], ["a test server", TEST], ["SOVA_RETIRE=off", SETTING]] as const) {
    test(`${name}: nothing goes, a finished tree in a real repository included`, async () => {
      const { fx, deps, ledger } = world();
      const b = finished(fx, "nope");
      const r = await removeFinished(b.checkout, deps, gate);
      assert.equal(r.ok, false);
      assert.match(!r.ok ? r.error : "", /Nothing was removed/);
      assert.ok(existsSync(b.checkout), "the folder stays");
      assert.match(branches(fx), /feat\/nope/);
      assert.deepEqual(ledger(), []);
    });
  }

  test("the control: on an install the same tree goes, folder then branch, its last commit pinned and in the ledger", async () => {
    const { fx, deps, ledger } = world();
    const b = finished(fx, "yes");
    const r = await removeFinished(b.checkout, deps, INSTALL);
    assert.deepEqual(r, { ok: true, path: b.checkout, branch: b.branch, branchDeleted: true });
    assert.equal(existsSync(b.checkout), false);
    assert.doesNotMatch(branches(fx), /feat\/yes/);
    assert.equal(git(fx.project, ["rev-parse", `refs/sova/retired/${b.commit}`]), b.commit);
    assert.deepEqual(ledger().map((e) => [e.path, e.tip, e.retired]), [[b.checkout, b.commit, true]]);
  });
});

describe("on an install, every refusal of the one step still holds", () => {
  test("a branch with work to land", async () => {
    const { fx, deps } = world();
    const b = fx.branch("work", { "work.txt": "work\n" });
    const r = await removeFinished(b.checkout, deps, INSTALL);
    assert.deepEqual(r, { ok: false, error: "It has work to land. Nothing was removed." });
    assert.ok(existsSync(b.checkout));
  });
  test("an uncommitted file", async () => {
    const { fx, deps } = world();
    const b = finished(fx, "dirty");
    writeFileSync(join(b.checkout, "only-here.txt"), "x\n");
    const r = await removeFinished(b.checkout, deps, INSTALL);
    assert.match(!r.ok ? r.error : "", /only-here\.txt.*Nothing was removed/);
    assert.ok(existsSync(join(b.checkout, "only-here.txt")));
  });
  test("an ignored file of an unknown kind", async () => {
    const { fx, deps } = world();
    const b = finished(fx, "ign");
    writeFileSync(join(b.checkout, ".git-info-exclude-test"), "");
    git(b.checkout, ["config", "core.excludesFile", join(b.checkout, ".git-info-exclude-test")]);
    writeFileSync(join(b.checkout, ".git-info-exclude-test"), "keep.me\n.git-info-exclude-test\n");
    writeFileSync(join(b.checkout, "keep.me"), "only here\n");
    const r = await removeFinished(b.checkout, deps, INSTALL);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(existsSync(join(b.checkout, "keep.me")));
  });
  test("a chat that isn't quiet", async () => {
    const { fx, deps } = world();
    const b = finished(fx, "busy");
    const d = { ...deps, chats: async (paths: readonly string[]) => ({ unreadable: [], uses: [{ path: "/s/x.jsonl", name: "“x”", cwd: b.checkout, inside: [...paths], tracks: [], archived: false, running: true, tui: false, workers: 0, sandbox: false, lastActiveAt: 0 }] }) };
    const r = await removeFinished(b.checkout, d, INSTALL);
    assert.deepEqual(r, { ok: false, error: "Chat “x” is running. Nothing was removed." });
    assert.ok(existsSync(b.checkout));
  });
  test("a folder git doesn't list, a main checkout or nowhere at all", async () => {
    const { fx, deps } = world();
    const plain = join(fx.root, "plain");
    mkdirSync(plain);
    for (const p of [plain, fx.project, "/nowhere/at/all"]) {
      const r = await removeFinished(p, deps, INSTALL);
      assert.equal(r.ok, false, p);
    }
    assert.ok(existsSync(plain) && existsSync(join(fx.project, ".git")));
  });
});
