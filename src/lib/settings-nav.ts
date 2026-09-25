import { createSignal } from "solid-js";

/**
 * Which Settings tab is open, app-wide; null = the dialog is closed. A module signal rather than
 * App state so a control deep in a pane — the mode menu's "Configure Delegate" — can open Settings
 * straight at the screen it's about, without threading a callback through every pane between.
 */
export const SETTINGS_TABS = ["general", "models", "modes", "overseer", "summaries", "themes", "experimental"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const [openTab, setOpenTab] = createSignal<SettingsTab | null>(null);

/** A section inside a tab to bring into view once it renders ("spec": Modes → Spec); null = the tab's top. */
export type SettingsSection = "spec";
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
  setOpenTab(null);
}
