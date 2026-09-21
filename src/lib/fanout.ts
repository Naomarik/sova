// The fanout dialog's logic (spec/14b-fanout.md, copy in §9): the member plan, what each row's
// cost preview says, and how a partial creation reads.
//
// Pure, because every one of these is a claim the user acts on — how full a member starts, whether
// it fits at all, how many will be created, and which of them didn't. The server decides what
// happens; this decides what is said about it beforehand.

import type { BatchRefusal, ModelInfo } from "../../shared/protocol";
import { contextStep, formatPercent, formatTokens } from "./context";
import { shortModel } from "./format";

/** One row of the plan: a model and how many of it. Array order is pane order. */
export interface MemberRow {
  /** `ModelInfo.ref`, "provider/id". */
  ref: string;
  /** 1–9. Repeats are the point: three of one model shows that model's spread. */
  count: number;
}

/** The count a row can hold (§14b "The dialog"). */
export const COUNT_MIN = 1;
export const COUNT_MAX = 9;
/** Longest group name, mirroring GROUP_NAME_MAX; the dialog's field enforces it too. */
const NAME_MAX = 60;

/** How many members the plan makes. */
export const totalMembers = (rows: readonly MemberRow[]): number => rows.reduce((n, r) => n + r.count, 0);

/**
 * Picking a model already listed increments its row rather than adding a second one — the count
 * IS the repeat, and two rows of one model would be two ways to say the same plan.
 */
export function addModel(rows: readonly MemberRow[], ref: string): MemberRow[] {
  const at = rows.findIndex((r) => r.ref === ref);
  if (at < 0) return [...rows, { ref, count: 1 }];
  return rows.map((r, i) => (i === at ? { ...r, count: Math.min(COUNT_MAX, r.count + 1) } : r));
}

/** `−` at 1 removes the row; that is what its label says there, so that is what it does. */
export function stepCount(rows: readonly MemberRow[], ref: string, by: 1 | -1): MemberRow[] {
  const at = rows.findIndex((r) => r.ref === ref);
  if (at < 0) return [...rows];
  const next = rows[at]!.count + by;
  if (next < COUNT_MIN) return rows.filter((r) => r.ref !== ref);
  return rows.map((r, i) => (i === at ? { ...r, count: Math.min(COUNT_MAX, next) } : r));
}

export const removeModel = (rows: readonly MemberRow[], ref: string): MemberRow[] => rows.filter((r) => r.ref !== ref);

/**
 * `Fanout · {first 6 words}` of the source's title or the fresh prompt, trimmed to the name limit.
 * A default, not a constraint: the field is plain text and duplicates are allowed, like §2's rename.
 */
export function defaultGroupName(from: string): string {
  const words = from.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  const name = words ? `Fanout · ${words}` : "Fanout";
  return name.length > NAME_MAX ? name.slice(0, NAME_MAX).trimEnd() : name;
}

/** What one row's fill reads, and whether it blocks Create (§14b "Cost preview"). */
export interface RowFill {
  text: string;
  /** §4f's step classes, so the preview and the head's gauge agree on what 80% looks like. */
  step: "" | "context-warn" | "context-error";
  /** The fork doesn't fit this model's window: a session that would fail on its first turn. */
  overflows: boolean;
}

/**
 * A member's starting fill against ITS OWN model's window — the comparison the preview exists to
 * make, since the same 48k is 4% of one window and 24% of another.
 *
 * `window` absent means no catalog knows this model, which is the same to us as an older server
 * that never sends one: tokens alone, no percent, and never a block — we don't know that it
 * doesn't fit. `tokens` null is fresh mode, where there is no history to carry.
 */
export function rowFill(tokens: number | null, window: number | undefined): RowFill {
  if (tokens === null) return { text: "new session", step: "", overflows: false };
  if (!window) return { text: `${formatTokens(tokens)}, window unknown`, step: "", overflows: false };
  if (tokens >= window) return { text: `${formatTokens(tokens)} of ${formatTokens(window)}`, step: "context-error", overflows: true };
  return {
    text: `${formatTokens(tokens)} of ${formatTokens(window)} · ${formatPercent(tokens, window)}%`,
    step: contextStep(tokens, window),
    overflows: false,
  };
}

/**
 * The running cost of the group composer: one message typed, N contexts re-sent.
 *
 * §9 gives only the plural form. A fanout of one is legal (a row at count 1), and "1 members …
 * re-sent 1 times" is not a sentence, so the singular agrees in number and changes nothing else —
 * every other count in the deck has a singular variant, which is the pattern being followed here.
 */
export function sharedTurnLine(members: number, tokens: number | null): string {
  const one = members === 1;
  if (tokens === null) {
    return one
      ? "1 member, starting empty. Every shared turn is re-sent 1 time as it grows."
      : `${members} members, each starting empty. Every shared turn is re-sent ${members} times as they grow.`;
  }
  return `${members} ${one ? "member" : "members"} × ~${formatTokens(tokens)} tokens re-sent every shared turn.`;
}

/** The primary counts what it will do. */
export const createLabel = (members: number): string => (members === 1 ? "Create 1 Member" : `Create ${members} Members`);

/**
 * The partial-creation banner's lines (§9 "…its failure lines"). Entries sharing a ref AND a
 * message collapse to a count, because three identical refusals are one fact; sharing a ref but
 * not a message gets a line each, because the reasons are the information.
 *
 * Never a member number: `failed` carries no index into the plan, so which repeat of "opus ×3"
 * failed is not knowable, and "claude-opus-5 #2" would be a guess dressed as a fact.
 */
export function failureLines(failed: readonly BatchRefusal[]): string[] {
  const groups: { ref: string; message: string; count: number }[] = [];
  for (const f of failed) {
    const ref = f.ref ?? "";
    const found = groups.find((g) => g.ref === ref && g.message === f.message);
    if (found) found.count += 1;
    else groups.push({ ref, message: f.message, count: 1 });
  }
  return groups.map((g) => {
    const model = shortModel(g.ref) ?? "A member";
    const who = g.count > 1 ? `${g.count} × ${model}` : model;
    return `${who} couldn't start: ${g.message}`;
  });
}

/** "4 of 5 members were created." — the banner's claim, before its reasons. */
export function partialTitle(created: number, planned: number): string {
  return created === 1 ? `1 of ${planned} members was created.` : `${created} of ${planned} members were created.`;
}

/** The closing line: what exists now, and where to add another. */
export const partialClosing = (created: number): string =>
  created === 1
    ? "It is running; add another from Add Members."
    : `The ${created} that exist are running; add another from Add Members.`;

/** The model a row is about, for every label that names one. */
export const rowModel = (ref: string): string => shortModel(ref) ?? ref;

/** The catalog entry for a ref, when the list has one. */
export const modelOf = (models: readonly ModelInfo[] | undefined, ref: string): ModelInfo | undefined =>
  models?.find((m) => m.ref === ref);
