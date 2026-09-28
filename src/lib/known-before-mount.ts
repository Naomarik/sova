// What a session view knows about its session before its own reads land (the insight load, the
// chat's hello), from what the client already holds: the session list's row and App's
// explanations and #/agents polls. A view opening another session shows its "Current goal" strip and its
// composer status row from these at the first frame, so neither pops in and shifts the transcript.
// Each is this session's own fact, and each gives way to the view's own read once it lands.
// Pure: no reactive state, so the rules are testable (known-before-mount.test.ts).

import type { AgentsInsight, ExplanationInfo, LiveAgentSession, SessionSummary, TeamInfo, TranscriptItem } from "../../shared/protocol";
import { isInput } from "../../shared/row-counts";
import { teamPause } from "./insights";

/** The strip's collapsed row as the session list has it: the newest outline snapshot's lines. */
export interface KnownOutline {
  now: string;
  /** Topics in that snapshot. */
  topics: number;
  /** The snapshot's "overall" line; "" when the list doesn't carry one. */
  gist: string;
}

/** The session's outline, from its list row: null when the row has no snapshot. */
export function knownOutline(s: Pick<SessionSummary, "outlineNow" | "outlineTopics" | "outlineGist">): KnownOutline | null {
  if (s.outlineNow === undefined) return null;
  return { now: s.outlineNow, topics: s.outlineTopics ?? 0, gist: s.outlineGist ?? "" };
}

/** The session's /explain pages among App's polled list (the store's; the insight adds any the
    file alone records). */
export const knownExplanations = (all: readonly ExplanationInfo[] | undefined, sessionId: string): ExplanationInfo[] =>
  (all ?? []).filter((x) => x.parentSessionId === sessionId);

/**
 * The file holds a typed user message: its derived title (the first one that isn't a wake nudge or
 * a link message) is not the list's "Untitled", whatever the user renamed it to. Such a message is
 * an input, so the status row's inputs trigger will show; false says nothing (a first message past
 * the head read, or none yet).
 */
export const knownInputs = (s: Pick<SessionSummary, "title" | "originalTitle">): boolean => (s.originalTitle ?? s.title) !== "Untitled";

/** How many subagents the session's live record counts, else how many its own records restore: a
    session no runtime hosts yet, or one whose runtime has just started and lists none while it
    restores them. The settled-workers row's number. */
export const knownWorkers = (s: Pick<SessionSummary, "workers" | "live" | "restoredWorkers">): number =>
  (s.workers ?? s.live?.workers)?.total || (s.restoredWorkers ?? 0);

/**
 * The settled-workers trigger's count: the socket's list once it has said, else the list's
 * (`known`). A runtime's first "workers" message can come before its subagents extension has
 * restored the workers the file records (its record lists none yet, and the next look is seconds
 * later), so a said-empty list doesn't override a known count: the session's own records say the
 * runtime will list them.
 */
export const workersShown = (said: boolean, listed: number, known: number): number => (said && (listed > 0 || known === 0) ? listed : known);

/**
 * The inputs trigger will show, but its count is not known yet: the count needs what is above the
 * rows (the hello's, or the pair kept with them), and until then the trigger's box is held.
 * `count` is null until it is known. The rows on screen are this session's own, so an input among
 * them says so too.
 */
export const inputsPending = (count: number | null, list: readonly TranscriptItem[] | null, known: boolean): boolean =>
  count === null && (known || (list ?? []).some(isInput));

/** The head's "Team · N" chip while nothing works: the first team's name, members and pause. */
export interface HeadTeam {
  name: string;
  members: number;
  /** The pause in force: its text. */
  paused: string | null;
}

/**
 * The head chip's team: the view's insight once it has loaded (`teams` defined), and until then
 * the session list's `team`, so the chip is there from the first frame for a session known to have
 * one, and absent for one known to have none.
 */
export function headTeam(teams: readonly TeamInfo[] | undefined, known: SessionSummary["team"]): HeadTeam | null {
  if (teams) {
    const t = teams[0];
    return t ? { name: t.name, members: t.members.length, paused: teamPause(t)?.text ?? null } : null;
  }
  return known ? { name: known.name, members: known.members, paused: known.paused ?? null } : null;
}

/** The session as App's #/agents poll has it (running sessions only; its teams are the insight's
    own join): undefined when the poll doesn't list it. */
export const knownAgents = (feed: AgentsInsight | undefined, path: string): LiveAgentSession | undefined =>
  feed?.sessions.find((x) => x.path === path);

/** The busiest live team: where the head's working chip links, "Team · N working". */
export const busiestLiveTeam = (teams: readonly TeamInfo[] | undefined): TeamInfo | null =>
  (teams ?? []).filter((t) => t.live).reduce<TeamInfo | null>((b, t) => (!b || t.working > b.working ? t : b), null);
