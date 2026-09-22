import type { SessionSummary } from "../../shared/protocol";

/**
 * The session list's summary line (spec/02-session-list.md §2): what the session is FOR.
 *
 * The outline writes two lines per snapshot — `outlineGist` ("what this session is about") and
 * `outlineNow` ("what the agent is doing this second"). The row truncates after a few words in a
 * narrow sidebar, so the gist is what makes a session recognizable; the now line only stands in for
 * snapshots written before the gist existed.
 */
export function summaryLineOf(s: SessionSummary): string {
  return s.outlineGist?.trim() || s.outlineNow?.trim() || "";
}

/** The row's tooltip: the line it shows, plus the latest activity when that is something else. */
export function summaryTitleOf(s: SessionSummary): string {
  const line = summaryLineOf(s);
  const now = s.outlineNow?.trim() ?? "";
  return now && now !== line ? `${line}\nNow: ${now}` : line;
}
