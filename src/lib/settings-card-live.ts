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
