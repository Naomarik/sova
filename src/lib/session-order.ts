// How the sidebar's folder sections are built and ordered.
//
// Two orders, because two regions are answering different questions:
//
//  - `groupByActivity` — "what moved last". The Archive's date sections and the rows inside a
//    user's group read this way: they are looking back, and the last thing that happened is the
//    handle you reach for. This is the ORIGINAL rule, moved here unchanged.
//  - `groupByCreation` — "what did I start, and when". Live & web reads this way. A session's
//    place in that region is then a fact about the session, not about the agent: a folder does not
//    jump to the top because a background subagent wrote a line in it, and a session you started
//    an hour ago stays an hour old however much output it produced since.
//
// Pure, so the orders are what a unit test can hold; the component keeps the open/closed state.

import type { SessionSummary } from "../../shared/protocol";

/** One folder section: its cwd and the sessions in it, already in the section's own order. */
export interface CwdGroup {
  cwd: string;
  sessions: SessionSummary[];
}

/** Newest FILE WRITE first — `lastActiveAt` is the session file's mtime. */
const byActivityDesc = (a: SessionSummary, b: SessionSummary) => b.lastActiveAt.localeCompare(a.lastActiveAt);

/**
 * Newest SESSION first, by `createdAt` — the header's own timestamp, written once when the session
 * was made and never touched again. Nothing an agent does moves it.
 *
 * Ties break on `id` (ascending), and they are real ties: session ids are uuidv7, so two sessions
 * created in the same millisecond are ordered by the id's own tail and that order never changes.
 * Without it two same-stamp rows would sit in whatever order the server's list happened to have,
 * which is not necessarily the same order on the next poll.
 */
export const byCreationDesc = (a: SessionSummary, b: SessionSummary): number =>
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

/**
 * Sessions into folder sections, rows inside a section sorted by `compare`. The sections come out
 * in the order of their own first row — the newest thing in a folder is what decides where the
 * folder sits — because a Map keeps insertion order and the first session seen per cwd is that
 * folder's leader.
 */
function bucketByCwd(sessions: readonly SessionSummary[], compare: (a: SessionSummary, b: SessionSummary) => number): CwdGroup[] {
  const byCwd = new Map<string, SessionSummary[]>();
  for (const s of [...sessions].sort(compare)) {
    const list = byCwd.get(s.cwd);
    if (list) list.push(s);
    else byCwd.set(s.cwd, [s]);
  }
  return [...byCwd].map(([cwd, list]) => ({ cwd, sessions: list }));
}

/**
 * Folder sections by last activity, newest first: the Archive's order, and a group's.
 *
 * Deliberately NOT given `groupByCreation`'s tie-breaks. This is the order those regions have
 * always had, down to what two same-mtime folders do, and making Live & web answer a different
 * question is no reason to move a row anywhere else in the sidebar.
 */
export const groupByActivity = (sessions: readonly SessionSummary[]): CwdGroup[] => bucketByCwd(sessions, byActivityDesc);

/**
 * Folder sections by session creation, newest first: Live & web's order.
 *
 * The sections are re-sorted rather than left in leader order, so that two folders whose newest
 * session shares a `createdAt` settle on `cwd` and cannot swap places between two polls — the same
 * reason rows break on `id`. Leader order already agrees with this sort everywhere else, so the
 * pass only ever moves an exact tie.
 */
export function groupByCreation(sessions: readonly SessionSummary[]): CwdGroup[] {
  return bucketByCwd(sessions, byCreationDesc).sort(
    (x, y) => byCreationDesc(x.sessions[0]!, y.sessions[0]!) || x.cwd.localeCompare(y.cwd),
  );
}
