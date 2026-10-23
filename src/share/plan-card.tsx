import { createSignal, For, Show } from "solid-js";
import type { BatonPlan, BatonPlanVisual } from "../../shared/baton";
import { optionLetter } from "../lib/align";
import { isRecommended, openQuestions, planAcceptAllMessage, planAnswerMessage, type PlanPicks } from "../lib/plan-answers";
import { batonKinds } from "./markdown";
import { LinkedText, Reply } from "./thread";

/**
 * A feature request chat's plan on the owner page (§app.project-assistant/feature-chats, copy:
 * §design.copy-deck/owner-page): what we found, the plan, what was ruled out, its drawings, and its questions.
 * With `answer` (the owner holds the chat), each open question's options are picked and sent with Send My
 * Answers, or every recommendation with Go With Recommendations: both only compose an ordinary message. Without
 * it the card reads only. Drawings render as a reply's would, clickable prototypes in the sealed frame.
 */
export function PlanCard(props: { plan: BatonPlan; answer?: (text: string) => Promise<boolean>; drawHtml?: boolean }) {
  const p = () => props.plan;
  const [picks, setPicks] = createSignal<PlanPicks>({});
  const [sending, setSending] = createSignal(false);
  const pick = (q: string, v: number | "rec") => setPicks((cur) => (cur[q] === v ? (({ [q]: _, ...rest }) => rest)(cur) : { ...cur, [q]: v }));
  const send = async (text: string) => {
    if (!text || !props.answer || sending()) return;
    setSending(true);
    try {
      if (await props.answer(text)) setPicks({});
    } finally {
      setSending(false);
    }
  };
  const open = () => openQuestions(p());
  const answerable = () => !!props.answer && p().state === "open" && open().length > 0;
  return (
    <aside class="share-card share-plan" aria-label={`Plan: ${p().title}`}>
      <span class="share-card-head">{p().state === "agreed" ? "The plan · agreed" : p().state === "dropped" ? "The plan · set aside" : "The plan"}</span>
      <h2 class="share-plan-title">{p().title}</h2>
      <LinkedText text={p().summary} />
      <Visual v={p().visual} drawHtml={props.drawHtml} />
      <Show when={p().findings.length}>
        <section class="share-plan-part">
          <h3 class="share-plan-head">What we found</h3>
          <ul class="share-plan-list">
            <For each={p().findings}>{(f) => <li><LinkedText text={f} /></li>}</For>
          </ul>
        </section>
      </Show>
      <Show when={p().approach.length}>
        <section class="share-plan-part">
          <h3 class="share-plan-head">The plan</h3>
          <ol class="share-plan-list">
            <For each={p().approach}>{(a) => <li><LinkedText text={a} /></li>}</For>
          </ol>
        </section>
      </Show>
      <Show when={p().rejected.length}>
        <section class="share-plan-part">
          <h3 class="share-plan-head">Ruled out</h3>
          <ul class="share-plan-list">
            <For each={p().rejected}>
              {(x) => (
                <li>
                  <strong>{x.option}</strong>: {x.why}
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={p().questions.length}>
        <section class="share-plan-part">
          <h3 class="share-plan-head">Questions</h3>
          <For each={p().questions}>
            {(q) => (
              <fieldset class="share-plan-q" disabled={!answerable() || q.decision !== undefined}>
                <legend class="share-plan-topic">
                  {q.id} · {q.topic}
                </legend>
                <LinkedText text={q.ask} />
                <Show when={q.context}>
                  <p class="share-plan-context">{q.context}</p>
                </Show>
                <Visual v={q.visual} drawHtml={props.drawHtml} />
                <Show
                  when={q.decision === undefined}
                  fallback={
                    <p class="share-plan-decision">
                      Answer: {q.decision}
                    </p>
                  }
                >
                  <Show
                    when={q.options.length}
                    fallback={
                      <p class="share-plan-rec">
                        Recommended: {q.recommendation.choice}. {q.recommendation.why}
                      </p>
                    }
                  >
                    <ul class="share-plan-options">
                      <For each={q.options}>
                        {(o, i) => (
                          <li>
                            <label class="share-plan-option" classList={{ "share-plan-option-picked": picks()[q.id] === i() }}>
                              <Show when={answerable()}>
                                <input type="radio" name={`${p().doc}-${q.id}`} checked={picks()[q.id] === i()} onChange={() => pick(q.id, i())} aria-label={`Answer ${q.id} with ${o.label}`} />
                              </Show>
                              <span class="share-plan-letter">{optionLetter(i())}</span>
                              <span class="share-plan-option-main">
                                <span class="share-plan-option-label">
                                  {o.label}
                                  <Show when={isRecommended(q, i())}>
                                    <span class="chip share-plan-recommended">Recommended</span>
                                  </Show>
                                </span>
                                <span class="share-plan-tradeoff">{o.tradeoff}</span>
                              </span>
                            </label>
                          </li>
                        )}
                      </For>
                    </ul>
                    <p class="share-plan-rec">Why we recommend it: {q.recommendation.why}</p>
                  </Show>
                </Show>
              </fieldset>
            )}
          </For>
        </section>
      </Show>
      <Show when={answerable()}>
        <div class="share-plan-actions">
          <button type="button" class="button button-primary" disabled={sending() || !planAnswerMessage(p(), picks())} onClick={() => void send(planAnswerMessage(p(), picks()))}>
            Send My Answers
          </button>
          <button type="button" class="button" disabled={sending()} onClick={() => void send(planAcceptAllMessage(p()))}>
            Go With Recommendations
          </button>
        </div>
      </Show>
    </aside>
  );
}

/** A plan's drawing, as the fence it is; withheld by the server's markup backstop: the quiet line. */
function Visual(props: { v?: BatonPlanVisual; drawHtml?: boolean }) {
  return (
    <Show when={props.v}>
      {(v) => (
        <Show when={"kind" in v()} fallback={<p class="share-plan-context">A drawing couldn't be shown here.</p>}>
          <Reply text={"```vis " + (v() as { kind: string }).kind + "\n" + (v() as { source: string }).source + "\n```"} kinds={batonKinds(props.drawHtml === true)} />
        </Show>
      )}
    </Show>
  );
}
