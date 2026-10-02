// Run: npx tsx --test src/lib/hidden-folders.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { hiddenFolder, parseShowHiddenFolders } from "./hidden-folders";

test("any hidden component makes a folder hidden, not just a hidden last name", () => {
  // The reported accident: the worktree's own name is ordinary, its parent is not.
  assert.equal(hiddenFolder("/home/u/webapps/.worktrees/sova-x"), true);
  assert.equal(hiddenFolder("/home/u/.config"), true);
  assert.equal(hiddenFolder("/home/u/sova/.pi/agent"), true);
  assert.equal(hiddenFolder("/home/deploy/.cache"), true, "a remote path is judged the same way");
});

test("an ordinary folder stays visible, a dot inside a name is not a hidden component", () => {
  assert.equal(hiddenFolder("/home/u/webapps/sova"), false);
  assert.equal(hiddenFolder("/home/u/foo.bar/baz"), false);
  assert.equal(hiddenFolder("/home/u/a.b"), false, "the component must START with the dot");
  assert.equal(hiddenFolder("/"), false);
  assert.equal(hiddenFolder(""), false);
  assert.equal(hiddenFolder("/home/u/./sova"), false, "`.` is the folder itself, not a hidden one");
  assert.equal(hiddenFolder("/home/u/../sova"), false);
});

test("Show hidden folders is off for anything but a stored \"true\"", () => {
  assert.equal(parseShowHiddenFolders("true"), true);
  for (const stored of [null, "", "false", "1", "yes", "TRUE", " true"]) {
    assert.equal(parseShowHiddenFolders(stored), false, `stored ${JSON.stringify(stored)}`);
  }
});
