import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACCOUNT_TABS, accountTabRequest, clearProfilesRequest, clearSettingsSection, closeSettings, openProfiles, openSettings, profilesRequest, settingsAccountFromHash, SETTINGS_TABS, setSubagentSettingsPath, settingsOpenAt, settingsSection, settingsProjectFromHash, settingsTabFromHash, subagentSettingsPath } from "./settings-nav";

test("Configure Spec opens Profiles at the Spec writer's row, and a plain open asks for none", () => {
  openProfiles({ section: "spec" });
  assert.equal(settingsOpenAt(), "profiles");
  assert.equal(settingsSection(), "spec");
  assert.deepEqual(profilesRequest(), { part: "models" }, "at the Models part");
  clearSettingsSection();
  assert.equal(settingsSection(), null, "the section clears once it has scrolled into view");
  openProfiles({ section: "spec" });
  openProfiles();
  assert.equal(settingsSection(), null, "a later open without a section forgets the earlier one");
  closeSettings();
});

test("openProfiles opens Profiles on one profile, at the part asked, for one chat; closing forgets all three", () => {
  openProfiles({ profile: "user:claude", path: "/s/one.jsonl" });
  assert.equal(settingsOpenAt(), "profiles");
  assert.deepEqual(profilesRequest(), { profile: "user:claude", part: "models" }, "the gears and Manage Profiles open its Models part");
  assert.equal(subagentSettingsPath(), "/s/one.jsonl");
  clearProfilesRequest();
  assert.equal(profilesRequest(), null, "the tab takes the request once");
  openProfiles({ part: "start" });
  assert.deepEqual(profilesRequest(), { part: "start" });
  assert.equal(subagentSettingsPath(), undefined, "an open for no chat is nobody's chat");
  closeSettings();
  assert.equal(profilesRequest(), null);
});

test("Settings opens at the tab asked for, and closes", () => {
  assert.equal(settingsOpenAt(), null, "closed until something opens it");
  openSettings();
  assert.equal(settingsOpenAt(), "general", "the gear opens General");
  closeSettings();
  assert.equal(settingsOpenAt(), null);
  openSettings("profiles");
  assert.equal(settingsOpenAt(), "profiles", "Configure Delegate opens Profiles directly");
  closeSettings();
});

test("Accounts sits after Models, MCP Servers after Accounts, Extensions after MCP Servers, Alignment after Extensions, Profiles after Alignment, Overseer after Profiles, Notifications after Overseer and Decisions after Notifications, Public links after Mesh, Outreach after Public links, Voice after Outreach in the rail, and the dialog's rail is this list", () => {
  assert.deepEqual([...SETTINGS_TABS], ["general", "models", "accounts", "mcp-servers", "extensions", "alignment", "profiles", "overseer", "notifications", "decisions", "summaries", "memory", "organizations", "merge-queue", "themes", "mesh", "public-links", "outreach", "voice", "experimental"]);
  // The dialog's own TABS must be the same ids in the same order (it is `satisfies`-typed against
  // SettingsTab, which catches an unknown id but not a missing or reordered one).
  const dialog = readFileSync(new URL("../components/SettingsDialog.tsx", import.meta.url), "utf8");
  const ids = [...dialog.matchAll(/\{ id: "([a-z-]+)", label: "[^"]+", icon: "[a-z-]+" as const \}/g)].map((m) => m[1]);
  assert.deepEqual(ids, [...SETTINGS_TABS]);
  // Modes and Teams were stubs that only pointed at Subagents; they are gone, with no alias. Subagents
  // is gone too: its screen is Profiles' Models part (§chat.subagent-profiles/settings).
  for (const gone of ["modes", "teams", "subagents"]) assert.ok(!(SETTINGS_TABS as readonly string[]).includes(gone), `${gone} is not a tab`);
});

test("the mode menu's gear actions open Settings → Profiles and switch nothing", () => {
  // The menu's action path, read from the component: it opens Profiles on the chat's profile (at
  // the spec writer for Configure Spec) and returns before any postMode call, so this chat's mode is
  // never touched by it.
  const menu = readFileSync(new URL("../components/ModeMenu.tsx", import.meta.url), "utf8");
  const action = /if \(it\.kind === "action"\) \{([\s\S]*?)\n    \}/.exec(menu)?.[1] ?? "";
  assert.match(action, /openProfiles\(\{[^}]*section: it\.id === CONFIGURE_SPEC\.id \? "spec" : undefined[^}]*\}\)/, "Configure Spec opens Profiles at the spec writer; Configure Delegate at the Models part's top");
  assert.match(action, /return;/);
  assert.doesNotMatch(action, /postMode|setBusy/);
  assert.ok(menu.indexOf('if (it.kind === "action")') < menu.indexOf("postMode(patch"), "the action returns before the switch");
});

test("closing Settings forgets the chat it was opened for", () => {
  // Profiles opens on that chat's profile: a reopened dialog must not still open on the old one.
  setSubagentSettingsPath("/sessions/one.jsonl");
  assert.equal(subagentSettingsPath(), "/sessions/one.jsonl");
  openSettings("profiles");
  closeSettings();
  assert.equal(subagentSettingsPath(), undefined, "the next open starts with no chat's pick");
});

test("#/settings/<tab> names a tab (a Needs you row, a notification's tap); anything else names none", () => {
  assert.equal(settingsTabFromHash("#/settings/outreach"), "outreach");
  assert.equal(settingsTabFromHash("#/settings/public-links"), "public-links");
  assert.equal(settingsTabFromHash("#/settings/nope"), null);
  assert.equal(settingsTabFromHash("#/settings/subagents"), "profiles", "the retired Subagents tab's link opens Profiles");
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
