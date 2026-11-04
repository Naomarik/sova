import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { SessionWorktreeInfo } from "../../shared/protocol";
import { modalHead, queueRow, rowButtons, rowsSummary, shownCommit, unclearLine, type MergeProjectInfo, type QueueRow, type WorktreeQueueInfo } from "../lib/merge-queue";
import { answerEntry, cancelEntry, land, refusal, type LandOptions } from "../lib/merge-queue-client";
import { mergeRunHref, projectSessionHref, projectTabHref } from "../lib/projects-route";
import { tildePath } from "../lib/format";
import { announce, home, toast } from "../lib/ui-state";
import { ActionMenu } from "./ActionMenu";
import type { MergeUnclear } from "../../shared/merge-queue";
import { Icon, trapFocus } from "./ui";
import { canReviewChanges } from "../lib/worktrees";
import { ReviewChangesButton } from "./ReviewChanges";

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

/** Land and its ▾: Land Without Review (only with a review kit) and Land Without Its Specs…, which asks first. */
export function LandSplit(props: { branch: string; review: boolean; busy: boolean; onLand(o?: LandOptions): void; onWithoutSpecs(): void }) {
  return (
    <div class="button-split wt-queue-split">
      <button type="button" class="button button-sm" aria-label={`Land ${props.branch}`} disabled={props.busy} aria-busy={props.busy ? "true" : undefined} onClick={() => props.onLand()}>
        Land
      </button>
      <ActionMenu label={`More ways to land ${props.branch}`} title="More ways to land" icon="chevron-down" ghost={false} menuName={`Land ${props.branch}`} returnFocus>
        {(menu) => (
          <>
            <Show when={props.review}>
              <menu.Item label="Land Without Review" aria={`Land ${props.branch} without review`} description="Skips the review step for this merge only." onRun={() => props.onLand({ withoutReview: true })} />
            </Show>
            <menu.Item label="Land Without Its Specs…" aria={`Land ${props.branch} without its specs`} description="Its spec drafts stay drafts." onRun={() => props.onWithoutSpecs()} />
          </>
        )}
      </ActionMenu>
    </div>
  );
}

/** Land Without Its Specs…: what stays behind, then the choice. */
export function LandSpecsConfirm(props: { branch: string; busy: boolean; onConfirm(): void; onCancel(): void }) {
  return (
    <div class="wt-queue-confirm" role="group" aria-label={`Land ${props.branch} without its specs`}>
      <p class="text-caption">Its spec drafts stay drafts in this worktree. Only the code lands.</p>
      <div class="button-row">
        <button type="button" class="button button-sm" disabled={props.busy} onClick={() => props.onConfirm()}>
          Land Without Specs
        </button>
        <button type="button" class="button button-sm button-ghost" onClick={() => props.onCancel()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Can't tell whose failure: each check that failed on both sides, with a link to its run's logs. */
export function UnclearChecks(props: { projectId?: string; unclear?: MergeUnclear[]; target?: string; class?: string }) {
  return (
    <Show when={props.unclear?.length}>
      <ul class={`mq-unclear text-caption${props.class ? ` ${props.class}` : ""}`} aria-label="Checks that failed on both sides">
        <For each={props.unclear}>
          {(u) => (
            <li>
              {unclearLine(u, props.target)}
              <Show when={props.projectId}>
                {(pid) => (
                  <>
                    {" "}
                    <a href={mergeRunHref(pid(), u.run)} aria-label={`Log of ${u.label}`}>
                      Log
                    </a>
                  </>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
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
 * beside Send Back where it waits for you, Land This Commit Again and Remove from Queue where it was
 * sent back, Set Up Queue where the project has none.
 */
export function WorktreeQueueRow(props: {
  worktree: QueueWorktree;
  showPath?: boolean;
  onChanged?(): void;
  /** More chips after the state (the pane's: workers, .agent). */
  chips?: JSX.Element;
  /** More actions after the row's own. */
  extra?: JSX.Element;
  /** The chat whose worktree it is: the row gets Review Changes (an active worktree with commits of its own), the
      branch against where it lands with its uncommitted files marked (§chat.changes/entry). */
  review?: { sessionPath: string; cwd?: string };
}) {
  const w = () => props.worktree;
  const row = () => queueRow(w());
  const projectId = () => projectIdOf(w());
  const buttons = () => rowButtons(row(), projectId());
  const entry = () => w().queue;
  /** The menu's Land Without Review: only where the project has a review kit. */
  const review = () => w().mergeProject?.review ?? w().queue?.reviewKit ?? false;
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
    void run("Land", () => land(w().path, { ...o, commit: shownCommit(w()) }), `Queued ${w().branch}${o.withoutReview ? " without review" : ""}${o.withoutSpecs ? " without its specs" : ""}.`);
  const e = () => entry()!;

  return (
    <li class="list-row wt-queue-row" data-branch={w().branch} data-state={row().key}>
      <div class="list-main">
        <p class="list-title text-mono wt-queue-branch" title={w().path}>
          {w().branch}
        </p>
        <Show when={props.showPath !== false}>
          <p class="list-meta text-mono wt-queue-path" title={w().path}>
            <span class="wt-queue-path-full">{tildePath(w().path, home())}</span>
            <span class="wt-queue-path-last">{w().path.replace(/\/+$/, "").split("/").pop() || w().path}</span>
          </p>
        </Show>
        <div class="wt-queue-facts">
          <QueueChip row={row()} />
          <Show when={row().detail}>{(d) => <span class="text-caption text-mono">{d()}</span>}</Show>
          <Show when={row().size}>{(z) => <span class="text-caption text-mono wt-queue-size">{z()}</span>}</Show>
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
        <Show when={row().key === "unattributed"}>
          <UnclearChecks projectId={projectId()} unclear={w().queue?.unclear} target={w().mergeProject?.target} />
        </Show>
        <Show when={w().queue?.reviewer}>
          {(rv) => (
            <p class="list-meta wt-queue-reviewer">
              <span class="text-muted">{rv().state === "running" ? "Review running" : `Review: ${rv().state === "failed" ? "no verdict" : rv().state}`}</span>
              <Show when={!rv().cleared} fallback={<span class="text-muted"> · Reviewer chat cleared</span>}>
                {" · "}
                <a href={projectId() ? projectSessionHref(projectId()!, rv().path) : `#/s/${encodeURIComponent(rv().path)}`}>Open Reviewer Chat</a>
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
          <LandSpecsConfirm
            branch={w().branch}
            busy={busy()}
            onConfirm={() => {
              setAskSpecs(false);
              doLand({ withoutSpecs: true });
            }}
            onCancel={() => setAskSpecs(false)}
          />
        </Show>
        <Show when={error()}>{(m) => <p class="list-meta wt-queue-error" role="alert">{m()}</p>}</Show>
      </div>
      <div class="wt-queue-act">
        <Show when={props.review && canReviewChanges(w())}>
          <ReviewChangesButton
            branch={w().branch}
            class="wt-queue-review"
            scope={() => ({ kind: "worktree", sessionPath: props.review!.sessionPath, worktreePath: w().path, uncommitted: true })}
            cwd={props.review!.cwd}
          />
        </Show>
        <Show when={buttons().includes("Land")}>
          <LandSplit branch={w().branch} review={review()} busy={busy()} onLand={doLand} onWithoutSpecs={() => setAskSpecs(true)} />
        </Show>
        <Show when={buttons().includes("Set Up Queue")}>
          <a class="button button-sm" href={projectTabHref(projectId()!, "merge-queue")} title="This project's merge queue isn't set up yet.">
            Set Up Queue
          </a>
        </Show>
        <Show when={buttons().includes("Cancel")}>
          <button type="button" class="button button-sm" aria-label={`Cancel landing ${w().branch}`} disabled={busy()} onClick={() => void run("Cancel", () => cancelEntry(e()), `Cancelled landing ${w().branch}.`)}>
            Cancel
          </button>
        </Show>
        <Show when={buttons().includes("Accept")}>
          <button type="button" class="button button-sm button-primary" aria-label={`Accept the resolution for ${w().branch}`} disabled={busy()} onClick={() => void run("Accept", () => answerEntry(e(), "accept"), `Accepted the resolution for ${w().branch}.`)}>
            Accept
          </button>
        </Show>
        <Show when={buttons().includes("Land Anyway")}>
          <button type="button" class="button button-sm button-primary" aria-label={`Land ${w().branch} anyway`} disabled={busy()} onClick={() => void run("Land Anyway", () => answerEntry(e(), "land-anyway"), `Landing ${w().branch} anyway.`)}>
            Land Anyway
          </button>
        </Show>
        <Show when={buttons().includes("Send Back")}>
          <button type="button" class="button button-sm button-destructive" aria-label={`Send ${w().branch} back to its chat`} disabled={busy()} onClick={() => void run("Send Back", () => answerEntry(e(), "send-back"), `Sent ${w().branch} back to its chat.`)}>
            Send Back
          </button>
        </Show>
        <Show when={buttons().includes("Land This Commit Again")}>
          <button
            type="button"
            class="button button-sm"
            aria-label={`Land ${w().branch} at this commit again`}
            title="Approve the same commit again: every check runs from the start."
            disabled={busy()}
            onClick={() => void run("Land This Commit Again", () => land(w().path, { commit: e().commit }), `Queued ${w().branch} at ${e().commit.slice(0, 7)} again.`)}
          >
            Land This Commit Again
          </button>
        </Show>
        <Show when={buttons().includes("Remove from Queue")}>
          <button
            type="button"
            class="button button-sm"
            aria-label={`Remove ${w().branch} from the merge queue`}
            title="Takes it off the queue. Its branch, folder, commits and drafts stay."
            disabled={busy()}
            onClick={() => void run("Remove from Queue", () => cancelEntry(e()), `Removed ${w().branch} from the merge queue.`)}
          >
            Remove from Queue
          </button>
        </Show>
        {props.extra}
      </div>
    </li>
  );
}

/** The rows, in the order the chat tracks them. */
export function WorktreeQueueList(props: { rows: QueueWorktree[]; showPath?: boolean; onChanged?(): void; review?: { sessionPath: string; cwd?: string } }) {
  return (
    <ul class="list wt-queue-list">
      <For each={props.rows}>{(w) => <WorktreeQueueRow worktree={w} showPath={props.showPath} onChanged={props.onChanged} review={props.review} />}</For>
    </ul>
  );
}

/** The composer control's modal: this chat's worktrees, each with its one action, and View Merge Queue. */
export function WorktreesModal(props: { title: string; rows: QueueWorktree[]; onClose(): void; onChanged?(): void; review?: { sessionPath: string; cwd?: string } }) {
  const summary = () => rowsSummary(props.rows.map((w) => queueRow(w)));
  /** The queue's intro and paused line: only where some row's repo is one the queue serves. */
  const head = () => modalHead(props.rows);
  const href = () => queueHrefOf(props.rows);
  // Escape closes it wherever focus is (an action's button goes busy and can drop focus to the page),
  // unless a menu inside is open (the key is that menu's: it closes itself) or the changes viewer is open over it
  // (the key closes the viewer, and this stays).
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(":popover-open") && !document.querySelector(".changes-dialog")) props.onClose();
  };
  document.addEventListener("keydown", onKey);
  onCleanup(() => document.removeEventListener("keydown", onKey));
  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal wt-queue-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wt-queue-title"
        ref={(el) => trapFocus(el)}
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
          <Show when={head().intro}>{(t) => <p class="text-caption wt-queue-intro">{t()}</p>}</Show>
          <Show when={head().paused}>{(t) => <p class="text-caption wt-queue-paused">{t()}</p>}</Show>
          <WorktreeQueueList rows={props.rows} onChanged={props.onChanged} review={props.review} />
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
