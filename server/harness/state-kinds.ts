// The registry of Sova's per-session state kinds (§app.harness/state): one StateKind per type Sova writes or
// folds, pi-free. Each `parse` wraps the strict read today's fold applies (a normalizer, or the predicate the
// reader checks before it uses a record), so a fold through the view (state-view.ts) gives what the fold
// gives; server/harness/state-kinds.test.ts checks it, kind by kind, and pins this list. Adding a kind is the
// route for new state (§app.harness/new-work); writing a type outside it is not.
//
// Types whose writer lives in chat-manager.ts or insights.ts are spelled again here, as insights.ts does:
// importing chat-manager would pull pi into every reader of this registry. The test checks the spellings.
import { CLAUDE_LOGIN_ENTRY, type ClaudeLoginEntry } from "../../pi-config/extensions/claude-code/accounts.ts";
import { MODE_ENTRY_TYPE, normalizeActive as normalizeMode, type ModeActive } from "../../pi-config/extensions/mode/state.ts";
import { normalizeActive as normalizeSandbox, SANDBOX_ENTRY_TYPE, type SandboxActive } from "../../pi-config/extensions/sandbox/state.ts";
import { normalizePick, PICK_ENTRY_TYPE, type PickEntryData } from "../../pi-config/extensions/subagents/subagent-profiles.ts";
import { normalizeActive as normalizeWorktrees, WORKTREES_ENTRY_TYPE, type WorktreesActive } from "../../pi-config/extensions/worktrees/state.ts";
import {
  BATON_DECISION_ENTRY,
  BATON_DONE_ENTRY,
  BATON_ENTRY,
  BATON_HANDOFF_ENTRY,
  BATON_LEASE_ENTRY,
  BATON_OFFER_ENTRY,
  BATON_PROPOSAL_ENTRY,
  BATON_SENT_ENTRY,
  BATON_WRAPUP_ENTRY,
  type BatonDecisionData,
  type BatonDoneData,
  type BatonHandoffData,
  type BatonLeaseData,
  type BatonMarkerData,
  type BatonOfferData,
  type BatonProposalData,
  type BatonSentData,
  type BatonWrapupData,
} from "../../shared/baton";
import type { StateFold, StateKind } from "../../shared/harness";
import {
  GRANT_ENTRY,
  normalizeGrant,
  normalizeRevoke,
  normalizeRule,
  normalizeUse,
  REVOKE_ENTRY,
  RULE_ENTRY,
  USE_ENTRY,
  type GrantEntry,
  type RevokeEntry,
  type RuleEntry,
  type UseEntry,
} from "../../shared/overseer-grants";
import { PROFILE_ENTRY, SESSION_SENT_ENTRY, type ProfileEntryData, type SessionSentData } from "../../shared/profiles";
import { PROJECT_OVERSEER_ENTRY, type ProjectOverseerMarkerData } from "../../shared/project-overseer";
import {
  OVERSEER_DIALOG_ANSWER_ENTRY,
  OVERSEER_ENTRY,
  OVERSEER_SENT_ENTRY,
  type OverseerDialogAnswerData,
  type OverseerSentMarkerData,
} from "../../shared/protocol";
import { normalizeLoadout, type LoadoutEntryData } from "../session-loadout";

const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
/** An object, as the readers that test `!d || typeof d !== "object"` take it (an array included). */
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null;
const filled = (v: unknown): v is string => typeof v === "string" && v !== "";

function kind<T>(type: string, fold: StateFold, parse: (data: unknown) => T | null, owner: StateKind<T>["owner"] = "sova"): StateKind<T> {
  return Object.freeze({ type, owner, fold, parse });
}

// ---- Sova's own -------------------------------------------------------------------------------------

/** A rewind's marker (chat-manager `rewindSession`): pi's leaf on reopen, and insights' rewinds. Any body
    reads (insights keeps a marker with neither id; it drops one with no entry id or time). */
export interface RewindData {
  targetId: string;
  fromLeafId: string;
}
export const REWIND = kind<RewindData>("sova-rewind", "branch-list", (d) => {
  const data = isRecord(d) ? d : {};
  return { targetId: typeof data.targetId === "string" ? data.targetId : "", fromLeafId: typeof data.fromLeafId === "string" ? data.fromLeafId : "" };
});

/** A topic batch's delivery (chat-manager `markTopic`). Nothing reads it back (§chat.topics/delivery). */
export interface TopicDeliveredData {
  v: 1;
  targetId: string;
  topic: unknown;
  batch: unknown;
  items: unknown;
}
export const TOPIC_DELIVERED = kind<TopicDeliveredData>("sova-topic-delivered", "write-only", (d) =>
  isRecord(d) && d.v === 1 && filled(d.targetId) ? (d as TopicDeliveredData) : null,
);

/** The marker an older build wrote into every member of a group it created; read so they keep opening as before. */
export const FANOUT_MEMBER = kind<Record<string, unknown>>("sova-fanout-member", "presence", (d) => (isRecord(d) ? d : null));

/** The session's profile (newest on the branch wins), as `profileOnBranch` checks it. */
export const PROFILE = kind<ProfileEntryData>(PROFILE_ENTRY, "newest-on-branch", (d) => {
  const p = d as ProfileEntryData | undefined;
  return p && p.v === 1 && (p.profile === null || (typeof p.profile === "object" && typeof p.profile.id === "string")) ? p : null;
});

/** The session's context files and skills left out (newest on the branch wins), `normalizeLoadout`. */
// Called through, not referenced: session-loadout folds through this registry, so the two modules form a cycle.
export const LOADOUT = kind<LoadoutEntryData>("sova-loadout", "newest-on-branch", (d) => normalizeLoadout(d));

/** Beside a user message another session sent, as the transcript's row reads it. */
export const SESSION_SENT = kind<SessionSentData>(SESSION_SENT_ENTRY, "branch-list", (d) =>
  isObject(d) && filled(d.targetId) && typeof d.from?.sessionId === "string" ? (d as SessionSentData) : null,
);

/** An Overseer file's marker: an Overseer file holds one (and overseer-state.json names it). */
export const OVERSEER = kind<{ v: 1 }>(OVERSEER_ENTRY, "presence", (d) => (isRecord(d) ? (d as { v: 1 }) : null));

/** Beside a user message the Overseer sent, as the transcript's row reads it. */
export const OVERSEER_SENT = kind<OverseerSentMarkerData>(OVERSEER_SENT_ENTRY, "branch-list", (d) =>
  isObject(d) && filled(d.targetId) ? (d as OverseerSentMarkerData) : null,
);

/** An extension dialog the Overseer answered (one row each). */
export const OVERSEER_DIALOG_ANSWER = kind<OverseerDialogAnswerData>(OVERSEER_DIALOG_ANSWER_ENTRY, "branch-list", (d) =>
  isObject(d) ? (d as OverseerDialogAnswerData) : null,
);

/** An approval for later, from a confirm card's click (read on the branch: a rewind drops it). */
export const GRANT = kind<GrantEntry>(GRANT_ENTRY, "branch-list", (d) => normalizeGrant(d) ?? null);
/** A standing rule, from a click or carried over a /clear (read on the branch). */
export const RULE = kind<RuleEntry>(RULE_ENTRY, "branch-list", (d) => normalizeRule(d) ?? null);
/** A revoke (read over the file, first per id wins: a rewind never brings a revoked one back). */
export const REVOKE = kind<RevokeEntry>(REVOKE_ENTRY, "file-list", (d) => normalizeRevoke(d) ?? null);
/** A grant's or rule's use by a tool, written mid-run (read over the file). */
export const GRANT_USE = kind<UseEntry>(USE_ENTRY, "file-list", (d) => normalizeUse(d) ?? null);

/** A project overseer's marker: its project, read once from the first one in the file (`markerOf`). */
export const PROJECT_OVERSEER = kind<ProjectOverseerMarkerData>(PROJECT_OVERSEER_ENTRY, "marker", (d) => {
  const data = d as { projectId?: unknown } | null | undefined;
  return data && typeof data.projectId === "string" ? { v: 1, projectId: data.projectId } : null;
});

// Baton kinds: each read as the transcript's baton row reads it (shared/baton.ts holds the shapes). The
// statechart's effect kinds also carry `key`, deduped over the file before a write.

export const BATON = kind<BatonMarkerData>(BATON_ENTRY, "presence", (d) => (isObject(d) ? (d as BatonMarkerData) : null));
export const BATON_SENT = kind<BatonSentData>(BATON_SENT_ENTRY, "branch-list", (d) =>
  isObject(d) && filled(d.targetId) && filled(d.by) ? (d as BatonSentData) : null,
);
export const BATON_HANDOFF = kind<BatonHandoffData>(BATON_HANDOFF_ENTRY, "branch-list", (d) =>
  isObject(d) && typeof d.n === "number" ? (d as BatonHandoffData) : null,
);
export const BATON_OFFER = kind<BatonOfferData>(BATON_OFFER_ENTRY, "branch-list", (d) =>
  isObject(d) && typeof d.n === "number" && Array.isArray(d.to) ? (d as BatonOfferData) : null,
);
export const BATON_LEASE = kind<BatonLeaseData>(BATON_LEASE_ENTRY, "branch-list", (d) => (isObject(d) ? (d as BatonLeaseData) : null));
export const BATON_DECISION = kind<BatonDecisionData>(BATON_DECISION_ENTRY, "branch-list", (d) => (isObject(d) ? (d as BatonDecisionData) : null));
export const BATON_DONE = kind<BatonDoneData>(BATON_DONE_ENTRY, "branch-list", (d) => (isObject(d) ? (d as BatonDoneData) : null));
export const BATON_PROPOSAL = kind<BatonProposalData>(BATON_PROPOSAL_ENTRY, "branch-list", (d) => (isObject(d) ? (d as BatonProposalData) : null));
export const BATON_WRAPUP = kind<BatonWrapupData>(BATON_WRAPUP_ENTRY, "branch-list", (d) => (isObject(d) ? (d as BatonWrapupData) : null));

// ---- Extension-owned shapes (the pi-config core builds and reads the data; Sova routes it) ----------

/** The session's active mode triple (newest usable on the branch), the data `pinEntryFor` builds. A body
    whose `active` this version can't read is skipped, whatever `mode` says (`restoreActive`). */
export interface ModePinData {
  mode?: unknown;
  active: ModeActive;
}
export const MODE = kind<ModePinData>(
  MODE_ENTRY_TYPE,
  "newest-on-branch",
  (d) => {
    if (!isRecord(d)) return null;
    const active = normalizeMode(d.active);
    return active ? { mode: d.mode, active } : null;
  },
  "extension:mode",
);

/** The chat's subagent profile pick (newest usable on the branch), `normalizePick`. */
export const SUBAGENT_PROFILE = kind<PickEntryData>(
  PICK_ENTRY_TYPE,
  "newest-on-branch",
  (d) => {
    const profile = normalizePick(d);
    return profile === undefined ? null : { v: 1, profile };
  },
  "extension:subagents",
);

/** A fork's cache lineage (read over the whole file: a rewind never changes the cache shard). */
export interface ForkCacheData {
  v: 1;
  key: string;
}
export const FORK_CACHE = kind<ForkCacheData>(
  "sova-fork-cache",
  "file-list",
  (d) => (isRecord(d) && d.v === 1 && filled(d.key) ? (d as ForkCacheData) : null),
  "extension:subagents",
);

/** The session's sandbox state (newest usable on the branch), sandbox's `normalizeActive`. */
export const SANDBOX = kind<SandboxActive>(SANDBOX_ENTRY_TYPE, "newest-on-branch", (d) => normalizeSandbox(d) ?? null, "extension:sandbox");

/** The session's tracked worktrees, a whole snapshot (newest usable on the branch), worktrees' `normalizeActive`. */
export const WORKTREES = kind<WorktreesActive>(WORKTREES_ENTRY_TYPE, "newest-on-branch", (d) => normalizeWorktrees(d) ?? null, "extension:worktrees");

/** The Claude login the session runs on (newest on the branch naming one), as `recordedLogin` reads it. */
export const CLAUDE_LOGIN = kind<ClaudeLoginEntry>(
  CLAUDE_LOGIN_ENTRY,
  "newest-on-branch",
  (d) => (isObject(d) && typeof d.login === "string" ? (d as ClaudeLoginEntry) : null),
  "extension:claude-code",
);

/** An older session's alignment document (mode's `align` tool now keeps it in tool results). Read only. */
export const ALIGN_DOC = kind<{ doc?: unknown }>("align-doc", "branch-list", (d) => (isObject(d) ? (d as { doc?: unknown }) : null), "extension:mode");

/** Every registered kind, by type. */
export const STATE_KINDS: ReadonlyMap<string, StateKind<unknown>> = new Map(
  [
    REWIND, TOPIC_DELIVERED, FANOUT_MEMBER, PROFILE, LOADOUT, SESSION_SENT, OVERSEER, OVERSEER_SENT, OVERSEER_DIALOG_ANSWER,
    GRANT, RULE, REVOKE, GRANT_USE, PROJECT_OVERSEER,
    BATON, BATON_SENT, BATON_HANDOFF, BATON_OFFER, BATON_LEASE, BATON_DECISION, BATON_DONE, BATON_PROPOSAL, BATON_WRAPUP,
    MODE, SUBAGENT_PROFILE, FORK_CACHE, SANDBOX, WORKTREES, CLAUDE_LOGIN, ALIGN_DOC,
  ].map((k) => [k.type, k as StateKind<unknown>]),
);

/** The baton statechart's effect kinds: the records a write dedupes by `key` before it lands. */
export const BATON_EFFECT_KINDS: readonly StateKind<unknown>[] = [BATON_HANDOFF, BATON_OFFER, BATON_LEASE, BATON_DONE, BATON_PROPOSAL];

/** The registered kind with this type, or undefined. */
export const stateKindOf = (type: string): StateKind<unknown> | undefined => STATE_KINDS.get(type);
