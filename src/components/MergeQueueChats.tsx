// The Merge Queue tab's own chats (§app.merge-queue/view): the Merge thread card under the queue's head, the head's
// "Review running · <branch> · Open" button, the History section at the bottom, and the reviewer links a run row and
// the run page show. The queue's chats are in no list of the session pane: these are where they are reached.
import { createSignal, For, Show } from "solid-js";
import type { MergeQueueChat, MergeQueueView } from "../../shared/merge-queue";
import { relativeTime } from "../lib/format";
import { answerThread, clearQueueChats, startFreshThread } from "../lib/merge-queue-client";
import { clearableRows, historyRows, historyWords, lastEventWords, memoryWords, reviewersOfRun, reviewerLinkWords, reviewingWords, threadStateChip, type HistoryFilter } from "../lib/merge-queue-chats";
import { projectSessionHref } from "../lib/projects-route";
import { type ChatOf, chatHref, useAct } from "./MergeQueueTab";
import { Icon } from "./ui";
import { QueueChip } from "./WorktreesModal";

/** Where a queue chat opens: its file's route when known, else the id route. */
const chatLink = (projectId: string, c: { session: string; path?: string }) => (c.path ? projectSessionHref(projectId, c.path) : `#/sid/${encodeURIComponent(c.session)}`);

/** The head's button while a review runs: it opens the reviewer's chat (a retry: the current attempt). */
export function ReviewRunningButton(props: { projectId: string; view: MergeQueueView }) {
  return (
    <Show when={props.view.reviewing}>
      {(r) => (
        <a class="button button-sm button-ghost mq-reviewing" href={chatLink(props.projectId, r())} data-run={r().run}>
          <Icon name="search" small />
          {reviewingWords(r())}
        </a>
      )}
    </Show>
  );
}

/** The Merge thread card: what it is, how it is, its question when it has one, Open and Start Fresh. */
export function MergeThreadCard(props: { projectId: string; view: MergeQueueView; chatOf?: ChatOf; onChanged(): void }) {
  const act = useAct(props.onChanged);
  const [confirm, setConfirm] = createSignal(false);
  const [answer, setAnswer] = createSignal("");
  const t = () => props.view.thread;
  return (
    <Show
      when={t()}
      fallback={
        <div class="mq-thread-card" data-state="none">
          <p class="text-caption text-muted">No merge thread now: the next event starts one (it reads each branch as it is queued).</p>
        </div>
      }
    >
      {(th) => {
        const chip = () => threadStateChip(th());
        const ask = () => th().ask;
        const askedIn = () => (ask()?.askedIn ? props.chatOf?.(ask()!.askedIn!.session) : undefined);
        return (
          <div class="mq-thread-card stack-2" data-state={th().state} aria-label="Merge thread">
            <div class="spread">
              <div class="cluster">
                <p class="list-title">Merge thread</p>
                <QueueChip row={chip()} />
              </div>
              <div class="button-row">
                <a class="button button-sm button-ghost" href={chatLink(props.projectId, th())}>
                  <Icon name="chat" small />
                  Open Merge Thread
                </a>
                <button type="button" class="button button-sm button-ghost" disabled={!!act.busy() || confirm()} onClick={() => setConfirm(true)}>
                  Start Fresh…
                </button>
              </div>
            </div>
            <p class="list-meta mq-thread-facts">
              <span>{memoryWords(th().memory)}</span>
              <span class="text-muted"> · started {relativeTime(th().startedAt)}</span>
              <Show when={lastEventWords(th().lastEvent)}>{(w) => <span class="text-muted"> · last: {w()}, {relativeTime(th().lastEvent!.at)}</span>}</Show>
            </p>
            <Show when={ask()}>
              {(a) => (
                <div class="mq-thread-ask stack-2" role="group" aria-label="The merge thread's question">
                  <p class="text-body-s">
                    <strong>The merge thread is asking you something.</strong> {a().question}
                  </p>
                  <Show
                    when={a().askedIn}
                    fallback={
                      <form
                        class="mq-thread-answer"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const text = answer().trim();
                          if (text) void act.run("answer", () => answerThread(props.view.root, a().id, text), "Sent your answer to the merge thread.").then(() => setAnswer(""));
                        }}
                      >
                        <label class="field-label" for="mq-thread-answer">
                          Your answer
                        </label>
                        <textarea id="mq-thread-answer" class="input" rows={2} value={answer()} onInput={(e) => setAnswer(e.currentTarget.value)} />
                        <span class="button-row">
                          <button type="submit" class="button button-sm button-primary" disabled={!answer().trim() || !!act.busy()}>
                            Send Answer
                          </button>
                          <a class="button button-sm button-ghost" href={chatLink(props.projectId, th())}>
                            Answer in Merge Thread
                          </a>
                        </span>
                      </form>
                    }
                  >
                    {(where) => (
                      <p class="list-meta">
                        Waiting on you · asked in <a href={chatHref(props.projectId, where().session, props.chatOf)}>{askedIn()?.title ?? "the branch's chat"}</a>
                      </p>
                    )}
                  </Show>
                </div>
              )}
            </Show>
            <Show when={confirm()}>
              <div class="mq-confirm" role="group" aria-label="Start a fresh merge thread">
                <p class="field-hint">This thread is archived once its turn ends, and its memory of past landings goes with it. The next event starts a new one. The old thread stays readable in History.</p>
                <span class="button-row">
                  <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="button button-sm button-destructive"
                    disabled={!!act.busy()}
                    onClick={() => {
                      setConfirm(false);
                      void act.run("fresh", () => startFreshThread(props.view.root), "Started fresh: the next event starts a new merge thread.");
                    }}
                  >
                    Start Fresh
                  </button>
                </span>
              </div>
            </Show>
            <Show when={act.error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
          </div>
        );
      }}
    </Show>
  );
}

/** A run's reviewer chats as links: "Review: ok · Open Reviewer Chat", one per attempt after a retry. */
export function ReviewerLinks(props: { projectId: string; view: MergeQueueView; run?: string }) {
  const list = () => reviewersOfRun(props.view.chats, props.run);
  return (
    <Show when={list().length > 0}>
      <p class="list-meta mq-reviewers">
        <For each={list()}>
          {(c, i) => {
            const w = reviewerLinkWords(c, list().length > 1);
            return (
              <span>
                {i() > 0 ? " · " : ""}
                <span class="text-muted">{w.lead}</span>
                <Show when={w.link}>
                  {(l) => (
                    <>
                      <span class="text-muted"> · </span>
                      <a href={chatLink(props.projectId, c)} onClick={(e) => e.stopPropagation()}>
                        {l()}
                      </a>
                    </>
                  )}
                </Show>
              </span>
            );
          }}
        </For>
      </p>
    </Show>
  );
}

const FILTERS: { id: HistoryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "threads", label: "Merge threads" },
  { id: "reviews", label: "Reviews" },
];

/** The History section: every chat the queue has had, each opening its chat; Clear and Clear All… delete for good. */
export function QueueHistory(props: { projectId: string; view: MergeQueueView; onChanged(): void }) {
  const act = useAct(props.onChanged);
  const [filter, setFilter] = createSignal<HistoryFilter>("all");
  const [confirmAll, setConfirmAll] = createSignal(false);
  const rows = () => historyRows(props.view.chats, filter());
  const clearable = () => clearableRows(props.view.chats);
  return (
    <Show when={(props.view.chats ?? []).length > 0}>
      <div class="stack-2 mq-history">
        <div class="spread">
          <h3 class="text-heading-s" id="mq-history-title">
            History
          </h3>
          <div class="button-row">
            <div class="segmented" role="group" aria-label="Show">
              <For each={FILTERS}>
                {(f) => (
                  <button type="button" class="button button-sm" classList={{ "button-ghost": filter() !== f.id }} aria-pressed={filter() === f.id ? "true" : "false"} onClick={() => setFilter(f.id)}>
                    {f.label}
                  </button>
                )}
              </For>
            </div>
            <button type="button" class="button button-sm button-ghost" disabled={clearable().length === 0 || !!act.busy()} onClick={() => setConfirmAll(true)}>
              Clear All…
            </button>
          </div>
        </div>
        <Show when={confirmAll()}>
          <div class="mq-confirm" role="group" aria-label="Clear the queue's chats">
            <p class="field-hint">
              Deletes {clearable().length} chat{clearable().length === 1 ? "" : "s"} for good. Runs keep their verdicts and findings. The current merge thread and a running review stay.
            </p>
            <span class="button-row">
              <button type="button" class="button button-sm button-ghost" onClick={() => setConfirmAll(false)}>
                Cancel
              </button>
              <button
                type="button"
                class="button button-sm button-destructive"
                disabled={!!act.busy()}
                onClick={() => {
                  setConfirmAll(false);
                  void act.run("clear-all", () => clearQueueChats(props.view.root, "all"), "Cleared the queue's old chats.");
                }}
              >
                Clear All
              </button>
            </span>
          </div>
        </Show>
        <Show when={act.error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
        <ul class="list mq-list" aria-labelledby="mq-history-title">
          <For each={rows()}>{(c) => <HistoryRow projectId={props.projectId} chat={c} busy={!!act.busy()} onClear={() => void act.run(`clear:${c.session}`, () => clearQueueChats(props.view.root, c.session), "Cleared that chat.")} />}</For>
        </ul>
      </div>
    </Show>
  );
}

function HistoryRow(props: { projectId: string; chat: MergeQueueChat; busy: boolean; onClear(): void }) {
  const c = () => props.chat;
  const w = () => historyWords(c());
  return (
    <li class="list-row mq-row" data-kind={c().kind} data-session={c().session} classList={{ "mq-cleared": !!c().cleared }}>
      <div class="list-main">
        <p class="list-title">
          <Show when={!c().cleared} fallback={<span>{w().title}</span>}>
            <a href={chatLink(props.projectId, c())}>{w().title}</a>
          </Show>
        </p>
        <p class="list-meta">
          <span>{w().facts}</span>
          <span class="text-muted">
            {" "}
            · {relativeTime(c().startedAt)}
            {c().endedAt ? ` to ${relativeTime(c().endedAt!)}` : ""}
          </span>
        </p>
      </div>
      <Show when={!c().current && !c().running && !c().cleared}>
        <div class="button-row mq-row-act">
          <button type="button" class="button button-sm button-ghost" aria-label={`Clear ${w().title}`} disabled={props.busy} onClick={() => props.onClear()}>
            Clear
          </button>
        </div>
      </Show>
    </li>
  );
}
