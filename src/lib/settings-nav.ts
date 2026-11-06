import { createSignal } from "solid-js";

/**
 * Which Settings tab is open, app-wide; null = the dialog is closed. A module signal rather than
 * App state so a control deep in a pane — the mode menu's "Configure Delegate" — can open Settings
 * straight at the screen it's about, without threading a callback through every pane between.
 */
export const SETTINGS_TABS = ["general", "models", "accounts", "mcp-servers", "subagents", "alignment", "profiles", "overseer", "notifications", "decisions", "summaries", "memory", "organizations", "merge-queue", "themes", "mesh", "public-links", "outreach", "voice", "experimental"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** Accounts' provider tabs, in order (§app.provider-keys/tabs): `#/settings/accounts/<tab>`. */
export const ACCOUNT_TABS = ["claude", "openai", "ollama-cloud", "deepseek", "zai", "other"] as const;
export type AccountTab = (typeof ACCOUNT_TABS)[number];
const [accountTab, setAccountTab] = createSignal<AccountTab | null>(null);
/** The provider tab the last openSettings asked Accounts for; null = the one last open in this browser. */
export const accountTabRequest = accountTab;

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

/** The project a project-scoped tab (Merge Queue) opens on: the one whose page opened it. Cleared
    on close: a dialog opened from the gear or a command starts on its own picker's choice. */
const [project, setProject] = createSignal<string | null>(null);
export const settingsProject = project;

/** Open Settings at `tab` (General by default), optionally at one of its sections, and for a
    project-scoped tab on one project (its id). Opening it changes nothing else — no mode switch. */
export function openSettings(tab: SettingsTab = "general", at: SettingsSection | null = null, opts: { project?: string; account?: AccountTab } = {}): void {
  setSection(at);
  setProject(opts.project ?? null);
  setAccountTab(opts.account ?? null);
  setOpenTab(tab);
}

/** `#/settings/<tab>` (a Needs you row of no session, a phone notification's tap): the tab it names, else null. */
export function settingsTabFromHash(hash: string): SettingsTab | null {
  const m = /^#\/settings\/([a-z-]+)$/.exec(hash);
  if (!m && settingsProjectFromHash(hash)) return "merge-queue";
  if (!m && settingsAccountFromHash(hash)) return "accounts";
  return SETTINGS_TABS.find((t) => t === m?.[1]) ?? null;
}

/** `#/settings/merge-queue/<project id>` (the project Settings tab's All settings row): that project, else null. */
export function settingsProjectFromHash(hash: string): string | null {
  return /^#\/settings\/merge-queue\/(prj_[A-Za-z0-9_-]+)$/.exec(hash)?.[1] ?? null;
}

/** `#/settings/accounts/<provider>` (§app.provider-keys/tabs): that provider tab, else null. */
export function settingsAccountFromHash(hash: string): AccountTab | null {
  const m = /^#\/settings\/accounts\/([a-z-]+)$/.exec(hash);
  return ACCOUNT_TABS.find((t) => t === m?.[1]) ?? null;
}

export function closeSettings(): void {
  setSubagentPath(undefined);
  setProject(null);
  setAccountTab(null);
  setOpenTab(null);
}
