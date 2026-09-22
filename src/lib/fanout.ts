// The fanout dialog's logic (spec/14b-fanout.md, copy in §9): the member plan, what each row's
// cost preview says, and how a partial creation reads.
//
// Pure, because every one of these is a claim the user acts on — how full a member starts, whether
// it fits at all, how many will be created, and which of them didn't. The server decides what
// happens; this decides what is said about it beforehand.

import type { BatchRefusal, FanoutRequest, ModelInfo, SessionSummary } from "../../shared/protocol";
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
 * What a member starts holding (§14b "Cost preview"), as one type so the three ways we cannot
 * name a number stay distinct from each other and from the two ways we can:
 *
 * - a **number** is the source branch's context at the fork point, against the member's own
 *   window;
 * - `"compacted"` is §4f's word for a fill that exists but can't be named until the source's
 *   next reply (a compaction row follows the last usage). It is NOT 0 — "0 of 1M · 0%" is a
 *   claim §4f refuses in the head for exactly this state, and the preview must not make it here;
 * - `"unknown"` is a source whose fill was never reported — the Add-Members entry, where the
 *   source isn't on screen and its tail is not the fork point's fill anyway;
 * - `null` is fresh mode: no history to carry, and the rows say "new session".
 *
 * None of the three unknowables blocks Create, for the same reason an unknown window doesn't:
 * we don't know that it doesn't fit.
 */
export type StartFill = number | "compacted" | "unknown" | null;

/**
 * A member's starting fill against ITS OWN model's window — the comparison the preview exists to
 * make, since the same 48k is 4% of one window and 24% of another.
 *
 * `window` absent means no catalog knows this model, which is the same to us as an older server
 * that never sends one: tokens alone, no percent, and never a block — we don't know that it
 * doesn't fit.
 */
export function rowFill(fill: StartFill, window: number | undefined): RowFill {
  if (fill === null) return { text: "new session", step: "", overflows: false };
  if (fill === "compacted") return { text: "compacted", step: "", overflows: false };
  if (fill === "unknown") return { text: "unknown", step: "", overflows: false };
  if (!window) return { text: `${formatTokens(fill)}, window unknown`, step: "", overflows: false };
  if (fill >= window) return { text: `${formatTokens(fill)} of ${formatTokens(window)}`, step: "context-error", overflows: true };
  return {
    text: `${formatTokens(fill)} of ${formatTokens(window)} · ${formatPercent(fill, window)}%`,
    step: contextStep(fill, window),
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
export function sharedTurnLine(members: number, fill: StartFill): string {
  const one = members === 1;
  if (fill === null) {
    return one
      ? "1 member, starting empty. Every shared turn is re-sent 1 time as it grows."
      : `${members} members, each starting empty. Every shared turn is re-sent ${members} times as they grow.`;
  }
  if (fill === "compacted") {
    return `${members} ${one ? "member" : "members"} × unknown tokens re-sent every shared turn — the fork point was compacted.`;
  }
  if (fill === "unknown") {
    return `${members} ${one ? "member" : "members"} × unknown tokens re-sent every shared turn.`;
  }
  return `${members} ${one ? "member" : "members"} × ~${formatTokens(fill)} tokens re-sent every shared turn.`;
}

/** The primary counts what it will do. */
export const createLabel = (members: number): string => (members === 1 ? "Create 1 Member" : `Create ${members} Members`);

/**
 * The partial-creation banner's lines (§9 "…its failure lines"). Entries sharing a ref AND a
 * message collapse to a count, because three identical refusals are one fact; sharing a ref but
 * not a message gets a line each, because the reasons are the information.
 *
 * TWO SHAPES of entry live in a 201's `failed`, told apart by `id` (the wire contract):
 * `id === ""` is a member that NEVER CAME INTO BEING — creation failed, `ref` is the only
 * handle, and the line says "couldn't start". An `id` SET is a member that EXISTS — created,
 * grouped, in `created` — but was REFUSED ITS FIRST MESSAGE by the batch path (fresh mode's
 * `text`): the line must not say "couldn't start", which would be false of a session the user
 * can see; it says the first message couldn't be sent. The collapse keys on the shape too, so
 * the same model failing both ways never merges two different facts into one count.
 *
 * Named by the FULL ref, under §14b's rule stated once: wherever two members could be
 * distinguished only by their provider, name the full ref. The collapse keys on the ref, so a
 * `zai/glm-5.3` failure and an `ollama-cloud/glm-5.3` failure correctly do NOT merge — which
 * means the short form would render them as two identical-looking lines that are not duplicates.
 * The duplicate-looking pair is the normal rendering here, not an edge case. A `groupId` fanout
 * that prompts pre-existing members reports those with `id` only (their model is not this
 * fanout's to claim), so they fall back to "A member" rather than a guessed ref.
 *
 * Never a member number: `failed` carries no index into the plan, so which repeat of "opus ×3"
 * failed is not knowable, and "claude-opus-5 #2" would be a guess dressed as a fact.
 */
export function failureLines(failed: readonly BatchRefusal[]): string[] {
  const groups: { ref: string; message: string; exists: boolean; count: number }[] = [];
  for (const f of failed) {
    const ref = f.ref ?? "";
    const exists = f.id !== "";
    const found = groups.find((g) => g.ref === ref && g.message === f.message && g.exists === exists);
    if (found) found.count += 1;
    else groups.push({ ref, message: f.message, exists, count: 1 });
  }
  return groups.map((g) => {
    const model = g.ref || "A member";
    const who = g.count > 1 ? `${g.count} × ${model}` : model;
    return g.exists ? `${who} couldn't take the first message: ${g.message}` : `${who} couldn't start: ${g.message}`;
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
   * exact string by hand": those end with Sova's own string on the group either way, so they
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
/**
 * At 1 the − button removes the row, so it says so — but NOT in the remove button's own words:
 * two controls in one row answering to the same name is a duplicate-accessible-name defect,
 * so − at 1 names the situation ("the only one") and × stays the plain "Remove {ref}".
 */
export const fewerLabel = (ref: string, count: number): string =>
  count === COUNT_MIN ? `Remove the only ${ref}` : `One fewer ${ref}`;
export const removeLabel = (ref: string): string => `Remove ${ref}`;

/** The catalog entry for a ref, when the list has one. */
export const modelOf = (models: readonly ModelInfo[] | undefined, ref: string): ModelInfo | undefined =>
  models?.find((m) => m.ref === ref);

/**
 * The row a dialog opens pre-seeded with (§14b "The dialog"): the source's own model when
 * forking — the comparison usually starts from where you are — else the first favorite, in the
 * picker's own order. Null when neither is known yet, which is the fresh dialog's case until
 * the model list lands.
 *
 * Pure because it is a claim about which fast path is offered, and the fast path is open →
 * Create: a pre-seed that pointed at a model that isn't listed would open on "window unknown"
 * instead, which is a worse first row than none.
 */
export function seedRef(models: readonly ModelInfo[] | undefined, fork: boolean, sourceModel: string | null): string | null {
  if (fork) return sourceModel;
  const favorites = (models ?? []).filter((m) => m.favorite).sort((a, b) => a.ref.localeCompare(b.ref));
  return favorites[0]?.ref ?? null;
}

/**
 * §14b "States"/§09: the dialog's own sentences for a source that can't be forked, written WITH
 * the recovery advice. The group composer's clause table (group-prompt.ts) deliberately drops
 * it — there it is advice about somebody else's gesture — but here the user asked to fork THIS
 * session, and the advice is the answer. Same words in `sourceBlocked` (before the press) and
 * `sourceRefusal` (after the server refuses), so a state never changes its sentence halfway.
 */
export const midTurnReason = (title: string): string =>
  `“${title}” is mid-turn. We read the file to fork it, and we don't read it while it's being written. This enables itself when the turn finishes.`;
export const oldFormatReason = (title: string): string =>
  `“${title}” is in an older session format. Forking reads the file, and reading it rewrites the whole thing — not something to do to a session that's open. Open it for chat here once to update it, then fan out.`;
export const unidentifiedWriterReason = (title: string): string =>
  `Another program wrote to “${title}” a moment ago. Forking waits until it stops.`;
export const staleLeafReason = (title: string): string =>
  `“${title}” answered while this dialog was open, so the fork point you picked isn't its latest message anymore. Reopen Fan out to fork from where it is now.`;
export const tuiLiveReason = (title: string): string =>
  `“${title}” is open in a terminal now. Sova doesn't touch a file a terminal owns; fan out once it closes.`;

/**
 * The source facts `sourceBlocked` reads — a structural slice of `SessionSummary`, so tests can
 * build one without the world. `legacyFormat` is the SERVER-computed old-format verdict (true =
 * the header's session-format version is behind the server's current; absent = current, an
 * unreadable head, or an older server — always "can't tell", never "current"), so the client
 * never compares versions and nothing drifts when the format bumps.
 */
type SourceFacts = Pick<SessionSummary, "title" | "busy" | "live" | "legacyFormat">;

/**
 * Why the SOURCE can't be forked right now, from the session list alone — the states the client
 * can see without reading the file (§14b "States"). Callers pass a summary ACCESSOR, so the
 * answer is reactive by construction: a turn finishing, a terminal closing or the list refetching
 * re-enables Create in place, which is the promise "It enables itself, in place, with no re-open".
 * A string snapshotted at open time cannot keep that promise — it would repeat the turn's end as
 * a block forever.
 *
 * The states the list cannot see — an unidentified recent writer, a leaf that moved while the
 * dialog was open — have no pre-state here. They stay server refusals, rendered with the same
 * sentences by `sourceRefusal` below.
 */
export function sourceBlocked(s: SourceFacts): string | null {
  // Permanent-until-migrated first: waiting doesn't clear it, and reading the file would rewrite
  // it (§14b "What creation does"). Then the terminal's claim on the file, then the turn's.
  if (s.legacyFormat) return oldFormatReason(s.title);
  if (s.live) return tuiLiveReason(s.title);
  if (s.busy) return midTurnReason(s.title);
  return null;
}

/**
 * A source refusal, in full: the §14b sentence for every code this build knows — recovery advice
 * included, unlike the group composer's clause — and the server's own reason for a code it knows
 * better than we do (`internal`, or a newer server's code), so an older client stays honest
 * instead of dropping the reason. Never parses the server's prose; the words stay Sova's.
 */
export function sourceRefusal(refusal: BatchRefusal, title: string): string {
  switch (refusal.code) {
    case "mid-turn":
      return midTurnReason(title);
    case "old-format":
      return oldFormatReason(title);
    case "busy":
      return unidentifiedWriterReason(title);
    case "stale-leaf":
      return staleLeafReason(title);
    case "tui-live":
      return tuiLiveReason(title);
    default: {
      const detail = refusal.message.trim();
      return detail ? `“${title}” couldn't be forked. ${detail}` : `“${title}” couldn't be forked.`;
    }
  }
}
