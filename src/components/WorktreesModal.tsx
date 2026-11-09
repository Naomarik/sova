import { createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { SessionWorktreeInfo } from "../../shared/protocol";
import { landConfirmWords, modalHead, queueRow, rowButtons, rowsSummary, shownCommit, unclearLine, type MergeProjectInfo, type QueueRow, type WorktreeQueueInfo } from "../lib/merge-queue";
import { answerEntry, cancelEntry, land, refusal, type LandOptions } from "../lib/merge-queue-client";
import { mergeRunHref, projectSessionHref, projectTabHref } from "../lib/projects-route";
import { announce, toast } from "../lib/ui-state";
import { BranchSummaryView } from "./BranchSummary";
import { ActionMenu } from "./ActionMenu";
import type { LandHow, MergeUnclear } from "../../shared/merge-queue";
import { Icon, trapFocus } from "./ui";
import { canReviewChanges } from "../lib/worktrees";
import { placeOf, queueLinksOf } from "../lib/branch-place";
import { BranchPlaceLine } from "./BranchPlaceLine";
import { ReviewChangesButton } from "./ReviewChanges";
import { paneScopedId, usePaneScope } from "../lib/pane-scope";

/** A tracked worktree with the queue's facts (SessionWorktreeInfo.queue, filled by the server). */
export type QueueWorktree = SessionWorktreeInfo & { queue?: WorktreeQueueInfo; mergeProject?: MergeProjectInfo };

/** Where the row's owner chat opens: its own route when its file is known, else the id route the app resolves. */
const ownerHref = (o: NonNullable<SessionWorktreeInfo["mergeOwner"]>, projectId: string | undefined): string =>
  o.path ? (projectId ? projectSessionHref(projectId, o.path) : `#/s/${encodeURIComponent(o.path)}`) : `#/sid/${encodeURIComponent(o.session)}`;

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

/** Land and its ▾: Land asks first (onAsk opens the row's confirm); the ▾ holds Land Without Review (only with a
    review kit), which lands at once, and Land Without Its Specs…, which asks first. */
export function LandSplit(props: { branch: string; review: boolean; busy: boolean; onAsk(): void; onLand(o?: LandOptions): void; onWithoutSpecs(): void }) {
  return (
    <div class="button-split wt-queue-split">
      <button type="button" class="button button-sm wt-queue-land" data-land="" aria-label={`Land ${props.branch}`} disabled={props.busy} aria-busy={props.busy ? "true" : undefined} onClick={() => props.onAsk()}>
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

/** A row's confirm: it replaces the row's actions, right-aligned under the row. Its action takes focus when it opens;
    Escape is the same as its cancel, and never closes the dialog around it. */
export function LandConfirmBox(props: { label: string; title: string; line: string; confirm: string; cancel: string; busy: boolean; onConfirm(): void; onCancel(): void }) {
  let primary: HTMLButtonElement | undefined;
  onMount(() => primary?.focus());
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    props.onCancel();
  };
  return (
    <div class="wt-queue-confirm" role="group" aria-label={props.label} on:keydown={onKey}>
      <p class="wt-queue-confirm-title">{props.title}</p>
      <p class="text-caption wt-queue-confirm-line">{props.line}</p>
      <div class="button-row wt-queue-confirm-act">
        <button type="button" class="button button-sm button-ghost" onClick={() => props.onCancel()}>
          {props.cancel}
        </button>
        <button type="button" class="button button-sm button-primary" ref={(el) => (primary = el)} disabled={props.busy} onClick={() => props.onConfirm()}>
          {props.confirm}
        </button>
      </div>
    </div>
  );
}

/** Land Without Its Specs…: what stays behind, then the choice. */
export function LandSpecsConfirm(props: { branch: string; busy: boolean; onConfirm(): void; onCancel(): void }) {
  return (
    <LandConfirmBox
      label={`Land ${props.branch} without its specs`}
      title={`Land ${props.branch} without its specs?`}
      line="Its spec drafts stay drafts in this worktree. Only the code lands."
      cancel="Cancel"
      confirm="Land Without Specs"
      busy={props.busy}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}

/** Which confirm a row has open: Land's or Land Without Its Specs…'s. Closing one by its cancel puts focus back on
    what opened it (Land, or the ▾ for the specs one). */
export function createLandConfirm() {
  const [ask, setAsk] = createSignal<"land" | "specs" | null>(null);
  let row: HTMLElement | undefined;
  const close = (back: boolean) => {
    const was = ask();
    setAsk(null);
    if (!back || !row) return;
    const to = row.querySelector<HTMLElement>(was === "specs" ? '.wt-queue-split > [aria-haspopup="menu"]' : "[data-land]");
    to?.focus();
  };
  return { ask, open: (k: "land" | "specs") => setAsk(k), close, rowRef: (el: HTMLElement) => (row = el) };
}
export type LandConfirm = ReturnType<typeof createLandConfirm>;

/** The open confirm, if any, for a row whose Land runs `onLand`. */
export function LandConfirms(props: { confirm: LandConfirm; branch: string; ahead?: number; target?: string; how?: LandHow; place?: string; busy: boolean; onLand(o?: LandOptions): void }) {
  const words = () => landConfirmWords(props.branch, props.ahead, props.target, props.how, props.place);
  return (
    <Switch>
      <Match when={props.confirm.ask() === "land"}>
        <LandConfirmBox
          label={`Land ${props.branch}`}
          title={words().title}
          line={words().line}
          cancel="Not Yet"
          confirm={words().confirm}
          busy={props.busy}
          onConfirm={() => {
            props.confirm.close(false);
            props.onLand();
          }}
          onCancel={() => props.confirm.close(true)}
        />
      </Match>
      <Match when={props.confirm.ask() === "specs"}>
        <LandSpecsConfirm
          branch={props.branch}
          busy={props.busy}
          onConfirm={() => {
            props.confirm.close(false);
            props.onLand({ withoutSpecs: true });
          }}
          onCancel={() => props.confirm.close(true)}
        />
      </Match>
    </Switch>
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

/**
 * One worktree in the queue's words, with its one action (§ the composer modal and the session pane
 * draw the same rows from the same state, so they always agree): Land on a ready one, which asks first (its ▾
 * holds Land Without Review and Land Without Its Specs…), Cancel on a queued one, a decision's answers (Accept,
 * Land Anyway, Try Again, Answer in Chat) where one waits for you, Remove from Queue on every stage of an
 * approval that stands, Set Up Queue where the project has none. Nothing sends it back or lands it again: the user's
 * Land stands while its chat fixes it.
 */
export function WorktreeQueueRow(props: {
  worktree: QueueWorktree;
  onChanged?(): void;
  /** More chips after the state (the pane's: workers, .agent). */
  chips?: JSX.Element;
  /** More actions after the row's own. */
  extra?: JSX.Element;
  /** The chat whose worktree it is: the row gets Review Changes (an active worktree with commits of its own), the
      branch against where it lands with its uncommitted files marked (§chat.changes/entry). */
  review?: { sessionPath: string; cwd?: string };
  /** Answer in Chat: before focus goes to the chat's message box (the modal closes). */
  onAnswerInChat?(): void;
}) {
  const w = () => props.worktree;
  const scope = usePaneScope();
  const answerInChat = () => {
    props.onAnswerInChat?.();
    queueMicrotask(() => document.getElementById(paneScopedId(scope, "composer-input"))?.focus());
  };
  const row = () => queueRow(w());
  const projectId = () => projectIdOf(w());
  const buttons = () => rowButtons(row(), projectId());
  const entry = () => w().queue;
  /** The menu's Land Without Review: only where the project has a review kit. */
  const review = () => w().mergeProject?.review ?? w().queue?.reviewKit ?? false;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const confirm = createLandConfirm();

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
  // A decision's Land (out of tries, a fix that needs your OK, drafts changed) is its answer on the queue, after the
  // same confirmation as every Land.
  const doLand = (o: LandOptions = {}) =>
    row().decision
      ? void run("Land", () => answerEntry(e(), "land"), `Queued ${w().branch}.`)
      : void run("Land", () => land(w().path, { ...o, commit: shownCommit(w()) }), `Queued ${w().branch}${o.withoutReview ? " without review" : ""}${o.withoutSpecs ? " without its specs" : ""}.`);
  const e = () => entry()!;

  return (
    <li class="list-row wt-queue-row" classList={{ "wt-queue-asking": !!confirm.ask() }} data-branch={w().branch} data-state={row().key} ref={confirm.rowRef}>
      <div class="list-main">
        {/* The chat that owns the branch first (a link), then the branch in small mono, then "archived"; no folder. */}
        <Show
          when={w().mergeOwner}
          fallback={
            <p class="list-title text-mono wt-queue-branch" title={w().path}>
              {w().branch}
            </p>
          }
        >
          {(o) => (
            <p class="list-title mq-head-line wt-queue-head-line" title={w().path}>
              <a class="mq-chat-link" href={ownerHref(o(), projectId())}>
                {o().title ?? "its chat"}
              </a>
              <span class="mq-branch text-mono wt-queue-branch">{w().branch}</span>
              <Show when={o().archived}>
                <span class="chip mq-archived">archived</span>
              </Show>
            </p>
          )}
        </Show>
        <BranchPlaceLine row={w()} />
        <div class="wt-queue-facts">
          <QueueChip row={row()} />
          <Show when={row().detail}>{(d) => <span class="text-caption text-mono">{d()}</span>}</Show>
          {/* "3 commits · +40 −2 · 2d ago": the date is when the branch last changed, in full on hover. */}
          <Show when={row().size || row().when}>
            <span class="text-caption text-mono wt-queue-size">
              {row().size}
              <Show when={row().when}>
                {(t) => (
                  <>
                    {row().size ? " · " : ""}
                    <time class="wt-queue-when" dateTime={t().iso} title={t().full} aria-label={`last commit ${t().full}`}>
                      {t().text}
                    </time>
                  </>
                )}
              </Show>
            </span>
          </Show>
          {props.chips}
        </div>
        <Show when={w().mergeServed}>
          <BranchSummaryView summary={w().mergeSummary} projectId={projectId()} branch={w().branch} />
        </Show>
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
        <Show when={row().decision?.choices.length}>
          <p class="list-meta wt-queue-reason">
            <span class="text-muted">Choices:</span> {row().decision!.choices.join(" · ")}
          </p>
        </Show>
        <Show when={row().answer}>
          {(a) => (
            <p class="list-meta wt-queue-reason">
              <span class="text-muted">Chat:</span> {a()}
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
        <Show when={error()}>{(m) => <p class="list-meta wt-queue-error" role="alert">{m()}</p>}</Show>
      </div>
      {/* A confirm replaces the row's actions while it is open. */}
      <LandConfirms confirm={confirm} branch={w().branch} ahead={w().mergeStats?.ahead} target={w().mergeProject?.target} how={w().mergeProject?.how} place={placeOf(w())} busy={busy()} onLand={doLand} />
      <Show when={!confirm.ask()}>
      <div class="wt-queue-act">
        <Show when={props.review && canReviewChanges(w())}>
          <ReviewChangesButton
            branch={w().branch}
            class="wt-queue-review"
            scope={() => ({ kind: "worktree", sessionPath: props.review!.sessionPath, worktreePath: w().path, uncommitted: true })}
            cwd={props.review!.cwd}
          />
        </Show>
        {/* A decision's Land is its answer on the queue (out of tries, a fix that needs your OK, drafts changed). */}
        <Show when={buttons().includes("Land") && row().decision}>
          <button type="button" class="button button-sm button-primary" aria-label={`Land ${w().branch}`} disabled={busy()} onClick={() => confirm.open("land")}>
            Land
          </button>
        </Show>
        <Show when={buttons().includes("Land") && !row().decision}>
          <LandSplit branch={w().branch} review={review()} busy={busy()} onAsk={() => confirm.open("land")} onLand={doLand} onWithoutSpecs={() => confirm.open("specs")} />
        </Show>
        <Show when={buttons().includes("Set Up Queue")}>
          <a class="button button-sm" href={projectTabHref(projectId()!, "merge-queue")} title="This project's merge queue isn't set up yet.">
            Set Up Queue
          </a>
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
        <Show when={buttons().includes("Try Again")}>
          <button type="button" class="button button-sm" aria-label={`Try ${w().branch} again`} title="Checks it afresh; it uses no try." disabled={busy()} onClick={() => void run("Try Again", () => answerEntry(e(), "try-again"), `Checking ${w().branch} again.`)}>
            Try Again
          </button>
        </Show>
        <Show when={buttons().includes("Answer in Chat")}>
          <button type="button" class="button button-sm" aria-label={`Answer about ${w().branch} in the chat`} title="Your answer goes in the chat's message box." onClick={answerInChat}>
            Answer in Chat
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
      </Show>
    </li>
  );
}

/** The rows, in the order the chat tracks them. */
export function WorktreeQueueList(props: { rows: QueueWorktree[]; onChanged?(): void; review?: { sessionPath: string; cwd?: string }; onAnswerInChat?(): void }) {
  return (
    <ul class="list wt-queue-list">
      <For each={props.rows}>{(w) => <WorktreeQueueRow worktree={w} onChanged={props.onChanged} review={props.review} onAnswerInChat={props.onAnswerInChat} />}</For>
    </ul>
  );
}

/** The composer control's modal: this chat's worktrees, each with its one action, and View Merge Queue. */
export function WorktreesModal(props: { title: string; rows: QueueWorktree[]; onClose(): void; onChanged?(): void; review?: { sessionPath: string; cwd?: string } }) {
  const summary = () => rowsSummary(props.rows.map((w) => queueRow(w)));
  /** The queue's intro and paused line: only where some row's repo is one the queue serves. */
  const head = () => modalHead(props.rows);
  const links = () => queueLinksOf(props.rows);
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
          <For each={head().paused}>{(t) => <p class="text-caption wt-queue-paused">{t}</p>}</For>
          <WorktreeQueueList rows={props.rows} onChanged={props.onChanged} review={props.review} onAnswerInChat={props.onClose} />
        </div>
        {/* The queue's one line on the left, its link on the right; the head's ✕ closes. */}
        <Show when={head().intro || links().length}>
          <div class="modal-foot wt-queue-foot">
            <Show when={head().intro}>{(t) => <p class="text-caption wt-queue-intro">{t()}</p>}</Show>
            <Show when={links().length}>
              <div class="wt-queue-foot-links">
                <For each={links()}>
                  {(l) => (
                    <a class="wt-queue-foot-link text-caption" href={l.href} onClick={() => props.onClose()}>
                      {l.label}
                    </a>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Portal>
  );
}
