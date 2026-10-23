// A feature request chat's plan card on the owner page (§app.project-assistant/feature-chats): what its
// buttons send. Nothing here writes a plan: the picks only compose an ordinary message, in the alignment
// card's own words (src/lib/align-picks.ts), and the chat records it with its `align` tool. Pure.

import type { BatonPlan } from "../../shared/baton";
import { picksMessage, type Picks, type QPick } from "./align-picks";

/** One plan's picks: question id → the option index picked, or "rec" for the recommendation. */
export type PlanPicks = Readonly<Record<string, number | "rec">>;

/** The index of the option the recommendation names, if one does. */
const recommendedIndex = (q: BatonPlan["questions"][number]): number | undefined => {
  const i = q.options.findIndex((o) => o.label.trim().toLowerCase() === q.recommendation.choice.trim().toLowerCase());
  return i >= 0 ? i : undefined;
};

/** The questions still open on the card. */
export const openQuestions = (p: BatonPlan) => p.questions.filter((q) => q.decision === undefined);

/** Whether option `i` of `q` is the one recommended. */
export const isRecommended = (q: BatonPlan["questions"][number], i: number): boolean => recommendedIndex(q) === i;

/** "Send My Answers": the picks of open questions, in the card's order, as the alignment card words them. Empty: none. */
export function planAnswerMessage(p: BatonPlan, picks: PlanPicks): string {
  const ps: QPick[] = [];
  for (const q of openQuestions(p)) {
    const v = picks[q.id];
    if (v === undefined) continue;
    if (v === "rec" || recommendedIndex(q) === v) ps.push({ q: q.id });
    else if (q.options[v]) ps.push({ q: q.id, option: { index: v, label: q.options[v]!.label } });
  }
  if (!ps.length) return "";
  const all: Picks = { [p.doc]: ps };
  return picksMessage(all);
}

/** "Go With Recommendations": every open question takes the recommendation (the align tool's accept_all). */
export const planAcceptAllMessage = (p: BatonPlan): string => `${p.doc}: go with your recommendations for every open question.`;
