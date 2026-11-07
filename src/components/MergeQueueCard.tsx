import { createSignal, For, Show, useContext } from "solid-js";
import type { CardInfo } from "../../shared/transcript-cards";
import { clockTime, tildePath } from "../lib/format";
import { cardActionLabel, cardActions, cardDecision, cardFacts, cardLabel, cardNewer, cardNotes, cardPill, cardSha, foldedLine, isNewest, notPushed, queueRowOf, type CardAction, type QueueCard, type QueueCardRow } from "../lib/merge-queue-card";
import { HELD_NOTE_LINE, STANDING_LINE, standingWords } from "../lib/merge-standing";
import { CardContext } from "../lib/card-controls";
import { paneScopedId, usePaneScope } from "../lib/pane-scope";
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


function Body(props: { data: QueueCard; readOnly?: boolean }) {
  const d = () => props.data;
  const pill = () => cardPill(d());
  const session = useChangesSession();
  const [reviewing, setReviewing] = createSignal(false);
  const [busy, setBusy] = createSignal<CardAction | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const facts = () => cardFacts(d());
  const runHref = () => (d().run ? mergeRunHref(d().project, d().run!) : null);
  /** Past Sova's checks on a request or push project: the host's states and Open on the host. */
  const onRequest = () => isRequestState(d().state) || (d().state === "landed" && !!d().request);
  const reqEntry = (): RequestEntry => ({ id: d().entry, branch: d().branch, state: d().state as RequestEntry["state"], reason: d().reason, newerCommits: d().newerCommits, request: d().request });
  const [reviewingRequest, setReviewingRequest] = createSignal(false);
  const decision = () => cardDecision(d());
  const standing = () => (decision() || d().state === "landed" || d().state === "cancelled" ? null : standingWords(d()));
  // A choice fills the chat's message box (the chat's card controls stage it at the draft's end); nothing is sent.
  const cards = useContext(CardContext);
  const scope = usePaneScope();
  const fill = (text: string) => {
    if (!cards) return;
    cards.stage(text);
    announce(`Put in the message box: ${text}`);
    queueMicrotask(() => document.getElementById(paneScopedId(scope, "composer-input"))?.focus());
  };

  const act = async (a: CardAction) => {
    if (busy()) return;
    setBusy(a);
    setError(null);
    // The entry the card follows now (a re-approval after a hand-back moves the same card on).
    const e = { id: d().entry };
    try {
      const r =
        a === "cancel" || a === "remove"
          ? await cancelEntry(e)
          : a === "accept" || a === "land-anyway" || a === "try-again"
            ? await answerEntry(e, a)
            : a === "land" && decision()
              ? // A decision's Land, on the queue itself: out of tries, a new standing approval at the branch's newest
                // commit with 3 new tries; a fix that needs your OK, back in line; drafts changed, re-pinned as they are.
                await answerEntry(e, "land")
              : // Land: the commit the card was approved at; Land Again: the branch's head.
                await landBranch(d().root, d().branch, { commit: a === "land-again" ? d().head : d().commit });
      const no = refusal(r);
      if (no) {
        setError(no);
        announce(no);
      } else {
        const done = `${cardActionLabel(a)}: ${d().branch}.`;
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
        <p class="text-caption mq-card-line">{unattributedWhy(d().reason, d().target)} Nobody is blamed: Land Anyway lands the commit it tested, Try Again checks it afresh.</p>
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
      <Show when={decision()?.sides ?? (d().state === "behaviour-differs" ? d().conflict : undefined)}>
        {(c) => (
          <dl class="mq-sides mq-card-sides">
            <div>
              <dt class="text-eyebrow">{d().target}</dt>
              <dd>{c().ours}</dd>
            </div>
            <div>
              <dt class="text-eyebrow">This branch</dt>
              <dd>{c().theirs}</dd>
            </div>
            <div>
              <dt class="text-eyebrow">Merge thread proposes</dt>
              <dd>{c().proposal}</dd>
            </div>
          </dl>
        )}
      </Show>
      <Show when={d().review?.text && d().state === "review-flagged"}>
        <p class="text-caption mq-card-line">
          <span class="text-muted">Review:</span> {d().review!.text}
        </p>
      </Show>
      <Show when={standing()}>
        {(w) => (
          <div class="mq-card-standing">
            <Show when={w().detail}>{(x) => <p class="text-caption mq-card-line mq-card-standing-detail">{x()}</p>}</Show>
            <Show when={w().answer}>{(x) => <p class="text-caption mq-card-line mq-card-answer"><span class="text-muted">Chat:</span> {x()}</p>}</Show>
            <p class="text-caption mq-card-line text-muted">{STANDING_LINE}</p>
          </div>
        )}
      </Show>
      <Show when={decision()}>
        {(x) => (
          <div class="mq-card-decision" role="group" aria-label={`Decision for ${d().branch}`}>
            <p class="mq-card-question">
              {x().question}
              <Show when={x().cantSettle}>
                <span class="text-muted"> · can't be settled without you</span>
              </Show>
            </p>
            <Show when={x().choices.length && !props.readOnly && cards}>
              <div class="button-row mq-card-choices" role="group" aria-label="Choices: each fills the message box">
                <For each={x().choices}>
                  {(c) => (
                    <button type="button" class="button button-sm" title="Puts these words in the message box; nothing is sent until you send" onClick={() => fill(c)}>
                      {c}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={x().choices.length && (props.readOnly || !cards)}>
              <ul class="mq-card-choices-list text-caption">
                <For each={x().choices}>{(c) => <li>{c}</li>}</For>
              </ul>
            </Show>
            <Show when={x().heldNote}>
              {(n) => (
                <div class="mq-card-held">
                  <p class="text-caption mq-card-line">
                    <span class="text-muted">Merge queue:</span> {n().text}
                  </p>
                  <p class="text-caption mq-card-held-mark">
                    <span class="chip chip-warn">
                      <span class="chip-dot" aria-hidden="true" />
                      Not sent yet
                    </span>{" "}
                    {HELD_NOTE_LINE.replace(/^Not sent yet: /, "")}
                  </p>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
      <Show when={d().state === "landed" && d().fixesLanded?.length}>
        <div class="mq-card-fixes">
          <p class="text-caption mq-card-line text-muted">Fixes that landed with your Land:</p>
          <ul class="text-caption">
            <For each={d().fixesLanded}>
              {(f) => (
                <li>
                  <span class="text-mono">{f.sha.slice(0, 7)}</span> {f.subject}
                </li>
              )}
            </For>
          </ul>
        </div>
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
                class={`button button-sm${a === "accept" || a === "land-anyway" || a === "land" ? " button-primary" : ""}`}
                aria-label={`${cardActionLabel(a)} ${d().branch}`}
                disabled={!!busy()}
                aria-busy={busy() === a ? "true" : undefined}
                onClick={() => void act(a)}
              >
                {cardActionLabel(a)}
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
