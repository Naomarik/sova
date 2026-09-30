import type { SessionProfileField, SessionSummary } from "../shared/protocol";
import {
  builtinProfile,
  DEFAULT_LIMITS,
  DEFAULT_PROFILE_ID,
  normalizeCaps,
  PROFILE_ENTRY,
  singletonRunningText,
  type Profile,
  type ProfileEntryData,
} from "../shared/profiles";
import { findProfile } from "./profiles-store";

/**
 * A session's profile (§chat.profiles/model, /applying, /singleton): the `sova-profile` entry's fold,
 * resolving a pick into the snapshot the entry keeps, and the One at a time check. The route and the
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
    ...(p.builtin ? { builtin: true as const } : {}),
    ...(p.custom ? { custom: true as const } : {}),
    ...(d?.by ? { by: d.by } : {}),
  };
}

/** A pick as the route receives it: an id, a custom board `{remove, grant, from?}`, or null. */
export type ProfileChoice = string | { remove: string[]; grant: string[]; from?: string } | null;

/** The snapshot a pick writes, or an error sentence. */
export function resolveChoice(choice: ProfileChoice): { ok: true; profile: ProfileEntryData["profile"] } | { ok: false; error: string } {
  if (choice === null || choice === DEFAULT_PROFILE_ID) return { ok: true, profile: null };
  if (typeof choice === "string") {
    const p = findProfile(choice);
    if (!p) return { ok: false, error: `No profile "${choice}". It may have been deleted.` };
    return { ok: true, profile: { ...p, ...normalizeCaps(p.remove, p.grant) } };
  }
  if (typeof choice !== "object" || !Array.isArray(choice.remove) || !Array.isArray(choice.grant)) return { ok: false, error: "profile must be an id, null, or {remove, grant}." };
  const caps = normalizeCaps(choice.remove, choice.grant);
  if (!caps.remove.length && !caps.grant.length) return { ok: true, profile: null };
  const from = typeof choice.from === "string" ? (findProfile(choice.from) ?? builtinProfile(DEFAULT_PROFILE_ID)!) : builtinProfile(DEFAULT_PROFILE_ID)!;
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

/** The live (non-archived) session other than `except` that holds this One at a time profile, or null. */
export function singletonHolder(profileId: string, sessions: readonly SessionSummary[], except?: string): SessionSummary | null {
  return sessions.find((s) => s.profile?.id === profileId && s.profile.singleton && !s.archived && s.path !== except) ?? null;
}

export class SingletonRefusal extends Error {
  constructor(
    readonly label: string,
    readonly running: { id: string; path: string; title: string },
    message = singletonRunningText(label),
  ) {
    super(message);
  }
}
