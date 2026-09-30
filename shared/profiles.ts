/**
 * Session profiles (§chat/profiles): what one session can do. Capabilities, the built-in profiles,
 * the snapshot a session keeps in its `sova-profile` entry, and the words both sides print. Shared by
 * the server and the client; imports nothing.
 */

/** Removable capabilities, in the order every list shows them. */
export const REMOVABLE = ["shell", "edit", "workers", "web", "worktrees", "links", "timers"] as const;
export type Removable = (typeof REMOVABLE)[number];

/** Grantable session powers, in order. */
export const GRANTABLE = ["sessions.read", "sessions.message", "sessions.all"] as const;
export type Grantable = (typeof GRANTABLE)[number];

/** The tools each removable capability takes away. Exact names, except the `*` prefixes. */
export const CAPABILITY_TOOLS: Record<Removable, readonly string[]> = {
  shell: ["bash"],
  edit: ["edit", "write"],
  workers: ["agent_*", "team_*"],
  web: ["web_search", "fetch_content", "get_search_content", "source_check"],
  worktrees: ["worktree"],
  links: ["link_*"],
  timers: ["wake_nudge"],
};

/** The tools each grant adds (registered by the server's `sova-session-powers` extension). */
export const GRANT_TOOLS: Record<Grantable, readonly string[]> = {
  "sessions.read": ["session_list", "session_detail", "session_read"],
  "sessions.message": ["session_send"],
  "sessions.all": [],
};
export const SESSION_TOOL_NAMES = ["session_list", "session_detail", "session_read", "session_send"] as const;

export const CAPABILITY_LABEL: Record<Removable | Grantable, string> = {
  shell: "Shell",
  edit: "Edit files",
  workers: "Workers & teams",
  web: "Web",
  worktrees: "Worktrees",
  links: "Mesh links",
  timers: "Timers",
  "sessions.read": "Read other sessions",
  "sessions.message": "Message other sessions",
  "sessions.all": "See all Sova sessions",
};

export const PROFILE_ICONS = ["grid", "eye", "network", "git-branch", "wrench", "shield", "search", "list-checks"] as const;
export type ProfileIcon = (typeof PROFILE_ICONS)[number];

/** §chat.profiles/limits. */
export interface ProfileLimits {
  /** Highest hop a send may carry. */
  hops: number;
  /** Sends per message the user sends. */
  perMessage: number;
  /** Sends a day in runs the user didn't start. */
  perDay: number;
  /** Distinct targets per run. */
  targetsPerRun: number;
  /** Sends to one target in any 10 minutes. */
  perPair: number;
}
export const DEFAULT_LIMITS: ProfileLimits = { hops: 3, perMessage: 10, perDay: 40, targetsPerRun: 5, perPair: 6 };
export const LIMIT_KEYS = ["hops", "perMessage", "perDay", "targetsPerRun", "perPair"] as const;
export const LIMIT_LABEL: Record<keyof ProfileLimits, string> = {
  hops: "Hops",
  perMessage: "Sends per message you send",
  perDay: "Sends a day on its own",
  targetsPerRun: "Sessions per run",
  perPair: "Sends to one session per 10 min",
};

export interface Profile {
  id: string;
  label: string;
  icon: ProfileIcon;
  description: string;
  remove: Removable[];
  grant: Grantable[];
  /** "One at a time" in the UI (§chat.profiles/singleton). */
  singleton: boolean;
  limits: ProfileLimits;
  /** Starts with this mode ("normal" | "delegate"); absent = the session default. */
  mode?: string;
  /** Starts with this model ref "provider/id"; absent = the session default. */
  model?: string;
  firstMessage?: string;
  overseerMayStart: boolean;
}

/** `<state root>/session-profiles.json`. */
export interface ProfilesFile {
  version: 1;
  profiles: Profile[];
  hiddenBuiltins: string[];
}

/** GET /api/profiles. */
export interface ProfilesListing {
  builtins: Profile[];
  /** Yours; empty when the file is malformed (`error` says so). */
  profiles: Profile[];
  hiddenBuiltins: string[];
  /** Ids of One at a time profiles with a live session, each with that session. */
  running: Record<string, { id: string; path: string; title: string }>;
  /** One at a time profiles that have been run at least once (their shelf slot). */
  everRun: string[];
  error?: string;
}

/** `customType` of the session's own profile entry (whole snapshot, newest on the branch wins). */
export const PROFILE_ENTRY = "sova-profile";
export interface ProfileEntryData {
  v: 1;
  /** null: Default. `custom`: made on the board, not saved. */
  profile: (Profile & { builtin?: boolean; custom?: boolean }) | null;
  /** Who picked it, when not the user on the empty screen. */
  by?: "overseer" | "start";
}

/** `customType` of the invisible marker beside a message another session sent (§chat.profiles/delivery). */
export const SESSION_SENT_ENTRY = "sova-session-sent";
export interface SessionSentData {
  v: 1;
  targetId: string;
  from: { sessionId: string; title: string };
  hop: number;
}

/** The one line a session message starts with, as the target's model reads it. */
export function sessionSentHeader(from: { sessionId: string; title: string }, hop: number): string {
  const title = from.title.replace(/["\n\r]/g, "'").slice(0, 80);
  return `[from session "${title}" (${from.sessionId}), hop ${hop}]`;
}
const HEADER_RE = /^\[from session "[^"\n]*" \([^)\s]+\), hop \d+\]\n?/;
/** The text without its header line, when it has one. */
export function stripSessionHeader(text: string): string {
  return text.replace(HEADER_RE, "");
}

export const DEFAULT_PROFILE_ID = "default";

const base = { description: "", remove: [] as Removable[], grant: [] as Grantable[], singleton: false, limits: DEFAULT_LIMITS, overseerMayStart: true };
export const BUILTIN_PROFILES: readonly Profile[] = [
  { ...base, id: DEFAULT_PROFILE_ID, label: "Default", icon: "grid", description: "Everything a new session has today.", overseerMayStart: false },
  {
    ...base,
    id: "reviewer",
    label: "Read-only reviewer",
    icon: "eye",
    description: "Reads other sessions. Can't edit files, run the shell, or start workers.",
    remove: ["shell", "edit", "workers"],
    grant: ["sessions.read"],
  },
  {
    ...base,
    id: "mini-overseer",
    label: "Mini overseer",
    icon: "network",
    description: "Reads and messages sessions in its folder. Can't edit files.",
    remove: ["edit", "workers"],
    grant: ["sessions.read", "sessions.message"],
  },
  {
    ...base,
    id: "merge-captain",
    label: "Merge captain",
    icon: "git-branch",
    description: "Sees and messages every Sova session, and keeps the shell for git and builds. No web.",
    remove: ["workers", "web"],
    grant: ["sessions.read", "sessions.message", "sessions.all"],
    singleton: true,
  },
];

export const builtinProfile = (id: string): Profile | undefined => BUILTIN_PROFILES.find((p) => p.id === id);

/**
 * The rules every profile is brought to, whatever made it: grants imply reading, and a profile that
 * removes anything removes Workers & teams too (§chat.profiles/enforcement: a worker would start
 * with every default tool). Returns sorted, deduplicated lists.
 */
export function normalizeCaps(remove: readonly string[], grant: readonly string[]): { remove: Removable[]; grant: Grantable[] } {
  const r = new Set(remove.filter((x): x is Removable => (REMOVABLE as readonly string[]).includes(x)));
  const g = new Set(grant.filter((x): x is Grantable => (GRANTABLE as readonly string[]).includes(x)));
  if (g.has("sessions.message") || g.has("sessions.all")) g.add("sessions.read");
  if (r.size > 0) r.add("workers");
  return { remove: REMOVABLE.filter((x) => r.has(x)), grant: GRANTABLE.filter((x) => g.has(x)) };
}

/** Why a toggle on the board can't change now, or null. */
export function lockedReason(cap: Removable | Grantable, remove: readonly Removable[]): string | null {
  if (cap === "workers" && remove.some((r) => r !== "workers")) return "Workers would get every tool back, so removing anything removes them too.";
  return null;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10_000 ? v : fallback;
}

/** A profile from untrusted JSON, or an error sentence. Unknown fields are dropped. */
export function parseProfile(raw: unknown): Profile | { error: string } {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return { error: "A profile must be an object." };
  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return { error: `Profile id "${id}" is not valid (lowercase letters, digits and dashes).` };
  const label = typeof o.label === "string" ? o.label.trim() : "";
  if (!label || label.length > 60) return { error: "A profile needs a name of up to 60 characters." };
  const caps = normalizeCaps(Array.isArray(o.remove) ? (o.remove as string[]) : [], Array.isArray(o.grant) ? (o.grant as string[]) : []);
  const l = (o.limits ?? {}) as Record<string, unknown>;
  const limits: ProfileLimits = {
    hops: num(l.hops, DEFAULT_LIMITS.hops),
    perMessage: num(l.perMessage, DEFAULT_LIMITS.perMessage),
    perDay: num(l.perDay, DEFAULT_LIMITS.perDay),
    targetsPerRun: num(l.targetsPerRun, DEFAULT_LIMITS.targetsPerRun),
    perPair: num(l.perPair, DEFAULT_LIMITS.perPair),
  };
  const icon = (PROFILE_ICONS as readonly string[]).includes(o.icon as string) ? (o.icon as ProfileIcon) : "wrench";
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const mode = o.mode === "normal" || o.mode === "delegate" ? o.mode : undefined;
  const model = str(o.model, 200);
  const firstMessage = str(o.firstMessage, 20_000);
  return {
    id,
    label,
    icon,
    description: str(o.description, 200) ?? "",
    ...caps,
    singleton: o.singleton === true,
    limits,
    ...(mode ? { mode } : {}),
    ...(model ? { model } : {}),
    ...(firstMessage ? { firstMessage } : {}),
    overseerMayStart: o.overseerMayStart === true,
  };
}

/** Whether the profile changes nothing (Default's shape). */
export const isDefaultShape = (p: Pick<Profile, "remove" | "grant">) => p.remove.length === 0 && p.grant.length === 0;

/** Whether a tool name is taken by these removals. */
export function toolRemoved(name: string, remove: readonly Removable[]): boolean {
  return remove.some((cap) => CAPABILITY_TOOLS[cap].some((t) => (t.endsWith("*") ? name.startsWith(t.slice(0, -1)) : name === t)));
}

/** The exact tool names to exclude from a runtime whose registry holds `present`. */
export function excludedTools(remove: readonly Removable[], present: readonly string[]): string[] {
  const exact = remove.flatMap((cap) => CAPABILITY_TOOLS[cap].filter((t) => !t.endsWith("*")));
  return [...new Set([...exact, ...present.filter((n) => toolRemoved(n, remove))])];
}

/** "Up to 3 hops · 10 sends per message you send · 40 a day on its own · 6 to one session per 10 min". */
export function limitsLine(l: ProfileLimits): string {
  return `Up to ${l.hops} hops · ${l.perMessage} sends per message you send · ${l.perDay} a day on its own · ${l.perPair} to one session per 10 min`;
}

/** The popover's and the start sheet's one sentence. `kept`/`total`: tool counts, when known. */
export function profileSentence(p: Pick<Profile, "label" | "remove" | "grant">, kept?: number, total?: number): string {
  const g = new Set(p.grant);
  const powers = g.has("sessions.message")
    ? g.has("sessions.all")
      ? "sees and messages all Sova sessions"
      : "reads and messages sessions in its folder"
    : g.has("sessions.read")
      ? g.has("sessions.all")
        ? "reads all Sova sessions"
        : "reads sessions in its folder"
      : "";
  const off = p.remove.filter((r) => r !== "workers" || p.remove.length === 1).map((r) => CAPABILITY_LABEL[r]);
  const tools = kept !== undefined && total !== undefined ? `keeps ${kept} of ${total} tools` : "";
  const withOff = off.length ? ` with ${off.join(", ")} off` : "";
  const parts = [powers, tools ? `${tools}${withOff}` : off.length ? `has ${off.join(", ")} off` : ""].filter(Boolean);
  return `A ${p.label} session.${parts.length ? ` It ${parts.join(" and ")}.` : ""}`;
}

/** The alert for a One at a time profile that is live elsewhere (§chat.profiles/singleton). */
export const singletonRunningText = (label: string) => `${label} is already running. It's set to One at a time, so only 1 session can use it.`;
export const singletonRaceText = (label: string) => `${label} started in another session. Nothing was sent. Open it or pick another profile.`;
/** "Merge captain" → "Merge Captain", for buttons (Title Case). */
export const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
