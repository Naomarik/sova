import { createSignal, For, onMount, Show } from "solid-js";
import type { ReviewCard as Review, ReviewFinding } from "../../shared/merge-queue";
import type { CardInfo } from "../../shared/transcript-cards";
import { transcriptRoot } from "../lib/jump";
import { takeReviewJump } from "../lib/review-jump";
import { findingPlace, foldedReviewLine, kindWord, reviewCardLabel, reviewHead, reviewRowOf, reviewStateLine, TIP_GONE_LINE } from "../lib/merge-review-card";
import { mergeRunHref, projectSessionHref } from "../lib/projects-route";
import { toast } from "../lib/ui-state";
import { ChangesDialog, useChangesSession } from "./ChangesViewer";
import { CardErrorBox } from "./TranscriptKind";
import { Icon } from "./ui";

/**
 * A blocking review's own card (§chat.merge-queue/review-card): the Found issues chip, the branch and
 * the commit reviewed, the try, the reviewer's summary and every finding as written, the merge
 * thread's note, the state line, See Run and Open Reviewer Chat. It has no text box and no action on
 * the queue. A later review of the same entry folds it to one line that opens it as it was, read-only.
 */
export function MergeReviewCard(props: { card: CardInfo; onReload?(): void }) {
  const row = () => reviewRowOf(props.card);
  return (
    <Show when={row()} fallback={<CardErrorBox why="This review card couldn't be read" reload={() => props.onReload?.()} />}>
      {(r) => (
        <Show when={!r().folded} fallback={<Folded review={r().review} />}>
          <Body review={r().review} />
        </Show>
      )}
    </Show>
  );
}

function Folded(props: { review: Review }) {
  return (
    <details class="disclosure transcript-card-revision mq-review-folded" data-branch={props.review.branch}>
      <summary class="disclosure-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="disclosure-label">{foldedReviewLine(props.review)}</span>
      </summary>
      <div class="disclosure-body">
        <Body review={props.review} readOnly />
      </div>
    </details>
  );
}

function Body(props: { review: Review; readOnly?: boolean }) {
  const r = () => props.review;
  const state = () => reviewStateLine(r());
  const session = useChangesSession();
  const [viewing, setViewing] = createSignal<string | null>(null);
  /** The queue card's decision, for Waiting for you: on screen in this chat, else the queue card's chat. */
  const toDecision = () => {
    const el = transcriptRoot(session?.path)?.querySelector<HTMLElement>(`[data-mq-entry="${CSS.escape(r().entry)}"]`);
    if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
    else toast("That card isn't in the transcript on screen.");
  };
  let el: HTMLDivElement | undefined;
  // Followed from a queue card in another chat: land on this card's top and focus it, as the same-chat jump does.
  onMount(() => {
    if (props.readOnly || !el || !takeReviewJump(r().id)) return;
    const land = el;
    requestAnimationFrame(() => {
      land.scrollIntoView({ block: "start", behavior: "instant" });
      land.focus({ preventScroll: true });
    });
  });
  return (
    <div ref={el} class="card mq-review-card" tabindex="-1" role="group" aria-label={reviewCardLabel(r())} data-state={r().state} data-branch={r().branch}>
      <div class="mq-review-head">
        <span class="icon icon-sm" style={{ "--icon": "url(/icons/alert-circle.svg)" }} aria-hidden="true" />
        <span class="mq-review-title">Review found issues</span>
        <span class="chip chip-warn">
          <span class="chip-dot" aria-hidden="true" />
          Found issues
        </span>
      </div>
      <p class="mq-review-facts text-caption text-mono" title={r().commit}>
        {reviewHead(r())}
      </p>
      <Show when={r().summary}>
        <p class="mq-review-summary">{r().summary}</p>
      </Show>
      <ol class="mq-review-findings" aria-label="Findings">
        <For each={r().findings}>{(f) => <Finding finding={f} onOpen={setViewing} canOpen={!!r().project} />}</For>
      </ol>
      <Show when={!r().reviewed.kept && r().findings.some((f) => f.file)}>
        <p class="text-caption text-muted mq-review-gone">{TIP_GONE_LINE}</p>
      </Show>
      <Show when={r().note}>
        {(n) => (
          <p class="text-caption mq-card-line mq-review-note">
            <span class="text-muted">Merge thread:</span> {n().text}
          </p>
        )}
      </Show>
      <p class="text-caption mq-review-state" data-tone={state().tone}>
        <span class={`mq-review-dot mq-review-dot-${state().tone}`} aria-hidden="true" />
        <Show when={state().toDecision && !props.readOnly} fallback={<span>{state().text}</span>}>
          <button type="button" class="button-link" title="Go to the decision on the branch's queue card" onClick={toDecision}>
            {state().text}
          </button>
        </Show>
      </p>
      <div class="button-row mq-review-actions">
        <a class="button button-sm button-ghost" href={mergeRunHref(r().project, r().run)}>
          See Run
        </a>
        <Show when={r().reviewer}>
          {(rv) => (
            <Show when={!rv().cleared && rv().path} fallback={<span class="text-caption text-muted">Reviewer chat cleared</span>}>
              <a class="button button-sm" href={projectSessionHref(r().project, rv().path!)}>
                Open Reviewer Chat
              </a>
            </Show>
          )}
        </Show>
      </div>
      <Show when={viewing()}>
        {(file) => (
          <ChangesDialog
            scope={{ kind: "queue", project: r().project, review: r().id, paths: [file()] }}
            stepsFrom={session?.path}
            cwd={session?.cwd}
            onClose={() => setViewing(null)}
          />
        )}
      </Show>
    </div>
  );
}

function Finding(props: { finding: ReviewFinding; canOpen: boolean; onOpen(file: string): void }) {
  const f = () => props.finding;
  const place = () => findingPlace(f());
  return (
    <li class="mq-review-finding">
      <span class="chip mq-review-kind">{kindWord(f().kind)}</span>
      <Show when={place()}>
        {(p) => (
          <Show when={props.canOpen && f().file} fallback={<span class="text-mono text-caption mq-review-place">{p()}</span>}>
            <button
              type="button"
              class="button-link text-mono text-caption mq-review-place"
              aria-label={`Open ${p()} in the changes viewer`}
              title="Opens this file in the change that was reviewed"
              onClick={() => props.onOpen(f().file!)}
            >
              {p()}
            </button>
          </Show>
        )}
      </Show>
      <span class="mq-review-text">{f().text}</span>
    </li>
  );
}
