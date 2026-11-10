/** Pure derivations behind the Design Brief on the Design card: no DOM, no Solid, so they are unit-tested. */
import type { DesignBriefQuestion, DesignLink, DesignLinkUse, DesignRun, DesignSetup } from "../../shared/design";
import { designBriefBlock, designLinksIn } from "../../shared/design";
import { recommendedOption } from "./align";

/** An answer picked on the card and not yet sent: an option, or words where a question has no options. */
export interface StagedPick {
  option?: number;
  text?: string;
}

/** A question's recommendation as a pick: its option, or its words when it names none. */
export function recommendedPick(q: DesignBriefQuestion): StagedPick {
  const option = recommendedOption(q);
  return option === undefined ? { text: q.recommendation.choice } : { option };
}

/** Whether a pick is the question's recommendation, so the recommendation's tick reads as taken. */
export function pickIsRecommended(q: DesignBriefQuestion, pick: StagedPick | undefined): boolean {
  if (!pick) return false;
  const rec = recommendedPick(q);
  return rec.option !== undefined ? pick.option === rec.option : pick.text === rec.text;
}

/** What Send Answers carries: only questions still open, only picks that say something. */
export function stagedAnswers(staged: Readonly<Record<string, StagedPick>>, questions: readonly DesignBriefQuestion[]): { id: string; option?: number; text?: string }[] {
  const out: { id: string; option?: number; text?: string }[] = [];
  for (const q of questions) {
    const pick = staged[q.id];
    if (q.answer || !pick) continue;
    const text = pick.text?.trim();
    if (pick.option !== undefined) out.push({ id: q.id, option: pick.option });
    else if (text) out.push({ id: q.id, text });
  }
  return out;
}

/** The word on the run's chip while the brief is open, from the one reason Start waits. */
export function briefStatus(run: Pick<DesignRun, "brief" | "setup">): { text: string; live: boolean } {
  const block = designBriefBlock(run);
  if (block?.code === "writing") return { text: run.brief ? "Writing the prompt" : "Writing the brief", live: true };
  if (block?.code === "look") return { text: "Reading the page's look", live: true };
  if (block?.code === "stalled") return { text: "Coordinator stopped", live: false };
  return { text: "Waiting on you", live: false };
}

/** Setup's link rows: every address in what the person wrote, with the use already chosen for it. */
export function setupLinks(setup: Pick<DesignSetup, "brief" | "links">): DesignLink[] {
  return designLinksIn(setup.brief).map((url) => setup.links?.find((l) => l.url === url) ?? { url, use: null });
}

/** Setup with one link's use chosen by the person; the other rows stay as they are. */
export function withLinkUse(setup: DesignSetup, url: string, use: DesignLinkUse): DesignSetup {
  return { ...setup, links: setupLinks(setup).map((l) => (l.url === url ? { url, use, by: "user" as const } : l)) };
}

/** The Start button's words: why it waits, or what it will do. */
export function startLabel(run: Pick<DesignRun, "brief" | "setup">, designs: number): string {
  return designBriefBlock(run)?.label ?? `Start ${designs} Design${designs === 1 ? "" : "s"}`;
}

/** The words a question was answered with, for the frozen brief. */
export function answerLine(q: DesignBriefQuestion): string {
  const a = q.answer;
  if (!a) return "Not answered";
  const picked = a.option !== undefined ? q.options?.[a.option]?.label : undefined;
  return `${[picked, a.text].filter(Boolean).join(": ") || q.recommendation.choice} · ${a.by === "you" ? "you" : "recommended"}`;
}
