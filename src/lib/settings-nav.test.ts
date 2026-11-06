import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACCOUNT_TABS, accountTabRequest, clearSettingsSection, closeSettings, openSettings, settingsAccountFromHash, SETTINGS_TABS, setSubagentSettingsPath, settingsOpenAt, settingsSection, settingsProjectFromHash, settingsTabFromHash, subagentSettingsPath } from "./settings-nav";

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

test("Accounts sits after Models, MCP Servers after Accounts, Subagents after MCP Servers, Alignment after Subagents, Profiles after Alignment, Overseer after Profiles, Notifications after Overseer and Decisions after Notifications, Public links after Mesh, Outreach after Public links, Voice after Outreach in the rail, and the dialog's rail is this list", () => {
  assert.deepEqual([...SETTINGS_TABS], ["general", "models", "accounts", "mcp-servers", "subagents", "alignment", "profiles", "overseer", "notifications", "decisions", "summaries", "memory", "organizations", "merge-queue", "themes", "mesh", "public-links", "outreach", "voice", "experimental"]);
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
  // The Merge Queue tab alone takes a project: the All settings row opens it on that project.
  assert.equal(settingsTabFromHash("#/settings/merge-queue"), "merge-queue");
  assert.equal(settingsTabFromHash("#/settings/merge-queue/prj_ab12cd34"), "merge-queue");
  assert.equal(settingsProjectFromHash("#/settings/merge-queue/prj_ab12cd34"), "prj_ab12cd34");
  assert.equal(settingsProjectFromHash("#/settings/merge-queue"), null);
  assert.equal(settingsTabFromHash("#/settings/memory/prj_ab12cd34"), null);
  assert.equal(settingsTabFromHash("#/settings"), null);
  assert.equal(settingsTabFromHash("#/overseer"), null);
});

test("#/settings/accounts/<provider> opens Accounts on that provider tab; anything else names none", () => {
  assert.deepEqual([...ACCOUNT_TABS], ["claude", "openai", "ollama-cloud", "deepseek", "zai", "other"]);
  for (const t of ACCOUNT_TABS) {
    assert.equal(settingsTabFromHash(`#/settings/accounts/${t}`), "accounts", t);
    assert.equal(settingsAccountFromHash(`#/settings/accounts/${t}`), t);
  }
  assert.equal(settingsTabFromHash("#/settings/accounts"), "accounts", "the plain tab still opens");
  assert.equal(settingsAccountFromHash("#/settings/accounts"), null, "and names no provider: the last one opens");
  for (const bad of ["#/settings/accounts/anthropic", "#/settings/accounts/", "#/settings/accounts/claude/x", "#/settings/models/claude"]) {
    assert.equal(settingsAccountFromHash(bad), null, bad);
  }
  assert.equal(settingsTabFromHash("#/settings/accounts/nope"), null);
  assert.equal(settingsTabFromHash("#/settings/merge-queue/prj_abc"), "merge-queue", "the project link is unchanged");
});

test("openSettings asks Accounts for a provider tab, and closing forgets it", () => {
  openSettings("accounts", null, { account: "claude" });
  assert.equal(settingsOpenAt(), "accounts");
  assert.equal(accountTabRequest(), "claude", "the Mesh page's Claude login line opens Accounts → Claude");
  openSettings("accounts");
  assert.equal(accountTabRequest(), null, "a plain open asks for none");
  openSettings("accounts", null, { account: "zai" });
  closeSettings();
  assert.equal(accountTabRequest(), null);
});
