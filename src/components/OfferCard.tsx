import { createContext, createSignal, For, Match, onCleanup, Show, Switch, useContext } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { OfferCard } from "../../shared/session-offers";
import { chooseOfferButton, getSessionOffers, setOfferNotNow } from "../lib/api";
import { toast } from "../lib/ui-state";
import { Icon } from "./ui";
import "../waiting.css";

/**
 * Offer cards (§chat.offers/card): a project's named button cards, drawn like the Overseer's decision
 * cards. A card stands at its `offer` call in the transcript; one another chat showed has no call, so
 * it stands at the thread's end (OfferTray). The view that can act on the session provides
 * OfferContext; without it (a watched or shared view) cards show their state and no controls.
 */

export interface OfferControls {
  /** The card's state now (the server's), else the one the transcript carried. */
  card(id: string): OfferCard | undefined;
  /** Cards no `offer` call in this transcript carries: shown by another chat. */
  tray(): OfferCard[];
  /** Every open card of the session, wherever it stands (the composer's waiting badge counts them). */
  open(): OfferCard[];
  busy(id: string): boolean;
  choose(card: OfferCard, index: number): void;
  notNow(card: OfferCard): void;
  /** Read again (after a turn ends). */
  refresh(): void;
}

export const OfferContext = createContext<OfferControls | undefined>(undefined);

/** How often a chat that can have offers reads its cards again (one another chat shows arrives this way). */
const OFFERS_POLL_MS = 20_000;

/**
 * The offer cards of the session at `path`, read from the server: once at the start, after each turn
 * (the view calls refresh), after a click, and every 20 s while the session's project has an offers
 * file. `inThread`: whether this transcript carries a card's `offer` call.
 */
export function createOfferControls(path: () => string, inThread: (card: OfferCard) => boolean, canAct: () => boolean): OfferControls {
  const [state, setState] = createStore<{ cards: OfferCard[] }>({ cards: [] });
  const [busy, setBusy] = createSignal<string | null>(null);
  const [shownHere, setShownHere] = createSignal<Set<string>>(new Set());
  let hasFile = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let gen = 0;
  const load = async () => {
    const mine = ++gen;
    const at = path();
    try {
      const a = await getSessionOffers(at);
      if (mine !== gen || at !== path()) return;
      setState("cards", reconcile(a.cards, { key: "id" }));
      // A card another chat shows stays in the tray while open, and with its choice until the page is opened again.
      setShownHere((prev) => new Set([...prev, ...a.cards.filter((c) => c.by === "another-chat" && c.state === "open").map((c) => c.id)]));
      hasFile = a.hasFile;
      if (hasFile && !timer) timer = setInterval(() => document.visibilityState === "visible" && void load(), OFFERS_POLL_MS);
      if (!hasFile && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    } catch {
      // Nothing to show: no offers is the common case, and a failed read leaves what was there.
    }
  };
  void load();
  onCleanup(() => timer && clearInterval(timer));
  const adopt = (card: OfferCard) => {
    const i = state.cards.findIndex((c) => c.id === card.id);
    if (i >= 0) setState("cards", i, reconcile(card));
    else setState("cards", state.cards.length, card);
  };
  return {
    card: (id) => state.cards.find((c) => c.id === id),
    tray: () => state.cards.filter((c) => !inThread(c) && (c.state === "open" || shownHere().has(c.id))),
    open: () => state.cards.filter((c) => c.state === "open"),
    busy: (id) => busy() === id,
    choose(card, index) {
      if (!canAct() || busy()) return;
      setBusy(card.id);
      chooseOfferButton(path(), card.id, index)
        .then((r) => adopt(r.card))
        .catch((err) => {
          toast(err instanceof Error ? err.message : String(err));
          void load();
        })
        .finally(() => setBusy(null));
    },
    notNow(card) {
      if (!canAct() || busy()) return;
      setBusy(card.id);
      setOfferNotNow(path(), card.name)
        .then(() => load())
        .catch((err) => toast(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(null));
    },
    refresh: () => void load(),
  };
}

/** One offer card. `card`: as the transcript carried it; the controls' copy, when they have one, is newer. */
export function OfferCardView(props: { card: OfferCard }) {
  const ctx = useContext(OfferContext);
  const card = () => ctx?.card(props.card.id) ?? props.card;
  const open = () => card().state === "open";
  return (
    <section class="card overseer-confirm overseer-card offer-card" data-offer-id={card().id} data-phase={card().state} aria-label={`Offer ${card().id}: ${card().title}`}>
      <div class="card-head overseer-card-head">
        <span class="text-mono overseer-card-id">{card().id}</span>
        <h3 class="card-title" title={card().title}>
          {card().title}
        </h3>
      </div>
      <Show when={card().from}>{(f) => <div class="card-body overseer-confirm-detail offer-card-from">From {f().title}</div>}</Show>
      <Show when={card().note}>{(n) => <div class="card-body overseer-confirm-detail">{n()}</div>}</Show>
      <div class="card-foot overseer-card-foot">
        <Show when={open()} fallback={<OfferOutcome card={card()} />}>
          <Show when={ctx} fallback={<span class="overseer-confirm-hint">Waiting for an answer: {card().buttons.map((b) => b.label).join(" · ")}.</span>}>
            <OfferActions card={props.card} />
          </Show>
        </Show>
      </div>
    </section>
  );
}

/**
 * An open card's buttons and Not Now, with a button's confirm step: the card's own controls, also
 * drawn by the composer's Waiting on you dialog (§chat.composer/waiting-dialog), so a press there
 * answers the same card the same way. Needs OfferContext.
 */
export function OfferActions(props: { card: OfferCard }) {
  const ctx = useContext(OfferContext);
  const card = () => ctx?.card(props.card.id) ?? props.card;
  const open = () => card().state === "open";
  const canAct = () => !!ctx && open() && !ctx.busy(card().id);
  // A button with a confirm asks first (§chat.offers/buttons): its question, then Cancel or the label again.
  const [asking, setAsking] = createSignal<number | null>(null);
  const asked = () => {
    const i = asking();
    return i === null ? undefined : card().buttons[i];
  };
  // Focus stays on the card through the confirm step: Cancel takes it when the question opens,
  // and the button that asked gets it back on Cancel (a press on a removed button drops it).
  let group: HTMLDivElement | undefined;
  const focusIn = (sel: string) => queueMicrotask(() => group?.querySelector<HTMLElement>(sel)?.focus());
  const press = (i: number) => {
    if (!canAct()) return;
    if (card().buttons[i]?.confirm && asking() !== i) {
      setAsking(i);
      return focusIn(".offer-card-cancel");
    }
    setAsking(null);
    ctx!.choose(card(), i);
  };
  const cancel = () => {
    const i = asking();
    setAsking(null);
    if (i !== null) focusIn(`[data-offer-button="${i}"]`);
  };
  return (
    <div class="offer-card-actions" ref={group}>
      <Show when={asked()}>
        {(b) => (
          <div class="offer-card-confirm" role="group" aria-label={`Confirm ${b().label}`}>
            <p class="overseer-confirm-detail">{b().confirm}</p>
            <div class="overseer-card-buttons">
              <button type="button" class="button button-sm button-ghost offer-card-cancel" onClick={cancel}>
                Cancel
              </button>
              <button type="button" class="button button-sm button-destructive" aria-disabled={canAct() ? undefined : "true"} onClick={() => press(asking()!)}>
                {b().label.replace(/…$/, "")}
              </button>
            </div>
          </div>
        )}
      </Show>
      <Show when={asking() === null}>
        <div class="overseer-card-buttons">
          <For each={card().buttons}>
            {(b, i) => (
              <button
                type="button"
                class="button button-sm"
                data-offer-button={i()}
                aria-disabled={canAct() ? undefined : "true"}
                title={b.about}
                onClick={() => press(i())}
              >
                {b.label}
              </button>
            )}
          </For>
          <button type="button" class="button button-sm button-ghost offer-card-not-now" aria-disabled={canAct() ? undefined : "true"} title="Hide this offer for the rest of this session." onClick={() => canAct() && ctx!.notNow(card())}>
            Not Now
          </button>
        </div>
      </Show>
    </div>
  );
}

function OfferOutcome(props: { card: OfferCard }) {
  const c = () => props.card;
  return (
    <p class="overseer-confirm-answer">
      <Switch>
        <Match when={c().state === "chosen" && c().choice}>
          {(choice) => (
            <>
              <Icon name="check" small />
              <span>
                You chose <strong>{choice().label}</strong>
                <Switch>
                  <Match when={c().outcome?.state === "running"}> · Running…</Match>
                  <Match when={c().outcome?.state === "done"}> · Done: {c().outcome?.text}</Match>
                  <Match when={c().outcome?.state === "failed"}> · Failed: {c().outcome?.text}</Match>
                </Switch>
              </span>
            </>
          )}
        </Match>
        <Match when={c().state === "not-now"}>
          <span>Not now</span>
        </Match>
        <Match when={c().state === "superseded"}>
          <span>Replaced by a newer commit</span>
        </Match>
        <Match when={c().state === "withdrawn"}>
          <span>No longer offered</span>
        </Match>
      </Switch>
    </p>
  );
}

/** The cards another chat showed in this session, at the thread's end (§chat.offers/from-another-chat). */
export function OfferTray() {
  const ctx = useContext(OfferContext);
  return (
    <Show when={ctx?.tray().length}>
      <div class="offer-tray">
        <For each={ctx!.tray()}>{(c) => <OfferCardView card={c} />}</For>
      </div>
    </Show>
  );
}
