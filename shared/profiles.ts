/**
 * Session profiles (§chat/profiles): what one session can do. Capabilities, Default (the only
 * profile in code; the others are files, §chat.profiles/projects), a profile's identity, the
 * snapshot a session keeps in its `sova-profile` entry, and the words both sides print. Shared by the
 * server and the client; imports nothing.
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

/** Every tool the `*` groups hold today (pi-config's subagents and link extensions), so a runtime
    excludes them by exact name even when an extension registers one after load. */
export const KNOWN_REMOVABLE_TOOLS = [
  "agent_spawn", "agent_resume", "agent_models", "agent_list", "agent_transcript", "agent_steer", "agent_kill", "agent_wait",
  "team_create", "team_add", "team_eject", "team_list",
  "link_members", "link_send", "link_inbox", "link_offer", "link_accept", "link_decline", "link_offers",
] as const;

/** The tools each grant adds (registered by the server's `sova-session-powers` extension). */
export const GRANT_TOOLS: Record<Grantable, readonly string[]> = {
  "sessions.read": ["session_list", "session_detail", "session_read"],
  "sessions.message": ["session_send", "queue_open"],
  "sessions.all": [],
};
export const SESSION_TOOL_NAMES = ["session_list", "session_detail", "session_read", "session_send", "queue_open"] as const;

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

export const PROFILE_ICONS = ["grid", "eye", "network", "branch", "wrench", "shield", "search", "terminal", "bulb", "building"] as const;
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
  /** A linked playbook's id (§chat.profiles/playbook). */
  playbook?: string;
  overseerMayStart: boolean;
}

/** Where a profile comes from (§chat.profiles/projects): Sova's code or shipped files, yours, a project's. */
export type ProfileSource = "sova" | "user" | "project";

/** What names one profile: `project` is the project root, for a project profile only. */
export interface ProfileRef {
  source: ProfileSource;
  id: string;
  project?: string;
}

/** A profile's identity: `sova:<id>`, `user:<id>` or `project:<root>#<id>`. */
export const profileKey = (r: ProfileRef): string => (r.source === "project" ? `project:${r.project ?? ""}#${r.id}` : `${r.source}:${r.id}`);

/** `<state root>/session-profiles.json` (Yours). */
export interface ProfilesFile {
  version: 1;
  profiles: Profile[];
}

/** One profile as the listing shows it. */
export interface ListedProfile extends Profile {
  source: ProfileSource;
  key: string;
  /** Project profiles: the project root and name. */
  project?: string;
  projectName?: string;
  /** The file it was read from (absent for Default). */
  file?: string;
  /** Project profiles that grant powers or allow Overseer starts (§chat.profiles/trust). */
  approval?: "needed" | "approved";
}

/** A profile file that couldn't be read, with the exact reason. */
export interface ProfileProblem {
  source: ProfileSource;
  file: string;
  error: string;
}

/** GET /api/profiles?cwd=. */
export interface ProfilesListing {
  /** Default, then the shipped profiles (those yours don't replace). */
  builtins: ListedProfile[];
  /** Yours; empty when the file is malformed (`error` says so). */
  yours: ListedProfile[];
  /** Your file's path. */
  yoursFile: string;
  /** The cwd's project: `ok` lists its profiles (none: an empty list). */
  project: { state: "ok" | "none" | "remote" | "missing"; message?: string; root?: string; name?: string; dir?: string; profiles: ListedProfile[] };
  /** Files skipped because they couldn't be read (your file's own error is `error`). */
  problems: ProfileProblem[];
  /** Keys hidden from the pickers. */
  hidden: string[];
  /** Keys of One at a time profiles with a live session, each with that session. */
  running: Record<string, { id: string; path: string; title: string }>;
  /** Keys of One at a time profiles that have been run at least once (their shelf slot). */
  everRun: string[];
  error?: string;
}

/** The profile a session keeps: the whole profile plus where it came from. */
export type SnapshotProfile = Profile & { source?: ProfileSource; project?: string; projectName?: string; builtin?: boolean; custom?: boolean };

/** `customType` of the session's own profile entry (whole snapshot, newest on the branch wins). */
export const PROFILE_ENTRY = "sova-profile";
export interface ProfileEntryData {
  v: 1;
  /** null: Default. `custom`: made on the board, not saved. An older entry's `builtin` reads as source `sova`. */
  profile: SnapshotProfile | null;
  /** Who picked it, when not the user on the empty screen. */
  by?: "overseer" | "start";
}

/** A snapshot's or summary field's source (an older entry has only `builtin`). */
export const sourceOf = (p: { id: string; source?: ProfileSource; builtin?: boolean }): ProfileSource =>
  p.source ?? (p.builtin || p.id === DEFAULT_PROFILE_ID ? "sova" : "user");

/** A snapshot's or summary field's identity. */
export const keyOf = (p: { id: string; source?: ProfileSource; builtin?: boolean; project?: string }): string =>
  profileKey({ source: sourceOf(p), id: p.id, ...(p.project ? { project: p.project } : {}) });

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

/** Default: nothing changed. The one profile in code; every other is a file (§chat.profiles/projects). */
export const DEFAULT_PROFILE: Profile = {
  id: DEFAULT_PROFILE_ID,
  label: "Default",
  icon: "grid",
  description: "Everything a new session has today.",
  remove: [],
  grant: [],
  singleton: false,
  limits: DEFAULT_LIMITS,
  overseerMayStart: false,
};

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

const PROFILE_FIELDS = ["id", "label", "icon", "description", "remove", "grant", "singleton", "limits", "mode", "model", "firstMessage", "playbook", "overseerMayStart"];
const PLAYBOOK_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * What is wrong with a profile FILE, or null (§chat.profiles/projects): stricter than parseProfile,
 * since a hand or agent edit should hear about a typo rather than lose a field to it. Unknown
 * fields, capability names, icons, modes, limits or types are each an error sentence.
 */
export function profileFileError(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "A profile must be a JSON object.";
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !PROFILE_FIELDS.includes(k));
  if (unknown.length) return `Unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}. Known: ${PROFILE_FIELDS.join(", ")}.`;
  const list = (k: "remove" | "grant", known: readonly string[]) => {
    const v = o[k];
    if (v === undefined) return null;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return `"${k}" must be a list of names.`;
    const bad = (v as string[]).filter((x) => !known.includes(x));
    return bad.length ? `"${k}" has unknown name${bad.length > 1 ? "s" : ""} ${bad.map((x) => `"${x}"`).join(", ")}. Known: ${known.join(", ")}.` : null;
  };
  const listError = list("remove", REMOVABLE) ?? list("grant", GRANTABLE);
  if (listError) return listError;
  for (const k of ["label", "description", "model", "firstMessage", "playbook"] as const)
    if (o[k] !== undefined && typeof o[k] !== "string") return `"${k}" must be text.`;
  for (const k of ["singleton", "overseerMayStart"] as const) if (o[k] !== undefined && typeof o[k] !== "boolean") return `"${k}" must be true or false.`;
  if (o.icon !== undefined && !(PROFILE_ICONS as readonly string[]).includes(o.icon as string)) return `"icon" must be one of ${PROFILE_ICONS.join(", ")}.`;
  if (o.mode !== undefined && o.mode !== "normal" && o.mode !== "delegate") return `"mode" must be "normal" or "delegate".`;
  if (o.playbook !== undefined && !PLAYBOOK_ID_RE.test(o.playbook as string)) return `"playbook" must be a playbook's id (its folder name: lowercase letters, digits and dashes).`;
  if (o.limits !== undefined) {
    if (!o.limits || typeof o.limits !== "object" || Array.isArray(o.limits)) return `"limits" must be an object.`;
    for (const [k, v] of Object.entries(o.limits as Record<string, unknown>)) {
      if (!(LIMIT_KEYS as readonly string[]).includes(k)) return `"limits" has an unknown key "${k}". Known: ${LIMIT_KEYS.join(", ")}.`;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 10_000) return `"limits.${k}" must be a whole number from 1 to 10000.`;
    }
  }
  const parsed = parseProfile(raw);
  return "error" in parsed ? parsed.error : null;
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
  const playbook = typeof o.playbook === "string" && PLAYBOOK_ID_RE.test(o.playbook.trim()) ? o.playbook.trim() : undefined;
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
    ...(playbook ? { playbook } : {}),
    overseerMayStart: o.overseerMayStart === true,
  };
}

/** The powers a project profile needs approved for (§chat.profiles/trust), or null when it needs none. */
export function powersToApprove(p: Pick<Profile, "grant" | "overseerMayStart">): { grant: Grantable[]; overseerMayStart: boolean } | null {
  return p.grant.length || p.overseerMayStart ? { grant: [...p.grant], overseerMayStart: p.overseerMayStart } : null;
}

/** "read other sessions, message other sessions and be started by the Overseer". */
export function powersText(p: { grant: readonly Grantable[]; overseerMayStart: boolean }): string {
  const verb: Record<Grantable, string> = { "sessions.read": "read other sessions", "sessions.message": "message other sessions", "sessions.all": "see all Sova sessions" };
  const parts = [...p.grant.map((g) => verb[g]), ...(p.overseerMayStart ? ["be started by the Overseer"] : [])];
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
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
  return [...new Set([...exact, ...[...KNOWN_REMOVABLE_TOOLS, ...present].filter((n) => toolRemoved(n, remove))])];
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
      : "reads and messages sessions in its project"
    : g.has("sessions.read")
      ? g.has("sessions.all")
        ? "reads all Sova sessions"
        : "reads sessions in its project"
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
/** "Release checker" → "Release Checker", for buttons (Title Case). */
export const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
