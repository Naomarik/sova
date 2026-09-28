// The Owner page's words (§app.owner-page/content): chips, counts and lines in plain English for a
// non-technical reader. Pure: the share build and the operator's preview both render through these,
// so a chip means the same thing in both. Imports types only.
import type {
  OwnerConversationStatus,
  OwnerCounts,
  OwnerDecisionState,
  OwnerDifference,
  OwnerPerson,
  OwnerStatus,
} from "../../shared/owner";

export type OwnerTone = "warn" | "info" | "success" | undefined;
export interface OwnerChipWord {
  word: string;
  tone: OwnerTone;
}

/** "1 person" / "3 people": digits always. */
export const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Relative time in whole words, for a reader who doesn't read "5m": "just now", "5 minutes ago",
    "2 hours ago", "yesterday", "3 days ago", then "Mar 4" ("Mar 4, 2025" in another year). "" when
    unreadable. A future time (clock skew) reads "just now". */
export function plainAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return "";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${count(min, "minute", "minutes")} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${count(hr, "hour", "hours")} ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} days ago`;
  return plainDate(iso, now);
}

/** "Mar 4", or "Mar 4, 2025" in another year. */
export function plainDate(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return "";
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? "" : `, ${d.getFullYear()}`}`;
}

/** A project's chip. */
export const PROJECT_CHIP: Record<OwnerStatus, OwnerChipWord> = {
  "waiting-on-you": { word: "Waiting on you", tone: "warn" },
  asking: { word: "Asking questions", tone: "info" },
  building: { word: "Building", tone: "info" },
  quiet: { word: "Quiet", tone: undefined },
};
export const projectChip = (s: OwnerStatus): OwnerChipWord => PROJECT_CHIP[s] ?? { word: "Quiet", tone: undefined };

/** A conversation's chip. */
export function conversationChip(s: OwnerConversationStatus): OwnerChipWord {
  switch (s.kind) {
    case "waiting-on":
      return { word: `Waiting on ${s.first}`, tone: "info" };
    case "waiting-on-you":
      return { word: "Waiting on you", tone: "warn" };
    case "with-operator":
      return { word: `With ${s.first}`, tone: "info" };
    case "offered":
      return { word: `Asked ${count(s.count, "person", "people")}`, tone: "info" };
    case "done":
      return { word: "Finished", tone: "success" };
    case "closed":
      return { word: "Ended", tone: undefined };
  }
}

export const DECISION_CHIP: Record<OwnerDecisionState, OwnerChipWord> = {
  agreed: { word: "Agreed", tone: "success" },
  noted: { word: "Noted", tone: undefined },
  "needs-choice": { word: "Needs a choice", tone: "warn" },
};

/** The project card's facts: "Talked to 3 people · 5 decisions · 2 pieces of work finished". */
export const factsLine = (c: OwnerCounts): string =>
  `Talked to ${count(c.people, "person", "people")} · ${count(c.decisions, "decision", "decisions")} · ${count(c.finished, "piece of work", "pieces of work")} finished`;

/** What's been built: "2 pieces of work finished · 1 in progress". */
export const builtLine = (c: Pick<OwnerCounts, "finished" | "inProgress">): string =>
  `${count(c.finished, "piece of work", "pieces of work")} finished · ${c.inProgress} in progress`;

/** The heading line of Waiting on you. */
export const waitingLine = (n: number): string => (n === 1 ? "1 question is waiting for your answer." : `${n} questions are waiting for your answer.`);

/** "3 conversations · last wrote 2 hours ago", or "1 conversation · hasn't replied yet". */
export function personLine(p: OwnerPerson, now = Date.now()): string {
  const n = count(p.conversations, "conversation", "conversations");
  return p.lastWroteAt ? `${n} · last wrote ${plainAgo(p.lastWroteAt, now)}` : `${n} · hasn't replied yet`;
}

/** "{A} and {B} gave different answers about {topic}. We've asked {C} to choose." */
export function differenceLine(d: OwnerDifference): string {
  const who = d.between.length >= 2 ? `${d.between[0]} and ${d.between[1]} gave` : `${d.between[0] ?? "Someone"} gave`;
  const choose =
    d.chooser.kind === "you" ? "We've asked you to choose." : d.chooser.kind === "operator" ? `${d.chooser.first} will choose.` : `We've asked ${d.chooser.first} to choose.`;
  return `${who} different answers about ${d.topic}. ${choose}`;
}

/** Decisions grouped by topic, in the order each topic first appears (the list is newest first). */
export function byTopic<T extends { topic: string }>(rows: T[]): { topic: string; rows: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const g = groups.get(r.topic);
    if (g) g.push(r);
    else groups.set(r.topic, [r]);
  }
  return [...groups].map(([topic, rows]) => ({ topic, rows }));
}

/** A page's route: the URL hash on the share page, a signal in the operator's preview. */
export type OwnerRoute = { kind: "home" } | { kind: "project"; id: string } | { kind: "conversation"; id: string };

const HANDLE = /^[a-z2-9]{8}$/;
/** `#p/q_xxxxxxxx` → a project, `#c/k_xxxxxxxx` → a conversation; anything else → home. */
export function parseOwnerHash(hash: string): OwnerRoute {
  const m = /^#?([pc])\/((?:q|k)_[a-z2-9]+)$/.exec(hash);
  if (!m) return { kind: "home" };
  const [, kind, id] = m;
  if (kind === "p" && id!.startsWith("q_") && HANDLE.test(id!.slice(2))) return { kind: "project", id: id! };
  if (kind === "c" && id!.startsWith("k_") && HANDLE.test(id!.slice(2))) return { kind: "conversation", id: id! };
  return { kind: "home" };
}
export const ownerHash = (r: OwnerRoute): string => (r.kind === "home" ? "#" : r.kind === "project" ? `#p/${r.id}` : `#c/${r.id}`);
