import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clearSettingsSection, closeSettings, openSettings, SETTINGS_TABS, setSubagentSettingsPath, settingsOpenAt, settingsSection, settingsTabFromHash, subagentSettingsPath } from "./settings-nav";

test("Configure Spec opens Subagents at the Spec section, and a plain open asks for none", () => {
  openSettings("subagents", "spec");
  assert.equal(settingsOpenAt(), "subagents");
  assert.equal(settingsSection(), "spec");
  clearSettingsSection();
  assert.equal(settingsSection(), null, "the section clears once it has scrolled into view");
  openSettings("subagents", "spec");
  openSettings("subagents");
  assert.equal(settingsSection(), null, "a later open without a section forgets the earlier one");
  closeSettings();
});

test("Settings opens at the tab asked for, and closes", () => {
  assert.equal(settingsOpenAt(), null, "closed until something opens it");
  openSettings();
  assert.equal(settingsOpenAt(), "general", "the gear opens General");
  closeSettings();
  assert.equal(settingsOpenAt(), null);
  openSettings("subagents");
  assert.equal(settingsOpenAt(), "subagents", "Configure Delegate opens Subagents directly");
  closeSettings();
});

test("Accounts sits after Models, Subagents after Accounts, Alignment after Subagents, Profiles after Alignment, Overseer after Profiles, Notifications after Overseer and Decisions after Notifications, Public links after Mesh, Outreach after Public links, Voice after Outreach in the rail, and the dialog's rail is this list", () => {
  assert.deepEqual([...SETTINGS_TABS], ["general", "models", "accounts", "subagents", "alignment", "profiles", "overseer", "notifications", "decisions", "summaries", "organizations", "themes", "mesh", "public-links", "outreach", "voice", "experimental"]);
  // The dialog's own TABS must be the same ids in the same order (it is `satisfies`-typed against
  // SettingsTab, which catches an unknown id but not a missing or reordered one).
  const dialog = readFileSync(new URL("../components/SettingsDialog.tsx", import.meta.url), "utf8");
  const ids = [...dialog.matchAll(/\{ id: "([a-z-]+)", label: "[^"]+", icon: "[a-z-]+" as const \}/g)].map((m) => m[1]);
  assert.deepEqual(ids, [...SETTINGS_TABS]);
  // Modes and Teams were stubs that only pointed at Subagents; they are gone, with no alias.
  for (const gone of ["modes", "teams"]) assert.ok(!(SETTINGS_TABS as readonly string[]).includes(gone), `${gone} is not a tab`);
});

test("the mode menu's gear actions open Settings → Subagents and switch nothing", () => {
  // The menu's action path, read from the component: it opens Subagents (at the spec writer for
  // Configure Spec) and returns before any postMode call, so this chat's mode is never touched by it.
  const menu = readFileSync(new URL("../components/ModeMenu.tsx", import.meta.url), "utf8");
  const action = /if \(it\.kind === "action"\) \{([\s\S]*?)\n    \}/.exec(menu)?.[1] ?? "";
  assert.match(action, /openSettings\("subagents", it\.id === CONFIGURE_SPEC\.id \? "spec" : null\)/, "Configure Spec opens Subagents at the spec writer; Configure Delegate at the top");
  assert.match(action, /return;/);
  assert.doesNotMatch(action, /postMode|setBusy/);
  assert.ok(menu.indexOf('if (it.kind === "action")') < menu.indexOf("postMode(patch"), "the action returns before the switch");
});

test("closing Settings forgets the chat it was opened for", () => {
  // The Subagents tab's save-current is per chat: a reopened dialog must not still act on the old one.
  setSubagentSettingsPath("/sessions/one.jsonl");
  assert.equal(subagentSettingsPath(), "/sessions/one.jsonl");
  openSettings("subagents");
  closeSettings();
  assert.equal(subagentSettingsPath(), undefined, "the next open starts with no chat's pick");
});

test("#/settings/<tab> names a tab (a Needs you row, a notification's tap); anything else names none", () => {
  assert.equal(settingsTabFromHash("#/settings/outreach"), "outreach");
  assert.equal(settingsTabFromHash("#/settings/public-links"), "public-links");
  assert.equal(settingsTabFromHash("#/settings/nope"), null);
  assert.equal(settingsTabFromHash("#/settings/outreach/x"), null);
  assert.equal(settingsTabFromHash("#/settings"), null);
  assert.equal(settingsTabFromHash("#/overseer"), null);
});
