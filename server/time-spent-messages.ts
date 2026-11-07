// Time Spent by message (§app.message-labels/labelling), computed on read and never stored: every counted second
// goes to the next message the user pressed Send on, so the rows add up to You whatever a message's label turns out
// to be. Pure.

import type { TimeSpentMessageRow, TimeSpentMessages, TimeSpentRow } from "../shared/time-spent";
import type { OwnMessage } from "./message-input";
import { isOnAt, UNSORTED_BELOW, wordsHash, type SessionLabels, type SwitchPeriod } from "./message-labels";
import type { TimeSpentRun } from "./time-spent";

const ROW_ORDER: readonly TimeSpentMessageRow[] = ["specifying", "directing", "reworking", "asking", "unsorted", "not-labelled"];
export const SCREENSHOTS_ROW: TimeSpentRow = "screenshots";

export interface ScreenshotsFollowed {
  reworking: number;
  specifying: number;
  directing: number;
  other: number;
}

/** A second's destination: a message, or a press that closes the stretch with no words. */
type Stop = { at: number; msg: OwnMessage | null };

/** What the row a message counts under is: its stored label held to the threshold, or that it has none. */
export function rowOfMessage(id: string, labels: SessionLabels): TimeSpentMessageRow {
  const stored = labels.labels.get(id);
  if (!stored) return "not-labelled";
  return stored.confidence < UNSORTED_BELOW ? "unsorted" : stored.label;
}

/** The notes beside the session applied. An offer's answer is an action, oldest note to oldest message with its words,
    and its press is when it was sent. A message no person sent is left out altogether: it closes no stretch. */
export function withPresses(messages: readonly OwnMessage[], labels: SessionLabels): OwnMessage[] {
  const acted = [...labels.acted];
  return messages.flatMap((m) => {
    const hash = acted.length ? wordsHash(m.fullText ?? m.text) : "";
    const i = acted.findIndex((a) => a.hash === hash && a.at <= m.sentAt);
    if (i >= 0) {
      const [note] = acted.splice(i, 1);
      return [{ ...m, action: "pressed" as const, sentAt: note!.at }];
    }
    if (labels.program.has(m.id)) return [];
    const pressed = labels.presses.get(m.id);
    return [pressed === undefined ? m : { ...m, sentAt: pressed }];
  });
}

/** Which of these the labeller still owes: typed, sent with the switch on, and with no stored label. */
export function pendingMessages(messages: readonly OwnMessage[], labels: SessionLabels, periods: readonly SwitchPeriod[]): OwnMessage[] {
  return withPresses(messages, labels).filter((m) => !m.action && !labels.labels.has(m.id) && isOnAt(periods, m.sentAt));
}

export function attributeMessages(
  runs: readonly TimeSpentRun[],
  own: readonly OwnMessage[],
  labels: SessionLabels,
  excerpt: (text: string) => string = (t) => t,
): { messages: TimeSpentMessages; screenshots: ScreenshotsFollowed } {
  // By when Send was pressed. Array.sort is stable: file order breaks ties. Every message counts, the switch on or off,
  // so the rows add up to You: one sent with it off is never asked about, and stays Not Labelled.
  const stops: Stop[] = [
    ...withPresses(own, labels).map((m) => ({ at: Math.floor(m.sentAt / 1000), msg: m })),
    ...labels.lands.map((ms) => ({ at: Math.floor(ms / 1000), msg: null })),
  ].sort((a, b) => a.at - b.at);

  const secondsOf = new Map<Stop, number>();
  const screenshots: ScreenshotsFollowed = { reworking: 0, specifying: 0, directing: 0, other: 0 };
  let sinceLast = 0;
  const give = (stop: Stop | undefined, sec: number, row: TimeSpentRow) => {
    if (sec <= 0) return;
    if (stop) secondsOf.set(stop, (secondsOf.get(stop) ?? 0) + sec);
    else sinceLast += sec;
    if (row !== SCREENSHOTS_ROW) return;
    const followed = stop?.msg && !stop.msg.action ? rowOfMessage(stop.msg.id, labels) : null;
    if (followed === "reworking" || followed === "specifying" || followed === "directing") screenshots[followed] += sec;
    else screenshots.other += sec;
  };
  for (const run of runs) {
    // The first stop after the run's first second; each stop takes the seconds before it.
    let lo = 0;
    let hi = stops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (stops[mid]!.at > run.s) hi = mid;
      else lo = mid + 1;
    }
    let from = run.s;
    for (let i = lo; i < stops.length && from < run.e; i++) {
      const to = Math.min(run.e, stops[i]!.at);
      give(stops[i], to - from, run.r);
      from = Math.max(from, to);
    }
    give(undefined, run.e - from, run.r);
  }

  const rows = new Map<TimeSpentMessageRow, TimeSpentMessages["rows"][number]>();
  const beforeAction = { count: 0, seconds: 0 };
  for (const stop of stops) {
    const seconds = secondsOf.get(stop) ?? 0;
    const m = stop.msg;
    if (!m || m.action) {
      beforeAction.count++;
      beforeAction.seconds += seconds;
      continue;
    }
    const key = rowOfMessage(m.id, labels);
    const row = rows.get(key) ?? { key, seconds: 0, messages: [] };
    row.seconds += seconds;
    const stored = labels.labels.get(m.id);
    row.messages.push({ id: m.id, excerpt: excerpt(m.text), seconds, ...(stored && stored.provider !== "jev" ? { labelledBy: stored.model } : {}) });
    rows.set(key, row);
  }
  return {
    messages: { rows: ROW_ORDER.flatMap((k) => rows.get(k) ?? []), beforeAction, sinceLast },
    screenshots,
  };
}

/** Your Messages shows once a session has a message you typed or dictated since the switch went on, or a label stored
    before. A session you only read has neither, and shows nothing. */
export function showsMessages(own: readonly OwnMessage[], labels: SessionLabels, periods: readonly SwitchPeriod[]): boolean {
  return labels.labels.size > 0 || withPresses(own, labels).some((m) => !m.action && isOnAt(periods, m.sentAt));
}
