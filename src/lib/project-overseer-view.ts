// The project overseer panel (§app/project-overseer): pure rules the panel renders, so they run
// under tsx --test.

import type { IdeaRecord, OverseerAction } from "../../shared/protocol";
import { GAP_TAG, type ItemSendInput, type StartedSession } from "../../shared/project-overseer";
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

/** One act, as a line: what it did, and for a refusal or failure, why. */
export function actionLine(a: Pick<OverseerAction, "tool" | "outcome" | "error">): string {
  const what = toolWords(a.tool);
  if (a.outcome === "ok") return what;
  const why = a.error?.trim().replace(/\.$/, "");
  return `${what}: ${a.outcome === "refused" ? "refused" : "failed"}${why ? ` (${why})` : ""}`;
}

/**
 * What follows "Last looked on its own {time}" in the status line, up to its full stop: a skip and
 * its reason, or what woke it. The reason arrives as a sentence of its own ("the session was
 * closed."), so its end punctuation goes: the line ends with exactly one period.
 */
export function lastRunTail(run: { reasons: readonly string[]; outcome: "started" | "skipped"; detail?: string }): string {
  const bare = (s: string) => s.trim().replace(/[.\s]+$/, "");
  if (run.outcome === "skipped") {
    const why = run.detail ? bare(run.detail) : "";
    return why ? `, skipped: ${why}` : ", skipped";
  }
  // Each reason is a sentence ("The gathering session … reached its goal."); inside this one it
  // continues mid-sentence, so its capitalised first word goes lower case (never an acronym: "IT").
  const reasons = run.reasons.map(bare).filter(Boolean).map((r) => r.replace(/^[A-Z](?=[a-z\s])/, (c) => c.toLowerCase()));
  return reasons.length ? `, after ${reasons.join(", ")}` : "";
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
