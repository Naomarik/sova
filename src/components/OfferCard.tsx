import { createContext, createSignal, For, Match, onCleanup, Show, Switch, useContext } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { JSX } from "solid-js";
import type { OfferCard, OfferCardButton, OfferCardRow, OfferChoice } from "../../shared/session-offers";
import { chooseOfferAll, chooseOfferButton, getSessionOffers, setOfferNotNow } from "../lib/api";
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
  /** A button's click; on a rows card, `row` names the row (§chat.offers/card, Rows). */
  choose(card: OfferCard, index: number, row?: string): void;
  /** A rows card's all button, over the rows its confirm named. */
  chooseAll(card: OfferCard): void;
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
    choose(card, index, row) {
      if (!canAct() || busy()) return;
      setBusy(card.id);
      chooseOfferButton(path(), card.id, index, row)
        .then((r) => adopt(r.card))
        .catch((err) => {
          toast(err instanceof Error ? err.message : String(err));
          void load();
        })
        .finally(() => setBusy(null));
    },
    chooseAll(card) {
      if (!canAct() || busy() || !card.all) return;
      setBusy(card.id);
      chooseOfferAll(path(), card.id, card.all.rows)
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
      <Show when={card().rows}>
        <div class="card-body overseer-confirm-items">
          <OfferRows card={props.card} />
        </div>
      </Show>
      <div class="card-foot overseer-card-foot">
        <Show when={open()} fallback={<OfferOutcome card={card()} />}>
          <Show
            when={ctx}
            fallback={
              <Show when={!card().rows}>
                <span class="overseer-confirm-hint">Waiting for an answer: {card().buttons.map((b) => b.label).join(" · ")}.</span>
              </Show>
            }
          >
            <OfferActions card={props.card} />
          </Show>
        </Show>
      </div>
    </section>
  );
}

/** A button of a ButtonSet: an offer card's, or a buttons data card's (DataCards.tsx). */
export interface ButtonSetItem {
  label: string;
  about?: string;
  confirm?: string;
}

/**
 * A row of buttons with each button's confirm step (§chat.offers/buttons): its question, then Cancel or the label
 * again. Focus stays in the group through the confirm step: Cancel takes it when the question opens, and the button
 * that asked gets it back on Cancel. `extra` follows the buttons (Not Now).
 */
export function ButtonSet(props: { buttons: readonly ButtonSetItem[]; canAct: () => boolean; press: (i: number) => void; extra?: JSX.Element; label?: string }) {
  const [asking, setAsking] = createSignal<number | null>(null);
  const asked = () => {
    const i = asking();
    return i === null ? undefined : props.buttons[i];
  };
  let group: HTMLDivElement | undefined;
  const focusIn = (sel: string) => queueMicrotask(() => group?.querySelector<HTMLElement>(sel)?.focus());
  const press = (i: number) => {
    if (!props.canAct()) return;
    if (props.buttons[i]?.confirm && asking() !== i) {
      setAsking(i);
      return focusIn(".offer-card-cancel");
    }
    setAsking(null);
    props.press(i);
  };
  const cancel = () => {
    const i = asking();
    setAsking(null);
    if (i !== null) focusIn(`[data-offer-button="${i}"]`);
  };
  return (
    <div class="offer-card-actions" ref={group} aria-label={props.label}>
      <Show when={asked()}>
        {(b) => (
          <div class="offer-card-confirm" role="group" aria-label={`Confirm ${b().label}`}>
            <p class="overseer-confirm-detail">{b().confirm}</p>
            <div class="overseer-card-buttons">
              <button type="button" class="button button-sm button-ghost offer-card-cancel" onClick={cancel}>
                Cancel
              </button>
              <button type="button" class="button button-sm button-destructive" aria-disabled={props.canAct() ? undefined : "true"} onClick={() => press(asking()!)}>
                {b().label.replace(/…$/, "")}
              </button>
            </div>
          </div>
        )}
      </Show>
      <Show when={asking() === null}>
        <div class="overseer-card-buttons">
          <For each={props.buttons}>
            {(b, i) => (
              <button type="button" class="button button-sm" data-offer-button={i()} aria-disabled={props.canAct() ? undefined : "true"} title={b.about} onClick={() => press(i())}>
                {b.label}
              </button>
            )}
          </For>
          {props.extra}
        </div>
      </Show>
    </div>
  );
}

/**
 * An open card's buttons and Not Now, with a button's confirm step: the card's own controls, also
 * drawn by the composer's Waiting on you dialog (§chat.composer/waiting-dialog), so a press there
 * answers the same card the same way. A rows card's buttons are its rows'; here it has its all button
 * (where the file declares one) and Not Now. Needs OfferContext.
 */
export function OfferActions(props: { card: OfferCard }) {
  const ctx = useContext(OfferContext);
  const card = () => ctx?.card(props.card.id) ?? props.card;
  const open = () => card().state === "open";
  const canAct = () => !!ctx && open() && !ctx.busy(card().id);
  const notNow = (
    <button type="button" class="button button-sm button-ghost offer-card-not-now" aria-disabled={canAct() ? undefined : "true"} title="Hide this offer for the rest of this session." onClick={() => canAct() && ctx!.notNow(card())}>
      Not Now
    </button>
  );
  // The all button is one button with its own confirm, naming the rows it answers.
  const allButtons = (): OfferCardButton[] => {
    const a = card().all;
    return a ? [{ label: a.label, about: a.about, kind: "send", confirm: a.confirm }] : [];
  };
  return (
    <Show when={card().rows} fallback={<ButtonSet buttons={card().buttons} canAct={canAct} press={(i) => ctx!.choose(card(), i)} extra={notNow} />}>
      <ButtonSet buttons={allButtons()} canAct={canAct} press={() => ctx!.chooseAll(card())} extra={notNow} />
    </Show>
  );
}

/** "You chose {label}", and where, when the answer came from the other place (§chat.offers/landing-rows). */
function ChoiceWords(props: { choice: OfferChoice }) {
  return (
    <>
      You chose <strong>{props.choice.label}</strong>
      <Show when={props.choice.where}>{(w) => <> in {w()}</>}</Show>
    </>
  );
}

/**
 * A rows card's rows (§chat.offers/card, Rows): each its label (a landing row's branch and short commit), its owner
 * chat as its own link, the drafts it leaves, then its buttons while open, else its state. The row is never a link.
 */
export function OfferRows(props: { card: OfferCard }) {
  const ctx = useContext(OfferContext);
  const card = () => ctx?.card(props.card.id) ?? props.card;
  const canAct = () => !!ctx && card().state === "open" && !ctx.busy(card().id);
  return (
    <>
      <ul class="overseer-confirm-list offer-card-rows">
        <For each={card().rows ?? []}>
          {(row) => (
            <li class="overseer-confirm-item offer-card-row" data-offer-row={row.id} data-phase={row.state} data-progress={row.progress}>
              <div class="overseer-confirm-item-line">
                <span class="overseer-confirm-item-name">{row.branch ?? row.label}</span>
                <Show when={row.commit}>{(c) => <span class="overseer-confirm-idea-id">{c()}</span>}</Show>
                <Show when={row.owner}>
                  {(o) => (
                    <a class="overseer-confirm-item-meta offer-card-row-owner" href={`#/sid/${encodeURIComponent(o().id)}`} title={`Open ${o().title}`}>
                      {o().title}
                    </a>
                  )}
                </Show>
              </div>
              <Show when={row.drafts}>{(d) => <span class="overseer-confirm-item-meta">Spec drafts left: {d()}</span>}</Show>
              <Show when={row.state === "open" && card().state === "open"} fallback={<RowOutcome row={row} />}>
                <Show when={ctx} fallback={<span class="overseer-confirm-hint">Waiting for an answer: {row.buttons.map((b) => b.label).join(" · ")}.</span>}>
                  <ButtonSet buttons={row.buttons} canAct={canAct} press={(i) => ctx!.choose(card(), i, row.id)} label={`${row.branch ?? row.label}`} />
                </Show>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={card().more}>
        {(n) => (
          <span class="overseer-confirm-hint">
            {n()} more {n() === 1 ? "branch waits" : "branches wait"} for this card to be answered.
          </span>
        )}
      </Show>
    </>
  );
}

function RowOutcome(props: { row: OfferCardRow }) {
  const r = () => props.row;
  return (
    <p class="overseer-confirm-answer">
      <Switch>
        <Match when={r().state === "chosen" && r().progress === "landed"}>
          <Icon name="check" small />
          <span>Landed</span>
        </Match>
        <Match when={r().state === "chosen" && r().progress === "landing"}>
          <span>Landing</span>
        </Match>
        <Match when={r().state === "chosen" && r().choice}>
          {(choice) => (
            <>
              <Icon name="check" small />
              <span>
                <ChoiceWords choice={choice()} />
              </span>
            </>
          )}
        </Match>
        <Match when={r().state === "superseded"}>
          <span>Replaced by a newer commit</span>
        </Match>
        <Match when={r().state === "withdrawn"}>
          <span>No longer offered</span>
        </Match>
      </Switch>
    </p>
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
                <ChoiceWords choice={choice()} />
                <Switch>
                  <Match when={c().outcome?.state === "running"}> · Running…</Match>
                  <Match when={c().outcome?.state === "done"}> · Done: {c().outcome?.text}</Match>
                  <Match when={c().outcome?.state === "failed"}> · Failed: {c().outcome?.text}</Match>
                </Switch>
              </span>
            </>
          )}
        </Match>
        <Match when={c().state === "chosen" && c().rows}>
          <span>Every row is answered.</span>
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
