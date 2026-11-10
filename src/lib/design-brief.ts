/** Pure derivations behind the Design Brief on the Design card: no DOM, no Solid, so they are unit-tested. */
import type { DesignBrief, DesignBriefQuestion, DesignLink, DesignLinkUse, DesignRun, DesignSetup } from "../../shared/design";
import type { DesignAsset, DesignAssetCatalogue } from "../../shared/design-assets";
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
export function briefStatus(run: Pick<DesignRun, "brief" | "setup" | "imagesBusy">): { text: string; live: boolean } {
  const block = designBriefBlock(run);
  if (block?.code === "writing") return { text: run.brief ? "Writing the prompt" : "Writing the brief", live: true };
  if (block?.code === "look") return { text: "Reading the page's look", live: true };
  if (block?.code === "images") return { text: run.imagesBusy === "capturing" ? "Reading the page's images" : "Describing the images", live: true };
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
export function startLabel(run: Pick<DesignRun, "brief" | "setup" | "imagesBusy">, designs: number): string {
  return designBriefBlock(run)?.label ?? `Start ${designs} Design${designs === 1 ? "" : "s"}`;
}

/** The words a question was answered with, for the frozen brief. */
export function answerLine(q: DesignBriefQuestion): string {
  const a = q.answer;
  if (!a) return "Not answered";
  const picked = a.option !== undefined ? q.options?.[a.option]?.label : undefined;
  return `${[picked, a.text].filter(Boolean).join(": ") || q.recommendation.choice} · ${a.by === "you" ? "you" : "recommended"}`;
}

const sameOrigin = (a: string, b: string): boolean => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

/** A run's grid, the set the server keeps (keptImages) with the unticked ones still shown: what a link on
    Use Its Images captured, in the capture's order, then the images you added since the run began. */
export function assetsOfRun(catalogue: Pick<DesignAssetCatalogue, "assets" | "captures"> | null, run: Pick<DesignRun, "setup" | "createdAt">): DesignAsset[] {
  if (!catalogue) return [];
  const links = (run.setup.links ?? []).filter((l) => l.use === "images");
  const ranked = catalogue.captures.filter((c) => links.some((l) => sameOrigin(l.url, c.url))).flatMap((c) => c.names);
  const out: DesignAsset[] = [];
  const seen = new Set<string>();
  for (const name of ranked) {
    const a = catalogue.assets.find((x) => x.name === name && x.source !== "yours");
    if (a && !seen.has(name)) out.push(a), seen.add(name);
  }
  for (const a of catalogue.assets) if (a.source === "yours" && a.addedAt >= run.createdAt && !seen.has(a.name)) out.push(a), seen.add(a.name);
  return out;
}

/** Whether an image is used: a click not yet confirmed first, then the brief's word; an image not listed is used. */
export const imageUsed = (brief: Pick<DesignBrief, "imageUse"> | undefined, held: Readonly<Record<string, boolean>>, name: string): boolean => held[name] ?? brief?.imageUse?.[name]?.use !== false;

/** How many images are in use, with a click not yet confirmed counted as made. */
export function usedCount(assets: readonly DesignAsset[], held: Readonly<Record<string, boolean>>, brief: Pick<DesignBrief, "imageUse"> | undefined): number {
  return assets.filter((a) => imageUsed(brief, held, a.name)).length;
}

export const assetKindWord = (a: DesignAsset): string => a.chosenKind ?? a.description?.kind ?? (a.source === "yours" ? "Yours" : "Image");

/** The one line under an image: what's said about it, or where its description stands. */
export function assetStateLine(a: DesignAsset): string {
  if (a.note) return a.note;
  if (a.describeError) return a.describeError;
  if (a.describeAgain || !a.description) return "Being described";
  return a.description.description;
}

/** Under Setup's models on a later run: what picking another coordinator does, or "" when it's the same model. */
export function coordinatorChangeLine(setup: Pick<DesignSetup, "models">, current: string): string {
  const picked = setup.models.find((m) => m.coordinator);
  if (!picked || picked.ref === current) return "";
  return `This starts a new coordinator on ${picked.name}; it keeps the notes, not the conversation.`;
}
