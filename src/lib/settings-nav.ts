import { createSignal } from "solid-js";

/**
 * Which Settings tab is open, app-wide; null = the dialog is closed. A module signal rather than
 * App state so a control deep in a pane — the mode menu's "Configure Delegate" — can open Settings
 * straight at the screen it's about, without threading a callback through every pane between.
 */
export const SETTINGS_TABS = ["general", "models", "accounts", "subagents", "alignment", "profiles", "overseer", "notifications", "decisions", "summaries", "memory", "organizations", "themes", "mesh", "public-links", "outreach", "voice", "experimental"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const [openTab, setOpenTab] = createSignal<SettingsTab | null>(null);
/** Settings → Subagents' view of "current": the chat the mode menu opened it for, so that chat's
    profile can be saved as its own. Cleared on close: a reopened dialog is nobody's chat. */
const [subagentPath, setSubagentPath] = createSignal<string | undefined>();
export const subagentSettingsPath = subagentPath;
export const setSubagentSettingsPath = setSubagentPath;

/** A section inside a tab to bring into view once it renders ("spec": Subagents → Spec writer;
    "overseer-limits": Overseer → Limits); null = the tab's top. */
export type SettingsSection = "spec" | "overseer-limits";
const [section, setSection] = createSignal<SettingsSection | null>(null);

/** The section the last openSettings asked for, until that section has scrolled itself into view. */
export const settingsSection = section;
export const clearSettingsSection = (): void => {
  setSection(null);
};

/** The tab Settings is open at, or null when it's closed. */
export const settingsOpenAt = openTab;

/** Open Settings at `tab` (General by default), optionally at one of its sections. Opening it changes nothing else — no mode switch. */
export function openSettings(tab: SettingsTab = "general", at: SettingsSection | null = null): void {
  setSection(at);
  setOpenTab(tab);
}

export function closeSettings(): void {
  setSubagentPath(undefined);
  setOpenTab(null);
}
