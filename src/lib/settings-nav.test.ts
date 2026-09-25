import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clearSettingsSection, closeSettings, openSettings, SETTINGS_TABS, settingsOpenAt, settingsSection } from "./settings-nav";

test("Configure Spec opens Modes at the Spec section, and a plain open asks for none", () => {
  openSettings("modes", "spec");
  assert.equal(settingsOpenAt(), "modes");
  assert.equal(settingsSection(), "spec");
  clearSettingsSection();
  assert.equal(settingsSection(), null, "the section clears once it has scrolled into view");
  openSettings("modes", "spec");
  openSettings("modes");
  assert.equal(settingsSection(), null, "a later open without a section forgets the earlier one");
  closeSettings();
});

test("Settings opens at the tab asked for, and closes", () => {
  assert.equal(settingsOpenAt(), null, "closed until something opens it");
  openSettings();
  assert.equal(settingsOpenAt(), "general", "the gear opens General");
  closeSettings();
  assert.equal(settingsOpenAt(), null);
  openSettings("modes");
  assert.equal(settingsOpenAt(), "modes", "Configure Delegate opens Modes directly");
  closeSettings();
});

test("Modes sits after Models and Overseer after Modes in the rail, and the dialog's rail is this list", () => {
  assert.deepEqual([...SETTINGS_TABS], ["general", "models", "modes", "overseer", "summaries", "themes", "experimental"]);
  // The dialog's own TABS must be the same ids in the same order (it is `satisfies`-typed against
  // SettingsTab, which catches an unknown id but not a missing or reordered one).
  const dialog = readFileSync(new URL("../components/SettingsDialog.tsx", import.meta.url), "utf8");
  const ids = [...dialog.matchAll(/\{ id: "([a-z]+)", label: "[^"]+", icon: "[a-z-]+" as const \}/g)].map((m) => m[1]);
  assert.deepEqual(ids, [...SETTINGS_TABS]);
});

test("the mode menu's Configure Delegate opens Settings and switches nothing", () => {
  // The menu's action path, read from the component: it opens Modes and returns before any
  // postMode call, so this chat's mode is never touched by it.
  const menu = readFileSync(new URL("../components/ModeMenu.tsx", import.meta.url), "utf8");
  const action = /if \(it\.kind === "action"\) \{([\s\S]*?)\n    \}/.exec(menu)?.[1] ?? "";
  assert.match(action, /openSettings\("modes", it\.id === CONFIGURE_SPEC\.id \? "spec" : null\)/, "Configure Spec opens Modes at its section; Configure Delegate at the top");
  assert.match(action, /return;/);
  assert.doesNotMatch(action, /postMode|setBusy/);
  assert.ok(menu.indexOf('if (it.kind === "action")') < menu.indexOf("postMode(patch"), "the action returns before the switch");
});
