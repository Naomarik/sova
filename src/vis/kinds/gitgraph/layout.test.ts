import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import { layoutGitgraph, refsAt } from "./layout";
import type { GitgraphSpec } from "./parse";

const spec = (body: string): GitgraphSpec => {
  const r = parseVis("gitgraph", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as GitgraphSpec;
};

const REBASE = spec(`commit A "init"
commit B "add the parser"
branch feature/login
commit C "add a login form with validation and a remember-me checkbox"
commit D "wire the session cookie"
checkout main
commit E "fix typo"
tag v1.0
checkout feature/login
rebase main
mark C' "new SHA, same change"`);

test("gitgraph layout: rows go down in order, lanes go right, text starts after the lanes", () => {
  for (const w of [320, 560, 720]) {
    const l = layoutGitgraph(REBASE, w);
    assert.ok(l.width <= w, `width ${l.width} > ${w}`);
    l.commits.forEach((p, i) => {
      assert.equal(p.x, l.laneX[p.commit.lane]);
      if (i) assert.ok(p.top >= l.commits[i - 1]!.top + l.commits[i - 1]!.h, "rows overlap");
      assert.ok(p.top + p.h <= l.height);
      for (const t of [...p.lines, ...(p.meta ? [p.meta] : []), ...p.chips]) assert.ok(t.x >= l.textX, "text over the lanes");
      for (const c of p.chips) assert.ok(c.x + c.w <= w, `chip ${c.name} past the edge at ${w}`);
      for (const t of [...p.lines, ...(p.meta ? [p.meta] : []), ...p.chips]) assert.ok(t.y >= p.top && t.y <= p.top + p.h, "text outside its row");
    });
  }
});

test("gitgraph layout: messages line up in one column whatever the ids' lengths", () => {
  const l = layoutGitgraph(REBASE, 560);
  const xs = new Set(l.commits.map((p) => p.lines[0]!.x));
  assert.equal(xs.size, 1);
  const plain = layoutGitgraph(spec("commit A\ncommit 3f2a91c \"x\"\ncommit B \"y\""), 560);
  assert.equal(plain.commits[1]!.lines[0]!.x, plain.commits[2]!.lines[0]!.x);
});

test("gitgraph layout: a narrow pane wraps the message instead of widening", () => {
  const wide = layoutGitgraph(REBASE, 720);
  const narrow = layoutGitgraph(REBASE, 300);
  assert.equal(wide.commits[2]!.lines.length, 1);
  assert.ok(narrow.commits[2]!.lines.length > 1);
  assert.ok(narrow.width <= 300);
});

test("gitgraph layout: at the end the originals are ghosts with their copy named; before the rebase they're not", () => {
  const end = layoutGitgraph(REBASE, 560);
  const c = end.commits.find((p) => p.commit.id === "C")!;
  assert.equal(c.ghost, true);
  assert.equal(c.meta?.text, "rebased as C'");
  assert.equal(c.chips.length, 0);
  assert.ok(end.edges.filter((e) => e.ghost).length >= 2);
  const before = layoutGitgraph(REBASE, 560, 4);
  assert.equal(before.commits.find((p) => p.commit.id === "C")!.ghost, false);
  // The branch head is on D before the rebase and on D' after it.
  assert.deepEqual(before.commits.find((p) => p.commit.id === "D")!.chips.map((ch) => ch.name), ["feature/login"]);
  assert.deepEqual(end.commits.find((p) => p.commit.id === "D'")!.chips.map((ch) => ch.name), ["feature/login"]);
  assert.deepEqual(end.commits.find((p) => p.commit.id === "E")!.chips.map((ch) => ch.name), ["main", "v1.0"]);
  assert.equal(refsAt(REBASE, 3).tags.length, 0);
});

test("gitgraph layout: a badge moves the text right; a cherry-pick gets a link", () => {
  const plain = layoutGitgraph(REBASE, 560);
  const badged = layoutGitgraph(REBASE, 560, undefined, undefined, new Set(["C'"]));
  const i = REBASE.commits.findIndex((c) => c.id === "C'");
  assert.ok(badged.commits[i]!.tx > plain.commits[i]!.tx);
  const pick = layoutGitgraph(spec("commit A\nbranch fix\ncommit H\ncheckout main\ncommit B\ncherry-pick H"), 400);
  assert.equal(pick.edges.filter((e) => e.link).length, 1);
  assert.equal(pick.commits.at(-1)!.meta?.text, "picked from H");
});

test("gitgraph layout: same input, same output", () => {
  assert.deepEqual(layoutGitgraph(REBASE, 480), layoutGitgraph(REBASE, 480));
});
