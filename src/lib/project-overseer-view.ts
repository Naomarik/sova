// The project overseer panel (§app/project-overseer): pure rules the panel renders, so they run
// under tsx --test.

import type { IdeaRecord, OverseerAction } from "../../shared/protocol";
import {
  autonomyMeaning,
  capProblem,
  GAP_TAG,
  PER_DAY,
  PO_LIMIT_KINDS,
  type AllowanceUse,
  type Autonomy,
  type HeldItem,
  type ItemSendInput,
  type LastRunOutcome,
  type PoLimitKind,
  type ProjectOverseerCaps,
  type ProjectOverseerInfo,
  type StartedSession,
} from "../../shared/project-overseer";
import { settled } from "./ideas";

/** The ideas worth acting on: not done or dropped, gaps first, then the store's order. */
export function openIdeas(ideas: readonly IdeaRecord[]): IdeaRecord[] {
  const live = ideas.filter((i) => !settled(i.status));
  return [...live.filter(isGap), ...live.filter((i) => !isGap(i))];
}

export const isGap = (i: Pick<IdeaRecord, "tags">): boolean => i.tags.includes(GAP_TAG);

/** A gap's decision area, from its `area-<key>` tag. */
export const gapArea = (i: Pick<IdeaRecord, "tags">): string | null => i.tags.find((t) => t.startsWith("area-"))?.slice(5) || null;

export const STARTED_KIND: Record<StartedSession["kind"], string> = { gathering: "Gathering", offer: "Offer", coding: "Coding" };

/** A tool name as the activity list says it: `sova_start_gathering` → "start gathering". */
export const toolWords = (tool: string): string => tool.replace(/^sova_/, "").replace(/_/g, " ");

/** One act, as a line: what it did, and for a refusal, a failure or an act done only in part (a promotion with refusals), why. */
export function actionLine(a: Pick<OverseerAction, "tool" | "outcome" | "error">): string {
  const what = toolWords(a.tool);
  if (a.outcome === "ok") return what;
  const why = a.error?.trim().replace(/\.$/, "");
  return `${what}: ${a.outcome === "partial" ? "partly" : a.outcome === "refused" ? "refused" : "failed"}${why ? ` (${why})` : ""}`;
}

/**
 * What follows "Last looked on its own {time}" in the status line, up to its full stop: how the run
 * went (running now, finished, stopped and why, cut off by a restart, skipped and why) and, while
 * it runs or once it finished, what woke it. The reason arrives as a sentence of its own ("the
 * session was closed."), so its end punctuation goes: the line ends with exactly one period.
 */
export function lastRunTail(run: { reasons: readonly string[]; outcome: LastRunOutcome; detail?: string }): string {
  const bare = (s: string) => s.trim().replace(/[.\s]+$/, "");
  if (run.outcome === "skipped" || run.outcome === "stopped") {
    const why = run.detail ? bare(run.detail) : "";
    // An abort's own "Stopped." says nothing the word doesn't.
    return why && why.toLowerCase() !== run.outcome ? `, ${run.outcome}: ${why}` : `, ${run.outcome}`;
  }
  if (run.outcome === "cut-off") return ", cut off by a restart";
  // Each reason is a sentence ("The gathering session … reached its goal."); inside this one it
  // continues mid-sentence, so its capitalised first word goes lower case (never an acronym: "IT").
  const reasons = run.reasons.map(bare).filter(Boolean).map((r) => r.replace(/^[A-Z](?=[a-z\s])/, (c) => c.toLowerCase()));
  const after = reasons.length ? `, after ${reasons.join(", ")}` : "";
  return run.outcome === "started" ? `, running now${after}` : after;
}

/**
 * The reasons waiting for its next look, as the "Waiting to look at:" line says them: each is a
 * sentence of its own, so they are joined as sentences, each ending in exactly one stop (its own
 * `.`, `?` or `!`, or an added period), never listed with commas and a period on top.
 */
export function pendingLine(reasons: readonly string[]): string {
  return reasons
    .map((r) =>
      r
        .trim()
        .replace(/\.{2,}$/, ".")
        // A quoted title that ends a sentence itself: `in "Rules?".` → `in "Rules?"`.
        .replace(/([.?!]["”’)])\.$/, "$1"),
    )
    .filter(Boolean)
    .map((r) => (/[.?!]["”’)]?$/.test(r) ? r : `${r}.`))
    .join(" ");
}

/** The operator's ideas' namespace, beside the overseer's `§gap`. */
export const OPERATOR_IDEA_NS = "idea";
/** The server's limit on an idea's title (server/overseer-ideas.ts IDEA_TITLE_MAX). */
export const IDEA_TITLE_MAX = 120;

/**
 * An id for an idea the operator adds by title: `§idea/<words of the title>`, a number added when
 * the id is taken (`-2`, `-3`, …), so adding the same title twice files two ideas, never a clash.
 */
export function operatorIdeaId(title: string, taken: ReadonlySet<string>): string {
  const base = title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "") || "idea";
  const id = (n: number) => `§${OPERATOR_IDEA_NS}/${n === 1 ? base : `${base}-${n}`}`;
  let n = 1;
  while (taken.has(id(n))) n++;
  return id(n);
}

/** Tokens as a short figure: 950, 12.3k, 1.2M. */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_500) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * The Send to Person… request. `publicTitle` and `question` are what the outsider sees (the title,
 * and the first question on their page), so each is only ever what the operator typed: never the
 * item's own title or text (an overseer's internal note — "… is an out-of-area instruction" —
 * reached a share page that way). Null until both are typed, so the server never falls back to
 * the item for either. The item's words still reach the model, as the private goal.
 */
export function itemSendInput(ref: { ideaId?: string; todoId?: string }, form: { to: string[]; publicTitle: string; question: string }): ItemSendInput | null {
  const publicTitle = form.publicTitle.trim();
  const question = form.question.trim();
  if (!publicTitle || !question || form.to.length === 0) return null;
  return {
    ...(ref.ideaId ? { ideaId: ref.ideaId } : { todoId: ref.todoId }),
    to: form.to.length === 1 ? form.to[0]! : [...form.to],
    publicTitle,
    question,
  };
}

// ---- limits (§app.project-overseer/limits, §design.copy-deck/project-limits) ----

/** The limits the Limits section edits, in the order it shows them (the first problem is theirs). */
export const LIMIT_FIELDS: readonly (keyof ProjectOverseerCaps)[] = [
  "gatherPerTurn",
  "promotePerTurn",
  "createPerTurn",
  "promptsPerTurn",
  "gatherPerDay",
  "promotePerDay",
  "createPerDay",
  "promptsPerDay",
  "unattendedPerDay",
  "gatheringsOpen",
  "codingRunning",
];

/** Why the Limits form can't be saved, as the server would say it, or null. An empty field is NaN, never Unlimited (null). */
export function limitsProblem(d: { caps: Record<keyof ProjectOverseerCaps, number | null> }): string | null {
  for (const k of LIMIT_FIELDS) {
    const why = capProblem(k, d.caps[k]);
    if (why) return why;
  }
  return null;
}

/** A gap in minutes as the page says it: "10 min", "1 hour". */
export const gapWords = (min: number): string => (min % 60 === 0 ? `${min / 60} ${min === 60 ? "hour" : "hours"}` : `${min} min`);
/** The hold before an act reaches a person or the code (§app.project-overseer/holds): "No hold", "10 min", "1 hour". */
export const holdWords = (min: number): string => (min === 0 ? "No hold" : gapWords(min));
/** The hold field's hint: what the choice means for the operator. */
export const holdHint = (min: number): string =>
  min === 0
    ? "What it starts on its own that reaches a person or the code goes ahead at once."
    : `What it starts on its own that reaches a person or the code waits ${gapWords(min)} in Needs you, where you can cancel it.`;
/** The confirm list's rows (r8, q14): each act kind that, held, waits for the overseer's approval. */
export const CONFIRM_KIND_LABEL: Record<string, string> = {
  gather: "Starting a gathering",
  offer: "Offering a gathering",
  close: "Closing a gathering",
  promote: "Promoting decisions",
  build: "Starting a coding session",
  prompt: "Prompting a coding session",
  "owner-update": "Owner updates",
  send: "Messaging a person on WhatsApp",
  "roster-approve": "Approving a proposed person",
  "roster-decline": "Declining a proposed person",
  preview: "Publishing a preview link",
};
/** The kinds only an organization's tools take (gatherings, promotion, owner updates, WhatsApp, the
    roster): a standalone project's approval list leaves them out. */
const ORG_CONFIRM_KINDS: ReadonlySet<string> = new Set(["gather", "offer", "close", "promote", "owner-update", "send", "roster-approve", "roster-decline"]);
/** The approval list's kinds for a project: all of them while an organization places it, else its own. */
export const confirmKindsFor = <K extends string>(all: readonly K[], placed: boolean): K[] => all.filter((k) => placed || !ORG_CONFIRM_KINDS.has(k));
/** A kind's row label; one this table lacks reads as its id. */
export const confirmKindLabel = (kind: string): string => CONFIRM_KIND_LABEL[kind] ?? kind;
/** The list after ticking or unticking one kind, in the server's order. */
export function toggleConfirmKind<K extends string>(all: readonly K[], on: readonly K[], kind: K, checked: boolean): K[] {
  const set = new Set(on);
  if (checked) set.add(kind);
  else set.delete(kind);
  return all.filter((k) => set.has(k));
}
/** Said after a tick is saved. */
export const confirmKindDone = (kind: string, checked: boolean): string =>
  `${confirmKindLabel(kind)}: ${checked ? "waits for the overseer's approval once its hold ends." : "goes ahead when its hold ends."}`;
/** A delay in seconds: "30 s", "1 min". */
export const soonWords = (sec: number): string => (sec % 60 === 0 ? `${sec / 60} min` : `${sec} s`);

/** The Watch hint, from the project's pace; conflicts and promotion only while an organization places it. */
export function watchHint(gapMin: number, soonSec: number | null, placed = true): string {
  const head = placed ? "When a session finishes, a conflict appears, or you promote, it looks on its own" : "When a session finishes, it looks on its own";
  return soonSec === null ? `${head} at most every ${gapWords(gapMin)}.` : `${head}: within ${soonWords(soonSec)} for the important ones, otherwise at most every ${gapWords(gapMin)}.`;
}

/** Each kind as the readout names it. */
const USED_NOUN: Record<PoLimitKind, string> = { gather: "gathering sessions", promote: "decisions promoted", create: "coding sessions", prompt: "prompts to coding sessions" };

/** "Today on its own: 3 of 6 gathering sessions, 2 coding sessions (no limit)." — only what was used; null when nothing was. */
export function allowanceLine(prefix: string, use: AllowanceUse): string | null {
  const parts = PO_LIMIT_KINDS.filter((k) => use[k].used > 0).map((k) => (use[k].max === null ? `${use[k].used} ${USED_NOUN[k]} (no limit)` : `${use[k].used} of ${use[k].max} ${USED_NOUN[k]}`));
  return parts.length ? `${prefix}: ${parts.join(", ")}.` : null;
}

/** One line per held item the operator should know of (the message allowance's retries at once: not shown). */
export function waitingLines(held: readonly HeldItem[], s: { caps: ProjectOverseerCaps }): string[] {
  const out: string[] = [];
  for (const h of held) {
    const [ledger, kind] = h.key.split(":") as [string, PoLimitKind | undefined];
    if (h.key === "looks") out.push(`Waiting until midnight: today's ${s.caps.unattendedPerDay ?? "unlimited"} looks are used.`);
    else if (ledger === "day" && kind && kind in USED_NOUN) out.push(`Waiting until midnight: today's ${s.caps[PER_DAY[kind]] ?? "unlimited"} ${USED_NOUN[kind]} are used.`);
  }
  return out;
}

// ---- its chat head (§app.project-overseer/page, §design.copy-deck/project-overseer-head) ----

type LevelInfo = { settings: { autonomy: Autonomy }; effective: { autonomy: Autonomy; reason?: string }; paused?: string | null };

/** The level in force differs from the chosen one, or an attach paused it (shown even with L0 chosen). */
export const levelForced = (i: LevelInfo): boolean => !!i.paused || i.effective.autonomy !== i.settings.autonomy;

/** The head's one state chip: Working while its turn runs, else "L0 in force" while forced, else none. */
export function headState(i: LevelInfo, busy: boolean): { tone: "accent" | "warn"; text: string; title?: string } | null {
  if (busy) return { tone: "accent", text: "Working" };
  if (levelForced(i)) return { tone: "warn", text: `${i.effective.autonomy} in force`, title: i.effective.reason };
  return null;
}

/** The level button's name: the chosen level and its meaning, what is in force while forced, and what it does. */
export function levelName(i: LevelInfo, placed = true): string {
  const l = i.settings.autonomy;
  return `Level ${l}, ${autonomyMeaning(l, placed)}${levelForced(i) ? ` In force now: ${i.effective.autonomy}.` : ""} Change level.`;
}

/** Status line 1's run sentence, the project page's words: "Last looked on its own {when}{tail}." */
export function lastRunLine(run: ProjectOverseerInfo["lastRun"], when: string): string {
  return run ? `Last looked on its own ${when}${lastRunTail(run)}.` : "It hasn't looked on its own yet.";
}

/** How many reasons wait for its next look; never when (the loop's timing can't be promised here). */
export const waitingToLook = (n: number): string => (n <= 0 ? "" : `Waiting to look at ${n} ${n === 1 ? "thing" : "things"}.`);

/**
 * The strip under the head: at most 3 lines, each only with something to say. Forced to L0, the
 * reason leads (with the level to resume at when an attach paused it: a level change ends that, and
 * nothing the operator sets fixes an empty roster).
 */
export function statusLines(
  i: LevelInfo & Pick<ProjectOverseerInfo, "lastRun"> & { settings: { caps: ProjectOverseerCaps }; usage: Pick<ProjectOverseerInfo["usage"], "pending" | "held"> & { allowance: { today: AllowanceUse } } },
  when: string,
): { lines: string[]; resume: Autonomy | null; pendingTitle: string } {
  const run = [lastRunLine(i.lastRun, when), waitingToLook(i.usage.pending.length)].filter(Boolean).join(" ");
  const waits = waitingLines(i.usage.held, i.settings).join(" ");
  const rest = [run, allowanceLine("Today on its own", i.usage.allowance.today), waits].filter((l): l is string => !!l);
  const forced = levelForced(i) && i.effective.reason;
  return {
    lines: (forced ? [i.effective.reason!, ...rest] : rest).slice(0, 3),
    resume: forced && i.paused ? i.settings.autonomy : null,
    pendingTitle: pendingLine(i.usage.pending),
  };
}

/** A History row's title: an untitled conversation is said as what it is. */
export const historyTitle = (title: string): string => (title === "Untitled" ? "No messages" : title);

/** A started session's row note in the head's menu: "Gathering · open". */
export const startedWords = (s: Pick<StartedSession, "kind" | "state">): string => `${STARTED_KIND[s.kind]} · ${s.state}`;
