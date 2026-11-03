import { createSignal, For, Show } from "solid-js";
import type { MergeAnswer } from "../../shared/merge-queue";
import type { CardInfo } from "../../shared/transcript-cards";
import { clockTime, tildePath } from "../lib/format";
import { cardActions, cardFacts, cardLabel, cardNewer, cardNotes, cardPill, cardSha, foldedLine, isNewest, notPushed, queueRowOf, type CardAction, type QueueCard, type QueueCardRow } from "../lib/merge-queue-card";
import { answerEntry, cancelEntry, landBranch, refusal } from "../lib/merge-queue-client";
import { mergeRunHref, projectTabHref } from "../lib/projects-route";
import { announce, home, toast } from "../lib/ui-state";
import { ChangesDialog, useChangesSession } from "./ChangesViewer";
import { CardErrorBox } from "./TranscriptKind";
import { Icon } from "./ui";
import { UnclearChecks } from "./WorktreesModal";
import { unattributedWhy } from "../lib/merge-queue";
import { isRequestState } from "../lib/merge-queue-requests";
import { RequestReview, RequestStatus, type RequestEntry } from "./MergeQueueRequests";

/**
 * The merge queue's card for one branch, in the chat that built it: its state pill, "feat/x into
 * master <sha>", what lands, its notes, and the action its state offers. The Landed card reads as the
 * Merged card does. Every button calls a merge verb; nothing is typed into the chat. An earlier revision
 * is one line ("feat/x · Queued 2nd") that opens in place.
 */
export function MergeQueueCard(props: { card: CardInfo; onReload?(): void }) {
  const row = () => queueRowOf(props.card);
  return (
    <Show when={row()} fallback={<CardErrorBox why="This merge queue card couldn't be read" reload={() => props.onReload?.()} />}>
      {(r) => (
        <Show when={isNewest(r())} fallback={<Folded row={r()} />}>
          <Body data={r().card} />
        </Show>
      )}
    </Show>
  );
}

/** An earlier copy: one line from its own frozen state, that opens to the card as it is now, read-only. */
function Folded(props: { row: QueueCardRow }) {
  return (
    <details class="disclosure transcript-card-revision mq-card-folded" data-branch={props.row.card.branch}>
      <summary class="disclosure-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="disclosure-label text-mono">{foldedLine(props.row.card.branch, props.row.revision)}</span>
        <span class="disclosure-preview">· earlier copy</span>
      </summary>
      <div class="disclosure-body">
        <Body data={props.row.card} readOnly />
      </div>
    </details>
  );
}

const ACTION_LABEL: Record<CardAction, string> = {
  cancel: "Cancel",
  accept: "Accept",
  "land-anyway": "Land Anyway",
  "send-back": "Send Back",
  "land-again": "Land Again",
};

function Body(props: { data: QueueCard; readOnly?: boolean }) {
  const d = () => props.data;
  const pill = () => cardPill(d());
  const session = useChangesSession();
  const [reviewing, setReviewing] = createSignal(false);
  const [busy, setBusy] = createSignal<CardAction | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const facts = () => cardFacts(d());
  const runHref = () => (d().run ? mergeRunHref(d().project, d().run!) : null);
  /** Past Sova's checks on a request or push project: the host's states, Open on the host, Send Back to Chat. */
  const onRequest = () => isRequestState(d().state) || (d().state === "landed" && !!d().request);
  const reqEntry = (): RequestEntry => ({ id: d().entry, branch: d().branch, state: d().state as RequestEntry["state"], reason: d().reason, newerCommits: d().newerCommits, request: d().request });
  const [reviewingRequest, setReviewingRequest] = createSignal(false);

  const act = async (a: CardAction) => {
    if (busy()) return;
    setBusy(a);
    setError(null);
    // The entry the card follows now (a re-approval after a hand-back moves the same card on).
    const e = { id: d().entry };
    const answer = (x: MergeAnswer) => answerEntry(e, x);
    try {
      const r =
        a === "cancel"
          ? await cancelEntry(e)
          : a === "accept"
            ? await answer("accept")
            : a === "land-anyway"
              ? await answer("land-anyway")
              : a === "send-back"
                ? await answer("send-back")
                : await landBranch(d().root, d().branch, { commit: d().head });
      const no = refusal(r);
      if (no) {
        setError(no);
        announce(no);
      } else {
        const done = `${ACTION_LABEL[a]}: ${d().branch}.`;
        toast(done);
        announce(done);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="card worktree-merge mq-chat-card" role="group" aria-label={cardLabel(d())} data-state={d().state} data-branch={d().branch}>
      <div class="worktree-merge-head">
        <span class="worktree-merge-text">
          <span class="icon icon-sm" style={{ "--icon": "url(/icons/branch.svg)" }} aria-hidden="true" />
          <span class={`chip chip-${pill().tone === "neutral" ? "" : pill().tone}${pill().live ? " chip-live" : ""}`}>
            <span class="chip-dot" aria-hidden="true" />
            {pill().label}
          </span>
          <span class="worktree-merge-title">
            <span class="text-mono">{d().branch}</span> into <span class="text-mono">{d().target}</span>
          </span>
          <span class="text-mono text-caption" title={d().landed?.sha ?? d().commit}>
            {cardSha(d())}
          </span>
        </span>
        <Show when={d().state === "landed" && d().landed && d().landed!.via !== "host" && session}>
          <button
            type="button"
            class="button button-sm worktree-merge-review"
            aria-label={`Review Changes from ${d().branch}`}
            title="Review exactly what this landing brought in"
            onClick={() => setReviewing(true)}
          >
            Review Changes
          </button>
        </Show>
      </div>
      <Show when={facts().length || d().landed}>
        <p class="worktree-merge-numbers text-caption">
          <For each={facts()}>
            {(f, i) => (
              <>
                <Show when={i() > 0}>
                  <span class="text-muted"> · </span>
                </Show>
                <Show when={f.lines} fallback={<span class="text-num">{f.text}</span>}>
                  {(l) => (
                    <span class="text-mono text-num" aria-label={`${l().added} added, ${l().removed} removed`}>
                      <span class="git-add">+{l().added}</span> <span class="git-del">−{l().removed}</span>
                    </span>
                  )}
                </Show>
              </>
            )}
          </For>
          <Show when={d().landed}>
            {(l) => (
              <span class="text-muted">
                {facts().length ? " · " : ""}
                {clockTime(l().at)}
              </span>
            )}
          </Show>
        </p>
      </Show>
      <Show when={d().state === "unattributed"}>
        <p class="text-caption mq-card-line">{unattributedWhy(d().reason, d().target)} Nobody is blamed: Land Anyway lands the commit it tested, Send Back hands it to this chat.</p>
        <UnclearChecks projectId={d().project} unclear={d().unclear} target={d().target} />
      </Show>
      <Show when={onRequest()}>
        <Show
          when={reviewingRequest() && d().state === "request-review" && !props.readOnly}
          fallback={<RequestStatus entry={reqEntry()} root={d().root} target={d().target} head={d().head} readOnly={props.readOnly} noChip onReview={() => setReviewingRequest(true)} />}
        >
          <RequestReview entry={reqEntry()} target={d().target} onDone={() => setReviewingRequest(false)} onCancel={() => setReviewingRequest(false)} />
        </Show>
      </Show>
      <Show when={d().reason && d().state !== "landed" && d().state !== "unattributed" && !onRequest()}>
        <p class="text-caption mq-card-line">
          {d().reason}
          <Show when={runHref()}>
            {(h) => (
              <>
                {" "}
                <a href={h()}>See Why</a>
              </>
            )}
          </Show>
        </p>
      </Show>
      <Show when={d().conflict && d().state === "behaviour-differs"}>
        <dl class="mq-sides mq-card-sides">
          <div>
            <dt class="text-eyebrow">{d().target}</dt>
            <dd>{d().conflict!.ours}</dd>
          </div>
          <div>
            <dt class="text-eyebrow">This branch</dt>
            <dd>{d().conflict!.theirs}</dd>
          </div>
          <div>
            <dt class="text-eyebrow">Merge thread proposes</dt>
            <dd>{d().conflict!.proposal}</dd>
          </div>
        </dl>
      </Show>
      <Show when={d().review?.text && d().state === "review-flagged"}>
        <p class="text-caption mq-card-line">
          <span class="text-muted">Review:</span> {d().review!.text}
        </p>
      </Show>
      <Show when={d().failures?.length}>
        <ul class="mq-card-failures text-caption" aria-label="Failing checks">
          <For each={d().failures}>
            {(f) => (
              <li>
                <span class="mq-fail-line">{f.label}</span>
                <Show when={f.detail}>
                  <span class="text-muted"> · {f.detail}</span>
                </Show>{" "}
                <a href={mergeRunHref(d().project, f.run)} aria-label={`Log of ${f.label}`}>
                  Log
                </a>
                <Show when={f.tests?.length}>
                  <ul class="mq-card-tests text-mono">
                    <For each={f.tests}>{(t) => <li>{t}</li>}</For>
                  </ul>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={d().explanation}>
        {(x) => (
          <p class="text-caption mq-card-line mq-card-explain">
            <span class="text-muted">Merge thread:</span> {x().text}
          </p>
        )}
      </Show>
      <For each={cardNotes(d())}>
        {(n) => (
          <p class="text-caption mq-card-line mq-card-note">
            <span class="text-muted">{n.label}:</span> {n.text}
          </p>
        )}
      </For>
      <Show when={notPushed(d())}>{(w) => <p class="text-caption mq-card-line mq-card-warn">{w()}</p>}</Show>
      <Show when={cardNewer(d())}>{(n) => <p class="text-caption mq-card-line">{n()}</p>}</Show>
      <Show when={d().worktree}>
        {(p) => (
          <p class="worktree-merge-path text-caption text-mono text-muted" title={p()}>
            {tildePath(p(), home())}
          </p>
        )}
      </Show>
      <Show when={error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
      <div class="button-row mq-card-actions">
        <Show when={!props.readOnly}>
          <For each={cardActions(d())}>
            {(a) => (
              <button
                type="button"
                class={`button button-sm${a === "accept" || a === "land-anyway" ? " button-primary" : ""}${a === "send-back" ? " button-destructive" : ""}`}
                aria-label={`${ACTION_LABEL[a]} ${d().branch}`}
                disabled={!!busy()}
                aria-busy={busy() === a ? "true" : undefined}
                onClick={() => void act(a)}
              >
                {ACTION_LABEL[a]}
              </button>
            )}
          </For>
        </Show>
        <a class="button button-sm button-ghost" href={projectTabHref(d().project, "merge-queue")}>
          View Merge Queue
        </a>
      </div>
      <Show when={reviewing() && session && d().landed}>
        <ChangesDialog scope={{ kind: "merge", sessionPath: session!.path, repoPath: d().root, sha: d().landed!.sha }} cwd={session!.cwd} onClose={() => setReviewing(false)} />
      </Show>
    </div>
  );
}
