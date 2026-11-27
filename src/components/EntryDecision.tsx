// An entry that waits for you, as the Needs you row and the run page both draw it: the question, its choices, the
// queue's held note, both sides of a conflict, and the answers (the decision's own, Answer in Chat when it is answered
// in words, Remove from Queue). One routing for every answer (lib/merge-queue-client sendAnswer → cardActionRoute), one
// list of answers (lib/merge-answers entryAnswers), and the words once it went through read off the queue's answer.
import { createSignal, For, Show } from "solid-js";
import type { MergeEntry, MergeQueueView } from "../lib/merge-queue";
import { answerAria, answerDone, answersHere, entryAnswers, waitingTitle } from "../lib/merge-answers";
import { refusal, sendAnswer } from "../lib/merge-queue-client";
import { answeredInChat, DECISION_ACTION_LABEL, openDecision, type DecisionAction } from "../lib/merge-standing";
import { projectSessionHref } from "../lib/projects-route";
import type { ChatRef } from "../lib/merge-chat";
import { announce, toast } from "../lib/ui-state";
import { QueueChip } from "./WorktreesModal";

type ChatOf = (id: string) => ChatRef | undefined;

/** Where a chat recorded by its id opens: its own route when the list carries it, else the id route the app resolves. */
export const chatHref = (projectId: string, id: string, chatOf?: ChatOf): string => {
  const c = chatOf?.(id);
  return c ? projectSessionHref(projectId, c.path) : `#/sid/${encodeURIComponent(id)}`;
};

/** One action button with its pending state; a refusal shows under the row and is announced. */
export function useAct(onChanged: () => void) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  /** `done`: the words once it went through, or how to read them off the answer (what the queue really did). */
  const run = async <R extends { ok: boolean; error?: { message: string } }>(key: string, call: () => Promise<R>, done: string | ((r: R) => string)) => {
    if (busy()) return;
    setBusy(key);
    setError(null);
    try {
      const r = await call();
      const no = refusal(r);
      if (no) {
        setError(no);
        announce(no);
      } else {
        const words = typeof done === "string" ? done : done(r);
        toast(words);
        announce(words);
        onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  /** Nothing was sent: say why where the row shows its errors. */
  const fail = (why: string) => {
    setError(why);
    announce(why);
  };
  return { busy, error, run, fail };
}

/** The answers of one entry and their one routing: busy and a refusal under the entry, a toast and an announcement in
 *  the queue's words once it went through. Ask the Merge Thread opens the thread's chat once the queue took it. */
export function createEntryAnswers(props: { projectId: string; root: () => string; entry: () => MergeEntry; threadPath?: () => string | undefined; onChanged(): void }) {
  const act = useAct(props.onChanged);
  const e = props.entry;
  const actions = (): DecisionAction[] => entryAnswers(e());
  /** Answered in words: in the chat's message box. */
  const inChat = (): boolean => {
    if (e().waitingRuling) return false;
    const d = openDecision(e());
    return d ? answeredInChat(d) : e().state === "behaviour-differs" || e().state === "needs-user";
  };
  const doAct = (a: DecisionAction) => {
    const entry = e();
    const path = props.threadPath?.();
    const call = async () => {
      const r = await sendAnswer(entry, a, props.root());
      if (r.ok && a === "ask-thread" && path) queueMicrotask(() => (location.hash = projectSessionHref(props.projectId, path)));
      return r;
    };
    void act.run(a, call, (r) => answerDone(a, entry.branch, r.entry));
  };
  return { act, actions, inChat, doAct };
}
export type EntryAnswers = ReturnType<typeof createEntryAnswers>;

/** The question, "can't be settled without you", its choices, the held note's line, and both sides with the merge
 *  thread's proposal. */
export function DecisionLines(props: { entry: MergeEntry; target: string }) {
  const decision = () => openDecision(props.entry);
  const sides = () => decision()?.sides ?? (props.entry.state === "behaviour-differs" ? props.entry.conflict : undefined);
  return (
    <>
      <Show when={decision()}>
        {(d) => (
          <>
            <p class="list-meta mq-question">
              {d().question}
              <Show when={d().cantSettle}>
                <span class="text-muted"> · can't be settled without you</span>
              </Show>
            </p>
            <Show when={d().choices.length}>
              <p class="list-meta">
                <span class="text-muted">Choices:</span> {d().choices.join(" · ")}
              </p>
            </Show>
            <Show when={d().heldNote}>
              <p class="list-meta text-muted">The merge queue's note to the chat isn't sent yet: it goes with your answer.</p>
            </Show>
          </>
        )}
      </Show>
      <Show when={sides()}>
        {(c) => (
          <dl class="mq-sides">
            <div>
              <dt class="text-eyebrow">{props.target}</dt>
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
    </>
  );
}

/** The answer buttons (those `show` keeps; Remove from Queue is its own, last), Answer in Chat, Remove from Queue. */
export function DecisionButtons(props: { projectId: string; entry: MergeEntry; answers: EntryAnswers; chatOf?: ChatOf; show?: (a: DecisionAction) => boolean }) {
  const e = () => props.entry;
  const busy = () => !!props.answers.act.busy();
  return (
    <>
      <For each={props.answers.actions().filter((a) => a !== "remove" && (props.show?.(a) ?? true))}>
        {(a) => (
          <button
            type="button"
            class={`button button-sm${a === "try-again" ? "" : " button-primary"}`}
            aria-label={answerAria(a, e().branch)}
            disabled={busy()}
            aria-busy={props.answers.act.busy() === a ? "true" : undefined}
            onClick={(ev) => {
              ev.stopPropagation();
              props.answers.doAct(a);
            }}
          >
            {DECISION_ACTION_LABEL[a]}
          </button>
        )}
      </For>
      <Show when={props.answers.inChat() && e().session}>
        <a class="button button-sm" href={chatHref(props.projectId, e().session!, props.chatOf)} aria-label={`Answer about ${e().branch} in its chat`} title="You answer in the chat's message box." onClick={(ev) => ev.stopPropagation()}>
          Answer in Chat
        </a>
      </Show>
      <button
        type="button"
        class="button button-sm"
        aria-label={answerAria("remove", e().branch)}
        title="Takes it off the queue. Its branch, folder, commits and drafts stay."
        disabled={busy()}
        aria-busy={props.answers.act.busy() === "remove" ? "true" : undefined}
        onClick={(ev) => {
          ev.stopPropagation();
          props.answers.doAct("remove");
        }}
      >
        Remove from Queue
      </button>
    </>
  );
}

/** The run page's block for a branch that waits for you: what it waits on, in the Needs you row's words and answers. */
export function EntryDecision(props: { projectId: string; root: string; target: string; entry: MergeEntry; view?: MergeQueueView; chatOf?: ChatOf; onChanged?(): void }) {
  const answers = createEntryAnswers({ projectId: props.projectId, root: () => props.root, entry: () => props.entry, threadPath: () => props.view?.thread?.path, onChanged: () => props.onChanged?.() });
  return (
    <Show when={answersHere(props.entry)}>
      <div class="mq-card mq-decision" role="group" aria-labelledby="mq-decision-title" data-branch={props.entry.branch}>
        <div class="cluster">
          <h3 class="text-heading-s" id="mq-decision-title">
            Waiting for you
          </h3>
          <QueueChip row={{ label: waitingTitle(props.entry), tone: "warn" }} />
        </div>
        <DecisionLines entry={props.entry} target={props.target} />
        <Show when={!openDecision(props.entry) && props.entry.state === "drafts-changed"}>
          <p class="list-meta">{props.entry.reason ?? "Its spec drafts changed after you approved. Land again to approve them as they are now."}</p>
        </Show>
        <Show when={answers.act.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
        <div class="button-row mq-card-actions">
          <DecisionButtons projectId={props.projectId} entry={props.entry} answers={answers} chatOf={props.chatOf} />
        </div>
      </div>
    </Show>
  );
}
