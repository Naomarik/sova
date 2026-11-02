import { createSignal, For, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { SessionWorktreeInfo } from "../../shared/protocol";
import { queueRow, rowsSummary, type MergeProjectInfo, type QueueRow, type WorktreeQueueInfo } from "../lib/merge-queue";
import { answerEntry, cancelEntry, land, refusal, type LandOptions } from "../lib/merge-queue-client";
import { mergeRunHref, projectTabHref } from "../lib/projects-route";
import { tildePath } from "../lib/format";
import { announce, home, toast } from "../lib/ui-state";
import { ActionMenu } from "./ActionMenu";
import { Icon, trapFocus } from "./ui";

/** A tracked worktree with the queue's facts (SessionWorktreeInfo.queue, filled by the server). */
export type QueueWorktree = SessionWorktreeInfo & { queue?: WorktreeQueueInfo; mergeProject?: MergeProjectInfo };

/** The worktree's project id: its own facts, else its entry's. */
const projectIdOf = (w: QueueWorktree): string | undefined => w.mergeProject?.id ?? w.queue?.project;

const chipClass = (r: Pick<QueueRow, "tone" | "live">) => `chip${r.tone === "neutral" ? "" : ` chip-${r.tone}`}${r.live ? " chip-live" : ""}`;

/** The chip: a dot and the word, never hue alone. */
export function QueueChip(props: { row: Pick<QueueRow, "label" | "tone" | "live">; title?: string }) {
  return (
    <span class={chipClass(props.row)} title={props.title}>
      <span class="chip-dot" aria-hidden="true" />
      {props.row.label}
    </span>
  );
}

/** "View Merge Queue": the worktree's project's Merge Queue tab. */
export const queueHrefOf = (rows: QueueWorktree[]): string | null => {
  const id = rows.map(projectIdOf).find(Boolean);
  return id ? projectTabHref(id, "merge-queue") : null;
};

/**
 * One worktree in the queue's words, with its one action (§ the composer modal and the session pane
 * draw the same rows from the same state, so they always agree): Land on a ready one (its ▾ holds
 * Land Without Review and Land Without Its Specs…), Cancel on a queued one, Accept or Land Anyway
 * beside Send Back where it waits for you, Set Up Queue where the project has none.
 */
export function WorktreeQueueRow(props: {
  worktree: QueueWorktree;
  showPath?: boolean;
  onChanged?(): void;
  /** More chips after the state (the pane's: workers, .agent). */
  chips?: JSX.Element;
  /** More actions after the row's own (the pane's Review Changes). */
  extra?: JSX.Element;
}) {
  const w = () => props.worktree;
  const row = () => queueRow(w());
  const projectId = () => projectIdOf(w());
  const entry = () => w().queue;
  /** The menu's Land Without Review: only where the project has a review kit. */
  const review = () => w().mergeProject?.review ?? w().queue?.review ?? false;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [askSpecs, setAskSpecs] = createSignal(false);

  const run = async (what: string, call: () => Promise<{ ok: boolean; error?: { message: string } } & object>, done: string) => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await call();
      const no = refusal(r);
      if (no) {
        setError(no);
        announce(`${what} refused: ${no}`);
      } else {
        toast(done);
        announce(done);
        props.onChanged?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const doLand = (o: LandOptions = {}) =>
    void run("Land", () => land(w().path, o), `Queued ${w().branch}${o.withoutReview ? " without review" : ""}${o.withoutSpecs ? " without its specs" : ""}.`);
  const e = () => entry()!;

  return (
    <li class="list-row wt-queue-row" data-branch={w().branch} data-state={row().key}>
      <div class="list-main">
        <p class="list-title text-mono wt-queue-branch" title={w().path}>
          {w().branch}
        </p>
        <Show when={props.showPath !== false}>
          <p class="list-meta text-mono wt-queue-path">{tildePath(w().path, home())}</p>
        </Show>
        <div class="wt-queue-facts">
          <QueueChip row={row()} />
          <Show when={row().detail}>{(d) => <span class="text-caption text-mono">{d()}</span>}</Show>
          {props.chips}
        </div>
        <Show when={row().newer}>{(n) => <p class="list-meta wt-queue-reason">{n()}</p>}</Show>
        <Show when={row().reason}>
          {(why) => (
            <p class="list-meta wt-queue-reason">
              {why()}
              <Show when={row().run && projectId() && row().key !== "queued"}>
                {" "}
                <a href={mergeRunHref(projectId()!, row().run!)}>See Why</a>
              </Show>
            </p>
          )}
        </Show>
        <For each={row().notes}>
          {(n) => (
            <p class="list-meta wt-queue-note">
              <span class="text-muted">{n.label}:</span> {n.text}
            </p>
          )}
        </For>
        <Show when={askSpecs()}>
          <div class="wt-queue-confirm" role="group" aria-label={`Land ${w().branch} without its specs`}>
            <p class="text-caption">Its spec drafts stay drafts in this worktree. Only the code lands.</p>
            <div class="button-row">
              <button
                type="button"
                class="button button-sm"
                disabled={busy()}
                onClick={() => {
                  setAskSpecs(false);
                  doLand({ withoutSpecs: true });
                }}
              >
                Land Without Specs
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={() => setAskSpecs(false)}>
                Cancel
              </button>
            </div>
          </div>
        </Show>
        <Show when={error()}>{(m) => <p class="list-meta wt-queue-error" role="alert">{m()}</p>}</Show>
      </div>
      <div class="wt-queue-act">
        <Show when={row().action === "land"}>
          <div class="button-split">
            <button type="button" class="button button-sm" aria-label={`Land ${w().branch}`} disabled={busy()} aria-busy={busy() ? "true" : undefined} onClick={() => doLand()}>
              Land
            </button>
            <ActionMenu label={`More ways to land ${w().branch}`} title="More ways to land" icon="chevron-down" ghost={false} menuName={`Land ${w().branch}`} returnFocus>
              {(menu) => (
                <>
                  <Show when={review()}>
                    <menu.Item label="Land Without Review" aria={`Land ${w().branch} without review`} description="Skips the review step for this merge only." onRun={() => doLand({ withoutReview: true })} />
                  </Show>
                  <menu.Item label="Land Without Its Specs…" aria={`Land ${w().branch} without its specs`} description="Its spec drafts stay drafts." onRun={() => setAskSpecs(true)} />
                </>
              )}
            </ActionMenu>
          </div>
        </Show>
        <Show when={row().action === "setup" && projectId()}>
          <a class="button button-sm" href={projectTabHref(projectId()!, "merge-queue")} title="This project's merge queue isn't set up yet.">
            Set Up Queue
          </a>
        </Show>
        <Show when={row().action === "cancel"}>
          <button type="button" class="button button-sm" aria-label={`Cancel landing ${w().branch}`} disabled={busy()} onClick={() => void run("Cancel", () => cancelEntry(e()), `Cancelled landing ${w().branch}.`)}>
            Cancel
          </button>
        </Show>
        <Show when={row().action === "accept"}>
          <button type="button" class="button button-sm button-primary" aria-label={`Accept the resolution for ${w().branch}`} disabled={busy()} onClick={() => void run("Accept", () => answerEntry(e(), "accept"), `Accepted the resolution for ${w().branch}.`)}>
            Accept
          </button>
        </Show>
        <Show when={row().action === "land-anyway"}>
          <button type="button" class="button button-sm button-primary" aria-label={`Land ${w().branch} anyway`} disabled={busy()} onClick={() => void run("Land Anyway", () => answerEntry(e(), "land-anyway"), `Landing ${w().branch} anyway.`)}>
            Land Anyway
          </button>
        </Show>
        <Show when={row().sendBack}>
          <button type="button" class="button button-sm button-destructive" aria-label={`Send ${w().branch} back to its chat`} disabled={busy()} onClick={() => void run("Send Back", () => answerEntry(e(), "send-back"), `Sent ${w().branch} back to its chat.`)}>
            Send Back
          </button>
        </Show>
        {props.extra}
      </div>
    </li>
  );
}

/** The rows, in the order the chat tracks them. */
export function WorktreeQueueList(props: { rows: QueueWorktree[]; showPath?: boolean; onChanged?(): void }) {
  return (
    <ul class="list wt-queue-list">
      <For each={props.rows}>{(w) => <WorktreeQueueRow worktree={w} showPath={props.showPath} onChanged={props.onChanged} />}</For>
    </ul>
  );
}

/** The composer control's modal: this chat's worktrees, each with its one action, and View Merge Queue. */
export function WorktreesModal(props: { title: string; rows: QueueWorktree[]; onClose(): void; onChanged?(): void }) {
  const summary = () => rowsSummary(props.rows.map((w) => queueRow(w)));
  const target = () => props.rows.find((w) => w.mergeProject)?.mergeProject?.target ?? "the target branch";
  const href = () => queueHrefOf(props.rows);
  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal wt-queue-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wt-queue-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.defaultPrevented) props.onClose();
        }}
      >
        <div class="modal-head wt-queue-head">
          <div>
            <h2 class="modal-title" id="wt-queue-title">
              Worktrees
            </h2>
            <p class="text-caption text-muted">
              {props.title} · {summary()}
            </p>
          </div>
          <button type="button" class="button button-ghost button-icon" aria-label="Close" onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">
          <p class="text-caption wt-queue-intro">
            Land queues a branch. It's merged onto {target()}, checked there on its own, and lands as exactly the commit that was tested.
          </p>
          <WorktreeQueueList rows={props.rows} onChanged={props.onChanged} />
        </div>
        <div class="modal-foot">
          <Show when={href()}>
            {(h) => (
              <a class="button button-ghost" href={h()} onClick={() => props.onClose()}>
                View Merge Queue
              </a>
            )}
          </Show>
          <button type="button" class="button" onClick={() => props.onClose()}>
            Close
          </button>
        </div>
      </div>
    </Portal>
  );
}
