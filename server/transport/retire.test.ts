// Which of a Move's packed worktrees end here (§app.transport/moved-row): every one that travelled, whoever made it,
// but the main checkout and one another chat here still works in. A lab Move left a worktree a script made (no
// ownership record) usable on the source; this is the rule that retires it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { treesToRetire } from "./retire";

const same = (p: string) => p;
const wt = { name: "proj-da4cbb", path: "/u/.worktrees/proj-da4cbb", main: false };
const main = { name: "proj", path: "/u/proj", main: true };

test("a worktree that travelled ends here whoever made it; nobody else works in it", () => {
  assert.deepEqual(treesToRetire([main, wt], [], same), [
    { name: "proj", path: "/u/proj", retire: false, why: "it is the repository's main checkout" },
    { name: "proj-da4cbb", path: "/u/.worktrees/proj-da4cbb", retire: true },
  ]);
});

test("one another chat here works in stays, with why: its folder is in it, or it tracks it; a chat elsewhere doesn't hold it", () => {
  const stays = (users: { id: string; cwd: string; trees: string[] }[]) => treesToRetire([wt], users, same)[0]!;
  assert.deepEqual(stays([{ id: "other", cwd: "/u/.worktrees/proj-da4cbb/src", trees: [] }]), { name: wt.name, path: wt.path, retire: false, why: "chat other still works in it" });
  assert.equal(stays([{ id: "lead", cwd: "/u/proj", trees: ["/u/.worktrees/proj-da4cbb"] }]).why, "chat lead still works in it");
  assert.equal(stays([{ id: "near", cwd: "/u/.worktrees/proj-da4cbb-2", trees: ["/u/.worktrees/x"] }]).retire, true, "a sibling folder whose name starts the same isn't inside it");
});

test("paths are compared as they really are (a link in the path)", () => {
  const real = (p: string) => p.replace(/^\/link\//, "/u/");
  assert.equal(treesToRetire([wt], [{ id: "other", cwd: "/link/.worktrees/proj-da4cbb", trees: [] }], real)[0]!.retire, false);
});
