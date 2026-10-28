import { createSignal, Show, useContext } from "solid-js";
import { answerOf, raiserText, type CardAnswerValue, type CardInfo } from "../../shared/transcript-cards";
import { checkCardData, letterIndex, type ChecklistCard, type QuestionCard } from "../../shared/view-cards";
import { CardContext, type CardControls } from "../lib/card-controls";
import type { KindViewProps } from "../lib/transcript-kinds";
import { DataCard, type DataCardAnswer } from "./DataCards";
import { Icon } from "./ui";

/**
 * A transcript card a project declared (§chat/transcript-cards), drawn by the toolkit as one of
 * Sova's data cards: who raised it, its data, and its answer. In a chat Sova holds (CardContext,
 * which can act) its controls answer it at once or stage a pick for the next message
 * (§chat.transcript-cards/answering); anywhere else it shows its answer and no controls. An earlier
 * revision of a follow card is one line, its title and revision number, that opens in place
 * (§chat.transcript-cards/placement).
 */
export default function TranscriptCard(props: KindViewProps<CardInfo>) {
  const ctx = useContext(CardContext);
  const card = () => ctx?.card(props.value.id) ?? props.value;
  const newest = () => ctx?.newest(card()) ?? true;
  return (
    <div class="transcript-card" data-card-id={card().id}>
      <Show when={newest()} fallback={<Revision card={card()} />}>
        <CardBody card={card()} ctx={ctx} />
      </Show>
    </div>
  );
}

/** An earlier revision: one line that opens to show it, read-only. */
function Revision(props: { card: CardInfo }) {
  return (
    <details class="disclosure transcript-card-revision">
      <summary class="disclosure-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="disclosure-label">{titleOf(props.card)}</span>
        <span class="disclosure-preview">· revision {props.card.revision ?? 1}</span>
      </summary>
      <div class="disclosure-body">
        <DataCard draws={props.card.draws} data={props.card.data} id={props.card.id} />
      </div>
    </details>
  );
}

const titleOf = (c: CardInfo): string => {
  const t = (c.data as { title?: unknown } | null)?.title;
  return typeof t === "string" && t.trim() ? t : c.title;
};

function CardBody(props: { card: CardInfo; ctx: CardControls | undefined }) {
  const from = () => raiserText(props.card.by);
  const answering = () => answeringFor(props.card, props.ctx);
  const ask = () => {
    const a = props.ctx?.trustAsk();
    return a && a.card === props.card.id ? a : null;
  };
  return (
    <>
      <Show when={from()}>
        <p class="transcript-card-from text-muted">{from()}</p>
      </Show>
      <DataCard draws={props.card.draws} data={props.card.data} id={props.card.id} answer={answering()} />
      <Show when={props.card.answer}>{(a) => <AnswerLine card={props.card} answer={a()} />}</Show>
      <Show when={!props.card.answer && props.card.answerMode !== "none" && props.card.state === "open" && !props.ctx?.canAct()}>
        <p class="transcript-card-answer text-muted">Waiting for an answer</p>
      </Show>
      <Show when={ask()}>
        {(a) => (
          <div class="banner banner-warn transcript-card-trust" role="group" aria-label="Trust this project's cards">
            <Icon name="attention" class="banner-icon" />
            <div class="banner-main">
              <p class="banner-title">
                Let {a().name}'s cards act for you? They can then run any Sova command, such as sending messages or merging, without asking again.
              </p>
            </div>
            <div class="banner-action">
              <button type="button" class="button button-sm button-primary" onClick={() => props.ctx?.trust(true)}>
                Trust {a().name}'s Cards
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={() => props.ctx?.trust(false)}>
                Not Now
              </button>
            </div>
          </div>
        )}
      </Show>
    </>
  );
}

/** "You chose **b**: Parquet", with the time on hover, and any command's outcome. */
function AnswerLine(props: { card: CardInfo; answer: NonNullable<CardInfo["answer"]> }) {
  const who = () => (props.answer.by === "you" ? "You" : props.answer.by);
  const parts = () => {
    const t = props.answer.text;
    const i = props.card.draws === "question" ? t.indexOf(": ") : -1;
    return i > 0 ? { head: t.slice(0, i), rest: t.slice(i) } : { head: t, rest: "" };
  };
  const verb = () => (props.card.draws === "checklist" ? "answered" : "chose");
  return (
    <p class="transcript-card-answer" title={new Date(props.answer.at).toLocaleString()}>
      <Icon name="check" small />
      <span>
        {who()} {verb()} <strong>{parts().head}</strong>
        {parts().rest}
        <Show when={props.answer.outcome}>
          {(o) => <span class={o().state === "failed" ? "text-error" : "text-muted"}> · {o().text}</span>}
        </Show>
      </span>
    </p>
  );
}

/** What the card's controls answer through, by its answer mode; none where nothing can act. */
function answeringFor(card: CardInfo, ctx: CardControls | undefined): DataCardAnswer | undefined {
  if (!ctx || card.answerMode === "none") return undefined;
  const open = () => card.state === "open" && ctx.canAct();
  const gather = card.answerMode === "gather";
  const blocked = () => (card.answer ? "Answered" : card.state !== "open" ? "Closed" : !ctx.canAct() ? "This chat can't take an answer now." : ctx.busy(card.id) ? "Saving…" : null);
  const give = (value: CardAnswerValue) => {
    if (!open()) return;
    if (!gather) return ctx.answer(card, value);
    const a = answerOf(card, value);
    if (a.ok) ctx.pick(card, { value: a.value, text: a.text });
  };
  const pickedValue = (): CardAnswerValue | undefined => card.answer?.value ?? (gather ? ctx.picked(card.id)?.value : undefined);
  if (card.draws === "question") {
    const q = () => {
      const c = checkCardData("question", card.data);
      return c.ok ? (c.data as QuestionCard) : undefined;
    };
    const recIndex = () => {
      const d = q();
      return d?.recommendation ? letterIndex(d.recommendation.option, d.options.length) : undefined;
    };
    return {
      picker: {
        blocked,
        picked: () => {
          const v = pickedValue();
          return v && "option" in v ? v.option : undefined;
        },
        pick: (i) => (i === null ? gather && ctx.pick(card, null) : give({ option: i })),
        ticked: () => {
          const v = pickedValue();
          return !!v && "option" in v && v.option === recIndex();
        },
        tick: (on) => {
          const r = recIndex();
          if (r === undefined) return;
          if (on) give({ option: r });
          else if (gather) ctx.pick(card, null);
        },
      },
    };
  }
  if (card.draws === "buttons") {
    return { canAct: () => !blocked(), press: (i) => give({ button: i }) };
  }
  if (card.draws === "checklist") {
    return checklistAnswer(card, ctx, give, blocked);
  }
  return undefined;
}

/** A checklist's ticks: staged as a pick (gather), or held here until every item is ticked, then recorded (at once). */
function checklistAnswer(card: CardInfo, ctx: CardControls, give: (v: CardAnswerValue) => void, blocked: () => string | null): DataCardAnswer {
  const items = () => {
    const c = checkCardData("checklist", card.data);
    return c.ok ? (c.data as ChecklistCard).items : [];
  };
  const [ticks, setTicks] = createSignal<boolean[] | null>(null);
  const current = (): boolean[] => {
    const v = card.answer?.value ?? ctx.picked(card.id)?.value;
    return v && "items" in v ? v.items : (ticks() ?? items().map((i) => i.done));
  };
  return {
    tickBlocked: blocked,
    ticked: (index) => current()[index] ?? false,
    tick: (index, done) => {
      const next = current().map((d, i) => (i === index ? done : d));
      setTicks(next);
      if (card.answerMode === "gather" || next.every(Boolean)) give({ items: next });
    },
  };
}
