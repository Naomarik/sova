import assert from "node:assert/strict";
import { test } from "node:test";
import { cardGroup, dropUndo, lineFor, setUndoLine, setupGroup, undoFor, withLine, withoutLine, type UndoLines } from "./approval-undo";

const line = (queue: string, group: string, token: string) => ({ queue, group, text: `Turned 2 off (${group}).`, token });

test("two groups in one folder each keep their own Undo line", () => {
  const skills = setupGroup("skill");
  const files = setupGroup("context");
  let lines: UndoLines = {};
  lines = withLine(lines, line("p:a", skills, "t1"));
  // A press in Context files after one in Skills: the Skills line stays.
  lines = withLine(lines, line("p:a", files, "t2"));
  assert.equal(lineFor(lines, "p:a", skills)?.token, "t1");
  assert.equal(lineFor(lines, "p:a", files)?.token, "t2");
  // A newer press of the same group replaces only that group's line.
  lines = withLine(lines, line("p:a", skills, "t3"));
  assert.equal(lineFor(lines, "p:a", skills)?.token, "t3");
  assert.equal(lineFor(lines, "p:a", files)?.token, "t2");
  // A change in one group (or its Undo used) drops that group's line, never the other's.
  lines = withoutLine(lines, "p:a", files);
  assert.equal(lineFor(lines, "p:a", files), null);
  assert.equal(lineFor(lines, "p:a", skills)?.token, "t3");
  // Unrelated folders and a group with no line are left as they are.
  assert.equal(withoutLine(lines, "p:b", skills), lines);
  assert.equal(lineFor(lines, "p:b", skills), null);
});

test("a project card's groups are per kind and source; the setup card's per kind", () => {
  assert.equal(setupGroup("skill"), "setup:skill");
  assert.equal(cardGroup("context", "user"), "card:context:user");
  assert.notEqual(cardGroup("skill", "project"), cardGroup("skill", "claude"));
  // The ids go to the server as they are: no spaces.
  for (const id of [setupGroup("context"), cardGroup("context", "subfolder")]) assert.match(id, /^[a-z0-9:_-]+$/);
});

test("the tab's store keeps lines the same way", () => {
  setUndoLine(line("d:/x", cardGroup("skill", "project"), "a"));
  setUndoLine(line("d:/x", cardGroup("skill", "user"), "b"));
  assert.equal(undoFor("d:/x", cardGroup("skill", "project"))?.token, "a");
  dropUndo("d:/x", cardGroup("skill", "user"));
  assert.equal(undoFor("d:/x", cardGroup("skill", "user")), null);
  assert.equal(undoFor("d:/x", cardGroup("skill", "project"))?.token, "a");
});
