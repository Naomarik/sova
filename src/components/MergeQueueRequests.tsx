import { createSignal, For, Show, type JSX } from "solid-js";
import "./MergeQueueRequests.css";
import { short } from "../lib/merge-queue";
import { landBranch, refusal } from "../lib/merge-queue-client";
import {
  behindWords,
  publishBlocked,
  publishLabel,
  requestActionLabel,
  requestActions,
  requestChecksWords,
  requestChip,
  requestReason,
  waitingOnHostHead,
  type RequestView,
  type RequestAction,
  type RequestState,
} from "../lib/merge-queue-requests";
import { publishRequest, updateLocalMain } from "../lib/merge-queue-requests-client";
import { announce, toast } from "../lib/ui-state";
import { QueueChip } from "./WorktreesModal";

/** What these parts read off an entry (contract §8): its id, branch, state, reason, newer commits and its request. */
export interface RequestEntry {
  id: string;
  branch: string;
  state: RequestState | "landed";
  reason?: string;
  newerCommits?: number;
  request?: RequestView;
}

/** One pending action at a time; a refusal shows beside it and is announced. */
function useRun() {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const run = async (key: string, call: () => Promise<string | null>, done: string | (() => string), onDone?: () => void) => {
    if (busy()) return;
    setBusy(key);
    setError(null);
    try {
      const no = await call();
      if (no) {
        setError(no);
        announce(no);
      } else {
        const said = typeof done === "function" ? done() : done;
        toast(said);
        announce(said);
        onDone?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run };
}

/** The chip, its line and its actions for an entry past Sova's checks (requested, pushed, closed, landed by the host). */
export function RequestStatus(props: { entry: RequestEntry; root: string; target: string; head?: string; readOnly?: boolean; noChip?: boolean; onChanged?(): void; onReview?(): void }) {
  const e = () => props.entry;
  const chip = () => requestChip(e().state, e().request, e().reason);
  const reason = () => requestReason(e().state, e().request, props.target, e().reason);
  const actions = () => (props.readOnly ? [] : requestActions(e().state, e().request, { newerCommits: e().newerCommits, reason: e().reason }));
  const act = useRun();
  const doAct = (a: RequestAction) => {
    if (a === "review") return props.onReview?.();
    if (a === "land-again")
      return void act.run(a, async () => refusal(await landBranch(props.root, e().branch, props.head ? { commit: props.head } : {})), `Queued ${e().branch} again.`, props.onChanged);
  };
  return (
    <div class="mq-request" data-state={e().state} data-branch={e().branch}>
      <Show when={!props.noChip}>
        <p class="cluster mq-request-head">
          <QueueChip row={chip()} />
          <Show when={e().request?.publishedHead}>{(h) => <span class="text-mono text-caption text-muted" title={h()}>{short(h())}</span>}</Show>
        </p>
      </Show>
      <Show when={reason()}>{(r) => <p class="text-caption mq-card-line">{r()}</p>}</Show>
      <Show when={actions().length}>
        <div class="button-row mq-request-actions">
          <For each={actions()}>
            {(a) => (
              <Show
                when={a !== "open-host"}
                fallback={
                  <a class="button button-sm" href={e().request?.url} target="_blank" rel="noopener noreferrer">
                    {requestActionLabel(a, e().request)}
                  </a>
                }
              >
                <button
                  type="button"
                  class={`button button-sm${a === "review" || a === "land-again" ? " button-primary" : ""}`}
                  aria-label={`${requestActionLabel(a, e().request)} ${e().branch}`}
                  disabled={!!act.busy()}
                  aria-busy={act.busy() === a ? "true" : undefined}
                  onClick={() => doAct(a)}
                >
                  {requestActionLabel(a, e().request)}
                </button>
              </Show>
            )}
          </For>
        </div>
      </Show>
      <Show when={act.error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
    </div>
  );
}

/**
 * The review before Sova publishes a request (q10): the title, the description and draft-or-ready (ready by default),
 * with the request skill folder's checks on the text Sova wrote. Nothing reaches the host until Publish.
 */
export function RequestReview(props: { entry: RequestEntry; target: string; onDone?(): void; onCancel?(): void }) {
  const p = () => props.entry.request;
  const text = () => p()?.text;
  const [title, setTitle] = createSignal(text()?.title ?? "");
  const [body, setBody] = createSignal(text()?.body ?? "");
  const [draft, setDraft] = createSignal(text()?.draft ?? false);
  const edited = () => title() !== (text()?.title ?? "") || body() !== (text()?.body ?? "");
  const held = () => publishBlocked(title());
  const how = () => p()?.how ?? "github-pr";
  const act = useRun();
  const id = () => `mq-req-${props.entry.id}`;
  const publish = () =>
    void act.run(
      "publish",
      async () => {
        const r = await publishRequest(props.entry.id, { title: title().trim(), body: body(), draft: draft() });
        return r.ok ? null : r.message;
      },
      `${publishLabel(how(), draft())}: ${props.entry.branch}.`,
      props.onDone,
    );
  return (
    <form
      class="mq-request-review stack-2"
      aria-label={`Review the request for ${props.entry.branch}`}
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!held()) publish();
      }}
    >
      <p class="text-caption">
        Into <span class="text-mono">{props.target}</span> from <span class="text-mono">{p()?.branch ?? props.entry.branch}</span>. Nothing goes to the host until you publish.
      </p>
      <div class="field">
        <label class="field-label" for={`${id()}-title`}>
          Title
        </label>
        <input id={`${id()}-title`} class="input" value={title()} disabled={!!act.busy()} onInput={(e) => setTitle(e.currentTarget.value)} aria-invalid={held() ? "true" : undefined} />
      </div>
      <div class="field">
        <label class="field-label" for={`${id()}-body`}>
          Description
        </label>
        <textarea id={`${id()}-body`} class="textarea" rows="8" value={body()} disabled={!!act.busy()} onInput={(e) => setBody(e.currentTarget.value)} />
      </div>
      <label class="toggle">
        <input type="checkbox" checked={draft()} disabled={!!act.busy()} onChange={(e) => setDraft(e.currentTarget.checked)} />
        <span class="toggle-box" aria-hidden="true" />
        <span>Open as a draft</span>
      </label>
      <div class="mq-request-checks" role="group" aria-label="Request folder checks">
        <p class="text-caption text-muted">{requestChecksWords(p()?.folder, text()?.checks)}</p>
        <Show when={text()?.checks?.length}>
          <ul class="mq-request-checklist text-caption">
            <For each={text()!.checks}>
              {(c) => (
                <li data-ok={c.ok ? "true" : "false"}>
                  <QueueChip row={c.ok ? { label: "Passed", tone: "success" } : { label: "Failed", tone: "error" }} /> {c.name}
                  <Show when={c.why}>
                    <span class="text-muted"> · {c.why}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={edited() && text()?.checks?.length}>
          <p class="text-caption text-muted">These ran on the text Sova wrote, before your edits.</p>
        </Show>
      </div>
      <Show when={held()}>{(m) => <p class="text-caption mq-error">{m()}</p>}</Show>
      <Show when={act.error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
      <div class="button-row">
        <button type="submit" class="button button-sm button-primary" disabled={!!act.busy() || !!held()} aria-busy={act.busy() === "publish" ? "true" : undefined}>
          {publishLabel(how(), draft())}
        </button>
        <Show when={props.onCancel}>
          <button type="button" class="button button-sm button-ghost" disabled={!!act.busy()} onClick={() => props.onCancel?.()}>
            Cancel
          </button>
        </Show>
      </div>
    </form>
  );
}

/** "Local main is 3 commits behind" with Update Local Main (q11): nothing on this computer moves until you press it.
 *  With uncommitted edits in the project folder the button is held and says why. */
export function LocalBehind(props: { project: string; target: string; behind?: number; blocked?: string; onChanged?(): void }) {
  const words = () => behindWords(props.target, props.behind);
  const act = useRun();
  const [done, setDone] = createSignal("");
  return (
    <Show when={words()}>
      {(w) => (
        <div class="mq-behind" role="group" aria-label={w()}>
          <p class="text-caption">{w()}.</p>
          <button
            type="button"
            class="button button-sm"
            disabled={!!act.busy() || !!props.blocked}
            aria-busy={act.busy() ? "true" : undefined}
            aria-describedby={props.blocked ? `mq-behind-why-${props.project}` : undefined}
            onClick={() =>
              void act.run(
                "update",
                async () => {
                  const r = await updateLocalMain(props.project);
                  if (!r.ok) return r.message;
                  setDone(r.body.kind === "current" ? `Local ${props.target} is already current.` : `Updated local ${props.target}.`);
                  return null;
                },
                done,
                props.onChanged,
              )
            }
          >
            Update Local Main
          </button>
          <Show when={props.blocked}>
            {(m) => (
              <p class="text-caption text-muted mq-behind-why" id={`mq-behind-why-${props.project}`}>
                {m()}
              </p>
            )}
          </Show>
          <Show when={act.error()}>{(m) => <p class="text-caption mq-error mq-behind-why" role="alert">{m()}</p>}</Show>
        </div>
      )}
    </Show>
  );
}

/** One entry past Sova's checks as a queue row: the branch, where it came from, its host state, or the review form. */
export function RequestRow(props: { root: string; target: string; entry: RequestEntry; from?: JSX.Element; onChanged?(): void }) {
  const [reviewing, setReviewing] = createSignal(false);
  const e = () => props.entry;
  return (
    <li class="list-row mq-row" data-branch={e().branch} data-state={e().state}>
      <div class="list-main">
        <p class="list-title cluster">
          <span class="text-mono">{e().branch}</span>
        </p>
        <Show when={reviewing() && e().state === "request-review"} fallback={<RequestStatus entry={e()} root={props.root} target={props.target} onChanged={props.onChanged} onReview={() => setReviewing(true)} />}>
          <RequestReview
            entry={e()}
            target={props.target}
            onDone={() => {
              setReviewing(false);
              props.onChanged?.();
            }}
            onCancel={() => setReviewing(false)}
          />
        </Show>
        <Show when={props.from}>
          <p class="list-meta">{props.from}</p>
        </Show>
      </div>
    </li>
  );
}

/** The tab's Waiting on the host group: requests open on the host, closed ones and pushed branches. */
export function WaitingOnHost(props: { root: string; target: string; entries: RequestEntry[]; from?(e: RequestEntry): JSX.Element; onChanged?(): void }) {
  return (
    <Show when={props.entries.length > 0}>
      <div class="stack-2" role="group" aria-label="Waiting on the host">
        <h3 class="text-heading-s">{waitingOnHostHead(props.entries.length)}</h3>
        <ul class="list mq-list">
          <For each={props.entries}>{(e) => <RequestRow root={props.root} target={props.target} entry={e} from={props.from?.(e)} onChanged={props.onChanged} />}</For>
        </ul>
      </div>
    </Show>
  );
}
