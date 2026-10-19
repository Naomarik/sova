// Run: pnpm test -- src/commands/view.test.ts
// The palette's Go to rows and dialog entries (§app.command-palette/rows, /command-panel): each
// goes where the app already goes, a keyed row runs that key's own owner, and nothing is a second
// implementation.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { COMMANDS } from "../../shared/commands-catalog";
import { bindKey, keyRow, runKey } from "./keys";
import { closeSettings, settingsOpenAt, SETTINGS_TABS } from "../lib/settings-nav";
import { commandDialogs, viewRows, WIDE_ONLY, type ViewHost } from "./view";

const g = globalThis as unknown as { window?: EventTarget; document?: EventTarget; location?: { hash: string } };
const was = { window: g.window, document: g.document, location: g.location };
const unbinds: (() => void)[] = [];
afterEach(() => {
  while (unbinds.length) unbinds.pop()!();
  g.window = was.window;
  g.document = was.document;
  g.location = was.location;
  closeSettings();
});
const stage = () => {
  g.window = new EventTarget();
  g.document = new EventTarget();
  g.location = { hash: "#/" };
};

const calls: string[] = [];
const host = (over: Partial<ViewHost> = {}): ViewHost => ({
  wide: () => true,
  collapsed: () => false,
  extensions: () => [{ id: "notes", title: "Notes" }],
  settingsTabs: () => SETTINGS_TABS.map((id) => ({ id, label: id.toUpperCase() })),
  openNewSessionDialog: () => calls.push("new"),
  openShortcuts: () => calls.push("sheet"),
  ...over,
});
const row = (h: ViewHost, id: string) => viewRows(h).find((r) => r.id === id)!;

test("Go to: the views, then each Settings tab, then each extension's page", () => {
  const ids = viewRows(host()).map((r) => r.id);
  assert.deepEqual(ids.slice(0, 11), ["overseer", "overview", "search", "sidebar", "usage", "agents", "projects", "orgs", "mesh", "shares", "shortcuts"]);
  assert.deepEqual(ids.slice(11, 11 + SETTINGS_TABS.length), SETTINGS_TABS.map((t) => `settings.${t}`));
  assert.deepEqual(ids.slice(11 + SETTINGS_TABS.length), ["ext.notes"]);
  assert.equal(row(host(), "settings.models").label, "Settings: MODELS");
});

test("a keyed row shows its key from the one key table", () => {
  const h = host();
  assert.equal(row(h, "overseer").keys, keyRow("overseer.open").label);
  assert.equal(row(h, "search").keys, keyRow("sidebar.search").label);
  assert.equal(row(h, "sidebar").keys, keyRow("sidebar.toggle").label);
  assert.equal(row(h, "shortcuts").keys, keyRow("shortcuts.open").label);
});

test("a keyed row runs that key's own owner, not a copy of it", () => {
  stage();
  const ran: string[] = [];
  unbinds.push(bindKey("sidebar.toggle", () => (ran.push("toggle"), true)));
  unbinds.push(bindKey("sidebar.search", () => (ran.push("search"), true)));
  unbinds.push(bindKey("overseer.open", () => (ran.push("overseer"), true)));
  const h = host();
  row(h, "sidebar").run();
  row(h, "search").run();
  row(h, "overseer").run();
  assert.deepEqual(ran, ["toggle", "search", "overseer"]);
  assert.equal(runKey("model.picker"), false); // no owner: nothing acts
});

test("Collapse Sessions Pane: disabled under 768px, and named for what it does now", () => {
  assert.equal(row(host({ wide: () => false }), "sidebar").disabled, WIDE_ONLY);
  assert.equal(row(host(), "sidebar").disabled, null);
  assert.equal(row(host(), "sidebar").label, "Collapse Sessions Pane");
  assert.equal(row(host({ collapsed: () => true }), "sidebar").label, "Expand Sessions Pane");
});

test("pages go to the hash the app already routes; Overview is #/ beside the list, #/overview folded", () => {
  stage();
  const want: Record<string, string> = { usage: "#/usage", agents: "#/agents", projects: "#/projects", orgs: "#/orgs", mesh: "#/mesh", shares: "#/shares", "ext.notes": "#/ext/notes" };
  for (const [id, hash] of Object.entries(want)) {
    row(host(), id).run();
    assert.equal(g.location!.hash, hash, id);
  }
  row(host({ wide: () => false }), "overview").run();
  assert.equal(g.location!.hash, "#/overview");
  row(host(), "overview").run();
  assert.equal(g.location!.hash, "#/");
});

test("Settings rows open Settings at their tab; Keyboard Shortcuts opens the sheet", () => {
  row(host(), "settings.memory").run();
  assert.equal(settingsOpenAt(), "memory");
  calls.length = 0;
  row(host(), "shortcuts").run();
  assert.deepEqual(calls, ["sheet"]);
});

test("entries with a dialog of their own open it, and each is a real catalogue id", () => {
  calls.length = 0;
  const d = commandDialogs(host());
  for (const id of d.keys()) assert.ok(COMMANDS.some((c) => c.id === id), id);
  d.get("session.create")!();
  assert.deepEqual(calls, ["new"]);
  d.get("settings.align.set")!();
  assert.equal(settingsOpenAt(), "alignment");
});
