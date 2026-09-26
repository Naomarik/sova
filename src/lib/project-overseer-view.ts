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
