// The command palette's view rows (§app.command-palette/rows): where this window can go, and the
// catalogue entries that open a dialog of the app's own instead of the palette's panel
// (§app.command-palette/command-panel). Each row reuses the way the app already gets there: a hash
// it already routes, a Settings tab through settings-nav, or a key's own owner through `runKey`
// (Collapse Sessions Pane is exactly Ctrl/⌘+B). Nothing here is a second implementation.
//
// Loaded with the palette, never before.

import { runKey, keyRow } from "./keys";
import { openSettings, type SettingsTab } from "../lib/settings-nav";
import { OVERSEER_HASH } from "../lib/overseer";
import { OVERVIEW_HREF } from "../lib/overview-route";
import { agentsHref, usageHref } from "../lib/insights";
import { PROJECTS_HREF } from "../lib/projects-route";
import { ORGS_HREF } from "../lib/orgs-route";
import { MESH_HREF } from "../lib/mesh";
import { SHARES_HREF } from "../lib/session-shares";
import { extHref } from "../lib/ext-route";
import type { ViewRowInput } from "../lib/palette";

/** What the view rows read and do in the app (App gives it). */
export interface ViewHost {
  /** At least 768px wide (the sessions pane collapses only there). */
  wide(): boolean;
  /** The sessions pane is collapsed into the spine. */
  collapsed(): boolean;
  /** The installed extensions with a page, by title. */
  extensions(): readonly { id: string; title: string }[];
  /** Settings' tabs, in the dialog's order, by the names its rail shows. */
  settingsTabs(): readonly { id: SettingsTab; label: string }[];
  openNewSessionDialog(): void;
  openShortcuts(): void;
}

export interface ViewRow extends ViewRowInput {
  run(): void;
}

export const WIDE_ONLY = "Only on a wide window.";

const go = (hash: string) => () => {
  if (location.hash !== hash) location.hash = hash;
};

/** The Go to rows, in order. */
export function viewRows(host: ViewHost): ViewRow[] {
  const rows: ViewRow[] = [
    { id: "overseer", label: "Open Overseer", keys: keyRow("overseer.open").label, disabled: null, run: () => void runKey("overseer.open") },
    // At 768px and up the overview is the main column beside the list, at `#/`.
    { id: "overview", label: "Overview", disabled: null, run: () => go(host.wide() ? "#/" : OVERVIEW_HREF)() },
    { id: "search", label: "Search Sessions", keys: keyRow("sidebar.search").label, disabled: null, run: () => void runKey("sidebar.search") },
    {
      id: "sidebar",
      label: host.collapsed() ? "Expand Sessions Pane" : "Collapse Sessions Pane",
      keys: keyRow("sidebar.toggle").label,
      disabled: host.wide() ? null : WIDE_ONLY,
      run: () => void runKey("sidebar.toggle"),
    },
    { id: "usage", label: "Usage", disabled: null, run: go(usageHref()) },
    { id: "agents", label: "Agents", disabled: null, run: go(agentsHref()) },
    { id: "projects", label: "Projects", disabled: null, run: go(PROJECTS_HREF) },
    { id: "orgs", label: "Organizations", disabled: null, run: go(ORGS_HREF) },
    { id: "mesh", label: "Mesh", disabled: null, run: go(MESH_HREF) },
    { id: "shares", label: "Shares", disabled: null, run: go(SHARES_HREF) },
    { id: "shortcuts", label: "Keyboard Shortcuts", keys: keyRow("shortcuts.open").label, disabled: null, run: () => host.openShortcuts() },
  ];
  for (const tab of host.settingsTabs()) rows.push({ id: `settings.${tab.id}`, label: `Settings: ${tab.label}`, disabled: null, run: () => openSettings(tab.id) });
  for (const ext of host.extensions()) rows.push({ id: `ext.${ext.id}`, label: ext.title, disabled: null, run: go(extHref(ext.id)) });
  return rows;
}

/** Catalogue entries that open the app's own dialog rather than the palette's panel. */
export function commandDialogs(host: ViewHost): ReadonlyMap<string, () => void> {
  return new Map([
    ["session.create", () => host.openNewSessionDialog()],
    ["settings.align.set", () => openSettings("alignment")],
  ]);
}
