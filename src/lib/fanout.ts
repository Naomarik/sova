// The fanout dialog's logic (spec/14b-fanout.md, copy in §9): the member plan, what each row's
// cost preview says, and how a partial creation reads.
//
// Pure, because every one of these is a claim the user acts on — how full a member starts, whether
// it fits at all, how many will be created, and which of them didn't. The server decides what
// happens; this decides what is said about it beforehand.

import type { BatchRefusal, FanoutRequest, ModelInfo } from "../../shared/protocol";
import { contextStep, formatPercent, formatTokens } from "./context";

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
 * Named by the FULL ref, under §14b's rule stated once: wherever two members could be
 * distinguished only by their provider, name the full ref. The collapse keys on the ref, so a
 * `zai/glm-5.3` failure and an `ollama-cloud/glm-5.3` failure correctly do NOT merge — which
 * means the short form would render them as two identical-looking lines that are not duplicates.
 * The duplicate-looking pair is the normal rendering here, not an edge case.
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
    const model = g.ref || "A member";
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

/**
 * The request body, with the two exclusivity rules the route enforces stated in one place:
 * EXACTLY ONE of `name` and `groupId` (sending both is a 400, because ignoring one would look
 * like a rename that did nothing), and exactly one of `source` and `cwd`. Built here rather than
 * inline so the rules are testable without a dialog.
 */
export function fanoutBody(plan: {
  rows: readonly MemberRow[];
  /** The group to land in; without it a new group named `name` is created. */
  into?: { id: string } | undefined;
  name: string;
  /**
   * Whether the user typed in the name field. Provenance is THIS EVENT, never a comparison
   * against the string we generated (spec/14b-fanout.md).
   *
   * Not because a comparison can't separate "typed over then restored our text" from "typed our
   * exact string by hand": those end with pi-web's own string on the group either way, so they
   * deserve the same answer, and both candidate rules give them one. The reason is the failure
   * mode. A comparison is correct only while regeneration stops at the first touch — weaken that
   * gate and `lastWritten` equals the field by construction, so it reports "generated" for a name
   * the user typed and the group is dissolved out from under them. It fails toward LOSS. The edit
   * event cannot fail that way; its cost is a group that stands empty until someone dissolves it
   * by hand. And in fresh mode the default changes on every keystroke of the prompt, so a
   * comparison must pick a moment to compare against and every choice is wrong in one mode. The
   * event has no moment to pick.
   */
  nameTouched?: boolean;
  /** Fork mode: the source and the leaf the dialog SHOWED the user. */
  source?: { path: string; leafId: string } | undefined;
  /** Fresh mode: where the members live and the message they all start from. */
  fresh?: { cwd: string; text: string } | undefined;
}): FanoutRequest {
  const name = plan.name.trim();
  // Only a group being CREATED has a name whose provenance matters; joining one leaves its name
  // alone, so the field would be a claim about a string this request doesn't set.
  const target = plan.into
    ? { groupId: plan.into.id }
    : { name, named: plan.nameTouched ? ("user" as const) : ("generated" as const) };
  const members = plan.rows.map((r) => ({ ref: r.ref, count: r.count }));
  return plan.source
    ? { ...target, members, source: plan.source }
    : { ...target, members, cwd: plan.fresh?.cwd ?? "", text: (plan.fresh?.text ?? "").trim() };
}

/**
 * The accessible names of a member row's own controls (§9, the "Member row" row). These carry
 * the FULL ref, never
 * the bare model id, because two providers ship the same name — `zai/glm-5.3` and
 * `ollama-cloud/glm-5.3` differ only by provider and bill to different subscriptions.
 *
 * The row's visible text is already the full ref, so a sighted user can tell two such rows apart.
 * The accessible name is the only signal a screen-reader user has, and `shortModel` would collapse
 * both rows to "One more glm-5.3" — two identical announcements for two different subscriptions.
 * Here rather than inline so the strings are pinned by a test: the defect they prevent is
 * invisible on screen, so nothing else would fail when it regresses.
 */
export const moreLabel = (ref: string): string => `One more ${ref}`;
export const fewerLabel = (ref: string, count: number): string => (count === COUNT_MIN ? `Remove ${ref}` : `One fewer ${ref}`);
export const removeLabel = (ref: string): string => `Remove ${ref}`;

/** The catalog entry for a ref, when the list has one. */
export const modelOf = (models: readonly ModelInfo[] | undefined, ref: string): ModelInfo | undefined =>
  models?.find((m) => m.ref === ref);
