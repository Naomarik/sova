// What the Transport agent asks you on its card (§app.transport/agent "Downloads, on your click", "Administrator
// rights stay yours"): a download list (each tool, its version and the one site it comes from), which widens its
// sandbox's network to exactly those sites only on your Allow; and a command needing administrator rights, which it
// never runs: you run it yourself and press Done. Pure: the records, their checks, the widened scope, the words.
import type { AgentScope } from "./agent-scope";

/** One thing the agent would download: the tool, its version, and the host it comes from. */
export interface DownloadItem {
  tool: string;
  version: string;
  host: string;
}

/** A download list on the card. `asked` until your Allow; then `allowed`, with the hosts its network gained. */
export interface DownloadPlan {
  id: string;
  items: DownloadItem[];
  why?: string;
  state: "asked" | "allowed";
  at: number;
  allowedAt?: number;
}

/** A command needing administrator rights, for you to run: `asked` until your Done. */
export interface AdminStep {
  id: string;
  command: string;
  why?: string;
  state: "asked" | "done";
  at: number;
  doneAt?: number;
}

/** The asks an agent's record carries (AgentState's). */
export interface AgentAsks {
  downloads?: DownloadPlan;
  admin?: AdminStep[];
}

export const MAX_DOWNLOADS = 16;
export const MAX_ADMIN_STEPS = 8;
const MAX_TEXT = 300;
const MAX_COMMAND = 1_000;

/** A plain host name: lowercase labels with at least one dot and a letter-led top label. No wildcard, no port, no
    address, no user: a listed site is exactly one host. */
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const LOCAL = /(^|\.)(localhost|local|internal|lan|home|arpa)$/;
const NAME = /^[\w][\w.+@/:-]{0,79}$/;
const VERSION = /^[\w][\w.+~^*<>=@-]{0,63}$/;

/** Why `host` isn't one plain public host name, or null. Pure. */
export function hostRefusal(host: string): string | null {
  if (!HOST.test(host)) return `${JSON.stringify(host.slice(0, 80))} isn't a plain host name (like nodejs.org): no wildcard, scheme, port, path or address`;
  if (LOCAL.test(host)) return `${host} is a local name, not a download site`;
  return null;
}

/** The download list the agent asked for, checked: each item a tool, a version and one host; or why not. Pure. */
export function cleanDownloads(raw: unknown): DownloadItem[] | string {
  if (!Array.isArray(raw) || !raw.length) return "items must list at least one download: {tool, version, host}.";
  if (raw.length > MAX_DOWNLOADS) return `At most ${MAX_DOWNLOADS} downloads in one list.`;
  const out: DownloadItem[] = [];
  for (const x of raw) {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const tool = typeof o.tool === "string" ? o.tool.trim() : "";
    const version = typeof o.version === "string" ? o.version.trim() : "";
    const host = typeof o.host === "string" ? o.host.trim().toLowerCase().replace(/\.$/, "") : "";
    if (!NAME.test(tool)) return `Each download names its tool (like node or java), not ${JSON.stringify(tool.slice(0, 80))}.`;
    if (!VERSION.test(version)) return `${tool}: give the version it gets (like 22.11.0 or 21), not ${JSON.stringify(version.slice(0, 80))}.`;
    const why = hostRefusal(host);
    if (why) return `${tool}: ${why}.`;
    out.push({ tool, version, host });
  }
  return out;
}

/** The command the agent asks you to run, checked: one non-empty command; or why not. Pure. */
export function cleanCommand(raw: unknown): { command: string } | { error: string } {
  const c = typeof raw === "string" ? raw.trim() : "";
  if (!c) return { error: "command must be the exact command to run." };
  if (c.length > MAX_COMMAND) return { error: `The command is longer than ${MAX_COMMAND} characters.` };
  if (c.includes("\0")) return { error: "The command holds a NUL." };
  return { command: c };
}

/** A reason the agent gave, kept to one short line. Pure. */
export const cleanWhy = (raw: unknown): string | undefined => {
  const s = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "";
  return s || undefined;
};

/** The hosts of a list, each once, in order. Pure. */
export const hostsOf = (items: readonly DownloadItem[]): string[] => [...new Set(items.map((i) => i.host))];

/** The scope with its network widened to `base` (what it reached before) plus exactly `hosts`. Pure. */
export function widenedScope(scope: AgentScope, base: readonly string[], hosts: readonly string[]): AgentScope {
  const from = scope.proxyAllow ?? base;
  return { ...scope, proxyAllow: [...new Set([...from, ...hosts])] };
}

/** What still waits on you: a download list not allowed, each command not done. Pure. */
export function waitingAsks(a: AgentAsks): { downloads: DownloadPlan | null; admin: AdminStep[] } {
  return { downloads: a.downloads?.state === "asked" ? a.downloads : null, admin: (a.admin ?? []).filter((s) => s.state === "asked") };
}
export const hasWaitingAsk = (a: AgentAsks): boolean => {
  const w = waitingAsks(a);
  return !!w.downloads || w.admin.length > 0;
};

/** The waiting asks as the card's "what is missing" lines (never a check of the project). Pure. */
export function waitingLines(a: AgentAsks): string[] {
  const w = waitingAsks(a);
  return [
    ...(w.downloads ? [`Waiting for you to allow downloads from ${hostsOf(w.downloads.items).join(", ")}`] : []),
    ...w.admin.map((s) => `Waiting for you to run: ${s.command}`),
  ];
}

// ---- what the agent is told ----------------------------------------------------------------------

/** The tool's answer to a download list. Pure. */
export const downloadsAsked = (items: readonly DownloadItem[]): string =>
  `Listed on the Transport card: ${items.map((i) => `${i.tool} ${i.version} from ${i.host}`).join("; ")}. Nothing is reachable yet: the user allows it on the card. End your turn now, and don't try another way; you'll be told when the downloads are allowed.`;

/** The tool's answer to a command for the user. Pure. */
export const adminAsked = (command: string): string =>
  `The Transport card shows the user this command to run themselves: ${command}\nNever run it, or anything else with sudo. End your turn now; you'll be told when the user has run it.`;

/** What the agent hears once you allowed its list. Pure. */
export const downloadsAllowed = (items: readonly DownloadItem[]): string =>
  [
    `The user allowed the downloads you listed. Your network now also reaches ${hostsOf(items).join(", ")}, and only those besides what it reached before:`,
    ...items.map((i) => `- ${i.tool} ${i.version} from ${i.host}`),
    "",
    "Download exactly these and carry on with the setup. Anything from another site needs a new list (transport_setup downloads); then end your turn.",
  ].join("\n");

/** What the agent hears once you ran its command. Pure. */
export const adminDone = (command: string): string => `The user says they ran this themselves on this device: ${command}\nCheck that it took effect and carry on with the setup, then end your turn.`;
