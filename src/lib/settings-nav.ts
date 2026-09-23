import { createSignal } from "solid-js";

/**
 * Which Settings tab is open, app-wide; null = the dialog is closed. A module signal rather than
 * App state so a control deep in a pane — the mode menu's "Configure Delegate" — can open Settings
 * straight at the screen it's about, without threading a callback through every pane between.
 */
export const SETTINGS_TABS = ["general", "models", "modes", "themes", "experimental"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const [openTab, setOpenTab] = createSignal<SettingsTab | null>(null);

/** The tab Settings is open at, or null when it's closed. */
export const settingsOpenAt = openTab;

/** Open Settings at `tab` (General by default). Opening it changes nothing else — no mode switch. */
export function openSettings(tab: SettingsTab = "general"): void {
  setOpenTab(tab);
}

export function closeSettings(): void {
  setOpenTab(null);
}
