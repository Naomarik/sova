import { createContext, createSignal, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { CardAnswerValue, CardInfo, SessionCardsAnswer } from "../../shared/transcript-cards";
import { answerSessionCard, ApiError, getSessionCards, setCardTrust } from "./api";
import { cardPicksOf, clearCardPicks, liveCardPicks, pickCard, type CardPick, type CardPicks } from "./card-picks";
import { toast } from "./ui-state";

/**
 * A chat's transcript cards (§chat/transcript-cards), read from the server: once at the start,
 * after each turn (the view calls refresh), after a press, and every 20 s while the session has a
 * card type or a card. The view that can act on the session provides CardContext; without it (a
 * watched or shared view) a card shows its data and answer and no controls.
 */

export interface CardTrustAsk {
  card: string;
  owner: string;
  name: string;
  value: CardAnswerValue;
}

export interface CardControls {
  /** The card's state now (the server's), else undefined. */
  card(id: string): CardInfo | undefined;
  /** Cards raised from outside the chat: the page places them (lib/transcript-placement placeOutsideCards). */
  outside(): CardInfo[];
  /** Every open card waiting on an answer. */
  open(): CardInfo[];
  /** Whether a card is the newest revision of its key (a follow card's earlier revisions fold to one line). */
  newest(card: CardInfo): boolean;
  canAct(): boolean;
  busy(id: string): boolean;
  /** An at-once press: recorded now; a button that acts may first ask to trust its project's cards. */
  answer(card: CardInfo, value: CardAnswerValue): void;
  /** The trust question a card is showing, if any. */
  trustAsk(): CardTrustAsk | null;
  /** Trust {name}'s Cards: the grant, then the press again. Not Now: nothing runs. */
  trust(on: boolean): void;
  /** A gathering card's staged pick, or with null cleared. */
  picked(id: string): CardPick | undefined;
  pick(card: CardInfo, pick: CardPick | null): void;
  /** The session's staged picks still open. */
  picks(): CardPicks;
  /** After a send carried the picks: each recorded as its card's answer, then cleared. */
  sent(picks: CardPicks): void;
  clearPicks(): void;
  refresh(): void;
}

export const CardContext = createContext<CardControls | undefined>(undefined);

const POLL_MS = 20_000;

export function createCardControls(path: () => string, canAct: () => boolean): CardControls {
  const [state, setState] = createStore<{ cards: CardInfo[] }>({ cards: [] });
  const [busy, setBusy] = createSignal<string | null>(null);
  const [ask, setAsk] = createSignal<CardTrustAsk | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  let gen = 0;
  const load = async () => {
    const mine = ++gen;
    const at = path();
    let a: SessionCardsAnswer;
    try {
      a = await getSessionCards(at);
    } catch {
      return; // no cards is the common case; a failed read leaves what was there
    }
    if (mine !== gen || at !== path()) return;
    setState("cards", reconcile(a.cards, { key: "id" }));
    const any = a.types.length > 0 || a.cards.length > 0;
    if (any && !timer) timer = setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
    if (!any && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  void load();
  onCleanup(() => timer && clearInterval(timer));
  const adopt = (card: CardInfo) => {
    const i = state.cards.findIndex((c) => c.id === card.id);
    if (i >= 0) setState("cards", i, reconcile(card));
    else setState("cards", state.cards.length, card);
  };
  const byId = (id: string) => state.cards.find((c) => c.id === id);
  const press = (card: CardInfo, value: CardAnswerValue) => {
    if (!canAct() || busy()) return;
    setBusy(card.id);
    answerSessionCard(path(), card.id, value)
      .then((r) => adopt(r.card))
      .catch((err) => {
        const trust = err instanceof ApiError ? (err.body as { needsTrust?: { owner?: unknown; name?: unknown } } | undefined)?.needsTrust : undefined;
        if (trust && typeof trust.owner === "string" && typeof trust.name === "string") setAsk({ card: card.id, owner: trust.owner, name: trust.name, value });
        else {
          toast(err instanceof Error ? err.message : String(err));
          void load();
        }
      })
      .finally(() => setBusy(null));
  };
  return {
    card: byId,
    outside: () => state.cards.filter((c) => !c.toolCallId),
    open: () => state.cards.filter((c) => c.state === "open" && c.answerMode !== "none"),
    newest: (card) => {
      if (card.placement !== "follow" || !card.key) return true;
      let top = card;
      for (const c of state.cards) if (c.type === card.type && c.key === card.key && (c.revision ?? 0) > (top.revision ?? 0)) top = c;
      return top.id === card.id;
    },
    canAct,
    busy: (id) => busy() === id,
    answer: press,
    trustAsk: ask,
    trust(on) {
      const a = ask();
      setAsk(null);
      if (!a || !on) return;
      setCardTrust(a.owner, true)
        .then(() => {
          const card = byId(a.card);
          if (card) press(card, a.value);
        })
        .catch((err) => toast(err instanceof Error ? err.message : String(err)));
    },
    picked: (id) => cardPicksOf(path())[id],
    pick: (card, p) => pickCard(path(), card.id, p),
    picks: () => liveCardPicks(cardPicksOf(path()), byId),
    sent(picks) {
      const at = path();
      clearCardPicks(at);
      for (const [id, p] of Object.entries(picks))
        void answerSessionCard(at, id, p.value, true)
          .then((r) => adopt(r.card))
          .catch((err) => toast(`${id}'s answer wasn't recorded: ${err instanceof Error ? err.message : String(err)}`));
    },
    clearPicks: () => clearCardPicks(path()),
    refresh: () => void load(),
  };
}
