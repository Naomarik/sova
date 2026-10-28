import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import {
  cardDataErrorText,
  checkCardData,
  LIMITS,
  type ButtonsCard,
  type ChecklistCard,
  type DataCardKind,
  type QuestionCard,
  type StatusCard,
  type StatusTone,
  type DataCardMap,
  type TableCard,
  letterIndex,
} from "../../shared/view-cards";
import { Inline, QuestionChoices, type QuestionPicker } from "./AlignDocCard";
import { ButtonSet } from "./OfferCard";
import "../data-cards.css";

/**
 * Sova's five data cards (§chat.transcript-cards/data-cards), drawn in the page from checked data:
 * the author writes only data. The question card draws its options and recommendation with the
 * alignment card's own question layout and picking (AlignDocCard `QuestionChoices`), the buttons
 * card with the offer card's button row and confirm step (OfferCard `ButtonSet`), so each exists
 * once. Without its answering props a card is read-only: picks and presses need a chat Sova holds.
 */

let seq = 0;

/** What a card's controls answer through; absent, the card draws read-only. */
export interface DataCardAnswer {
  /** The question card's pick (an option by index, or the recommendation). */
  picker?: QuestionPicker | null;
  /** A checklist item ticked or unticked, by index. */
  tick?: (index: number, done: boolean) => void;
  /** Why ticking can't happen here, else null. */
  tickBlocked?: () => string | null;
  /** The buttons card: whether a press can count now, and the press itself. */
  canAct?: () => boolean;
  press?: (index: number) => void;
}

const TONE: Record<StatusTone, { cls: string; word: string }> = {
  ok: { cls: " chip-success", word: "OK" },
  warn: { cls: " chip-warn", word: "Warning" },
  error: { cls: " chip-error", word: "Error" },
  info: { cls: " chip-info", word: "Info" },
  muted: { cls: "", word: "Note" },
};

/** The question card: a title, the ask, an optional context line, lettered options and the recommendation, picked as on an alignment card. */
export function QuestionDataCard(props: { card: QuestionCard; id?: string; answer?: DataCardAnswer }) {
  const titleId = `data-card-${++seq}`;
  /** The recommendation as the alignment card states it: the named option's own label, so `recommendedOption` finds that option. */
  const recommendation = () => {
    const r = props.card.recommendation;
    const i = r ? letterIndex(r.option, props.card.options.length) : undefined;
    return r && i !== undefined ? { choice: props.card.options[i]!.label, why: r.why } : undefined;
  };
  return (
    <section class="card align-doc data-card data-card-question" aria-labelledby={titleId}>
      <ol class="align-questions" aria-label="Question">
        <li class="align-q" data-state="open">
          <p class="align-q-head">
            <Show when={props.id}>
              <span class="text-mono align-q-id">{props.id}</span>
            </Show>
            <strong class="align-q-topic" id={titleId}>
              {props.card.title}
            </strong>
          </p>
          <p class="align-q-ask">
            <Inline text={props.card.ask} />
          </p>
          <Show when={props.card.context}>
            <p class="align-q-context">
              <Inline text={props.card.context ?? ""} />
            </p>
          </Show>
          <QuestionChoices id={props.id ?? props.card.title} options={props.card.options} recommendation={recommendation()} picker={props.answer?.picker ?? null} />
        </li>
      </ol>
    </section>
  );
}

/** The checklist card: 1 to 50 lines, each ticked or not; ticking only where the card takes answers. */
export function ChecklistDataCard(props: { card: ChecklistCard; answer?: DataCardAnswer }) {
  const titleId = `data-card-${++seq}`;
  const done = () => props.card.items.filter((i) => i.done).length;
  return (
    <section class="card data-card data-card-checklist" aria-labelledby={titleId}>
      <div class="card-head">
        <h3 class="card-title" id={titleId}>
          {props.card.title}
        </h3>
        <span class="text-num text-muted data-card-count">
          {done()} of {props.card.items.length} done
        </span>
      </div>
      <ul class="card-body data-checklist">
        <For each={props.card.items}>
          {(item, i) => {
            const blocked = () => props.answer?.tickBlocked?.() ?? null;
            const tick = props.answer?.tick;
            return (
              <li>
                <label class="toggle" title={tick ? (blocked() ?? undefined) : undefined}>
                  <input
                    type="checkbox"
                    checked={item.done}
                    disabled={!tick || !!blocked()}
                    onChange={(e) => {
                      if (tick && !blocked()) tick(i(), e.currentTarget.checked);
                      e.currentTarget.checked = item.done;
                    }}
                  />
                  <span class="toggle-box" />
                  <span>
                    <Inline text={item.text} />
                  </span>
                </label>
              </li>
            );
          }}
        </For>
      </ul>
    </section>
  );
}

/** The status card: a title, a tone shown as the dot and its word, a line and an optional detail. */
export function StatusDataCard(props: { card: StatusCard }) {
  const titleId = `data-card-${++seq}`;
  const tone = () => TONE[props.card.tone];
  return (
    <section class="card data-card data-card-status" aria-labelledby={titleId}>
      <div class="card-head">
        <h3 class="card-title" id={titleId}>
          {props.card.title}
        </h3>
        <span class={`chip${tone().cls}`}>
          <i class="chip-dot" />
          {tone().word}
        </span>
      </div>
      <div class="card-body data-status-body">
        <p class="data-status-line">
          <Inline text={props.card.line} />
        </p>
        <Show when={props.card.detail}>
          <p class="data-status-detail">
            <Inline text={props.card.detail ?? ""} />
          </p>
        </Show>
      </div>
    </section>
  );
}

/** The table card: column heads and plain-text rows; past 10 rows the first 10 and Show All {n} Rows. */
export function TableDataCard(props: { card: TableCard }) {
  const titleId = `data-card-${++seq}`;
  const [all, setAll] = createSignal(false);
  const rows = () => (all() ? props.card.rows : props.card.rows.slice(0, LIMITS.rowsShown));
  const more = () => !all() && props.card.rows.length > LIMITS.rowsShown;
  return (
    <section class="card data-card data-card-table" aria-labelledby={props.card.title ? titleId : undefined} aria-label={props.card.title ? undefined : "Table"}>
      <Show when={props.card.title}>
        <div class="card-head">
          <h3 class="card-title" id={titleId}>
            {props.card.title}
          </h3>
        </div>
      </Show>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <For each={props.card.columns}>{(c) => <th scope="col">{c}</th>}</For>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>{(row) => <tr><For each={row}>{(cell) => <td><Inline text={cell} /></td>}</For></tr>}</For>
          </tbody>
        </table>
      </div>
      <Show when={more()}>
        <div class="card-foot">
          <button type="button" class="button button-sm button-ghost" onClick={() => setAll(true)}>
            Show All {props.card.rows.length} Rows
          </button>
        </div>
      </Show>
    </section>
  );
}

/** The buttons card: a title, an optional note and 1 to 4 buttons, each with its confirm step, as an offer card's. */
export function ButtonsDataCard(props: { card: ButtonsCard; answer?: DataCardAnswer }) {
  const titleId = `data-card-${++seq}`;
  return (
    <section class="card overseer-card data-card data-card-buttons" aria-labelledby={titleId}>
      <div class="card-head overseer-card-head">
        <h3 class="card-title" id={titleId}>
          {props.card.title}
        </h3>
      </div>
      <Show when={props.card.note}>
        <div class="card-body overseer-confirm-detail">
          <Inline text={props.card.note ?? ""} />
        </div>
      </Show>
      <div class="card-foot overseer-card-foot">
        <Show
          when={props.answer?.press}
          fallback={<span class="overseer-confirm-hint">Waiting for an answer: {props.card.buttons.map((b) => b.label).join(" · ")}.</span>}
        >
          {(press) => <ButtonSet buttons={props.card.buttons} canAct={() => props.answer?.canAct?.() ?? true} press={(i) => press()(i)} label={props.card.title} />}
        </Show>
      </div>
    </section>
  );
}

/**
 * A data card from its stored data: checked against its shape first, and data that doesn't fit
 * throws, naming the field, so the card's own error box draws (components/TranscriptKind.tsx)
 * and never half a card.
 */
export function DataCard(props: { draws: DataCardKind; data: unknown; id?: string; answer?: DataCardAnswer }) {
  const checked = createMemo(() => checkCardData(props.draws, props.data));
  const data = <K extends DataCardKind>(kind: K) => {
    const c = checked();
    if (!c.ok) throw new Error(cardDataErrorText(c.error));
    return props.draws === kind ? (c.data as DataCardMap[K]) : undefined;
  };
  return (
    <Switch>
      <Match when={data("question")}>{(card) => <QuestionDataCard card={card()} id={props.id} answer={props.answer} />}</Match>
      <Match when={data("checklist")}>{(card) => <ChecklistDataCard card={card()} answer={props.answer} />}</Match>
      <Match when={data("status")}>{(card) => <StatusDataCard card={card()} />}</Match>
      <Match when={data("table")}>{(card) => <TableDataCard card={card()} />}</Match>
      <Match when={data("buttons")}>{(card) => <ButtonsDataCard card={card()} answer={props.answer} />}</Match>
    </Switch>
  );
}
