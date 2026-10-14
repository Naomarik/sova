import assert from "node:assert/strict";
import { test } from "node:test";
import { TUI_ONLY_COMMANDS, enterRunsLocal, localCommand, menuCommands, slashMenuSuppressed, tuiOnlyCommand } from "./slash";

test("localCommand claims a bare /agents and /subagents", () => {
  assert.equal(localCommand("/agents"), "subagents");
  assert.equal(localCommand("/subagents"), "subagents");
  assert.equal(localCommand("  /agents\n"), "subagents");
});

test("localCommand leaves everything else to the runtime", () => {
  assert.equal(localCommand("/subagents now"), null); // the runtime's (it opens its terminal monitor)
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

test("localCommand claims a bare /timeline, and leaves the rest to the runtime", () => {
  assert.equal(localCommand("/timeline"), "timeline");
  assert.equal(localCommand("  /timeline\n"), "timeline");
  assert.equal(localCommand("/timeline of the session"), null);
  assert.equal(localCommand("/timelines"), null);
  assert.equal(localCommand("timeline"), null);
});

test("enterRunsLocal and slashMenuSuppressed treat a bare /timeline like /tree", () => {
  assert.equal(enterRunsLocal("/timeline", "Enter", false), true);
  assert.equal(enterRunsLocal("/timeline", "Enter", true), false);
  assert.equal(enterRunsLocal("/timeline show me", "Enter", false), false);
  assert.equal(slashMenuSuppressed("/timeline"), true);
  assert.equal(slashMenuSuppressed("/timelines"), false);
  assert.equal(slashMenuSuppressed("/time"), false);
});

test("/clear is local only where the Overseer turns it on", () => {
  assert.equal(localCommand("/clear"), null, "any other chat: the runtime's, as before");
  assert.equal(localCommand("/clear", { clear: true }), "clear");
  assert.equal(localCommand("/clear now", { clear: true }), null, "with arguments it is text");
  assert.equal(enterRunsLocal("/clear", "Enter", false, { clear: true }), true);
  assert.equal(slashMenuSuppressed("/clear"), false);
  assert.equal(slashMenuSuppressed("/clear", { clear: true }), true);
});

test("/mode is local only where the Overseer turns it on, arguments and all", () => {
  assert.equal(localCommand("/mode"), null, "any other chat: the runtime's, as before");
  assert.equal(localCommand("/mode delegate"), null);
  assert.equal(localCommand("/mode", { mode: true }), "mode");
  assert.equal(localCommand(" /mode delegate\n", { mode: true }), "mode", "a switch is refused, not sent");
  assert.equal(localCommand("/mode spec on", { mode: true }), "mode");
  assert.equal(localCommand("/modes", { mode: true }), null, "a longer name is not /mode");
  assert.equal(localCommand("what /mode are you in?", { mode: true }), null);
  assert.equal(localCommand("/clear", { mode: true }), null, "one option never turns on the other");
  assert.equal(localCommand("/mode", { clear: true }), null);
  assert.equal(enterRunsLocal("/mode delegate", "Enter", false, { mode: true }), true);
  assert.equal(enterRunsLocal("/mode", "Enter", true, { mode: true }), false);
  assert.equal(slashMenuSuppressed("/mode"), false);
  assert.equal(slashMenuSuppressed("/mode", { mode: true }), true);
});

test("menuCommands leaves TUI-only commands and every form of team out of the menu", () => {
  const names = ["compact", "sessions", "sessions-back", "palette", "usage", "subagents", "agents", "websearch", "team", "team:x", "team-y", "teammate", "remote", "btw:new", "skill:omarchy"];
  const shown = menuCommands(names.map((name) => ({ name, source: "extension" as const }))).map((c) => c.name);
  assert.deepEqual(shown, ["compact", "teammate", "remote", "btw:new", "skill:omarchy"]);
});

test("/agents, like /subagents, only opens the terminal monitor: TUI-only, left out of the menu, still a local command typed bare", () => {
  assert.ok(TUI_ONLY_COMMANDS.has("agents") && TUI_ONLY_COMMANDS.has("subagents"));
  const shown = menuCommands(["agents", "subagents", "compact"].map((name) => ({ name, source: "extension" as const }))).map((c) => c.name);
  assert.deepEqual(shown, ["compact"]);
  assert.equal(tuiOnlyCommand("/agents"), "agents");
  assert.equal(localCommand("/agents"), "subagents");
  assert.equal(enterRunsLocal("/agents", "Enter", false), true);
});

test("tuiOnlyCommand names a bare TUI-only command typed in full, nothing else", () => {
  assert.equal(tuiOnlyCommand("/sessions"), "sessions");
  assert.equal(tuiOnlyCommand("  /usage-refresh "), "usage-refresh");
  assert.equal(tuiOnlyCommand("/subagents now"), null);
  assert.equal(tuiOnlyCommand("/agents x"), null);
  assert.equal(tuiOnlyCommand("/sess"), null);
  assert.equal(tuiOnlyCommand("/team"), null);
  assert.equal(tuiOnlyCommand("/remote"), null);
});
