import { createContext, For, Show, useContext } from "solid-js";
import type { AlignDocInfo, AlignQuestionInfo, AlignRowInfo } from "../../shared/protocol";
import { ALIGN_STATUS_CHIP, alignStatusOf, cardSections, isOpenDoc, openCount, openLabel, optionLetter, QUESTION_CHIP, questionStateOf, recommendedOption, type AlignCardSection } from "../lib/align";
import { Chip, Icon } from "./ui";
import "../design/align-viewer.css";

let seq = 0;

/**
 * Answering from the card (§chat.alignment/card), in a chat Sova holds: only ChatView provides it,
 * so watch views and worker transcripts stay read-only. Ticks, option picks and the button only
 * compose an ordinary message; the agent records it with its `align` tool.
 */
export interface AlignAnswer {
  /** Whether the align minor mode is on in a chat this user can write to. */
  on(): boolean;
  /** The newest revision of an alignment on the branch: only its card takes answers. */
  current(doc: string): AlignDocInfo | undefined;
  /** Whether the recommendation is staged for `q`. */
  picked(doc: string, q: string): boolean;
  toggle(doc: string, q: string, on: boolean): void;
  /** The option staged for `q` by index (the recommended one when its recommendation is), else undefined. */
  pickedOption(doc: string, q: string): number | undefined;
  /** Stages option `index` as `q`'s answer, or with null clears `q`'s pick. */
  pick(doc: string, q: string, index: number | null): void;
  /** Why ticking or picking can't stage anything here, else null. */
  tickBlocked(): string | null;
  /** Why "Go With Recommendations" can't send now, else null. */
  goBlocked(): string | null;
  goWithRecommendations(doc: string): void;
}
export const AlignAnswerContext = createContext<AlignAnswer | null>(null);

/** A field's text with its inline code spans and bold runs, the two marks models put in these one-liners; no other markdown. */
function Inline(props: { text: string }) {
  const parts = () => props.text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).filter((p) => p !== "");
  return (
    <For each={parts()}>
      {(p) => (p.startsWith("`") && p.endsWith("`") && p.length > 2 ? <code>{p.slice(1, -1)}</code> : p.startsWith("**") && p.endsWith("**") && p.length > 4 ? <strong>{p.slice(2, -2)}</strong> : p)}
    </For>
  );
}

/**
 * An `align` call's row (§chat.alignment/card): the full card for the newest revision of its
 * document on the branch, one line for an earlier revision (open it to read that revision), and
 * one info row for an exemption. Nothing here writes: in a chat Sova holds with align on, the
 * newest card of an open alignment lets the user tick recommendations and go with all of them,
 * which only composes a message (AlignAnswerContext).
 */
export function AlignRow(props: { row: AlignRowInfo; newest: boolean }) {
  return (
    <Show
      when={props.row.doc}
      fallback={
        <div class="info-row" role="note">
          <span class="info-row-text">No alignment needed: {props.row.exempt?.why}</span>
        </div>
      }
    >
      {(doc) => (
        <Show when={props.newest} fallback={<AlignRevision doc={doc()} line={props.row.line} />}>
          <AlignDocCard doc={doc()} line={props.row.line} />
        </Show>
      )}
    </Show>
  );
}

/** An earlier revision: one line built from the call's changes; opening it shows that revision. */
function AlignRevision(props: { doc: AlignDocInfo; line: string }) {
  return (
    <details class="disclosure align-rev">
      <summary class="disclosure-summary align-rev-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="text-mono align-rev-id">{props.doc.id}</span>
        <span class="text-mono text-num">v{props.doc.rev}</span>
        <span class="align-rev-text">
          {props.doc.title}
          <Show when={props.line}> · {props.line}</Show>
        </span>
      </summary>
      <div class="disclosure-body">
        <AlignDocBody doc={props.doc} />
      </div>
    </details>
  );
}

export function AlignDocCard(props: { doc: AlignDocInfo; line?: string }) {
  const titleId = `align-doc-${++seq}`;
  const hintId = `${titleId}-hint`;
  const ctx = useContext(AlignAnswerContext);
  /** Answerable: this card is its alignment's newest revision, open, with a question open. */
  const answer = () => (ctx?.on() && ctx.current(props.doc.id)?.rev === props.doc.rev && isOpenDoc(props.doc) && openCount(props.doc) > 0 ? ctx : null);
  const goBlocked = () => answer()?.goBlocked() ?? null;
  // "Aligning" is every open document's default: only a later status earns a chip.
  const status = () => {
    const s = alignStatusOf(props.doc);
    return s === "aligning" ? undefined : ALIGN_STATUS_CHIP[s];
  };
  return (
    <article class="card align-doc" aria-labelledby={titleId}>
      <header class="align-doc-head">
        <p class="align-doc-eyebrow">
          <span class="text-mono">{props.doc.id}</span> · Alignment · <span class="text-num">v{props.doc.rev}</span>
        </p>
        <div class="align-doc-titlerow">
          <h3 class="align-doc-title" id={titleId}>
            {props.doc.title}
          </h3>
          <Show when={status()}>{(st) => <Chip tone={st().tone}>{st().label}</Chip>}</Show>
        </div>
        <p class="align-doc-meta">
          <span class="text-num">{openLabel(props.doc)}</span>
          <Show when={props.line}>
            <span class="align-doc-change"> · {props.line}</span>
          </Show>
        </p>
      </header>
      <AlignDocBody doc={props.doc} answer={answer()} />
      <Show when={answer()}>
        {(a) => (
          <div class="card-foot align-doc-foot">
            <button
              type="button"
              class="button button-sm"
              aria-disabled={goBlocked() ? "true" : undefined}
              aria-describedby={hintId}
              title={goBlocked() ?? undefined}
              onClick={() => !goBlocked() && a().goWithRecommendations(props.doc.id)}
            >
              Go With Recommendations
            </button>
            <span class="align-doc-foot-hint" id={hintId}>
              {goBlocked() ?? "Or pick some answers and type the rest below."}
            </span>
          </div>
        )}
      </Show>
    </article>
  );
}

function AlignDocBody(props: { doc: AlignDocInfo; answer?: AlignAnswer | null }) {
  const sections = () => cardSections(props.doc);
  return (
    <>
      <p class="align-doc-summary"><Inline text={props.doc.summary} /></p>
      <Show when={props.doc.phase === "dropped" && props.doc.droppedWhy}>
        <p class="align-doc-dropped">Dropped: <Inline text={props.doc.droppedWhy ?? ""} /></p>
      </Show>
      {/* The reading order is `cardSections`' own: the approach open between the summary and the
          questions, then the folded sections below the questions. */}
      <For each={sections().filter((s) => s.kind === "approach")}>{(s) => <AlignApproach section={s} />}</For>
      <Show when={props.doc.questions.length > 0}>
        <ol class="align-questions" aria-label="Questions">
          <For each={props.doc.questions}>{(q) => <AlignQuestion q={q} doc={props.doc.id} answer={props.answer} />}</For>
        </ol>
      </Show>
      <For each={sections().filter((s) => s.kind !== "approach")}>{(s) => <AlignSection section={s} />}</For>
    </>
  );
}

/** A field's text as plain words, for a truncated line's hover title. */
const plain = (text: string) => text.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/`([^`\n]+)`/g, "$1");

function AlignQuestion(props: { q: AlignQuestionInfo; doc: string; answer?: AlignAnswer | null }) {
  const radioName = `align-q-${++seq}`;
  const state = () => questionStateOf(props.q);
  const chip = () => QUESTION_CHIP[state()];
  const rec = () => recommendedOption(props.q);
  const take = () => (state() === "open" ? props.answer : null);
  const recLine = () => (
    <>
      <span class="align-q-line">
        <span class="align-q-kicker">Recommended</span>
        <Show when={rec() !== undefined} fallback={<strong><Inline text={props.q.recommendation.choice} /></strong>}>
          <span class="text-mono align-q-letter">{optionLetter(rec()!)}</span> — <strong><Inline text={props.q.options![rec()!]!.label} /></strong>
        </Show>
      </span>
      <span class="align-q-desc"><Inline text={props.q.recommendation.why} /></span>
    </>
  );
  const by = (d: NonNullable<AlignQuestionInfo["decision"]>) => (d.by === "user" ? "you" : "accepted recommendation");
  // The outcome: under an opened fold in full, and in its folded summary as one truncated line.
  const outcome = () => {
    const d = props.q.decision;
    if (d) return { label: "Decided:", text: d.text, by: by(d) };
    const x = props.q.dropped;
    return x ? { label: "Dropped:", text: x.why, by: undefined } : undefined;
  };
  const outcomeLine = () => (
    <Show when={outcome()}>
      {(o) => (
        <>
          <span class="align-q-label">{o().label}</span> <Inline text={o().text} />
          <Show when={o().by}>
            <span class="align-q-by"> · {o().by}</span>
          </Show>
        </>
      )}
    </Show>
  );
  const head = (fold: boolean) => (
    <>
      <Show when={fold}>
        <Icon name="chevron-right" small class="icon-twist" />
      </Show>
      <span class="text-mono align-q-id">{props.q.id}</span>
      <strong class="align-q-topic" title={fold ? props.q.topic : undefined}>
        {props.q.topic}
      </strong>
      <Show when={!fold}>
        <Chip tone={chip().tone}>{chip().label}</Chip>
      </Show>
      <Show when={fold && outcome()}>
        {(o) => (
          <span class="align-q-outcome" title={`${o().label} ${plain(o().text)}${o().by ? ` · ${o().by}` : ""}`}>
            {outcomeLine()}
          </span>
        )}
      </Show>
      {/* A folded row's chip closes the line, at its right end. */}
      <Show when={fold}>
        <span class="align-q-end">
          <Chip tone={chip().tone}>{chip().label}</Chip>
        </span>
      </Show>
    </>
  );
  const body = () => (
    <>
      <p class="align-q-ask"><Inline text={props.q.ask} /></p>
      <Show when={props.q.context}>
        <p class="align-q-context"><Inline text={props.q.context ?? ""} /></p>
      </Show>
      <Show when={props.q.options?.length}>
        <ol class="align-q-options" aria-label="Options">
          <For each={props.q.options}>
            {(o, i) => {
              const text = () => (
                <span>
                  <strong class="align-q-line"><Inline text={o.label} /></strong>
                  <span class="align-q-desc"><Inline text={o.tradeoff} /></span>
                </span>
              );
              return (
                <li>
                  {/* On an answerable card an open question's option is a radio's label: the whole
                      row is the target, picked it takes the selection tint and accent edge, and a click on the picked one
                      clears it. */}
                  <Show
                    when={take()}
                    fallback={
                      <>
                        <span class="text-mono align-q-letter">{optionLetter(i())}</span>
                        {text()}
                      </>
                    }
                  >
                    {(a) => {
                      const on = () => a().pickedOption(props.doc, props.q.id) === i();
                      return (
                        <label class="align-q-pick" title={a().tickBlocked() ?? undefined}>
                          <input
                            type="radio"
                            class="visually-hidden"
                            name={radioName}
                            checked={on()}
                            disabled={!!a().tickBlocked()}
                            aria-label={`Answer ${props.q.id} with ${optionLetter(i())}: ${plain(o.label)}`}
                            onClick={(e) => {
                              a().pick(props.doc, props.q.id, on() ? null : i());
                              e.currentTarget.checked = on();
                            }}
                          />
                          <span class="text-mono align-q-letter" aria-hidden="true">{optionLetter(i())}</span>
                          {text()}
                        </label>
                      );
                    }}
                  </Show>
                </li>
              );
            }}
          </For>
        </ol>
      </Show>
      {/* An open question on an answerable card: the recommendation is the checkbox's label, so
          the whole line is the target and what it takes is what it says. */}
      <Show when={take()} fallback={<p class="align-q-rec">{recLine()}</p>}>
        {(a) => (
          <label class="toggle align-q-rec align-q-take" title={a().tickBlocked() ?? undefined}>
            <input
              type="checkbox"
              checked={a().picked(props.doc, props.q.id)}
              disabled={!!a().tickBlocked()}
              onChange={(e) => a().toggle(props.doc, props.q.id, e.currentTarget.checked)}
            />
            <span class="toggle-box" />
            <span>
              <span class="visually-hidden">Take the recommendation for {props.q.id}. </span>
              {recLine()}
            </span>
          </label>
        )}
      </Show>
    </>
  );
  // An open question is what the user answers, so it stays whole; a settled one folds to one line
  // (its head and outcome, truncated) and opens to the ask, options and recommendation it was
  // settled from, then its outcome in full.
  return (
    <li class="align-q" data-state={state()}>
      <Show
        when={state() !== "open"}
        fallback={
          <>
            <p class="align-q-head">{head(false)}</p>
            {body()}
          </>
        }
      >
        <details class="align-q-fold">
          <summary class="align-q-head align-q-summary">{head(true)}</summary>
          <div class="align-q-body">
            {body()}
            <p class="align-q-decision">{outcomeLine()}</p>
          </div>
        </details>
      </Show>
    </li>
  );
}

/** The approach: the plan the user reads first, between the summary and the questions, open when
    the card renders and still a disclosure. Steps number by their stable ids only (a1, a2…), each
    in a narrow column of its own with no list marker, so wrapped text aligns. */
function AlignApproach(props: { section: AlignCardSection }) {
  return (
    <Show when={props.section.items.length > 0}>
      <details class="disclosure align-section align-approach" open>
        <summary class="disclosure-summary align-approach-summary">
          <Icon name="chevron-right" small class="icon-twist" />
          <span class="align-approach-label">{props.section.label}</span> · <span class="text-num">{props.section.items.length}</span>
        </summary>
        <div class="disclosure-body">
          <ul class="align-list align-approach-list">
            <For each={props.section.items}>
              {(item) => (
                <li>
                  <span class="text-mono align-item-id">{item.id}</span>
                  <span class="align-approach-text"><Inline text={item.body} /></span>
                </li>
              )}
            </For>
          </ul>
        </div>
      </details>
    </Show>
  );
}

function AlignSection(props: { section: AlignCardSection }) {
  const list = () => (
    <For each={props.section.items}>
      {(item) => (
        <li>
          <span class="text-mono align-item-id">{item.id}</span> <Inline text={item.body} />
        </li>
      )}
    </For>
  );
  return (
    <Show when={props.section.items.length > 0}>
      <details class="disclosure align-section">
        <summary class="disclosure-summary">
          <Icon name="chevron-right" small class="icon-twist" />
          {props.section.label} · <span class="text-num">{props.section.items.length}</span>
        </summary>
        <div class="disclosure-body">
          <ul class="align-list">{list()}</ul>
        </div>
      </details>
    </Show>
  );
}
