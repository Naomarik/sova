import { For, Show } from "solid-js";
import type { AlignDocInfo, AlignQuestionInfo, AlignRowInfo } from "../../shared/protocol";
import { ALIGN_STATUS_CHIP, alignStatusOf, openLabel, QUESTION_CHIP, questionStateOf } from "../lib/align";
import { Chip, Icon } from "./ui";
import "../design/align-viewer.css";

let seq = 0;

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
 * one info row for an exemption. Read-only: the user answers in chat, never here.
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
  const status = () => ALIGN_STATUS_CHIP[alignStatusOf(props.doc)];
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
          <Chip tone={status().tone}>{status().label}</Chip>
        </div>
        <p class="align-doc-meta">
          <span class="text-num">{openLabel(props.doc)}</span>
          <Show when={props.line}>
            <span class="align-doc-change"> · {props.line}</span>
          </Show>
        </p>
      </header>
      <AlignDocBody doc={props.doc} />
    </article>
  );
}

function AlignDocBody(props: { doc: AlignDocInfo }) {
  return (
    <>
      <p class="align-doc-summary"><Inline text={props.doc.summary} /></p>
      <Show when={props.doc.phase === "dropped" && props.doc.droppedWhy}>
        <p class="align-doc-dropped">Dropped: <Inline text={props.doc.droppedWhy ?? ""} /></p>
      </Show>
      <Show when={props.doc.questions.length > 0}>
        <ol class="align-questions" aria-label="Questions">
          <For each={props.doc.questions}>{(q) => <AlignQuestion q={q} />}</For>
        </ol>
      </Show>
      <AlignSection label="Findings" items={props.doc.findings.map((f) => ({ id: f.id, body: f.text }))} />
      <AlignSection label="Approach" ordered items={props.doc.approach.map((a) => ({ id: a.id, body: a.text }))} />
      <AlignSection label="Rejected" items={props.doc.rejected.map((x) => ({ id: x.id, body: `${x.option} — ${x.why}` }))} />
    </>
  );
}

function AlignQuestion(props: { q: AlignQuestionInfo }) {
  const state = () => questionStateOf(props.q);
  const chip = () => QUESTION_CHIP[state()];
  return (
    <li class="align-q" data-state={state()}>
      <p class="align-q-head">
        <span class="text-mono align-q-id">{props.q.id}</span>
        <strong class="align-q-topic">{props.q.topic}</strong>
        <Chip tone={chip().tone}>{chip().label}</Chip>
      </p>
      <p class="align-q-ask"><Inline text={props.q.ask} /></p>
      <Show when={props.q.context}>
        <p class="align-q-context"><Inline text={props.q.context ?? ""} /></p>
      </Show>
      <Show when={props.q.options?.length}>
        <ul class="align-q-options" aria-label="Options">
          <For each={props.q.options}>
            {(o) => (
              <li>
                <strong><Inline text={o.label} /></strong> — <Inline text={o.tradeoff} />
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="align-q-rec">
        <span class="align-q-label">Recommended:</span> <strong><Inline text={props.q.recommendation.choice} /></strong> — <Inline text={props.q.recommendation.why} />
      </p>
      <Show when={props.q.decision}>
        {(d) => (
          <p class="align-q-decision">
            <span class="align-q-label">Decided:</span> <Inline text={d().text} />
            <span class="align-q-by"> · {d().by === "user" ? "you" : "accepted recommendation"}</span>
          </p>
        )}
      </Show>
      <Show when={props.q.dropped}>
        {(d) => (
          <p class="align-q-decision">
            <span class="align-q-label">Dropped:</span> <Inline text={d().why} />
          </p>
        )}
      </Show>
    </li>
  );
}

function AlignSection(props: { label: string; items: { id: string; body: string }[]; ordered?: boolean }) {
  const list = () => (
    <For each={props.items}>
      {(item) => (
        <li>
          <span class="text-mono align-item-id">{item.id}</span> <Inline text={item.body} />
        </li>
      )}
    </For>
  );
  return (
    <Show when={props.items.length > 0}>
      <details class="disclosure align-section">
        <summary class="disclosure-summary">
          <Icon name="chevron-right" small class="icon-twist" />
          {props.label} · <span class="text-num">{props.items.length}</span>
        </summary>
        <div class="disclosure-body">
          <Show when={props.ordered} fallback={<ul class="align-list">{list()}</ul>}>
            <ol class="align-list">{list()}</ol>
          </Show>
        </div>
      </details>
    </Show>
  );
}
