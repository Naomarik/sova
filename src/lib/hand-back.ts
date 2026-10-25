/**
 * Where a send the chat never took goes back to (§app.overseer/confirm, "Clicks compose a message").
 * A typed message goes back to the composer, to be sent again. A click on an Overseer card never
 * does: sent again from the composer it would be typed text, which approves nothing
 * (§app.overseer/org-people-facing). Its card's "Sent" mark clears instead, so the buttons come back,
 * and the pane says so. Every path that hands sends back (a refusal, a reload or close, a connection
 * that ended before its chat opened, a queued message that left undelivered) goes through `handBack`.
 * Pure: no DOM, no Solid.
 */

/** What the pane says when a click came back. */
export const CLICK_NOT_DELIVERED = "Your click didn't reach the Overseer. Click again.";

/** A send handed back: its client id when known, and its text. */
export interface Unsent {
  id?: string;
  text: string;
}

/** The card clicks this pane sent, by client id (each send's own id), until they are handed back. */
export class CardClicks {
  private readonly byId = new Map<string, { card: string; text: string }>();

  /** `clientId` is a click on card `card` (`c_N`) that sent `text`. */
  note(clientId: string, card: string, text: string): void {
    this.byId.set(clientId, { card, text });
  }

  cardOf(clientId: string | undefined): string | undefined {
    return clientId ? this.byId.get(clientId)?.card : undefined;
  }

  /** Stop drained the queue (`queue_cleared` names texts, not ids): the card of a click that sent
      `text`, taken (the oldest such click), else undefined. */
  takeByText(text: string): string | undefined {
    for (const [id, c] of this.byId)
      if (c.text === text) {
        this.byId.delete(id);
        return c.card;
      }
    return undefined;
  }

  forget(clientId: string | undefined): void {
    if (clientId) this.byId.delete(clientId);
  }
}

/** The part of a pane a hand-back changes: its draft and which cards show "Sent". */
export interface HandBackState {
  draft: string | undefined;
  cardSent: Readonly<Record<string, string>>;
}

export interface HandBackResult extends HandBackState {
  /** The typed texts that went to the top of the draft, oldest first. */
  texts: string[];
  /** The cards whose buttons came back. */
  cards: string[];
  /** CLICK_NOT_DELIVERED when a click came back, else null. */
  note: string | null;
}

/** Split sends handed back into typed texts (for the composer) and card clicks (their cards). */
export function splitHandBack(back: readonly Unsent[], clicks: CardClicks): { texts: Unsent[]; cards: string[] } {
  const texts: Unsent[] = [];
  const cards: string[] = [];
  for (const u of back) {
    const card = clicks.cardOf(u.id);
    if (card === undefined) {
      texts.push(u);
      continue;
    }
    clicks.forget(u.id);
    if (!cards.includes(card)) cards.push(card);
  }
  return { texts, cards };
}

/** The cards' "Sent" marks cleared: their buttons come back. */
export function reopenCards(cardSent: Readonly<Record<string, string>>, cards: readonly string[]): Record<string, string> {
  const out = { ...cardSent };
  for (const c of cards) delete out[c];
  return out;
}

/**
 * Sends handed back to a pane: typed texts go to the top of the draft (joined as the composer joins
 * them), clicks never do; their cards' "Sent" marks clear.
 */
export function handBack(state: HandBackState, back: readonly Unsent[], clicks: CardClicks): HandBackResult {
  const split = splitHandBack(back, clicks);
  const texts = split.texts.map((u) => u.text);
  const draft = texts.length ? [...texts, ...(state.draft ? [state.draft] : [])].join("\n\n") : state.draft;
  return {
    draft,
    cardSent: split.cards.length ? reopenCards(state.cardSent, split.cards) : { ...state.cardSent },
    texts,
    cards: split.cards,
    note: split.cards.length ? CLICK_NOT_DELIVERED : null,
  };
}
