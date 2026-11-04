// A Settings change card's live state in a chat (§app.project-overseer/settings,
// §chat.create-mode/settings-cards): who may act on it, where it is read from, and the read that
// keeps it current while it waits, an Apply on the project page or a held Save showing up this way.
import { createSignal, onCleanup } from "solid-js";
import type { SettingsCardView, SettingsToolDetails } from "../../shared/project-settings";

/** What a view allows. `overseer`: any card it draws (the overseer's own chat page). `create`: a card
    a Create chat prepared, kept after that chat leaves Create so no card is stranded. */
export interface SettingsCardScope {
  overseer: boolean;
  create: boolean;
}

export const cardCanAct = (scope: SettingsCardScope, details: Pick<SettingsToolDetails, "create">): boolean => scope.overseer || (scope.create && !!details.create);

type CardLists = { cards: SettingsCardView[]; recent: SettingsCardView[] };

/** The reads a card chooses between: a Sova-wide card has no project, so it has a list of its own. */
export interface CardReads {
  project(projectId: string): Promise<CardLists>;
  sova(): Promise<CardLists>;
}

export async function readCard(details: Pick<SettingsToolDetails, "projectId">, id: string, reads: CardReads): Promise<SettingsCardView | undefined> {
  const lists = details.projectId === null ? await reads.sova() : await reads.project(details.projectId);
  return [...lists.cards, ...lists.recent].find((c) => c.id === id);
}

/** A card applied while a branch is checking (§app.merge-queue/settings-save). */
export const QUEUE_CARD_WAITS = "Saves when the current branch finishes.";

/** What Apply's answer says happened, and never more: a held card hasn't applied yet, and a grant
    that wasn't recorded isn't approved (the card names each one and where to approve it). */
export function applyToast(answer: Pick<SettingsCardView, "state" | "stillNeeds" | "saveWords">, card: Pick<SettingsCardView, "id" | "grants">): string {
  if (answer.state === "waiting") return answer.saveWords ?? QUEUE_CARD_WAITS;
  const needs = answer.stillNeeds?.length ?? 0;
  const local = card.id === "local";
  const done = local ? "Landed the folder's settings edits." : card.grants.length && !needs ? `Applied and approved ${card.id}.` : `Applied ${card.id}.`;
  return needs ? `${done} ${needs === 1 ? "1 approval still needs" : `${needs} approvals still need`} you: the card says where.` : done;
}

/** What Apply sends of the card's field: undefined for a card with none, so nothing typed goes
    astray; "" while it is empty, which holds Apply back. */
export const typedInput = (card: Pick<SettingsCardView, "input">, typed: string): string | undefined => (card.input ? typed.trim() : undefined);

/** The held card's one button. On a project card whose save failed, cancelling is dismissing, and the
    failure may say to dismiss it; a queue card cancels a kept save, and the folder's edits stay. */
export const heldButton = (card: Pick<SettingsCardView, "id" | "kind" | "saveFailed">): "Dismiss" | "Cancel Save" =>
  card.saveFailed && card.kind !== "queue" && card.id !== "local" ? "Dismiss" : "Cancel Save";

/** The ways to cancel a held Save, which differ by card. */
export interface HeldSaveCancels {
  queue(projectId: string): Promise<unknown>;
  card(projectId: string, id: string): Promise<unknown>;
  /** Keeps the folder's edits: never the Discard call, which deletes them. */
  local(projectId: string): Promise<unknown>;
}

/** Cancel Save on a held card: a queue card's pending save, the folder's edits (they stay, and the
    card returns to Land), or a held project card, which ends Dismissed. */
export function cancelHeldSave(card: Pick<SettingsCardView, "id" | "kind">, projectId: string, cancels: HeldSaveCancels): Promise<unknown> {
  if (card.kind === "queue") return cancels.queue(projectId);
  return card.id === "local" ? cancels.local(projectId) : cancels.card(projectId, card.id);
}

/** A repeating timer, stopped by what it returns. */
export type CardTimer = (run: () => void, ms: number) => () => void;

/**
 * The card as last read, or null before a read. Reads once, then every `everyMs` while the card
 * waits; a card that has ended stops. Nothing is read where this view can't act: the transcript's
 * copy is all it draws. A failed read keeps what is shown. Call inside a reactive owner.
 */
export function createCardLive(opts: {
  details: Pick<SettingsToolDetails, "projectId" | "card">;
  canAct: () => boolean;
  reads: CardReads;
  everyMs: number;
  timer: CardTimer;
}) {
  const [live, setLive] = createSignal<SettingsCardView | null>(null);
  let stop: (() => void) | undefined;
  const halt = () => {
    stop?.();
    stop = undefined;
  };
  const load = async () => {
    const id = opts.details.card?.id;
    if (!id || !opts.canAct()) return;
    try {
      const found = await readCard(opts.details, id, opts.reads);
      if (found) setLive(found);
      if (found && found.state !== "waiting") halt();
    } catch {
      // Keep what the transcript carried.
    }
  };
  void load();
  if (opts.canAct() && opts.details.card?.state === "waiting") stop = opts.timer(() => void load(), opts.everyMs);
  onCleanup(halt);
  return { live, load };
}
