import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import type { GitgraphSpec } from "./parse";

const ok = (body: string): GitgraphSpec => {
  const r = parseVis("gitgraph", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as GitgraphSpec;
};
const err = (body: string) => {
  const r = parseVis("gitgraph", body);
  assert.equal(r.ok, false, `expected an error for:\n${body}`);
  return r as { ok: false; line: number; message: string };
};
const shape = (s: GitgraphSpec) => s.commits.map((c) => `${c.id}@${c.lane}<${c.parents.join(",")}`);
const headOf = (s: GitgraphSpec, b: string) => s.heads.filter((h) => h.name === b).at(-1)?.commit;

const MERGE = `commit A "init"
commit B
branch feature
commit C "add login"
commit D
checkout main
commit E "fix typo"
merge feature M`;

test("gitgraph: commits, a branch and a merge commit", () => {
  const s = ok(MERGE);
  assert.deepEqual(s.branches.map((b) => b.name), ["main", "feature"]);
  assert.deepEqual(shape(s), ["A@0<", "B@0<A", "C@1<B", "D@1<C", "E@0<B", "M@0<E,D"]);
  assert.equal(s.commits[5]!.kind, "merge");
  assert.equal(s.commits[5]!.message, "Merge feature");
  assert.equal(headOf(s, "main"), "M");
  assert.equal(s.current, "main");
});

test("gitgraph: rebase replays the branch's own commits as primes and leaves ghosts", () => {
  const s = ok(MERGE.replace("checkout main\ncommit E \"fix typo\"\nmerge feature M", 'checkout main\ncommit E "fix typo"\ncheckout feature\nrebase main'));
  assert.deepEqual(shape(s), ["A@0<", "B@0<A", "C@1<B", "D@1<C", "E@0<B", "C'@1<E", "D'@1<C'"]);
  const [c, d] = [s.commits[2]!, s.commits[3]!];
  assert.equal(c.ghostAt, 5);
  assert.equal(d.ghostAt, 5);
  assert.equal(c.replacedBy, "C'");
  assert.equal(s.commits[5]!.message, "add login");
  assert.equal(s.commits[5]!.kind, "rebase");
  assert.equal(headOf(s, "feature"), "D'");
  // Rebasing twice adds another prime.
  const twice = ok(`commit A\nbranch f\ncommit C\ncheckout main\ncommit B\ncheckout f\nrebase main\ncheckout main\ncommit E\ncheckout f\nrebase main`);
  assert.deepEqual(twice.commits.map((c) => c.id), ["A", "C", "B", "C'", "E", "C''"]);
  assert.match(err("commit A\nbranch f\nrebase main").message, /nothing to replay/);
  assert.match(err("commit A\nbranch f\ncommit B\nrebase main").message, /already sits on main/);
});

test("gitgraph: rebase drops merge commits, like git", () => {
  const s = ok("commit A\nbranch f\ncommit B\nbranch g\ncommit C\ncheckout f\nmerge g M\ncheckout main\ncommit D\ncheckout f\nrebase main");
  const m = s.commits.find((c) => c.id === "M")!;
  assert.equal(m.ghostAt !== undefined, true);
  assert.equal(m.replacedBy, undefined);
  assert.deepEqual(s.commits.slice(-2).map((c) => c.id), ["B'", "C'"]);
});

test("gitgraph: fast-forward and squash", () => {
  const ff = ok("commit A\nbranch f\ncommit B\ncheckout main\nmerge f ff\ncommit C");
  assert.deepEqual(shape(ff), ["A@0<", "B@1<A", "C@0<B"]);
  assert.match(err("commit A\nbranch f\ncommit B\ncheckout main\ncommit C\nmerge f ff").message, /can't fast-forward/);
  const sq = ok("commit A\nbranch f\ncommit B\ncommit C\ncheckout main\nmerge f S squash");
  const s = sq.commits.at(-1)!;
  assert.deepEqual([s.id, s.kind, s.from, s.parents, s.message], ["S", "squash", "C", ["A"], "Squash f"]);
});

test("gitgraph: cherry-pick copies a commit with a prime and keeps the original", () => {
  const s = ok('commit A\nbranch hotfix\ncommit H "patch CVE"\ncheckout main\ncommit B\ncherry-pick H');
  const pick = s.commits.at(-1)!;
  assert.deepEqual([pick.id, pick.kind, pick.from, pick.message, pick.parents], ["H'", "pick", "H", "patch CVE", ["B"]]);
  assert.equal(s.commits[1]!.ghostAt, undefined);
  assert.match(err("commit A\ncherry-pick A").message, /already contains A/);
  assert.match(err("commit A\nbranch f\ncommit B\ncheckout main\ncherry-pick f").message, /not a branch/);
});

test("gitgraph: branch from, tags, tones, auto ids", () => {
  const s = ok('commit A\ncommit\ncommit B warn\nbranch old from A info\ncommit "legacy fix"\ntag v1.0 on B ok\ntag v0.9');
  assert.deepEqual(shape(s), ["A@0<", "@2@0<A", "B@0<@2", "@4@1<A"]);
  assert.equal(s.commits[1]!.named, false);
  assert.equal(s.commits[2]!.tone, "warn");
  assert.equal(s.branches[1]!.tone, "info");
  assert.deepEqual(s.tags.map((t) => [t.name, t.commit, t.tone]), [["v1.0", "B", "ok"], ["v0.9", "@4", undefined]]);
  // Short SHAs as ids.
  assert.equal(ok("commit 3f2a91c\ncommit 1234").commits[1]!.id, "1234");
});

test("gitgraph: heads and tags record the row after which they hold", () => {
  const s = ok("commit A\nbranch f\ncommit B\ntag t1\ncheckout main\nmerge f M");
  assert.deepEqual(s.heads.map((h) => [h.name, h.commit, h.at]), [["main", null, -1], ["main", "A", 0], ["f", "A", 0], ["f", "B", 1], ["main", "M", 2]]);
  assert.equal(s.tags[0]!.at, 1);
});

test("gitgraph: mark a commit id, a message, a primed copy or a branch", () => {
  const s = ok(`${MERGE}\nmark M "the merge commit"\nmark "add login" ok\nmark feature`);
  assert.deepEqual(s.emphasis, [
    { key: "M", tone: "accent", note: "the merge commit", n: 1 },
    { key: "C", tone: "ok" },
    { key: "branch:feature", tone: "accent" },
  ]);
  const r = ok(MERGE.replace("merge feature M", "checkout feature\nrebase main") + "\nmark C' \"new SHA\"");
  assert.equal(r.emphasis![0]!.key, "C'");
  assert.equal(ok("commit 1234\nmark 1234").emphasis![0]!.key, "1234");
  assert.match(err(`${MERGE}\nmark Z`).message, /no commit or branch Z/);
});

test("gitgraph: errors say what to write", () => {
  assert.match(err("git commit").message, /drop the leading git/);
  assert.match(err("commit A\ncheckout -b f").message, /write branch f/);
  assert.match(err("commit A\ncheckout f").message, /create it with branch f/);
  assert.match(err("commit A\nbranch main").message, /already exists: checkout main/);
  assert.match(err("commit A\ncommit A").message, /already exists/);
  assert.match(err("commit A\nbranch f\ncheckout main\nmerge f").message, /already contains f/);
  assert.match(err("commit A\nmerge main").message, /into itself/);
  assert.match(err("push origin").message, /unknown line "push"/);
  assert.match(err("commit A \"x\" \"y\"").message, /one message/);
  assert.match(err("commit A sparkly").message, /unknown word "sparkly"/);
  assert.match(err("title: x").message, /nothing to draw/);
  assert.match(err(Array.from({ length: 41 }, (_, i) => `commit c${i}`).join("\n")).message, /at most 40 commits/);
  assert.match(err(["commit A", ...Array.from({ length: 7 }, (_, i) => `branch b${i}`)].join("\n")).message, /at most 6 branches/);
  const e = err("commit A\n\ncommit A");
  assert.equal(e.line, 3);
});
