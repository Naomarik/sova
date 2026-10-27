// Go on an Overseer card's Ready to land row (§app.overseer/card-land): the go-ahead is recorded for the exact commit
// the row showed, and the captain woken, only while the branch is still there and still Ready to land; otherwise
// nothing is written to landing.json and no one is woken.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SessionSummary, WorktreeReadiness } from "../shared/protocol";
import { readLanding, recordGoAhead } from "../pi-config/extensions/worktrees/landing.ts";
import { recordCardGoAhead, type CardLandDeps } from "./overseer-land";
import { scratchRoot } from "./test-scratch";

const root = scratchRoot("sova-overseer-land-");
after(() => rmSync(root, { recursive: true, force: true }));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let n = 0;
/** A repository with a worktree on feat/x one commit ahead: its path and head (A). */
function repo() {
  const main = join(root, `repo${++n}`);
  mkdirSync(main);
  sh(main, "init", "-q", "-b", "master");
  sh(main, "config", "user.email", "t@example.invalid");
  sh(main, "config", "user.name", "t");
  sh(main, "config", "commit.gpgsign", "false");
  writeFileSync(join(main, "a.txt"), "one\n");
  sh(main, "add", "a.txt");
  sh(main, "commit", "-q", "-m", "one");
  const tree = join(root, `wt${n}`);
  sh(main, "worktree", "add", "-q", "-b", "feat/x", tree);
  return { tree, commit: (msg: string) => (writeFileSync(join(tree, `${msg}.txt`), msg), sh(tree, "add", "."), sh(tree, "commit", "-q", "-m", msg), sh(tree, "rev-parse", "HEAD")) };
}

/** Deps around one session whose readiness reads `tree()`; records go to a real landing.json, wakes are counted. */
function deps(file: string, tree: () => WorktreeReadiness, session: Partial<SessionSummary> = {}) {
  const wakes: number[] = [];
  const d: Partial<CardLandDeps> = {
    pathOf: async (id) => (id === "s1" ? "/sessions/s1.jsonl" : undefined),
    summary: async () => ({ id: "s1", path: "/sessions/s1.jsonl", cwd: "/x", ...session }) as SessionSummary,
    readiness: async () => ({ trees: [tree()] }) as SessionSummary["readiness"],
    record: (rec) => recordGoAhead({ ...rec, by: "overseer-card" }, file),
    wake: () => void wakes.push(1),
    now: () => new Date("2026-10-27T10:00:00Z"),
  };
  return { d, wakes };
}
const ready = (path: string, commit: string): WorktreeReadiness => ({ path, branch: "feat/x", state: "ready", landing: { state: "ready", commit } });

test("at the commit the row showed, Go records the go-ahead for it as the Overseer card's, and wakes the captain", async () => {
  const r = repo();
  const A = r.commit("two");
  const file = join(root, `landing${n}.json`);
  const { d, wakes } = deps(file, () => ready(r.tree, A));
  const out = await recordCardGoAhead({ session: "s1", branch: "feat/x", head: A }, d);
  assert.deepEqual(out, { ok: true, branch: "feat/x", commit: A, session: "s1", at: "2026-10-27T10:00:00.000Z" });
  assert.deepEqual(readLanding(file).goAheads, [{ branch: "feat/x", commit: A, session: "s1", at: "2026-10-27T10:00:00.000Z", by: "overseer-card" }]);
  assert.equal(wakes.length, 1);
});

test("the branch moved A→B after the card was raised: nothing is written to landing.json and the captain isn't woken", async () => {
  const r = repo();
  const A = r.commit("two");
  const B = r.commit("three");
  const file = join(root, `landing${n}.json`);
  // Readiness now reads Ready to land at B: B is still not what the user saw.
  const { d, wakes } = deps(file, () => ready(r.tree, B));
  const out = await recordCardGoAhead({ session: "s1", branch: "feat/x", head: A }, d);
  assert.deepEqual(out, { ok: false, reason: `feat/x has a newer commit (${B.slice(0, 7)}) than the one you saw (${A.slice(0, 7)}).` });
  assert.equal(existsSync(file), false);
  assert.equal(wakes.length, 0);
  // Readiness still remembering A (a stale reading) changes nothing: the head is read from git.
  const stale = deps(file, () => ready(r.tree, A));
  assert.equal((await recordCardGoAhead({ session: "s1", branch: "feat/x", head: A }, stale.d)).ok, false);
  assert.equal(existsSync(file), false);
  assert.equal(stale.wakes.length, 0);
});

test("at the same commit but no longer Ready to land, or its session gone, archived or working: refused with why, nothing written", async () => {
  const r = repo();
  const A = r.commit("two");
  const file = join(root, `landing${n}.json`);
  const cases: [ReturnType<typeof deps>, RegExp][] = [
    [deps(file, () => ({ path: r.tree, branch: "feat/x", state: "in-progress", why: "1 uncommitted file", reason: "In progress · 1 uncommitted file" })), /^feat\/x is no longer ready to land: 1 uncommitted file\.$/],
    [deps(file, () => ({ path: r.tree, branch: "feat/x", state: "ready", landing: { state: "specs", commit: A, drafts: ["d"] } })), /no longer ready to land: its spec drafts aren't promoted/],
    [deps(file, () => ({ path: r.tree, branch: "feat/other", state: "ready", landing: { state: "ready", commit: A } })), /no longer tracks a worktree on it/],
    [deps(file, () => ready(r.tree, A), { archived: true }), /its session is archived/],
    [deps(file, () => ready(r.tree, A), { busy: true }), /its session is working right now/],
  ];
  for (const [{ d, wakes }, why] of cases) {
    const out = await recordCardGoAhead({ session: "s1", branch: "feat/x", head: A }, d);
    assert.equal(out.ok, false);
    assert.match(!out.ok ? out.reason : "", why);
    assert.equal(wakes.length, 0);
  }
  const unknown = deps(file, () => ready(r.tree, A));
  assert.match(((await recordCardGoAhead({ session: "nope", branch: "feat/x", head: A }, unknown.d)) as { reason: string }).reason, /session can't be found/);
  assert.match(((await recordCardGoAhead({ session: "s1", branch: "feat/x", head: "abc1234" }, unknown.d)) as { reason: string }).reason, /no branch and full commit/);
  assert.equal(existsSync(file), false);
  assert.equal(unknown.wakes.length, 0);
});

test("a branch whose head can't be read is refused, not guessed", async () => {
  const r = repo();
  const A = r.commit("two");
  const file = join(root, `landing${n}.json`);
  const { d, wakes } = deps(file, () => ({ ...ready(r.tree, A), path: join(root, "gone") }));
  const out = await recordCardGoAhead({ session: "s1", branch: "feat/x", head: A }, d);
  assert.match(!out.ok ? out.reason : "", /can't read feat\/x's current commit/);
  assert.equal(existsSync(file), false);
  assert.equal(wakes.length, 0);
  assert.equal(readFileSync(join(r.tree, "two.txt"), "utf8"), "two");
});
