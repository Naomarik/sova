/**
 * Settings → Accounts' provider tabs and API keys (§app/provider-keys): the words each key row shows, each tab's
 * mark, the tab Accounts opens on, and the reveal's 30-second hide. DOM- and Solid-free, so the unit tests read
 * the same sentences and run the same timer.
 */
import type { ProviderKeyCheck, ProviderKeyRow, ProviderKeysInfo } from "../../shared/protocol";
import { agoWords } from "./model-check";
import { ACCOUNT_TABS, type AccountTab } from "./settings-nav";

export type { ProviderKeyRow, ProviderKeysInfo };
export type ChipTone = "success" | "warn" | "error" | undefined;

/** The tabs' labels, in tab order. */
export const ACCOUNT_TAB_LABELS: Record<AccountTab, string> = {
  claude: "Claude",
  openai: "OpenAI",
  "ollama-cloud": "Ollama Cloud",
  deepseek: "DeepSeek",
  zai: "Z.ai",
  other: "Other provider",
};

/** Where the provider tab last open is kept, in this browser. */
export const ACCOUNT_TAB_STORAGE = "sova.settings.accountsTab";

/** The tab Accounts opens on: the one a link asked for, else the one last open here, else Claude. */
export function initialAccountTab(requested: AccountTab | null | undefined, stored: string | null | undefined): AccountTab {
  if (requested) return requested;
  return ACCOUNT_TABS.find((t) => t === stored) ?? "claude";
}

/** A key row's chip (§app.provider-keys/key-tab). A refused paste overrides it until the field is cleared. */
export function chipOf(row: Pick<ProviderKeyRow, "status">, pasteRefused = false): { text: string; tone: ChipTone } {
  if (pasteRefused) return { text: "Key refused", tone: "error" };
  switch (row.status) {
    case "connected":
      return { text: "Connected", tone: "success" };
    case "refused":
      return { text: "Key refused", tone: "error" };
    case "unchecked":
      return { text: "Not checked yet", tone: "warn" };
    case "saved":
      return { text: "Saved, not checked", tone: undefined };
    default:
      return { text: "No key", tone: undefined };
  }
}

/** The masked field: only the last 4 characters. */
export const maskKey = (last4: string | undefined): string => `••••••••${last4 ?? ""}`;

/** "Saved here", "Environment" or "None", with the variable's name for the environment. */
export function sourceText(row: Pick<ProviderKeyRow, "source" | "envName">): string {
  if (row.source === "saved") return "Saved here";
  if (row.source === "env") return row.envName ? `Environment (${row.envName})` : "Environment";
  return "None";
}

/** "Checked 2 minutes ago: accepted", or "Not checked yet". */
export function lastCheckedText(check: ProviderKeyCheck | undefined, now: number): string {
  if (!check) return "Not checked yet";
  const what = check.result === "accepted" ? "accepted" : check.result === "refused" ? "refused" : "couldn't reach the provider";
  return `Checked ${agoWords(check.at, now)}: ${what}`;
}

/** The inline question before Remove (§app.provider-keys/remove). */
export function removeQuestion(row: Pick<ProviderKeyRow, "name">, meshSharesLogins: boolean): string {
  return meshSharesLogins ? `Remove the ${row.name} key here and on your mesh computers?` : `Remove the ${row.name} key from this computer?`;
}

/** What else Remove does: the models leave the menu, unless the environment's key still serves the provider. */
export function removeDetail(row: Pick<ProviderKeyRow, "name" | "envSet" | "envName">): string {
  return row.envSet
    ? `${row.envName ?? "The environment's key"} still serves ${row.name}, so its models stay in the model menu.`
    : `${row.name}'s models leave the model menu until a key is saved again.`;
}

/** What a tab's mark says, for its dot's tone and its accessible name ("DeepSeek: Connected"). */
export function tabMark(tab: AccountTab, info: ProviderKeysInfo | undefined): { tone: ChipTone; words: string } {
  if (!info) return { tone: undefined, words: "" };
  const rowOf = (provider: string) => info.rows.find((r) => r.provider === provider);
  const signed = (on: boolean, provider: string): { tone: ChipTone; words: string } => {
    if (on) return { tone: "success", words: "Signed in" };
    const r = rowOf(provider);
    return r && r.status !== "nokey" ? { tone: chipOf(r).tone, words: `API key: ${chipOf(r).text}` } : { tone: undefined, words: "Not signed in" };
  };
  if (tab === "claude") return signed(info.signIns.claude, "anthropic");
  if (tab === "openai") return signed(info.signIns.openai, "openai");
  if (tab === "other") {
    const n = info.rows.filter((r) => r.tab === "other" && r.saved).length;
    return n ? { tone: undefined, words: `${n} ${n === 1 ? "key" : "keys"} saved` } : { tone: undefined, words: "No key" };
  }
  const r = rowOf(tab);
  if (!r) return { tone: undefined, words: "" };
  const c = chipOf(r);
  return { tone: c.tone, words: c.text };
}

/** How long a revealed key stays shown. */
export const REVEAL_MS = 30_000;

export interface RevealClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * The reveal's life (§app.provider-keys/show-copy): `show` holds the key and hides it after 30 s; `hide` (Hide,
 * a tab switch, closing Settings: the row's cleanup) drops it at once. `onChange` hears the key, or null.
 */
export function createReveal(onChange: (key: string | null) => void, clock: RevealClock = globalThis, ms = REVEAL_MS) {
  let timer: unknown;
  let shown: string | null = null;
  const hide = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    if (shown === null) return;
    shown = null;
    onChange(null);
  };
  return {
    show(key: string) {
      if (timer !== undefined) clock.clearTimeout(timer);
      shown = key;
      onChange(key);
      timer = clock.setTimeout(hide, ms);
    },
    hide,
    shown: () => shown,
  };
}
