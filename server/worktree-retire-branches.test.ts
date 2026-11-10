// §chat.worktrees/retirement: "The branch stays unless the project says otherwise." Each rule once, in-process: real git
// on a throwaway repository, the chats and processes stood in for (the safety suite is the home of everything else).
//
// Broken on purpose in a private copy: retireTree called retireBranch whatever the setting said, and "off keeps the branch"
// failed on the missing branch (not on a wording), so the off path can't delete one unnoticed.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import type { Git } from "../pi-config/extensions/worktrees/git.ts";
import { rowKeyOf, type RowKeyInput } from "../src/lib/merge-queue";
import { CONTRACT_FILE } from "../shared/project-contract";
import { Fixture, git } from "./merge-queue/testing/repo";
import { branchLeft } from "./nothing-left";
import { removeWorktree } from "./project-worktrees";
import { appendLedger, goneTreeState, markLedger, readLedger } from "./removed-worktrees";
import { classifyRepo, pidAlive, type TreeRecord } from "./worktree-cleanup";
import { bringBack, definitionDeletesBranches, removeFinished, restoreRetired, retireNow, retirePass, retireTree, setRealRetireDeps, type RetireDeps } from "./worktree-retire";
import type { Gate } from "./worktree-retire-gate";
import { execGit } from "./worktrees";

const fixtures: Fixture[] = [];
after(() => fixtures.forEach((f) => f.dispose()));
afterEach(() => setRealRetireDeps(null));

const verb = (args: readonly string[]): string[] => {
  const a = [...args];
  while (a[0] === "-c") a.splice(0, 2);
  return a;
};

interface World {
  fx: Fixture;
  d: RetireDeps;
  writes: string[];
  queueMade: Set<string>;
  records: TreeRecord[];
}

function world(o: { seam?: RetireDeps["deleteBranches"]; fixture?: ConstructorParameters<typeof Fixture>[0] } = {}): World {
  const fx = new Fixture({ remote: false, ...o.fixture });
  fixtures.push(fx);
  const writes: string[] = [];
  const queueMade = new Set<string>();
  const records: TreeRecord[] = [];
  const through: Git = async (args, cwd) => {
    writes.push(verb(args).join(" "));
    const r = await execGit(args, { cwd });
    return { code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  const later = Date.now() + 3_600_000;
  const ledgerFile = join(fx.state, "removed-worktrees.json");
  const target = async (main: string) => ({ name: fx.target, oid: git(main, ["rev-parse", fx.target]) });
  const d: RetireDeps = {
    allowed: () => ({ on: true }),
    repos: () => [fx.project],
    git: execGit,
    gitWrite: through,
    gitRemove: through,
    classify: (root, only) => classifyRepo(root, { git: execGit, withQueueMade: true, queueMade: async () => (p) => queueMade.has(p), ...(only ? { only } : {}) }),
    chats: async () => ({ uses: [], unreadable: [] }),
    records: async () => ({ records, unreadable: [] }),
    processes: async () => [],
    alive: pidAlive,
    openEntry: () => null,
    draftsUnproved: async () => [],
    branchFinished: async (main, branch) => {
      const tip = await execGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], { cwd: main });
      if (tip.code !== 0) return false;
      const left = await branchLeft({ root: main, branch, head: tip.stdout.trim(), target: await target(main) });
      return !left.code.left && left.code.kind !== "unknown";
    },
    copies: { of: () => null, teardown: async () => {} },
    ledger: () => readLedger(ledgerFile),
    appendLedger: (e) => appendLedger(e, ledgerFile),
    markLedger: (m, p) => markLedger(m, p, ledgerFile),
    removed: async () => {},
    now: () => later,
    pendingFile: () => join(fx.state, "retire-pending.json"),
    queueMade: async (p) => queueMade.has(p),
    ...(o.seam ? { deleteBranches: o.seam } : {}),
  };
  return { fx, d, writes, queueMade, records };
}

const finished = (w: World, name: string) => {
  const b = w.fx.branch(name, { [`${name}.txt`]: `${name}\n` });
  git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
  return b;
};
const OFF = () => false;
const ON = () => true;
const branchAt = (w: World, name: string): string => git(w.fx.project, ["rev-parse", "-q", "--verify", `refs/heads/${name}`], { allowFail: true });
const lastEntry = (w: World) => w.d.ledger().at(-1)!;
const deletes = (w: World, branch: string): string[] => w.writes.filter((x) => x === `branch -d -- ${branch}` || x.startsWith(`update-ref -d refs/heads/${branch}`));
const add = (w: World): string[] => w.writes.filter((x) => x.startsWith("worktree add"));

describe("the setting: true only where the definition says so", () => {
  test("in the definition's text", () => {
    // Every row is otherwise a definition the parser accepts, so a false here is the key's own answer, not a parse failure.
    const w = world();
    const def = w.fx.definition() as Record<string, unknown> & { merge?: Record<string, unknown> };
    const withKey = (v: unknown) => JSON.stringify({ ...def, merge: { ...def.merge, deleteBranches: v } });
    assert.equal(definitionDeletesBranches(withKey(true)), true, "the control");
    const noMerge = { ...def };
    delete noMerge.merge;
    for (const text of [JSON.stringify({ ...def, merge: { ...def.merge } }), JSON.stringify(noMerge), withKey(false), withKey("true"), withKey(1), "{ not json", ""])
      assert.equal(definitionDeletesBranches(text), false, text);
  });

  test("read from the definition at the target's head, a missing one counting as off", async () => {
    const on = world({ fixture: { merge: { deleteBranches: true } } });
    const a = finished(on, "defon");
    assert.equal((await retireTree(on.d, on.fx.project, a.checkout)).state, "retired");
    assert.equal(branchAt(on, a.branch), "", "the control: the key on the target deletes it");

    for (const [name, change] of [
      ["absent", null],
      ["unparsable", { [CONTRACT_FILE]: "{ not json" }],
      ["deleted", { [CONTRACT_FILE]: null }],
    ] as [string, Record<string, string | null> | null][]) {
      const w = world();
      const b = finished(w, `def-${name}`);
      if (change) w.fx.moveTargetOutside(change);
      assert.equal((await retireTree(w.d, w.fx.project, b.checkout)).state, "retired", name);
      assert.equal(branchAt(w, b.branch), b.commit, `${name}: the branch stays`);
    }
  });

  test("a seam that throws or answers anything but true keeps the branch", async () => {
    for (const seam of [() => { throw new Error("?"); }, () => "true" as never, () => 1 as never]) {
      const w = world({ seam });
      const b = finished(w, "seamdoubt");
      assert.equal((await retireTree(w.d, w.fx.project, b.checkout)).state, "retired");
      assert.equal(branchAt(w, b.branch), b.commit);
    }
  });
});

describe("off", () => {
  test("the folder goes, the branch stays, its commit stays pinned, and the ledger says the setting kept it", async () => {
    const w = world({ seam: OFF });
    const b = finished(w, "kept");
    const r = await retireTree(w.d, w.fx.project, b.checkout);
    assert.equal(r.state, "retired", JSON.stringify(r));
    assert.equal(r.state === "retired" && r.row.branchKept, true);
    assert.equal(existsSync(b.checkout), false, "the folder went");
    assert.equal(branchAt(w, b.branch), b.commit, "the branch stayed where it was");
    assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${b.commit}`]), b.commit, "pinned all the same");
    assert.deepEqual(deletes(w, b.branch), [], "no delete was sent");
    const e = lastEntry(w);
    assert.equal(e.branchKept, true);
    assert.equal(e.branchDeleted, false);
  });

  test("a kept branch is never deleted later, even with the setting turned on; a branch git refused still is", async () => {
    let on = false;
    const w = world({ seam: () => on });
    const b = finished(w, "keptlater");
    await retirePass(w.d);
    assert.equal(lastEntry(w).branchKept, true);
    on = true;
    await retirePass(w.d);
    assert.equal(branchAt(w, b.branch), b.commit, "it stays kept when the setting changes");
    assert.deepEqual(deletes(w, b.branch), []);

    // The control: the same pass would finish a branch the setting meant to delete. Without this, a pass that never finishes anything passes the test above.
    const c = finished(w, "refused");
    git(w.fx.project, ["worktree", "remove", "--force", c.checkout]);
    w.d.appendLedger([{ v: 1, path: c.checkout, branch: c.branch, commonDir: join(w.fx.project, ".git"), tip: c.commit, merged: "ancestor", branchDeleted: false, at: 1, retired: true, pinned: true }]);
    await retirePass(w.d);
    assert.equal(branchAt(w, c.branch), "", "the same wake-up does delete one with no branchKept");
  });

  /** A folder left behind, its branch still there and finished, named by a chat's record. */
  const leftover = (w: World, name: string) => {
    const b = finished(w, name);
    git(w.fx.project, ["worktree", "remove", "--force", b.checkout]);
    mkdirSync(join(b.checkout, "node_modules"), { recursive: true });
    writeFileSync(join(b.checkout, "node_modules/a.js"), "x\n");
    w.records.push({ path: b.checkout, branch: b.branch, base: git(w.fx.project, ["rev-list", "--max-parents=0", w.fx.target]), session: "s" });
    return b;
  };

  // The case that proves the queue's exception doesn't widen deletion. A seam that can't answer isn't proof.
  for (const [name, seam] of [["no proof of who made it", undefined], ["a seam that throws", async () => { throw new Error("?"); }]] as const)
    test(`an ordinary leftover keeps its branch and records it, with the setting off: ${name}`, async () => {
      const w = world({ seam: OFF });
      if (seam) w.d.queueMade = seam;
      const b = leftover(w, "leftkept");
      // Proved this repository's: a folder only a chat's record names never touches a branch at all (safety suite).
      w.d.appendLedger([{ v: 1, path: b.checkout, branch: b.branch, commonDir: realpathSync(join(w.fx.project, ".git")), tip: b.commit, merged: "leftover", branchDeleted: false, at: 1, retired: true, pinned: true }]);
      await retirePass(w.d);
      assert.equal(existsSync(b.checkout), false, "the folder went");
      assert.equal(branchAt(w, b.branch), b.commit);
      assert.equal(lastEntry(w).branchKept, true);
    });

  test("a leftover the queue made loses its branch with the setting off, by the queue's seam or by its ledger entry", async () => {
    const byEntry = world({ seam: OFF });
    const seamed = world({ seam: OFF });
    const a = leftover(seamed, "resolve-mq_seam");
    seamed.queueMade.add(a.checkout);
    const b = leftover(byEntry, "resolve-mq_entry");
    byEntry.d.appendLedger([{ v: 1, path: b.checkout, branch: b.branch, commonDir: byEntry.d.ledger().at(-1)?.commonDir ?? realpathSync(join(byEntry.fx.project, ".git")), tip: b.commit, merged: "leftover", branchDeleted: false, at: 1, retired: true, pinned: true, queueMade: true }]);
    for (const [w, x] of [[seamed, a], [byEntry, b]] as const) {
      await retirePass(w.d);
      assert.equal(existsSync(x.checkout), false, "the folder went");
      assert.equal(branchAt(w, x.branch), "", "its branch went too, whatever the setting");
      assert.notEqual(lastEntry(w).branchKept, true);
      assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${x.commit}`]), x.commit, "still pinned");
    }
  });

  test("the merge queue's own copies always lose their branch; a branch of yours with a name like one follows the setting", async () => {
    const w = world({ seam: OFF });
    const q = finished(w, "resolve-mq_1");
    const yours = finished(w, "resolve-mq_2");
    w.queueMade.add(q.checkout);
    await retirePass(w.d);
    assert.equal(existsSync(q.checkout), false);
    assert.equal(branchAt(w, q.branch), "", "made by the queue: it goes");
    assert.equal(existsSync(yours.checkout), false);
    assert.equal(branchAt(w, yours.branch), yours.commit, "the name isn't who made it");
  });
});

describe("a kept branch and the way back", () => {
  async function kept(name: string) {
    const w = world({ seam: OFF });
    const b = finished(w, name);
    assert.equal((await retireTree(w.d, w.fx.project, b.checkout)).state, "retired");
    w.writes.length = 0;
    return { w, b };
  }

  test("a message brings the folder back on it as it stands, with no -b and the branch unmoved, though the target went on", async () => {
    const { w, b } = await kept("bb");
    const newest = w.fx.moveTargetOutside({ "newer.txt": "n\n" });
    const r = await bringBack(w.d, b.checkout);
    assert.equal(r.state, "back", JSON.stringify(r));
    assert.deepEqual(add(w), [`worktree add -- ${b.checkout} ${b.branch}`]);
    assert.equal(branchAt(w, b.branch), b.commit, "the branch didn't move");
    assert.equal(git(b.checkout, ["rev-parse", "HEAD"]), b.commit, "and the folder is on it");
    assert.notEqual(git(b.checkout, ["rev-parse", "HEAD"]), newest);
    const sha = b.commit.slice(0, 7);
    assert.equal(r.state === "back" && r.line, `Your worktree was retired after ${b.branch} landed. It's back at ${b.checkout}, on ${b.branch} as it was at ${sha}. It may be behind ${w.fx.target}.`);
  });

  test("a kept branch deleted since comes back fresh from the target", async () => {
    const { w, b } = await kept("bbgone");
    const newest = w.fx.moveTargetOutside({ "newer.txt": "n\n" });
    git(w.fx.project, ["branch", "-D", b.branch]);
    const r = await bringBack(w.d, b.checkout);
    assert.equal(r.state, "back", JSON.stringify(r));
    assert.equal(git(b.checkout, ["rev-parse", "HEAD"]), newest);
    assert.match(r.state === "back" ? r.line : "", new RegExp(`fresh from ${w.fx.target} at`));
  });

  test("a same-named branch off another line isn't the one it kept: in use, with nothing moved", async () => {
    const { w, b } = await kept("bbother");
    git(w.fx.project, ["branch", "-D", b.branch]);
    git(w.fx.project, ["branch", b.branch, git(w.fx.project, ["rev-list", "--max-parents=0", w.fx.target])]);
    const at = branchAt(w, b.branch);
    const r = await bringBack(w.d, b.checkout);
    assert.equal(r.state, "failed", JSON.stringify(r));
    assert.equal(branchAt(w, b.branch), at);
    assert.equal(existsSync(b.checkout), false);
  });

  test("Restore puts the folder back on a present branch as it stands; moved on since, it stays moved", async () => {
    const { w, b } = await kept("rs");
    const moved = git(w.fx.project, ["commit-tree", `${b.commit}^{tree}`, "-p", b.commit, "-m", "after it retired"]);
    git(w.fx.project, ["update-ref", `refs/heads/${b.branch}`, moved]);
    const r = await restoreRetired(w.d, { root: w.fx.project, path: b.checkout, branch: b.branch, tip: b.commit });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(add(w), [`worktree add -- ${b.checkout} ${b.branch}`]);
    assert.equal(branchAt(w, b.branch), moved, "never moved back");
    assert.equal(git(b.checkout, ["rev-parse", "HEAD"]), moved);
  });

  test("Restore of a kept branch deleted since puts it back at its recorded commit", async () => {
    const { w, b } = await kept("rsgone");
    git(w.fx.project, ["branch", "-D", b.branch]);
    assert.equal((await restoreRetired(w.d, { root: w.fx.project, path: b.checkout, branch: b.branch, tip: b.commit })).ok, true);
    assert.equal(branchAt(w, b.branch), b.commit);
  });

  test("Restore refuses a same-named branch off another line, with nothing changed", async () => {
    const { w, b } = await kept("rsother");
    git(w.fx.project, ["branch", "-D", b.branch]);
    const root = git(w.fx.project, ["rev-list", "--max-parents=0", w.fx.target]);
    git(w.fx.project, ["branch", b.branch, root]);
    const r = await restoreRetired(w.d, { root: w.fx.project, path: b.checkout, branch: b.branch, tip: b.commit });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(!r.ok && r.error.includes(b.branch));
    assert.equal(branchAt(w, b.branch), root);
    assert.equal(existsSync(b.checkout), false);
  });

  test("its row reads Landed · cleaned up, on a landing history can't prove", async () => {
    const w = world({ seam: OFF });
    const b = w.fx.branch("squashlook", { "s.txt": "s\n" });
    git(w.fx.project, ["merge", "-q", "--squash", b.branch]);
    git(w.fx.project, ["commit", "-q", "-m", "squash"]);
    assert.equal((await retireTree(w.d, w.fx.project, b.checkout)).state, "retired");
    w.fx.moveTargetOutside({ "s.txt": "rewritten since\n" });
    const base = git(w.fx.project, ["rev-list", "--max-parents=0", w.fx.target]);
    const gone = await goneTreeState({ path: b.checkout, branch: b.branch, base }, [w.fx.project], { ledger: w.d.ledger });
    assert.equal(gone, "merged");
    assert.equal(rowKeyOf({ status: "active", exists: false, gone } as RowKeyInput), "cleaned-up");
  });
});

describe("who follows the setting", () => {
  test("archive follows it, off and on", async () => {
    for (const [seam, stays] of [[OFF, true], [ON, false]] as const) {
      const w = world({ seam });
      const b = finished(w, "arch");
      assert.equal((await retireNow(w.fx.project, b.checkout, undefined, w.d)).state, "retired");
      assert.equal(branchAt(w, b.branch), stays ? b.commit : "");
    }
  });

  test("a row's Remove follows it, off and on", async () => {
    const install: Gate = { on: false, offFor: "install", why: "x" };
    for (const [seam, stays] of [[OFF, true], [ON, false]] as const) {
      const w = world({ seam });
      const b = finished(w, "row");
      const r = await removeFinished(b.checkout, w.d, install);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(branchAt(w, b.branch), stays ? b.commit : "");
    }
  });

  test("a project page's Remove Worktree doesn't read it: a merged branch goes with the setting off, in the definition and the seam", async () => {
    const w = world({ seam: OFF });
    setRealRetireDeps(w.d);
    const b = finished(w, "pagerm");
    const base = git(w.fx.project, ["rev-list", "--max-parents=0", w.fx.target]);
    await removeWorktree({ path: b.checkout, branch: b.branch, base, target: w.fx.target }, w.fx.project);
    assert.equal(existsSync(b.checkout), false);
    assert.equal(branchAt(w, b.branch), "");
  });

  test("a copy's teardown doesn't read it: it never calls the branch step at all", () => {
    // Read, not run: teardown needs a running copy, and the integration tier pins that it keeps the branch. What this rule adds is only that
    // no later change makes teardown ask the setting.
    for (const f of ["project-services/engine.ts", "project-services/checkout-teardown.ts"]) {
      const text = readFileSync(join(import.meta.dirname, f), "utf8");
      assert.doesNotMatch(text, /deleteBranches|retireBranch/, f);
    }
  });
});
