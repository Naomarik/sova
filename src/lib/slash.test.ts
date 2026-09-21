import assert from "node:assert/strict";
import { test } from "node:test";
import { enterRunsLocal, localCommand, slashMenuSuppressed } from "./slash";

test("localCommand claims a bare /agents and /subagents", () => {
  assert.equal(localCommand("/agents"), "subagents");
  assert.equal(localCommand("/subagents"), "subagents");
  assert.equal(localCommand("  /agents\n"), "subagents");
});

test("localCommand leaves everything else to the runtime", () => {
  assert.equal(localCommand("/subagents models haiku"), null); // the runtime's model picker
  assert.equal(localCommand("/agents please"), null);
  assert.equal(localCommand("/team"), null);
  assert.equal(localCommand("agents"), null);
  assert.equal(localCommand("what do the /agents do?"), null);
  assert.equal(localCommand(""), null);
});

test("localCommand claims a bare /new", () => {
  assert.equal(localCommand("/new"), "new");
  assert.equal(localCommand("  /new\n"), "new");
});

test("localCommand leaves /new with arguments, or a longer name, to the runtime", () => {
  assert.equal(localCommand("/new x"), null);
  assert.equal(localCommand("/new session please"), null);
  assert.equal(localCommand("/newer"), null);
  assert.equal(localCommand("new"), null);
  assert.equal(localCommand("start a /new one"), null);
});

test("enterRunsLocal: plain Enter on a bare local command runs it", () => {
  assert.equal(enterRunsLocal("/new", "Enter", false), true);
  assert.equal(enterRunsLocal("/agents", "Enter", false), true);
  assert.equal(enterRunsLocal(" /new\n", "Enter", false), true);
  assert.equal(enterRunsLocal("/new", "Enter", true), false); // Shift+Enter: a newline
  assert.equal(enterRunsLocal("/new", "Tab", false), false); // Tab stays the menu's
  assert.equal(enterRunsLocal("/new x", "Enter", false), false);
  assert.equal(enterRunsLocal("/ne", "Enter", false), false);
});

test("slashMenuSuppressed only for a whole bare local command", () => {
  assert.equal(slashMenuSuppressed("/new"), true);
  assert.equal(slashMenuSuppressed("/agents"), true);
  assert.equal(slashMenuSuppressed("/ne"), false);
  assert.equal(slashMenuSuppressed("/"), false);
  assert.equal(slashMenuSuppressed("/newer"), false);
  assert.equal(slashMenuSuppressed("/new x"), false);
});

test("localCommand claims a bare /tree", () => {
  assert.equal(localCommand("/tree"), "tree");
  assert.equal(localCommand("  /tree\n"), "tree");
});

test("localCommand leaves /tree with arguments, or a longer name, to the runtime", () => {
  assert.equal(localCommand("/tree x"), null);
  assert.equal(localCommand("/tree show me the branches"), null);
  assert.equal(localCommand("/trees"), null);
  assert.equal(localCommand("tree"), null);
  assert.equal(localCommand("draw a /tree"), null);
});

test("enterRunsLocal and slashMenuSuppressed treat a bare /tree like /new", () => {
  assert.equal(enterRunsLocal("/tree", "Enter", false), true);
  assert.equal(enterRunsLocal(" /tree\n", "Enter", false), true);
  assert.equal(enterRunsLocal("/tree", "Enter", true), false);
  assert.equal(enterRunsLocal("/tree", "Tab", false), false);
  assert.equal(enterRunsLocal("/tree x", "Enter", false), false);
  assert.equal(enterRunsLocal("/tre", "Enter", false), false);
  assert.equal(slashMenuSuppressed("/tree"), true);
  assert.equal(slashMenuSuppressed("/tre"), false);
  assert.equal(slashMenuSuppressed("/trees"), false);
  assert.equal(slashMenuSuppressed("/tree x"), false);
});

test("/tree with arguments is an ordinary send, not a local command", () => {
  assert.equal(localCommand("/tree --depth 2"), null);
  assert.equal(enterRunsLocal("/tree --depth 2", "Enter", false), false); // Enter sends it
  assert.equal(slashMenuSuppressed("/tree --depth 2"), false); // and the "/" menu stays available
});
