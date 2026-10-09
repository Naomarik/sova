// The History tab's words: every
// line here is made from what the server returned, never from a guess. A value the server didn't
// record reads as not recorded, never as the operator or anyone else. Pure: no DOM, no Solid.
import {
  isUnknown,
  OUTCOME_WORDS,
  type ActorRef,
  type ActorView,
  type Authorization,
  type ChainEdge,
  type EventSummary,
  type HistoryCoverage,
  type HistoryOutcome,
  type LinkView,
  type RelationType,
  type SourceAvailability,
  type QuoteCheck,
  type Relation,
  type Trigger,
  type Unknown,
} from "../../shared/org-history";
import { clockTime, shortDate, stampTime } from "./format";

export const NOT_RECORDED = "Not recorded";
export const REASON_NOT_RECORDED = "Reason not recorded";
export const TRIGGER_NOT_RECORDED = "Trigger not recorded";
export const OUTSIDE_FILTER = "Outside project filter";
export const EMPTY_SCOPE = "No recorded event in this scope";
export const SOURCE_UNAVAILABLE = "Decision recorded; source unavailable";
export const UNREADABLE = "This event can't be read by this version.";
/** Purge Reason…'s confirm: what goes (this history's stored reason and its search words), then what
    stays (the event and its sources), then what it can't reach (what Git already holds). */
export const PURGE_CONFIRM =
  "Removes this reason and its search words from the history. The event, its links and who did it stay, and the original messages, decisions and spec keep their own text. Earlier workspace commits, the remote and backups may still hold it.";
/** The tab's footer: where history is kept, and what a purge leaves behind. */
export const HISTORY_FOOTER =
  "History is kept in this organization's workspace repo on this device; only a push to its remote copies it elsewhere. A purge removes a stored reason here, not from earlier commits, the remote or backups.";

type Tone = "success" | "info" | "warn" | "error";

/** The outcome's word and chip tone: a status is a word with a marker, never hue alone. Refusals and
    failures are errors; a defer, a hold and an unknown result wait; a deliberate rejection is a fact. */
export function outcomeChip(outcome: HistoryOutcome | "unsupported"): { word: string; tone?: Tone } {
  if (outcome === "unsupported") return { word: "Unreadable", tone: "warn" };
  const tone: Partial<Record<HistoryOutcome, Tone>> = {
    done: "success",
    chosen: "success",
    released: "success",
    started: "info",
    recorded: "info",
    observed: "info",
    rejected: "info",
    "do-not-do": "info",
    held: "warn",
    deferred: "warn",
    unknown: "warn",
    refused: "error",
    failed: "error",
  };
  return { word: OUTCOME_WORDS[outcome], tone: tone[outcome] };
}

/** What an unknown recorded about itself: "Not recorded", with the why recorded for it when there is one. */
const unknownWord = (a: Unknown): string => {
  const why = a.why?.trim();
  return why && why !== "Not recorded." && why !== "Not recorded" ? `${NOT_RECORDED}: ${why[0]!.toLowerCase()}${why.slice(1)}` : NOT_RECORDED;
};

/** An actor's label, "Not recorded" (with its recorded why), or "Withheld" where this reader may not see who. */
export const actorWord = (a: ActorView | Unknown): string => (isUnknown(a) ? (a.why === "withheld" ? "Withheld" : unknownWord(a)) : a.label);

const WITHHELD: Unknown = { unknown: true, why: "withheld" };
/** The five facts as given, or each withheld on a boundary card that carries none. */
export const actorsOf = (e: Pick<EventSummary, "actors">): NonNullable<EventSummary["actors"]> =>
  e.actors ?? { initiatedBy: WITHHELD, decidedBy: WITHHELD, recordedBy: WITHHELD, executedBy: WITHHELD, authorization: WITHHELD };

const same = (a: ActorView, b: ActorView): boolean => !isUnknown(a) && !isUnknown(b) && a.kind === b.kind && a.id === b.id && a.label === b.label;

/** One actor in two records (a reason's author and the event's recorder, say): by kind and id, and by
    session where both name one. Labels are not compared: two labelers can name one actor two ways. */
const sameRef = (a: Pick<ActorRef, "kind" | "id" | "session">, b: Pick<ActorRef, "kind" | "id" | "session">): boolean =>
  a.kind === b.kind && (a.id ?? "") === (b.id ?? "") && (!a.session || !b.session || a.session === b.session);

/** Who words a statement: a model, an overseer, a person or the operator. Sova, the statechart and the system
    compose a template headline from names and titles, which words no one's decision. */
const WORDERS: ReadonlySet<string> = new Set(["model", "project-overseer", "global-overseer", "person", "operator"]);

/** Who worded the statement, when that isn't who decided it (a model wording a person's decision). The
    operator's own decision is worded by the operator, so it has none, whoever the record names as recorder;
    a template headline (a conflict opened, a branch merged) has none either. The one rule for every read. */
export function wordedBy(e: Pick<EventSummary, "actors">): string | null {
  const a = e.actors;
  if (!a || isUnknown(a.recordedBy) || !WORDERS.has(a.recordedBy.kind)) return null;
  if (!isUnknown(a.decidedBy) && (a.decidedBy.kind === "operator" || sameRef(a.decidedBy, a.recordedBy))) return null;
  return a.recordedBy.label;
}

/** The detail's What block: only when the recorded statement says more than the headline. */
export const whatAdds = (what: string | undefined, headline: string): boolean => !!what?.trim() && what.trim() !== headline.trim();

/** The recorded reason's caption: "{author} · Worded by {recorder} · recorded at the time" ("Added later"
    for a later one), "Worded by" only when the recorder isn't the author, the author isn't the operator, and
    the recorder words statements at all (never Sova storing someone's reason, the same rule as `wordedBy`).
    The author is named by the recorder's own label when they are one actor, so it is never named twice. */
export function reasonCaption(
  r: { author: Pick<ActorRef, "kind" | "id" | "session"> | Unknown; contemporaneous: boolean },
  recordedBy: ActorView,
  label: (a: Pick<ActorRef, "kind" | "id">) => string,
): string {
  const author = isUnknown(r.author) ? null : r.author;
  const recorder = isUnknown(recordedBy) ? null : recordedBy;
  const one = !!author && !!recorder && sameRef(author, recorder);
  const parts = [author ? (one ? recorder!.label : label(author)) : "Author not recorded"];
  if (recorder && !one && author?.kind !== "operator" && WORDERS.has(recorder.kind)) parts.push(`Worded by ${recorder.label}`);
  parts.push(r.contemporaneous ? "recorded at the time" : "Added later");
  return parts.join(" · ");
}

/** A decision's authority, shown apart only when it isn't who decided. */
export const authorityAdds = (authority: Pick<ActorRef, "kind" | "id"> | Unknown, decidedBy: ActorView): boolean =>
  isUnknown(authority) || isUnknown(decidedBy) || !sameRef(authority, decidedBy);

/** What the detail has none of, in one muted line, instead of two titled empty blocks. */
export function absentLine(evidence: number, consequences: number): string | null {
  if (!evidence && !consequences) return "No evidence cited · no recorded consequence.";
  if (!evidence) return "No evidence cited.";
  if (!consequences) return "No recorded consequence.";
  return null;
}

/** A row's who line: who decided, who started it when someone else, and an unattended act said as
    one: "Portal's overseer · started by Operator · unattended". */
export function whoLine(e: Pick<EventSummary, "actors" | "attended">): string {
  if (!e.actors) return "Who: withheld";
  const { decidedBy, initiatedBy } = e.actors;
  const parts = [isUnknown(decidedBy) ? "Decided by: not recorded" : decidedBy.label];
  if (!isUnknown(initiatedBy) && !same(initiatedBy, decidedBy)) parts.push(`started by ${initiatedBy.label}`);
  else if (isUnknown(initiatedBy)) parts.push("start not recorded");
  if (e.attended === false) parts.push("unattended");
  return parts.join(" · ");
}

/** The authorization in words, as evaluated for that act: who it was by is named by `label` (a roster
    name, say), never by a raw kind. */
export function authorizationWord(a: Authorization | Unknown, label: (r: Pick<ActorRef, "kind" | "id">) => string | undefined = () => undefined): string {
  if (isUnknown(a)) return a.why === "withheld" ? "Withheld" : unknownWord(a);
  const base: Record<Authorization["kind"], string> = {
    "operator-act": "The operator's own act",
    "attended-turn": "A turn the operator attended",
    "autonomy-level": a.level ? `Autonomy level ${a.level}` : "Its autonomy level",
    grant: "A grant",
    "confirm-card": "A confirm card",
    "hold-release": "A released hold",
    "person-decision": "A person's decision",
    safety: "A safety act",
    none: "None recorded as needed",
  };
  const parts = [base[a.kind]];
  // "A turn the operator attended" already says it.
  if (a.attended === true && a.kind !== "attended-turn") parts.push("attended");
  if (a.attended === false) parts.push("unattended");
  if (a.by) parts.push(`by ${a.by.kind === "operator" ? "the operator" : (label(a.by) ?? BY_UNNAMED[a.by.kind] ?? "someone not named here")}`);
  if (a.ref) parts.push(a.ref);
  return parts.join(" · ");
}

const BY_UNNAMED: Partial<Record<ActorRef["kind"], string>> = {
  person: "a person not named here",
  "project-overseer": "a project's overseer",
  "global-overseer": "the Overseer",
  model: "a model",
  sova: "Sova",
};

/** When it happened, in the row: the occurrence time when recorded, else the recorded time. */
export const rowTime = (e: Pick<EventSummary, "occurredAt" | "recordedAt">): number => e.occurredAt ?? e.recordedAt;
export const rowClock = (e: Pick<EventSummary, "occurredAt" | "recordedAt">): string => clockTime(rowTime(e));

/** The detail's time lines: when it was recorded, when it happened where that differs, and an import's
    source time beside its import time. */
export function timeLines(e: Pick<EventSummary, "occurredAt" | "recordedAt" | "origin">, now = Date.now()): string[] {
  if (e.origin === "imported")
    return [`Imported ${stampTime(e.recordedAt, now)}`, e.occurredAt !== undefined ? `Source time ${stampTime(e.occurredAt, now)}` : "Source time not recorded"];
  // "Recorded {t}", and "Happened {t}" when that differs (an event with no occurrence time of its own, a note say, has none)
  const lines = [`Recorded ${stampTime(e.recordedAt, now)}`];
  if (e.occurredAt !== undefined && Math.abs(e.occurredAt - e.recordedAt) >= 60_000) lines.push(`Happened ${stampTime(e.occurredAt, now)}`);
  return lines;
}

/** A timeline day's heading: "Today", "Yesterday", else "Apr 8" (a year added when not this year's). */
export function dayLabel(t: number, now = Date.now()): string {
  const d = new Date(t);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return shortDate(t, now);
}
export const dayKey = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** The rows in day groups, in the order given (newest first). */
export function byDay<T extends Pick<EventSummary, "occurredAt" | "recordedAt">>(rows: readonly T[]): { key: string; at: number; rows: T[] }[] {
  const groups: { key: string; at: number; rows: T[] }[] = [];
  for (const r of rows) {
    const at = rowTime(r);
    const key = dayKey(at);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(r);
    else groups.push({ key, at, rows: [r] });
  }
  return groups;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The filter bar's count: what shows of the server's total, and, under a project filter, the linked
    events outside it the server said it reached (never counted here). */
export const countLine = (shown: number, total: number, linkedOutside?: number): string =>
  `${shown.toLocaleString("en-US")} of ${plural(total, "event")}${linkedOutside ? ` · ${linkedOutside.toLocaleString("en-US")} linked outside this filter` : ""}`;

/** A decision's disposition says something its outcome word doesn't: a "Deferred" decision needs no
    "Deferral" beside it, but a recorded choice whose outcome reads otherwise keeps it. */
const SAME_AS_OUTCOME: Record<string, string> = { choose: "chosen", reject: "rejected", defer: "deferred", "do-not-do": "do-not-do" };
export const dispositionAdds = (disposition: string, outcome: string): boolean => SAME_AS_OUTCOME[disposition] !== outcome;

/** An option's review condition, prefixed "Until:" unless its own words already start so. */
export const conditionText = (c: string): string => (/^until\b/i.test(c.trim()) ? `${c.trim()[0]!.toUpperCase()}${c.trim().slice(1)}` : `Until: ${c.trim()}`);

/** What a quote's check against its cited message found, in concrete words. A match says the words
    are in that message and its sender is the person named; it is never a confirmation that the
    person approved what the recorder wrote around them. */
export const QUOTE_CHECK_WORDS: Record<QuoteCheck, string> = {
  checked: "Quote found in source; sender is the person named",
  "quote-not-found": "Quote not found in source",
  "speaker-mismatch": "Quote's sender is not the person named",
  "source-unavailable": "Source unavailable; quote not compared",
  unchecked: "Quote not compared with source",
};
/** A quote's check, with the recorder's reason when it wasn't compared (the sender wasn't recorded, say). */
export const quoteCheckWords = (check: QuoteCheck, why?: string): string =>
  check === "unchecked" && why ? `Not checked: ${why}` : (QUOTE_CHECK_WORDS[check] ?? QUOTE_CHECK_WORDS.unchecked);
export const QUOTE_CHECK_NOTE = "A found quote shows those words are in the message. It doesn't show the person approved the record.";

/** The coverage line under the title. */
export function coverageLine(c: HistoryCoverage | undefined, now = Date.now()): string {
  if (!c) return "";
  if (c.capturedSince === null) return c.importedSince !== null ? `Imported history only, from ${shortDate(c.importedSince, now)}` : "Nothing captured yet";
  const since = `Captured since ${shortDate(c.capturedSince, now)}`;
  return c.importedSince !== null || c.gaps.length ? `${since} · Earlier history partial` : since;
}

/** A capture gap, as the claim words it. */
export const gapSentence = (g: { from: number; to: number }, now = Date.now()): string =>
  `History wasn't saved from ${stampTime(g.from, now)} to ${stampTime(g.to, now)}. Stops and cancels made then aren't in it.`;

/** A citation's state: every state the shared type names has its words
    (exhaustive); a state this version has no words for still shows (`availabilityWord`). */
export const AVAILABILITY_WORDS: Record<SourceAvailability, string> & Record<string, string> = {
  available: "Available",
  "other-host": "Source not on this host",
  changed: "Source changed since it was recorded",
  withheld: "Source withheld",
  missing: "Source missing",
  corrupt: "Source can't be read",
  "unsupported-version": "Source is from a version this one can't read",
  unchecked: "Not checked",
};
export const availabilityWord = (a: SourceAvailability): string => AVAILABILITY_WORDS[a] ?? "Source state not readable here";
export const availabilityTone = (a: SourceAvailability): Tone | undefined => (a === "available" ? "success" : a === "unchecked" ? undefined : "warn");

/** A trigger's words: how this event came from the other. */
export const VIA_WORDS: Record<Trigger["via"], string> = {
  request: "requested",
  timer: "timer",
  "tool-call": "tool call",
  effect: "effect",
  spawn: "spawned",
  notification: "notification",
  "operator-act": "operator act",
  invocation: "invoked",
};

/** A relation's name, as stored (the refused-link line, say). */
export const RELATION_WORDS: Record<RelationType, string> = {
  supports: "supports",
  related: "related to",
  supersedes: "supersedes",
  amends: "amends",
  revokes: "revokes",
  corrects: "corrects",
  adopts: "adopts",
  "context-of": "context of",
  "source-for": "source for",
  "named-target": "names as its target",
  "depends-on": "depends on",
  "member-of": "member of",
  "recorded-in": "was recorded in",
  about: "is about",
};

/** "X {type} Y" with X the subject left out: the words after the holder, around their object. */
const RELATION_PHRASE: Record<RelationType, (o: string) => string> = {
  supports: (o) => `supports ${o}`,
  related: (o) => `is related to ${o}`,
  supersedes: (o) => `supersedes ${o}`,
  amends: (o) => `amends ${o}`,
  revokes: (o) => `revokes ${o}`,
  corrects: (o) => `corrects ${o}`,
  adopts: (o) => `adopts ${o}`,
  "context-of": (o) => `is context for ${o}`,
  "source-for": (o) => `is a source for ${o}`,
  "named-target": (o) => `names ${o} as its target`,
  "depends-on": (o) => `depends on ${o}`,
  "member-of": (o) => `is a member of ${o}`,
  "recorded-in": (o) => `was recorded in ${o}`,
  about: (o) => `is about ${o}`,
};
/** A relation this version has no words for (a newer server) still shows, by its own name. */
const phrase = (type: RelationType, o: string): string => (RELATION_PHRASE[type] ?? ((x: string) => `${type} ${x}`))(o);
/** The same words as a predicate under a card that is their subject: "related to this", "recorded in this". */
const predicate = (type: RelationType, o: string): string => phrase(type, o).replace(/^(is|was) /, "");
const cap = (w: string): string => `${w[0]!.toUpperCase()}${w.slice(1)}`;

/** One chain edge, said from a card at one of its ends: when the card holds the edge ("from") it is the
    subject, left out ("adopts this", "triggered this · effect"); when it is the target, the other end is
    the subject, named ("this triggered it · spawned", "“Conflict settled” names it as its target"). Only
    a trigger says "triggered"; a relation says its own words. */
export function edgeWords(e: Pick<ChainEdge, "via" | "type">, side: "from" | "to", other: string): string {
  if (e.via) return side === "from" ? `triggered ${other} · ${VIA_WORDS[e.via]}` : `${other} triggered it · ${VIA_WORDS[e.via]}`;
  if (!e.type) return side === "from" ? `linked to ${other}` : `${other} links to it`;
  return side === "from" ? predicate(e.type, other) : `${other} ${phrase(e.type, "it")}`;
}

/** A link in the detail, under the linked event: "{it} {words} this" for one into this event (Triggered
    By, or a relation onto it), "This {words} it" for one this event holds. */
export function linkWords(l: LinkView): string {
  const e = { via: l.via, type: l.type };
  return cap(l.direction === "in" ? edgeWords(e, "from", "this") : edgeWords(e, "to", "this"));
}

/** A relation whose target is an entity, not an event (a fact from before capture started): its
    words, the entity's type and id, and that it isn't in this history. No headline is made up. */
export function entityRelationLines(relations: readonly Relation[] | undefined): string[] {
  return (relations ?? []).flatMap((r) => ("entity" in r.target ? [`This ${phrase(r.type, `${r.target.entity.type} ${r.target.entity.id}`)} · not in this history`] : []));
}

/** A note or a correction added later starts, decides and authorizes nothing: it reads as its author's
    note ("Operator note", "Operator correction"), never as a decision with an authority. Null for every
    other kind. */
export function noteChip(e: Pick<EventSummary, "kind" | "actors">): string | null {
  const what = e.kind === "annotation.added" ? "note" : e.kind === "correction.recorded" ? "correction" : null;
  if (!what) return null;
  const by = e.actors?.recordedBy;
  const author = !by || isUnknown(by) ? "" : by.kind === "operator" ? "Operator" : by.label;
  return author ? `${author} ${what}` : `${what[0]!.toUpperCase()}${what.slice(1)}`;
}

/** The project label of a row: its own, then the others it affects. */
export function projectWords(e: Pick<EventSummary, "project" | "affected">): string {
  const names = [e.project, ...e.affected].filter((p): p is NonNullable<typeof p> => !!p).map((p) => (p.archived ? `${p.name} (archived)` : p.name));
  return names.length ? names.join(" + ") : "Organization";
}

/** The reason line's state words, for a row or the detail. */
export function reasonWords(e: Pick<EventSummary, "reason" | "reasonState">, purgedAt?: number, now = Date.now()): { text: string; muted: boolean } {
  switch (e.reasonState) {
    case "recorded":
      return { text: e.reason ?? REASON_NOT_RECORDED, muted: !e.reason };
    case "added-later":
      return { text: e.reason ? `Added later: ${e.reason}` : REASON_NOT_RECORDED, muted: !e.reason };
    case "purged":
      return { text: purgedAt ? `Reason purged ${shortDate(purgedAt, now)}` : "Reason purged", muted: true };
    case "withheld":
      return { text: "Reason withheld", muted: true };
    default:
      return { text: REASON_NOT_RECORDED, muted: true };
  }
}
