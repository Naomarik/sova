// The sidebar's per-row remote marks and the group label's remote form (spec/02-session-list.md
// §2 "Remote sessions"). Pure decisions, so a row and its group's label cannot disagree: both
// read `remotePlaceOf` (the summary's own target/remoteCwd, else its placeholder cwd) through
// here, and `mounted` is only ever `SessionSummary.mounted` — never inferred from the target or
// from a cwd that happens to sit inside a mount point.

import { remotePlaceOf, type RemotePlace } from "./remote-session";

export type { RemotePlace };

/** A session row's remote mark: where the row runs, and whether its files are the local mount. */
export interface RemoteMark {
  /** The target and the remote folder (remotePlaceOf): the summary's own fields, else its cwd. */
  place: RemotePlace;
  /** `SessionSummary.mounted` and nothing else: a summary that says nothing is not mounted. */
  mounted: boolean;
  /** The session's own cwd: for a mounted session, the local mount its files really are. */
  cwd: string;
}

/** The mark a row carries, or null for a local session — one row answers for itself, whatever its
 *  group's first row happens to be. */
export function remoteMarkOf(s: { cwd: string; target?: string; remoteCwd?: string; mounted?: boolean }): RemoteMark | null {
  const place = remotePlaceOf(s);
  return place ? { place, mounted: s.mounted === true, cwd: s.cwd } : null;
}

/** The one remote place a group's label may claim: the target and folder every row in the group
 *  shares, or null when the group is local or mixed — its label then shows the plain folder and
 *  claims nothing about its rows, whose own marks say where each one runs. An empty group falls
 *  back to its cwd alone, its label having no rows to speak for. */
export function groupRemotePlaceOf(
  sessions: readonly { cwd: string; target?: string; remoteCwd?: string }[],
  cwd: string,
): RemotePlace | null {
  if (sessions.length === 0) return remotePlaceOf({ cwd });
  let common: RemotePlace | null = null;
  for (const s of sessions) {
    const place = remotePlaceOf(s);
    if (!place) return null;
    if (common && (common.target !== place.target || common.remoteCwd !== place.remoteCwd)) return null;
    common ??= place;
  }
  return common;
}

/** The mark's hover text: names the target and the remote folder like a uniform group label's
 *  title, and says mounted — with the local mount — only for a session the summary says is. */
export function remoteMarkTitle(m: RemoteMark, host?: string): string {
  const where = `${m.place.target}${host ? ` (${host})` : ""}:${m.place.remoteCwd}`;
  return m.mounted
    ? `Remote: ${where}. Mounted: the session's files are the local mount, at ${m.cwd}.`
    : `Remote: ${where}.`;
}

/** The row link's hidden suffix, one short clause like the rail's own: which rows are remote is a
 *  fact a session is picked by, so it rides the link's accessible name, unlike the topic chip and
 *  the context ring, whose numbers are only watched. */
export function remoteMarkSuffix(m: RemoteMark): string {
  return m.mounted ? `, remote on ${m.place.target}, mounted` : `, remote on ${m.place.target}`;
}