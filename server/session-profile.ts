import type { SessionProfileField, SessionSummary } from "../shared/protocol";
import {
  DEFAULT_LIMITS,
  DEFAULT_PROFILE,
  DEFAULT_PROFILE_ID,
  keyOf,
  normalizeCaps,
  PROFILE_ENTRY,
  singletonRunningText,
  sourceOf,
  type ListedProfile,
  type Profile,
  type ProfileEntryData,
  type ProfileSource,
  type SnapshotProfile,
} from "../shared/profiles";
import { findProfile, type ProfilePick } from "./profile-sources";
import { approvalRefusal } from "./profile-trust";

/**
 * A session's profile (§chat.profiles/model, /applying, /singleton): the `sova-profile` entry's fold,
 * resolving a pick against the session's project into the snapshot the entry keeps (§chat.profiles/projects,
 * /trust), and the One at a time check by profile identity. The route and the
 * create paths that write it are in server/session-profile-routes.ts, which may import chat-manager;
 * this module must not (chat-manager imports it).
 */

type BranchEntry = { type: string; customType?: string; data?: unknown };

/** The newest `sova-profile` entry on a branch (null: none, i.e. Default). */
export function profileOnBranch(branch: readonly BranchEntry[]): ProfileEntryData | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type !== "custom" || e.customType !== PROFILE_ENTRY) continue;
    const d = e.data as ProfileEntryData | undefined;
    if (d && d.v === 1 && (d.profile === null || (typeof d.profile === "object" && typeof d.profile.id === "string"))) return d;
  }
  return null;
}

/** `SessionSummary.profile` for an entry, or undefined for Default. */
export function profileField(d: ProfileEntryData | null | undefined): SessionProfileField | undefined {
  const p = d?.profile;
  if (!p || p.id === DEFAULT_PROFILE_ID) return undefined;
  return {
    id: p.id,
    label: p.label,
    icon: p.icon,
    ...(p.singleton ? { singleton: true as const } : {}),
    ...(p.custom ? {} : { source: sourceOf(p) }),
    ...(p.project ? { project: p.project } : {}),
    ...(p.projectName ? { projectName: p.projectName } : {}),
    ...(p.custom ? { custom: true as const } : {}),
    ...(d?.by ? { by: d.by } : {}),
  };
}

/** A pick as the route receives it: an id or `{source, id}`, a custom board `{remove, grant, from?}`, or null. */
export type ProfileChoice = ProfilePick | { remove: string[]; grant: string[]; from?: ProfilePick } | null;

const isPick = (v: unknown): v is ProfilePick =>
  typeof v === "string" ||
  (!!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" && ["sova", "user", "project"].includes((v as { source?: unknown }).source as string));

/** The snapshot a listed profile writes: the profile's fields and where it came from. */
export function snapshotOf(p: ListedProfile): SnapshotProfile {
  const { key: _k, file: _f, approval: _a, ...rest } = p;
  return { ...rest, ...normalizeCaps(p.remove, p.grant) };
}

export type Resolved = { ok: true; profile: SnapshotProfile | null; listed?: ListedProfile } | { ok: false; error: string; approval?: true };

/** The snapshot a pick writes for a session in `cwd`, or an error sentence. An unapproved project profile is refused. */
export async function resolveChoice(choice: ProfileChoice, cwd?: string | null): Promise<Resolved> {
  if (choice === null || choice === DEFAULT_PROFILE_ID) return { ok: true, profile: null };
  if (isPick(choice)) {
    const id = typeof choice === "string" ? choice : choice.id;
    if (id === DEFAULT_PROFILE_ID && (typeof choice === "string" || choice.source === "sova")) return { ok: true, profile: null };
    const p = await findProfile(choice, cwd);
    if (!p) return { ok: false, error: `No profile "${id}" for this folder. It may have been deleted, or it belongs to another project.` };
    if (p.approval === "needed") return { ok: false, error: approvalRefusal(p), approval: true };
    return { ok: true, profile: snapshotOf(p), listed: p };
  }
  if (typeof choice !== "object" || !Array.isArray((choice as { remove?: unknown }).remove) || !Array.isArray((choice as { grant?: unknown }).grant))
    return { ok: false, error: "profile must be an id, {source, id}, null, or {remove, grant}." };
  const board = choice as { remove: string[]; grant: string[]; from?: ProfilePick };
  const caps = normalizeCaps(board.remove, board.grant);
  if (!caps.remove.length && !caps.grant.length) return { ok: true, profile: null };
  const from: Profile = (isPick(board.from) ? await findProfile(board.from, cwd) : null) ?? DEFAULT_PROFILE;
  const label = from.id === DEFAULT_PROFILE_ID ? "Custom" : `${from.label}, edited`;
  const custom: Profile & { custom: true } = {
    id: "custom",
    label,
    icon: "wrench",
    description: "",
    ...caps,
    singleton: false,
    limits: from.limits ?? DEFAULT_LIMITS,
    overseerMayStart: false,
    custom: true,
  };
  return { ok: true, profile: custom };
}

/**
 * The live (non-archived) session other than `except` that holds the One at a time profile with
 * identity `key` (§chat.profiles/singleton): the one check every path uses.
 */
export function singletonHolder(key: string, sessions: readonly SessionSummary[], except?: string): SessionSummary | null {
  return sessions.find((s) => !!s.profile && !s.profile.custom && s.profile.singleton && keyOf(s.profile) === key && !s.archived && s.path !== except) ?? null;
}

/** The identity of a snapshot, for the One at a time check. */
export const snapshotKey = (p: { id: string; source?: ProfileSource; builtin?: boolean; project?: string }) => keyOf(p);

export class SingletonRefusal extends Error {
  constructor(
    readonly label: string,
    readonly running: { id: string; path: string; title: string },
    message = singletonRunningText(label),
  ) {
    super(message);
  }
}
