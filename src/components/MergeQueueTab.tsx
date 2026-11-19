import { createContext, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, useContext, type JSX } from "solid-js";
import { MergeThreadCard, QueueHistory, ReviewerLinks, ReviewRunningButton } from "./MergeQueueChats";
import type { ChatRef } from "../lib/merge-chat";
import type { MergeAnswer } from "../../shared/merge-queue";
import { relativeTime } from "../lib/format";
import { headWhen, mins, notesOf, readyFactsWords, readyRowChip, unattributedWhy, WAITING_RULING_LINE, sentence, pausedTitle, pushedWords, queueStateChip, runProgress, short, waitingHead, type MergeEntry, type MergeQueueView, needsYouOf, withItsChat } from "../lib/merge-queue";
import { DECISION_ACTION_LABEL, DECISION_LABEL, decisionActions, openDecision, STANDING_LINE, standingWords, answeredInChat, type DecisionAction } from "../lib/merge-standing";
import { answerEntry, cancelEntry, landBranch, type LandOptions, mergeChanged, mergeFeed, pauseQueue, readQueue, refusal, resumeQueue } from "../lib/merge-queue-client";
import { createPoll } from "../lib/poll";
import { mergeQueueTabHref, mergeRunHref, projectSessionHref, projectTabHref, type QueueTab } from "../lib/projects-route";
import { announce, toast } from "../lib/ui-state";
import { MergeRunView } from "./MergeRunView";
import { LocalBehind, RequestRow, type RequestEntry } from "./MergeQueueRequests";
import { HOST_NAME, introWords, isRequestState } from "../lib/merge-queue-requests";
import { QueueSettingsButton, QueueSummaryLine } from "./settings/MergeQueueSummary";
import { notSetUp } from "../lib/merge-queue";
import { createSetupPoll, SetupChatButton, SetupChatState, SetupNotSetUp, type SetupPoll } from "./SetupChat";
import { Banner, Icon } from "./ui";
import { createLandConfirm, LandConfirms, LandSplit, QueueChip, UnclearChecks } from "./WorktreesModal";
import { createDiscard } from "./DiscardBranch";
import { discardMenuLine } from "../lib/discard-branch";
import type { LandHow, MergeReady, TargetBroken } from "../../shared/merge-queue";
import { BranchSummaryView } from "./BranchSummary";
import type { DiffScope, WorktreeReadiness } from "../../shared/protocol";
import { ReviewChangesButton } from "./ReviewChanges";
import { heldCount, heldHasContent, HeldList, RetiredList, RetirementLists, RetirementOff } from "./RetirementLists";
import { DRY_RUN_NOW_LINE, dryRunActions, dryRunChip, dryRunFact, failureLine, landFirstLine, runsFirst, scopeWords, tookWords, heldDryRunLabel, nth, trialChip, trialLine, waitingIdOf, whoStarted, type BranchDryRun } from "../lib/dry-run";
import { DryRunButton, DryRunLines, DryRunWhat, FixNewChatButton, FixSplit, runDryRunPress, usePress, type FixTarget } from "./DryRun";
import type { MergeTrial, MergeTrialWaiting } from "../../shared/merge-queue";

/** How often the tab reads the queue while it shows (a run's steps move by the second). */
const POLL_MS = 4000;

/**
 * A project's Merge Queue tab: the target and what's pushed, the queue's state with Pause / Resume and
 * the merge thread's chat, what's being checked now, the line with its estimates, what waits for you,
 * what went back to its chat, and recent landings with their notes, with Change Setup and the Setup chat. A project
 * with no merge setup gets what the queue does and Set Up with a Chat instead. `run`: one run's page
 * (`…/merge-queue/<run>`). `queueTab`: which of the queue's tabs the address names (on a run's page, the one it was
 * opened from). `setup`: the page's read of the Setup chat (one of its own when absent). `refreshed`: the page's
 * Refresh tick (each press closes Waiting, as a fresh visit shows it).
 */
export function MergeQueueTab(props: { projectId: string; root: string; name: string; run?: string; queueTab?: QueueTab; refreshed?: () => number; chatOf?: ChatOf; treesOf?: TreesOf; setup?: SetupPoll }) {
  const setup = props.setup ?? createSetupPoll(props.projectId);
  const poll = createPoll(() => readQueue(props.root), POLL_MS, { cacheKey: `project:${props.projectId}:merge-queue` });
  createEffect(on(mergeChanged, () => poll.refetch(), { defer: true }));
  // What the feed pushes for this project is the newest view: adopt it as is.
  createEffect(
    on(mergeFeed, (f) => {
      if (f && f.project === props.projectId) poll.set(f.view);
    }, { defer: true }),
  );
  const view = () => poll.data();
  // Back from a run's page (Back to Queue, the breadcrumb or the browser's Back): the queue opens with its tab strip
  // at the top of the pane, where the rows the run was opened from are.
  let was = props.run;
  const fromRun = createMemo(() => {
    const run = props.run;
    const back = !run && !!was;
    was = run;
    return back;
  });
  return (
    <section class="card orgs-section mq-tab" aria-labelledby="mq-title">
      <Show
        when={view()}
        fallback={<p class="orgs-empty">{poll.error() ? `Couldn't read this project's merge queue. ${poll.error()}` : "Reading the merge queue."}</p>}
      >
        {(v) => (
          <Show
            when={!props.run}
            fallback={<MergeRunView projectId={props.projectId} view={v()} runId={props.run!} chatOf={props.chatOf} from={props.queueTab} />}
          >
            {/* An invalid definition reads "unset" too: its error is said, never the not-set-up words. */}
            <Show when={!notSetUp(v())} fallback={<NotSetUp projectId={props.projectId} view={v()} setup={setup} chatOf={props.chatOf} onChanged={() => poll.refetch()} />}>
              <QueueBody projectId={props.projectId} view={v()} tab={props.queueTab} refreshed={props.refreshed} toStrip={fromRun} chatOf={props.chatOf} treesOf={props.treesOf} setup={setup} onChanged={() => poll.refetch()} />
            </Show>
          </Show>
        )}
      </Show>
    </section>
  );
}

/** The release holding the queue, as the Releases tab names it: its tag, else its version. */
const holdName = (r: { version: string | null; tag?: string | null }): string => (r.tag ? `release ${r.tag}` : r.version ? `release ${r.version}` : "a release");

/**
 * A listed project with no merge setup: its chats merge plainly. The tab says what the queue does and what setting it
 * up changes, with Set Up with a Chat (the project's Setup chat), then that chat's state and its proposal.
 */
function NotSetUp(props: { projectId: string; view: MergeQueueView; setup: SetupPoll; chatOf?: ChatOf; onChanged(): void }) {
  return (
    <div class="stack mq-body mq-unset">
      <div class="cluster">
        <h2 class="orgs-h2" id="mq-title">
          Merge queue
        </h2>
        <QueueChip row={{ label: "Not set up", tone: "warn" }} />
      </div>
      <SetupNotSetUp projectId={props.projectId} surface="merge-queue" target={props.view.target} poll={props.setup} />
      <RetirementLists projectId={props.projectId} root={props.view.root} view={props.view.retirement} chatOf={props.chatOf} onChanged={props.onChanged} />
    </div>
  );
}

/** The strip: the target's head, and what origin has. */
export function HeadsStrip(props: { view: MergeQueueView }) {
  const v = () => props.view;
  const pushed = () => pushedWords(v().heads);
  return (
    <div class="mq-strip" role="group" aria-label={`${v().target} and origin`}>
      <div class="mq-cell">
        <p class="text-eyebrow">{v().target}</p>
        <p class="mq-cell-value text-mono">{short(v().heads.target)}</p>
        <Show when={v().heads.targetRed?.length}>
          <p class="text-caption mq-red">Red on {v().target} alone: {v().heads.targetRed!.join(", ")}</p>
        </Show>
      </div>
      <div class="mq-cell mq-cell-end">
        <p class="text-eyebrow">Pushed to origin</p>
        <p class="mq-cell-value">
          <Show when={v().heads.pushed}>
            <span class="text-mono">{short(v().heads.pushed)}</span>
          </Show>
          <QueueChip row={pushed()} />
        </p>
        <p class="text-caption text-muted">{sentence(pushed().why) || "After every landing."}</p>
      </div>
    </div>
  );
}

/** A chat the page's session list knows, by its id (a queue records ids): where it opens and what it's called
    (lib/merge-chat chatRefOf: a worker is named as its chat's). */
export type { ChatRef };
export type ChatOf = (id: string) => ChatRef | undefined;
/** A chat's readiness readings of its worktrees, by its id (lib/merge-queue chatTreesOf); undefined: not known. */
export type TreesOf = (id: string) => WorktreeReadiness[] | undefined;

/** Where a chat recorded by its id opens: its own route when the list carries it, else the id route the app resolves. */
export const chatHref = (projectId: string, id: string, chatOf?: ChatOf): string => {
  const c = chatOf?.(id);
  return c ? projectSessionHref(projectId, c.path) : `#/sid/${encodeURIComponent(id)}`;
};

/** "from <chat>": a link to the branch's own chat when the entry knows it (the run's page). */
export function FromChat(props: { projectId: string; entry: Pick<MergeEntry, "session">; chatOf?: ChatOf }) {
  return (
    <Show when={props.entry.session} fallback={<span>from its chat</span>}>
      {(s) => (
        <span>
          from <a href={chatHref(props.projectId, s(), props.chatOf)}>{props.chatOf?.(s())?.title ?? "its chat"}</a>
        </span>
      )}
    </Show>
  );
}

/**
 * A row's top line: the title of the chat that owns the branch (a real link; "No chat found for this worktree" when
 * none is known), then the branch in small mono, then an "archived" tag when that chat is archived. The row names no
 * worktree folder and carries no "Chat" label.
 */
export function RowHead(props: { projectId: string; branch: string; session?: string; archived?: boolean; chatOf?: ChatOf; class?: string }) {
  const chat = () => (props.session ? props.chatOf?.(props.session) : undefined);
  return (
    <p class={`list-title mq-head-line${props.class ? ` ${props.class}` : ""}`}>
      <Show when={props.session} fallback={<span class="text-muted mq-no-chat">No chat found for this worktree</span>}>
        {(s) => (
          <a class="mq-chat-link" href={chatHref(props.projectId, s(), props.chatOf)} onClick={keepSelection}>
            {chat()?.title ?? "its chat"}
          </a>
        )}
      </Show>
      <span class="mq-branch text-mono">{props.branch}</span>
      <Show when={props.session && (props.archived || chat()?.archived)}>
        <span class="chip mq-archived">archived</span>
      </Show>
    </p>
  );
}

/** The chat link: a click that ends a text selection in its row doesn't follow it. */
function keepSelection(e: MouseEvent) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const row = (e.currentTarget as Element).closest(".mq-tap");
  const sel = window.getSelection();
  if (row && sel && !sel.isCollapsed && sel.anchorNode && row.contains(sel.anchorNode)) e.preventDefault();
}

/**
 * The whole row opens its chat (the Agents board's rule): a plain primary click anywhere but its links, buttons,
 * menus and fields, and not one that ends a text selection in it. A click inside the changes viewer (a portal, so
 * outside the row's own elements) never counts.
 */
export function rowOpens(href: () => string | undefined) {
  return (e: MouseEvent & { currentTarget: HTMLElement }) => {
    const to = href();
    if (!to || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target as Element;
    if (!e.currentTarget.contains(target)) return;
    // A row's open confirm is a choice in progress: a tap on its words never leaves for the chat.
    if (target.closest("a, button, input, textarea, select, label, form, summary, [role=menuitem], [popover], .wt-queue-confirm")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return;
    location.hash = to;
  };
}

/** A queue row's Review Changes: the queue's own comparison, steps from its chat's turns when the list knows it. */
function QueueReview(props: { projectId: string; branch: string; scope: DiffScope; session?: string; chatOf?: ChatOf }) {
  return (
    <ReviewChangesButton
      branch={props.branch}
      class="mq-review"
      scope={() => props.scope}
      stepsFrom={props.session ? props.chatOf?.(props.session)?.path : undefined}
      title={
        props.scope.kind === "queue" && props.scope.branch
          ? "The branch as it is now against the branch it lands on, its uncommitted files marked. Nothing is changed."
          : "The commit that was approved against the branch it lands on, or, once landed, what its landing brought in. Nothing is changed."
      }
    />
  );
}

/** One action button with its pending state; a refusal shows under the row and is announced. */
export function useAct(onChanged: () => void) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const run = async (key: string, call: () => Promise<{ ok: boolean; error?: { message: string } }>, done: string) => {
    if (busy()) return;
    setBusy(key);
    setError(null);
    try {
      const no = refusal(await call());
      if (no) {
        setError(no);
        announce(no);
      } else {
        toast(done);
        announce(done);
        onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run };
}

function QueueBody(props: { projectId: string; view: MergeQueueView; tab?: QueueTab; refreshed?: () => number; toStrip(): boolean; chatOf?: ChatOf; treesOf?: TreesOf; setup: SetupPoll; onChanged(): void }) {
  const v = () => props.view;
  const onHost = createMemo(() => hostOf(v()) !== null);
  const tabs = createMemo(() => queueTabs(props.projectId, v, onHost(), props.chatOf, props.treesOf, props.onChanged));
  // An address naming a tab this project doesn't show (Waiting on GitHub on a local project) shows Ready to land.
  const tab = (): QueueTab => (tabs().some((t) => t.id === props.tab) ? props.tab! : "ready");
  const runHref = (projectId: string, run: string) => mergeRunHref(projectId, run, tab());
  const chip = () => (v().release && v().state !== "paused" && !v().invalid ? { label: "Frozen for a release", tone: "warn" as const } : queueStateChip(v()));
  const head = useAct(props.onChanged);
  const paused = () => v().state === "paused";
  return (
    <RunFrom.Provider value={tab}>
    <div class="stack mq-body">
      <HeadsStrip view={v()} />
      <LocalBehind project={props.projectId} target={v().target} behind={v().heads.behind} blocked={v().heads.behindBlocked} onChanged={props.onChanged} />
      <div class="spread mq-head">
        <div class="cluster">
          <h2 class="orgs-h2" id="mq-title">
            Merge queue
          </h2>
          <QueueChip row={chip()} />
        </div>
        <div class="button-row">
          <SetupChatButton projectId={props.projectId} setUp from="merge-queue" poll={props.setup} />
          <QueueSettingsButton projectId={props.projectId} />
          <Show
            when={paused()}
            fallback={
              <button type="button" class="button button-sm" disabled={!!head.busy()} onClick={() => void head.run("pause", () => pauseQueue(v().root), "Paused the merge queue.")}>
                Pause Queue
              </button>
            }
          >
            <button type="button" class="button button-sm button-primary" disabled={!!head.busy()} onClick={() => void head.run("resume", () => resumeQueue(v().root), "Resumed the merge queue.")}>
              Resume Queue
            </button>
          </Show>
          <ReviewRunningButton projectId={props.projectId} view={v()} />
        </div>
      </div>
      <QueueSummaryLine view={v()} />
      <MergeThreadCard projectId={props.projectId} view={v()} chatOf={props.chatOf} onChanged={props.onChanged} />
      <SetupChatState projectId={props.projectId} poll={props.setup} fresh />
      <p class="text-caption text-muted mq-intro">
        {introWords(v().target, v().settings?.how?.effective)}
        <Show when={v().checks === "none"}> This project declares no automated tests: landings say "No checks declared".</Show>
      </p>
      <Show when={head.error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
      <Show when={v().invalid}>
        {(bad) => <Banner tone="error" title="This project's .sova/project.json doesn't parse." body={`${bad().trim().replace(/[.]$/, "")}. Fix it on ${v().target}, or land a branch that fixes it; nothing else lands until it parses.`} />}
      </Show>
      {/* The definition's own pause is said by the banner above, once. */}
      <Show when={paused() && !(v().paused?.kind === "definition-invalid" && v().invalid)}>
        <Banner
          tone="warn"
          title={pausedTitle(v())}
          body={
            <>
              {v().paused?.kind !== "operator" ? sentence(v().paused?.why) : "Approvals are still taken; nothing is checked until you resume."}
              <Show when={v().paused?.run}>
                {(r) => (
                  <>
                    {" "}
                    <a href={runHref(props.projectId, r())}>View the Run</a>
                  </>
                )}
              </Show>
            </>
          }
          action={
            <button type="button" class="button button-sm" disabled={!!head.busy()} onClick={() => void head.run("resume", () => resumeQueue(v().root), "Resumed the merge queue.")}>
              Resume
            </button>
          }
        />
      </Show>
      {/* An open release freezes the target on it: only its own entries land until it's published or abandoned. */}
      <Show when={v().release}>
        {(rel) => (
          <Banner
            tone="info"
            title={`${v().target} is frozen for ${holdName(rel())}`}
            body="Other landings wait in line, and nothing is pushed, until the release is published or abandoned."
            action={
              <a class="button button-sm" href={projectTabHref(props.projectId, "releases")}>
                Open Releases
              </a>
            }
          />
        )}
      </Show>
      <CheckingNow projectId={props.projectId} view={v()} chatOf={props.chatOf} />
      <Waiting projectId={props.projectId} view={v()} refreshed={props.refreshed} chatOf={props.chatOf} onChanged={props.onChanged} />
      <RetirementOff view={v().retirement} />
      <QueueTabs projectId={props.projectId} tabs={tabs()} tab={tab()} toStrip={props.toStrip} />
    </div>
    </RunFrom.Provider>
  );
}

/**
 * The queue's tab strip and the tab shown under it, as the project page's own strip: each tab is an address (each pick
 * a history entry), Left/Right move focus along it (wrapping), Home/End jump, Enter or Space picks. A label carries its
 * count; Needs you's warns while it has anything. A tab with no rows says so in one line.
 */
function QueueTabs(props: { projectId: string; tabs: QueueTabDef[]; tab: QueueTab; toStrip(): boolean }) {
  const els: HTMLButtonElement[] = [];
  const at = () => Math.max(0, props.tabs.findIndex((t) => t.id === props.tab));
  const shown = createMemo(() => props.tabs[at()]!);
  let strip: HTMLDivElement | undefined;
  let panel: HTMLDivElement | undefined;
  // Back from a run: the pane scrolls so the strip is at its top (its own scrollTop: scrollIntoView would move every
  // scroller up the tree), the panel at least the rest of the pane's height so a short tab can be scrolled that far.
  onMount(() => {
    if (!props.toStrip()) return;
    requestAnimationFrame(() => {
      const pane = strip && scrollerOf(strip);
      if (!pane || !strip || !panel) return;
      const top = pane === document.scrollingElement ? 0 : pane.getBoundingClientRect().top;
      panel.style.minHeight = `${Math.max(panel.offsetHeight, pane.clientHeight - strip.offsetHeight)}px`;
      pane.scrollTop += strip.getBoundingClientRect().top - top;
    });
  });
  // A pick never moves the strip under the pointer: the panel keeps at least the tallest height it had this visit, so
  // a shorter tab can't shorten the page under the scroll position.
  const keepHeight = () => {
    if (panel) panel.style.minHeight = `${Math.max(panel.offsetHeight, parseFloat(panel.style.minHeight) || 0)}px`;
  };
  // On a narrow strip the tab shown is scrolled into view, clear of the strip's edge fade: the strip scrolls sideways,
  // never the page (the strip sits low on it, so scrollIntoView would move the page to it on an address that names a
  // tab).
  createEffect(
    on(
      () => props.tab,
      () =>
        queueMicrotask(() => {
          const el = els[at()];
          if (!strip || !el) return;
          const left = el.offsetLeft - strip.offsetLeft - TAB_FADE_PX;
          const right = el.offsetLeft - strip.offsetLeft + el.offsetWidth + TAB_FADE_PX;
          if (left < strip.scrollLeft) strip.scrollLeft = left;
          else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
        }),
    ),
  );
  const onKey = (e: KeyboardEvent, i: number) => {
    const last = props.tabs.length - 1;
    const next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    els[next]?.focus();
  };
  return (
    <div class="stack-2 mq-tabs-area">
      <div class="tabs mq-tabs" role="tablist" aria-label="Merge queue" ref={strip}>
        <For each={props.tabs}>
          {(t, i) => (
            <button
              type="button"
              role="tab"
              class="tab"
              id={`mq-tab-${t.id}`}
              data-tab={t.id}
              aria-selected={props.tab === t.id ? "true" : "false"}
              aria-controls={props.tab === t.id ? "mq-tabpanel" : undefined}
              tabindex={props.tab === t.id ? 0 : -1}
              // The name as it reads: "Needs you · 2".
              aria-label={t.count !== null ? `${t.label} · ${t.count}` : t.label}
              ref={(el) => (els[i()] = el)}
              onClick={() => {
                if (props.tab === t.id) return;
                keepHeight();
                location.hash = mergeQueueTabHref(props.projectId, t.id);
              }}
              onKeyDown={(e) => onKey(e, i())}
            >
              {t.label}
              <Show when={t.count !== null}>
                <span class="text-num mq-tab-count" classList={{ "mq-tab-count-warn": !!t.warn }}>
                  · {t.count}
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>
      {/* An empty tab's panel takes focus itself, so its one line is in the tab order (its rows' links are otherwise). */}
      <div class="stack-2 mq-tabpanel" role="tabpanel" id="mq-tabpanel" aria-labelledby={`mq-tab-${shown().id}`} data-tab={shown().id} tabindex={shown().rows > 0 ? undefined : 0} ref={panel}>
        <Show when={shown().rows > 0} fallback={<p class="mq-empty text-caption">{shown().empty}</p>}>
          <Show when={shown()} keyed>
            {(t) => t.panel()}
          </Show>
        </Show>
      </div>
    </div>
  );
}

/** The width of a tab strip's edge fade (the design system's `.tabs`): a tab scrolled into view clears it. */
const TAB_FADE_PX = 32;

/** The nearest ancestor that scrolls vertically: the page's pane. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === "auto" || y === "scroll") return p;
  }
  return document.scrollingElement as HTMLElement | null;
}

/**
 * The live fact an empty tab's line starts with (the design system's empty state: the fact, then what will show
 * there): what the queue is doing now.
 */
export function queueFact(v: Pick<MergeQueueView, "waiting" | "state" | "current" | "trialNow">): string {
  const n = v.waiting.length;
  if (v.state === "paused") return n ? `The queue is paused with ${n} waiting.` : "The queue is paused.";
  if (v.trialNow && !v.current) return dryRunFact(n);
  if (v.current) return n ? `1 being checked, ${n} waiting.` : "1 being checked.";
  return n ? `${n} waiting.` : "The queue is idle.";
}

/** The tab a run's page is opened from: its Back to Queue returns there (`…/merge-queue/<tab>/<run>`). */
const RunFrom = createContext<() => QueueTab | undefined>(() => undefined);
/** A run's page, from the queue's tab shown now. Call at a component's top (it reads the context). */
const useRunHref = () => {
  const from = useContext(RunFrom);
  return (projectId: string, run: string) => mergeRunHref(projectId, run, from());
};

/**
 * One of the queue's tabs, under Checking now and Waiting: its address word, its label, its count (null: none shown),
 * whether the count warns, how many rows it has, the one line it says with none, and its rows. A new tab is one more
 * entry in queueTabs (and its word in QUEUE_TABS).
 */
interface QueueTabDef {
  id: QueueTab;
  label: string;
  count: number | null;
  warn?: boolean;
  rows: number;
  empty: string;
  panel(): JSX.Element;
}

/** The project's host by name, for a project that lands on one: its landing choice's, else an entry's request's. */
function hostOf(v: MergeQueueView): string | null {
  const how = v.settings?.how?.effective;
  if (how === "github-pr") return HOST_NAME.github;
  if (how === "gitlab-mr") return HOST_NAME.gitlab;
  const kind = (v.waitingOnHost ?? []).find((e) => e.request?.host)?.request?.host;
  if (kind) return HOST_NAME[kind];
  return how === "push-branch" || (v.waitingOnHost ?? []).length ? "the host" : null;
}

/**
 * The queue's tabs, in the strip's order; each shows exactly the rows its section always showed. Built once (again
 * only when the host's tab comes or goes): labels, counts and rows are read as the view changes, so a poll keeps the
 * strip's buttons and the rows shown, focus and open confirms with them.
 */
function queueTabs(projectId: string, v: () => MergeQueueView, onHost: boolean, chatOf: ChatOf | undefined, treesOf: TreesOf | undefined, onChanged: () => void): QueueTabDef[] {
  const ready = () => v().ready ?? [];
  const needsCount = () => (v().heads.targetBroken ?? []).length + needsYouOf(v()).length;
  // A Land the merge thread is still ruling on shows here, but asks nothing of you yet: the count leaves it out.
  const needsYours = () => needsCount() - needsYouOf(v()).filter((e) => e.waitingRuling).length;
  const tabs: (QueueTabDef | null)[] = [
    {
      id: "ready",
      label: "Ready to land",
      get count() {
        return ready().length;
      },
      get rows() {
        return ready().length;
      },
      get empty() {
        return `${queueFact(v())} A finished branch shows here until you land it.`;
      },
      panel: () => (
        <ul class="list mq-list">
          <For each={v().ready}>{(r) => <ReadyRow projectId={projectId} root={v().root} target={v().target} how={v().settings?.how?.effective} ready={r} review={v().review} waitingId={(v().trialsWaiting ?? []).find((w) => w.branch === r.branch)?.id} chatOf={chatOf} treesOf={treesOf} onChanged={onChanged} />}</For>
        </ul>
      ),
    },
    {
      id: "needs-you",
      label: "Needs you",
      get count() {
        return needsYours();
      },
      get warn() {
        return needsYours() > 0;
      },
      get rows() {
        return needsCount();
      },
      get empty() {
        return `${queueFact(v())} A branch shows here when it needs your decision.`;
      },
      panel: () => (
        <ul class="list mq-list">
          <For each={v().heads.targetBroken ?? []}>{(b) => <BrokenRow projectId={projectId} target={v().target} broken={b} offer={v().heads.targetBrokenFix?.[b.check]} />}</For>
          <For each={needsYouOf(v())}>
            {(e) =>
              isRequestState(e.state) ? (
                <RequestRow root={v().root} target={v().target} entry={e as RequestEntry} from={<FromChat projectId={projectId} entry={e} chatOf={chatOf} />} onChanged={onChanged} />
              ) : (
                <NeedsYouRow projectId={projectId} root={v().root} entry={e} target={v().target} chatOf={chatOf} view={v()} onChanged={onChanged} />
              )
            }
          </For>
        </ul>
      ),
    },
    {
      id: "with-its-chat",
      label: "With its chat",
      get count() {
        return withItsChat(v()).length;
      },
      get rows() {
        return withItsChat(v()).length;
      },
      get empty() {
        return `${queueFact(v())} A branch shows here while its chat fixes what the queue sent back.`;
      },
      panel: () => (
        <ul class="list mq-list">
          <For each={withItsChat(v())}>{(e) => <WithChatRow projectId={projectId} entry={e} view={v()} chatOf={chatOf} onChanged={onChanged} />}</For>
        </ul>
      ),
    },
    onHost
      ? {
          id: "waiting-on-host",
          get label() {
            return `Waiting on ${hostOf(v()) ?? "the host"}`;
          },
          get count() {
            return (v().waitingOnHost ?? []).length;
          },
          get rows() {
            return (v().waitingOnHost ?? []).length;
          },
          get empty() {
            return `${queueFact(v())} A branch shows here while its request waits on ${hostOf(v()) ?? "the host"}.`;
          },
          panel: () => (
            <ul class="list mq-list" aria-label={`Waiting on ${hostOf(v()) ?? "the host"}`}>
              <For each={(v().waitingOnHost ?? []) as RequestEntry[]}>
                {(e) => <RequestRow root={v().root} target={v().target} entry={e} from={<FromChat projectId={projectId} entry={e as unknown as MergeEntry} chatOf={chatOf} />} onChanged={onChanged} />}
              </For>
            </ul>
          ),
        }
      : null,
    {
      id: "held",
      label: "Held",
      get count() {
        return heldCount(v().retirement);
      },
      get rows() {
        return heldHasContent(v().retirement) ? Math.max(1, heldCount(v().retirement)) : 0;
      },
      get empty() {
        return `${queueFact(v())} A folder shows here when Sova can't retire it.`;
      },
      panel: () => <Show when={v().retirement}>{(r) => <HeldList projectId={projectId} view={r()} chatOf={chatOf} />}</Show>,
    },
    {
      id: "landed",
      label: "Landed",
      // At most the newest 20 come: a count would read as all of them.
      count: null,
      // Retired rows keep the tab from reading empty: they show under the landings, in this same tab.
      get rows() {
        return v().recent.length + (v().retirement?.retiredTotal ?? 0);
      },
      get empty() {
        return `${queueFact(v())} Each landing shows here.`;
      },
      panel: () => (
        <>
          <Show when={v().recent.length > 0}>
            <ul class="list mq-list">
              <For each={v().recent}>{(l) => <LandedRow projectId={projectId} view={v()} landed={l} chatOf={chatOf} />}</For>
            </ul>
          </Show>
          <Show when={v().retirement}>{(r) => <RetiredList root={v().root} view={r()} onChanged={onChanged} />}</Show>
        </>
      ),
    },
    {
      id: "dry-runs",
      label: "Dry runs",
      // At most the newest 20 are kept: a count would read as all of them.
      count: null,
      get rows() {
        return (v().trials ?? []).length + (v().trialsWaiting ?? []).length;
      },
      get empty() {
        return `${queueFact(v())} Each dry run shows here.`;
      },
      panel: () => (
        <ul class="list mq-list" aria-label="Dry runs">
          <For each={v().trialsWaiting ?? []}>{(w) => <DryRunWaitingRow projectId={projectId} view={v()} waiting={w} chatOf={chatOf} />}</For>
          <For each={dryRunsShown(v())}>{(t) => <DryRunRow projectId={projectId} view={v()} trial={t} chatOf={chatOf} />}</For>
        </ul>
      ),
    },
    {
      id: "queue-chats",
      label: "Queue chats",
      get count() {
        return (v().chats ?? []).length;
      },
      get rows() {
        return (v().chats ?? []).length;
      },
      get empty() {
        return `${queueFact(v())} Each chat the queue starts shows here.`;
      },
      panel: () => <QueueHistory projectId={projectId} view={v()} onChanged={onChanged} />,
    },
  ];
  return tabs.filter((t): t is QueueTabDef => !!t);
}

/** The Dry runs tab's rows: the newest 20, newest first, the running one at the top. */
const dryRunsShown = (v: MergeQueueView): MergeTrial[] => {
  const all = v.trials ?? [];
  return [...all.filter((t) => t.verdict === "running"), ...all.filter((t) => t.verdict !== "running")].slice(0, 20);
};

/** One dry run on the Dry runs tab: its chat and branch, its chip, commit, who started it, when and how long, its why,
 *  what came of it, View Checks (on the dry run's own run page, whose Back to Queue returns here) and, running, Stop. */
function DryRunRow(props: { projectId: string; view: MergeQueueView; trial: MergeTrial; chatOf?: ChatOf }) {
  const t = () => props.trial;
  const branch = () => t().branch ?? short(t().commit);
  const session = () => dryRunSession(props.view, t());
  const title = (id: string) => props.chatOf?.(id)?.title;
  const chip = () => trialChip(t());
  const line = () => trialLine(t(), props.view.target, title);
  const took = () => tookWords(t().startedAt, t().endedAt);
  const press = usePress();
  return (
    <li class="list-row mq-row" classList={{ "mq-tap": !!session() }} data-branch={branch()} data-state={`dry-run-${t().verdict}`} onClick={rowOpens(() => session() && chatHref(props.projectId, session()!, props.chatOf))}>
      <div class="list-main">
        <RowHead projectId={props.projectId} branch={branch()} session={session()} chatOf={props.chatOf} />
        <p class="mq-facts">
          <QueueChip row={chip()} />
          <span class="text-mono text-muted">{short(t().commit)}</span>
          <span>
            started by {whoStarted(t().by, title)} · {relativeTime(t().startedAt)}
            {took() ? ` · ${took()}` : ""}
          </span>
        </p>
        <Show when={t().needs}>{(w) => <p class="list-meta">Needed: {w()}</p>}</Show>
        <Show when={line()}>{(l) => <p class="list-meta">{l()}</p>}</Show>
        <Show when={press.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
      </div>
      <div class="button-row mq-row-act">
        <a class="button button-sm button-ghost" href={mergeRunHref(props.projectId, t().run, "dry-runs")} aria-label={`View checks for the dry run of ${branch()}`} onClick={(e) => e.stopPropagation()}>
          View Checks
        </a>
        <Show when={t().verdict === "running"}>
          <DryRunButton projectId={props.projectId} branch={branch()} commit={t().commit} kind="stop" run={t().run} press={press} />
        </Show>
      </div>
    </li>
  );
}

/** A dry run waiting for the merge copy (Run Dry Run pressed while it was busy): what it waits for, and Stop Dry Run. */
function DryRunWaitingRow(props: { projectId: string; view: MergeQueueView; waiting: MergeTrialWaiting; chatOf?: ChatOf }) {
  const w = () => props.waiting;
  const session = () => dryRunSession(props.view, w());
  const title = (id: string) => props.chatOf?.(id)?.title;
  const press = usePress();
  return (
    <li class="list-row mq-row" classList={{ "mq-tap": !!session() }} data-branch={w().branch} data-state="dry-run-waiting" onClick={rowOpens(() => session() && chatHref(props.projectId, session()!, props.chatOf))}>
      <div class="list-main">
        <RowHead projectId={props.projectId} branch={w().branch} session={session()} chatOf={props.chatOf} />
        <p class="mq-facts">
          <QueueChip row={{ label: "Dry run waiting", tone: "info" }} />
          <span class="text-mono text-muted">{short(w().commit)}</span>
          <span>
            started by {whoStarted(w().by, title)} · {relativeTime(w().at)}
          </span>
        </p>
        <p class="list-meta">Dry run waiting · starts after {w().after}</p>
        <Show when={w().needs}>{(n) => <p class="list-meta">Needed: {n()}</p>}</Show>
        <Show when={press.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
      </div>
      <div class="button-row mq-row-act">
        <DryRunButton projectId={props.projectId} branch={w().branch} commit={w().commit} kind="stop" waiting={w().id} press={press} />
      </div>
    </li>
  );
}

/** A landing: its chip, its commit, when and whether it was pushed, its summary, review and notes, Review Changes and
 *  View Checks. */
function LandedRow(props: { projectId: string; view: MergeQueueView; landed: MergeQueueView["recent"][number]; chatOf?: ChatOf }) {
  const l = () => props.landed;
  const runHref = useRunHref();
  return (
    <li class="list-row mq-row" classList={{ "mq-tap": !!l().entry.session }} data-branch={l().entry.branch} data-state="landed" onClick={rowOpens(() => l().entry.session && chatHref(props.projectId, l().entry.session!, props.chatOf))}>
      <div class="list-main">
        <RowHead projectId={props.projectId} branch={l().entry.branch} session={l().entry.session} chatOf={props.chatOf} />
        <p class="mq-facts">
          <QueueChip row={{ label: l().entry.landed?.via === "host" ? `Merged on ${l().entry.request?.host === "gitlab" ? "GitLab" : "GitHub"}` : "Landed", tone: "success" }} />
          <Show when={l().entry.landed}>
            {(ld) => (
              <span>
                as <span class="text-mono">{short(ld().sha)}</span> · {relativeTime(ld().at)}
                <Show when={ld().via !== "host"}>{ld().pushed === "not-pushed" ? ` · not pushed${ld().pushWhy ? `: ${ld().pushWhy}` : ""}` : ld().pushed === "pushed" ? " · pushed" : ""}</Show>
                <Show when={l().run?.noChecks}> · No checks declared</Show>
              </span>
            )}
          </Show>
        </p>
        <BranchSummaryView summary={l().entry.summary} branch={l().entry.branch} />
        <ReviewerLinks projectId={props.projectId} view={props.view} run={l().entry.run ?? l().run?.id} />
        <For each={notesOf(l().entry.notes)}>
          {(n) => (
            <p class="list-meta mq-note">
              <span class="text-muted">{n.label}:</span> {n.text}
            </p>
          )}
        </For>
      </div>
      <div class="button-row mq-row-act">
        <QueueReview projectId={props.projectId} branch={l().entry.branch} scope={{ kind: "queue", project: props.projectId, entry: l().entry.id }} session={l().entry.session} chatOf={props.chatOf} />
        <Show when={l().run}>
          {(r) => (
            <a class="button button-sm button-ghost" href={runHref(props.projectId, r().id)} aria-label={`View checks for ${l().entry.branch}`}>
              View Checks
            </a>
          )}
        </Show>
      </div>
    </li>
  );
}

function CheckingNow(props: { projectId: string; view: MergeQueueView; chatOf?: ChatOf }) {
  const cur = () => props.view.current;
  const runHref = useRunHref();
  /** The entry the run checks, from whichever list holds it. */
  const entry = () => {
    const r = cur();
    if (!r) return undefined;
    const v = props.view;
    return [...v.checking, ...v.waiting, ...v.needsYou, ...v.needsFix].find((e) => e.id === r.entry);
  };
  return (
    <Show
      when={cur()}
      fallback={
        // A dry run holds the merge copy: it takes a landing's place, never "Nothing being checked" (§app.merge-queue/dry-runs).
        <Show
          when={props.view.trialNow}
          fallback={
            <p class="mq-empty text-caption">
              {props.view.release
                ? props.view.waiting.length
                  ? `${props.view.waiting.length} waiting for ${holdName(props.view.release)}: they start once it's published or abandoned.`
                  : `Nothing being checked. A branch you land now waits for ${holdName(props.view.release)}.`
                : props.view.waiting.length
                  ? `${props.view.waiting.length} waiting. The next one starts in a moment.`
                  : "Nothing being checked. A branch starts as soon as you press Land."}
            </p>
          }
        >
          {(t) => <DryRunNow projectId={props.view.project} view={props.view} now={t()} chatOf={props.chatOf} />}
        </Show>
      }
    >
      {(r) => {
        const p = () => runProgress(r());
        return (
          <div
            class="mq-card"
            classList={{ "mq-tap": !!entry()?.session }}
            role="group"
            aria-label="Checking now"
            data-branch={r().branch}
            onClick={rowOpens(() => entry()?.session && chatHref(props.projectId, entry()!.session!, props.chatOf))}
          >
            <div class="spread">
              <div class="cluster">
                <h3 class="text-heading-s">Checking now</h3>
                <QueueChip row={{ label: "Checking", tone: "accent", live: true }} />
              </div>
              <div class="button-row mq-row-act">
                <QueueReview projectId={props.projectId} branch={r().branch} scope={{ kind: "queue", project: props.projectId, entry: r().entry }} session={entry()?.session} chatOf={props.chatOf} />
                <a class="button button-sm" href={runHref(props.projectId, r().id)}>
                  View Checks
                </a>
              </div>
            </div>
            <RowHead projectId={props.projectId} branch={r().branch} session={entry()?.session} chatOf={props.chatOf} class="mq-card-title" />
            <p class="mq-facts">
              <span class="text-mono text-muted">{short(r().commit)}</span>
            </p>
            <BranchSummaryView summary={entry()?.summary} projectId={props.projectId} branch={r().branch} />
            <ReviewerLinks projectId={props.projectId} view={props.view} run={r().id} />
            <p class="text-caption">
              <span class="text-mono">
                {props.view.target} {short(r().base)}
              </span>{" "}
              + this branch{r().tip ? <> → testing <span class="text-mono">{short(r().tip)}</span></> : null}
            </p>
            <p class="text-caption mq-now">
              {p().label}
              {p().of ? ` · check ${p().index} of ${p().of}` : ""}
            </p>
            <div class="meter">
              <div class="meter-track" role="img" aria-label={`${p().done} of ${p().of} checks done`}>
                <div class="meter-fill" style={{ width: `${p().of ? Math.round((100 * p().done) / p().of) : 0}%` }} />
              </div>
            </div>
            <p class="text-caption text-muted">
              Started {relativeTime(r().startedAt)}
              {entry()?.eta ? ` · takes ~${mins(entry()!.eta!.takesMs)}` : ""}
              {r().checks.filter((c) => c.source === "picked").length ? ` · ${r().checks.filter((c) => c.source === "picked").length} added by the merge thread` : ""}
            </p>
          </div>
        );
      }}
    </Show>
  );
}

/** The branch's session for a dry run: the chat that started it, else the branch's row's or entry's chat. */
function dryRunSession(v: MergeQueueView, t: Pick<MergeTrial, "by" | "branch">): string | undefined {
  if (t.by.kind === "chat" && t.by.session) return t.by.session;
  const b = t.branch;
  if (!b) return undefined;
  return v.ready?.find((r) => r.branch === b)?.session ?? [...v.waiting, ...v.checking, ...v.needsYou, ...v.needsFix].find((e) => e.branch === b)?.session;
}

/** Checking now while a branch's dry run holds the merge copy: what it is and why, who started it, check N of M, View
 *  Checks and Stop Dry Run (§app.merge-queue/dry-runs). */
function DryRunNow(props: { projectId: string; view: MergeQueueView; now: NonNullable<MergeQueueView["trialNow"]>; chatOf?: ChatOf }) {
  const runHref = useRunHref();
  const t = () => props.now.trial;
  const r = () => props.now.run;
  const branch = () => t().branch ?? short(t().commit);
  const session = () => dryRunSession(props.view, t());
  const title = (id: string) => props.chatOf?.(id)?.title;
  const press = usePress();
  const p = () => props.now.progress;
  const cur = () => runProgress(r());
  return (
    <div class="mq-card mq-dry-run-now" classList={{ "mq-tap": !!session() }} role="group" aria-label="Checking now · Dry run" data-branch={branch()} data-dry-run="running" onClick={rowOpens(() => session() && chatHref(props.projectId, session()!, props.chatOf))}>
      <div class="spread">
        <div class="cluster">
          <h3 class="text-heading-s">Checking now</h3>
          <QueueChip row={{ label: "Dry run", tone: "accent", live: true }} />
        </div>
        <div class="button-row mq-row-act">
          <a class="button button-sm" href={runHref(props.projectId, r().id)} onClick={(e) => e.stopPropagation()}>
            View Checks
          </a>
          <DryRunButton projectId={props.projectId} branch={branch()} commit={t().commit} kind="stop" run={r().id} press={press} />
        </div>
      </div>
      <RowHead projectId={props.projectId} branch={branch()} session={session()} chatOf={props.chatOf} class="mq-card-title" />
      <p class="mq-facts">
        <span>
          {branch()} at <span class="text-mono">{short(t().commit)}</span> · started by {whoStarted(t().by, title)}
        </span>
      </p>
      <Show when={t().needs}>{(w) => <p class="text-caption">Needed: {w()}</p>}</Show>
      <p class="text-caption">{DRY_RUN_NOW_LINE}</p>
      <Show when={scopeWords(t())}>{(w) => <p class="text-caption text-muted">{w()}</p>}</Show>
      <p class="text-caption mq-now">
        {cur().label}
        {p().of ? ` · check ${p().at} of ${p().of}` : ""}
      </p>
      <div class="meter">
        <div class="meter-track" role="img" aria-label={`check ${p().at} of ${p().of}`}>
          <div class="meter-fill" style={{ width: `${p().of ? Math.round((100 * Math.max(0, p().at - 1)) / p().of) : 0}%` }} />
        </div>
      </div>
      <p class="text-caption text-muted">Started {relativeTime(r().startedAt)}</p>
      <DryRunWhat target={props.view.target} />
      <Show when={press.error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
    </div>
  );
}

/** Waiting's head: while a dry run holds the copy, its entries start once it ends. */
const waitingWords = (v: MergeQueueView): string =>
  v.trialNow && !v.current && v.waiting.length ? `Waiting · ${v.waiting.length} · they start once the dry run ends` : waitingHead(v.waiting);

function Waiting(props: { projectId: string; view: MergeQueueView; refreshed?: () => number; chatOf?: ChatOf; onChanged(): void }) {
  // Closed each time it is shown: whether it was open is never kept. The page's Refresh and a page restored from the
  // browser's back-forward cache close it too; the queue's own live reads keep it as it is.
  const [open, setOpen] = createSignal(false);
  if (props.refreshed) createEffect(on(props.refreshed, () => setOpen(false), { defer: true }));
  const onShow = (e: PageTransitionEvent) => e.persisted && setOpen(false);
  window.addEventListener("pageshow", onShow);
  onCleanup(() => window.removeEventListener("pageshow", onShow));
  return (
    <div class="stack-2 mq-waiting">
      {/* With nothing in line, a plain line: nothing to open. */}
      <Show when={props.view.waiting.length > 0} fallback={<h3 class="mq-waiting-head mq-waiting-none">{waitingWords(props.view)}</h3>}>
      <h3 class="mq-waiting-head">
        <button type="button" class="mq-waiting-toggle" aria-expanded={open() ? "true" : "false"} aria-controls="mq-waiting-rows" onClick={() => setOpen(!open())}>
          <Icon name="chevron-right" small class="mq-twist" />
          <span>{waitingWords(props.view)}</span>
        </button>
      </h3>
      </Show>
      <div id="mq-waiting-rows" role="region" aria-label="Waiting" hidden={!open() || props.view.waiting.length === 0}>
      <Show when={open() && props.view.waiting.length > 0}>
        <ul class="list mq-list">
          <For each={props.view.waiting}>
            {(e) => {
              const act = useAct(props.onChanged);
              return (
                <li class="list-row mq-row" classList={{ "mq-tap": !!e.session }} data-branch={e.branch} data-state="queued" onClick={rowOpens(() => e.session && chatHref(props.projectId, e.session, props.chatOf))}>
                  <div class="list-main">
                    <RowHead projectId={props.projectId} branch={e.branch} session={e.session} chatOf={props.chatOf} />
                    <p class="mq-facts">
                      <QueueChip row={e.release ? { label: "Release", tone: "accent" } : e.standing?.phase === "dry-run" ? { label: e.position ? `Approved · dry run first · ${nth(e.position)}` : "Approved · dry run first", tone: "info" } : { label: `In line · ${e.position ?? "?"}`, tone: "neutral" }} />
                      <span class="text-mono text-muted">{short(e.commit)}</span>
                      <span>
                        approved {relativeTime(e.approval.at)} · {e.approval.by === "typed" ? "typed in its chat" : "Land button"}
                        {e.approval.withoutReview ? " · without review" : ""}
                        {e.approval.withoutSpecs ? " · without its specs" : ""}
                      </span>
                    </p>
                    <BranchSummaryView summary={e.summary} projectId={props.projectId} branch={e.branch} />
                    {/* While a release holds the queue, no estimate holds: the row's reason says what it waits for. */}
                    <Show when={props.view.release && !e.release ? null : e.eta}>
                      {(t) => (
                        <p class="list-meta">
                          <Icon name="clock" small /> starts in ~{mins(t().startsInMs)} · takes ~{mins(t().takesMs)}
                        </p>
                      )}
                    </Show>
                    <Show when={e.release ? null : e.reason}>
                      {(why) => <p class="list-meta">{why()}</p>}
                    </Show>
                    <Show when={e.dryRun}>{(d) => <DryRunLines dryRun={d()} target={props.view.target} chatTitle={(id) => props.chatOf?.(id)?.title} />}</Show>
                    <Show when={e.newerCommits}>
                      <p class="list-meta">
                        {e.newerCommits} newer commit{e.newerCommits === 1 ? "" : "s"} not included
                      </p>
                    </Show>
                    <Show when={act.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
                  </div>
                  <div class="button-row mq-row-act">
                    <QueueReview projectId={props.projectId} branch={e.branch} scope={{ kind: "queue", project: props.projectId, entry: e.id }} session={e.session} chatOf={props.chatOf} />
                    <button type="button" class="button button-sm button-ghost" aria-label={`Remove ${e.branch} from the merge queue`} title="Takes it off the queue. Its branch, folder, commits and drafts stay." disabled={!!act.busy()} onClick={() => void act.run("cancel", () => cancelEntry(e), `Removed ${e.branch} from the merge queue.`)}>
                      Remove from Queue
                    </button>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      </div>
    </div>
  );
}

/** A held-up entry's Fix in place of its Land (§app.merge-queue/fix): Fix, its ▾ with Fix in New Chat, then what Fix
 *  took the place of (`land`: a decision's Land), Run Dry Run Again on a dry run's failure, and Land Anyway when its
 *  Land's dry run fails on the target too. */
function EntryFix(props: { projectId: string; target: string; entry: MergeEntry; press: ReturnType<typeof usePress>; chatOf?: ChatOf; onAgain?(): void; onLand?(): void; onLandAnyway?(): void }) {
  const e = () => props.entry;
  return (
    <FixSplit
      fix={{ projectId: props.projectId, target: props.target, branch: e().branch, commit: e().commit, failure: e().failure, offer: e().fixOffer, chatTitle: (id) => props.chatOf?.(id)?.title }}
      press={props.press}
      items={(Item) => (
        <>
          <Show when={props.onAgain}>{(f) => <Item label="Run Dry Run Again" aria={`Run the dry run of ${e().branch} again`} description="Runs its new or changed checks on this commit again." onRun={() => f()()} />}</Show>
          <Show when={props.onLand}>{(f) => <Item label="Land" aria={`Land ${e().branch}`} description="Lands the commit it waits at." onRun={() => f()()} />}</Show>
          <Show when={props.onLandAnyway}>{(f) => <Item label="Land Anyway" aria={`Land ${e().branch} anyway`} description={`The landing still runs ${props.target}'s checks.`} onRun={() => f()()} />}</Show>
        </>
      )}
    />
  );
}

/** A Land's dry run that fails on the target too, or can't tell whose: Run Dry Run Again beside Fix (its Try Again),
 *  Land Anyway in Fix's menu (§app.project-setup/trial). */
const heldOnDryRun = (e: MergeEntry): boolean => !!e.dryRunHold && e.dryRunHold.commit === e.commit;

/** An entry that waits for you: a decision (its question, its choices, its answers on the queue, Answer in Chat when
 *  it is answered in words), or a state that waits from before decisions; or a conflict the merge thread is judging.
 *  Remove from Queue on each. No row has a text box, a Send Back or a re-land. */
function NeedsYouRow(props: { projectId: string; root: string; target: string; entry: MergeEntry; chatOf?: ChatOf; view?: MergeQueueView; onChanged(): void }) {
  const e = () => props.entry;
  const act = useAct(props.onChanged);
  const runHref = useRunHref();
  const answer = (a: MergeAnswer, done: string) => void act.run(a, () => answerEntry(e(), a), done);
  const fixPress = usePress(props.onChanged);
  const decision = () => openDecision(e());
  /** The answers on the queue: the decision's, else the state's own. Remove from Queue always last. */
  // The merge thread rules on whose failure it is first: nothing to answer yet, only Remove from Queue.
  const ruling = () => !!e().waitingRuling;
  const actions = (): DecisionAction[] => {
    if (ruling()) return ["remove"];
    const d = decision();
    if (d) return decisionActions(d);
    switch (e().state) {
      case "behaviour-differs":
        return e().conflict?.proposal ? ["accept", "remove"] : ["remove"];
      case "unattributed":
        return ["land-anyway", "try-again", "remove"];
      case "drafts-changed":
        return ["land", "remove"];
      default:
        return ["remove"];
    }
  };
  const inChat = () => {
    const d = decision();
    return d ? answeredInChat(d) : e().state === "behaviour-differs" || e().state === "needs-user";
  };
  const chip = (): { label: string; tone: "warn" | "info" } => {
    if (ruling()) return { label: "Waiting for the merge thread", tone: "info" };
    const d = decision();
    const held = heldDryRunLabel(e());
    if (held) return { label: held, tone: "warn" };
    if (d) return { label: d.kind === "needs-you" ? `Needs you · ${e().branch}` : `${DECISION_LABEL[d.kind]} · waiting for you`, tone: "warn" };
    switch (e().state) {
      case "behaviour-differs":
        return { label: "Behaviour differs · waiting for you", tone: "warn" };
      case "review-flagged":
        return { label: "Review flagged · waiting for you", tone: "warn" };
      case "unattributed":
        return { label: "Can't tell whose failure · waiting for you", tone: "warn" };
      case "drafts-changed":
        return { label: "Drafts changed since you approved", tone: "warn" };
      case "needs-user":
        return { label: `Needs you · ${e().branch}`, tone: "warn" };
      default:
        return { label: "Conflict", tone: "warn" };
    }
  };
  const sides = () => decision()?.sides ?? (e().state === "behaviour-differs" ? e().conflict : undefined);
  const doAct = (a: DecisionAction) => {
    const b = e().branch;
    switch (a) {
      case "accept":
        return answer("accept", `Accepted the resolution for ${b}.`);
      case "land-anyway":
        return answer("land-anyway", `Landing ${b} anyway.`);
      case "try-again":
        return answer("try-again", `Checking ${b} again.`);
      case "land":
        // A decision's Land is answered on the queue (out of tries: a new standing approval at the newest commit); a
        // Drafts changed entry from before decisions re-approves at the commit it waits at.
        return void act.run("land", () => (decision() ? answerEntry(e(), "land") : landBranch(props.root, b, { commit: e().commit })), `Queued ${b}.`);
      case "remove":
        return void act.run("remove", () => cancelEntry(e()), `Removed ${b} from the merge queue.`);
    }
  };
  return (
    <li
      class="list-row mq-row mq-row-grid mq-needs"
      classList={{ "mq-tap": !!e().session }}
      data-branch={e().branch}
      data-state={e().state}
      onClick={rowOpens(() => e().session && chatHref(props.projectId, e().session!, props.chatOf))}
    >
      <div class="list-main">
        <RowHead projectId={props.projectId} branch={e().branch} session={e().session} chatOf={props.chatOf} />
        <p class="mq-facts">
          <QueueChip row={chip()} />
          <span class="text-mono text-muted">{short(e().commit)}</span>
          <Show when={e().run}>
            {(r) => (
              <a href={runHref(props.projectId, r())} onClick={(ev) => ev.stopPropagation()}>
                See Why
              </a>
            )}
          </Show>
        </p>
        <BranchSummaryView summary={e().summary} projectId={props.projectId} branch={e().branch} />
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
        <Show when={!decision() && e().state === "review-flagged"}>
          <p class="list-meta">{e().review?.text ?? e().reason ?? "The review found something that blocks it."}</p>
        </Show>
        {/* A Land's held dry run says its failure once, in the question; Fix and its menu answer it. */}
        <Show when={ruling()}>
          <p class="list-meta">{WAITING_RULING_LINE}</p>
        </Show>
        <Show when={!ruling() && (e().state === "unattributed" || decision()?.kind === "unattributed") && !heldOnDryRun(e())}>
          <p class="list-meta">{unattributedWhy(e().reason, props.target)} Land Anyway lands the commit it tested; Try Again checks it afresh.</p>
          <UnclearChecks projectId={props.projectId} unclear={e().unclear} target={props.target} class="list-meta" />
        </Show>
        <Show when={!decision() && e().state === "drafts-changed"}>
          <p class="list-meta">{e().reason ?? "Its spec drafts changed after you approved. Land again to approve them as they are now."}</p>
        </Show>
        <Show when={!decision() && (e().state === "conflict" || e().state === "needs-user")}>
          <p class="list-meta">{e().reason ?? "The merge thread is judging the conflict. The line moves on meanwhile."}</p>
        </Show>
        <Show when={!ruling() && !heldOnDryRun(e()) && e().failure}>{(f) => <p class="list-meta mq-failure">{failureLine(f(), props.target)}</p>}</Show>
        <Show when={e().failure?.kind === "dry-run"}>
          <DryRunWhat target={props.target} class="list-meta" />
        </Show>
        <Show when={props.view}>{(pv) => <ReviewerLinks projectId={props.projectId} view={pv()} run={e().run} />}</Show>
        <Show when={act.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
        <Show when={fixPress.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
      </div>
      <div class="button-row mq-row-act">
        <QueueReview projectId={props.projectId} branch={e().branch} scope={{ kind: "queue", project: props.projectId, entry: e().id }} session={e().session} chatOf={props.chatOf} />
        {/* A failure holds it up: Fix takes Land's place, Land moves into its menu (§app.merge-queue/fix). */}
        <Show when={!ruling() && e().failure}>
          <Show when={heldOnDryRun(e())}>
            <button type="button" class="button button-sm" aria-label={`Run the dry run of ${e().branch} again`} disabled={!!act.busy()} onClick={(ev) => { ev.stopPropagation(); doAct("try-again"); }}>
              Run Dry Run Again
            </button>
          </Show>
          <EntryFix projectId={props.projectId} target={props.target} entry={e()} press={fixPress} chatOf={props.chatOf} onLand={actions().includes("land") ? () => doAct("land") : undefined} onLandAnyway={heldOnDryRun(e()) && actions().includes("land-anyway") ? () => doAct("land-anyway") : undefined} />
        </Show>
        {/* Fix took Land's place; a Land's held dry run moves Land Anyway into Fix's menu and Try Again beside it. */}
        <For each={actions().filter((a) => a !== "remove" && !(e().failure && a === "land") && !(e().failure && heldOnDryRun(e()) && (a === "land-anyway" || a === "try-again")))}>
          {(a) => (
            <button
              type="button"
              class={`button button-sm${a === "try-again" ? "" : " button-primary"}`}
              aria-label={a === "accept" ? `Accept the resolution for ${e().branch}` : a === "land-anyway" ? `Land ${e().branch} anyway` : a === "try-again" ? `Try ${e().branch} again` : `Land ${e().branch}`}
              disabled={!!act.busy()}
              aria-busy={act.busy() === a ? "true" : undefined}
              onClick={(ev) => {
                ev.stopPropagation();
                doAct(a);
              }}
            >
              {DECISION_ACTION_LABEL[a]}
            </button>
          )}
        </For>
        <Show when={inChat() && e().session}>
          <a class="button button-sm" href={chatHref(props.projectId, e().session!, props.chatOf)} aria-label={`Answer about ${e().branch} in its chat`} title="You answer in the chat's message box." onClick={(ev) => ev.stopPropagation()}>
            Answer in Chat
          </a>
        </Show>
        <button
          type="button"
          class="button button-sm"
          aria-label={`Remove ${e().branch} from the merge queue`}
          title="Takes it off the queue. Its branch, folder, commits and drafts stay."
          disabled={!!act.busy()}
          onClick={(ev) => {
            ev.stopPropagation();
            doAct("remove");
          }}
        >
          Remove from Queue
        </button>
      </div>
    </li>
  );
}

/** A test check broken on the target (heads.targetBroken): every branch skips it meanwhile, so the user starts a chat
 *  to fix it there. It leaves once a later run of that check runs tests again. */
function BrokenRow(props: { projectId: string; target: string; broken: TargetBroken; offer?: import("../../shared/merge-queue").FixOffer }) {
  const b = () => props.broken;
  const runHref = useRunHref();
  const press = usePress();
  return (
    <li class="list-row mq-row" data-state="target-broken" data-check={b().check}>
      <div class="list-main">
        <p class="mq-facts">
          <QueueChip row={{ label: `Broken on ${props.target}`, tone: "error" }} />
          <span class="text-muted">{relativeTime(b().at)}</span>
        </p>
        <p class="list-meta">{sentence(b().why)}</p>
        <p class="list-meta text-muted">Every branch skips it until it's fixed, and lands without it.</p>
        <Show when={press.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
      </div>
      <div class="button-row mq-row-act">
        <FixNewChatButton fix={{ projectId: props.projectId, target: props.target, offer: props.offer, check: { id: b().check, label: b().label, run: b().run } }} press={press} />
        <a class="button button-sm button-ghost" href={runHref(props.projectId, b().run)} aria-label={`View the log of ${b().label} on ${props.target}`}>
          View the Log
        </a>
      </div>
    </li>
  );
}

/** A branch with its chat: the user's Land stands while its chat fixes something ("Back with the chat · try 2 of 3 ·
 *  Unit tests failed", "Waiting for the merge thread", "Paused: you stopped the chat", "Approved · waiting for a
 *  fix"), or one still sent back from before. See Why and Remove from Queue; never Land, a re-land or a send-back. */
function WithChatRow(props: { projectId: string; entry: MergeEntry; view: MergeQueueView; chatOf?: ChatOf; onChanged(): void }) {
  const e = () => props.entry;
  const act = useAct(props.onChanged);
  const runHref = useRunHref();
  const words = (): { label: string; tone: "info" | "warn" | "neutral" | "error"; detail?: string; answer?: string } => standingWords(e()) ?? { label: "Needs a fix", tone: "error" };
  const fixPress = usePress(props.onChanged);
  return (
    <li class="list-row mq-row" classList={{ "mq-tap": !!e().session }} data-branch={e().branch} data-state={e().state} onClick={rowOpens(() => e().session && chatHref(props.projectId, e().session!, props.chatOf))}>
      <div class="list-main">
        <RowHead projectId={props.projectId} branch={e().branch} session={e().session} chatOf={props.chatOf} />
        <p class="mq-facts">
          <QueueChip row={{ label: words().label, tone: words().tone }} />
          <Show when={words().detail}>{(x) => <span class="text-muted">{x()}</span>}</Show>
          <span class="text-mono text-muted">{short(e().commit)}</span>
          <span class="text-muted">{relativeTime(e().updatedAt)}</span>
        </p>
        <BranchSummaryView summary={e().summary} projectId={props.projectId} branch={e().branch} />
        <Show when={e().reason}>{(r) => <p class="list-meta">{r()}</p>}</Show>
        <Show when={words().answer}>
          {(x) => (
            <p class="list-meta">
              <span class="text-muted">Chat:</span> {x()}
            </p>
          )}
        </Show>
        <Show when={e().failure}>{(f) => <p class="list-meta mq-failure">{failureLine(f(), props.view.target)}</p>}</Show>
        <Show when={e().dryRun && e().dryRun!.commit === e().commit ? e().dryRun : undefined}>{(d) => <DryRunWhat target={props.view.target} />}</Show>
        <p class="list-meta text-muted">{STANDING_LINE}</p>
        <ReviewerLinks projectId={props.projectId} view={props.view} run={e().run} />
        <Show when={act.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
        <Show when={fixPress.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
      </div>
      <div class="button-row mq-row-act">
        <QueueReview projectId={props.projectId} branch={e().branch} scope={{ kind: "queue", project: props.projectId, entry: e().id }} session={e().session} chatOf={props.chatOf} />
        <Show when={e().failure}>
          <EntryFix
            projectId={props.projectId}
            target={props.view.target}
            entry={e()}
            press={fixPress}
            chatOf={props.chatOf}
            onAgain={e().dryRun && e().dryRun!.commit === e().commit ? () => runDryRunPress(fixPress, props.projectId, e().branch, e().commit) : undefined}
            onLandAnyway={e().failure?.whose === "master" && e().dryRun?.land ? () => void act.run("land-anyway", () => answerEntry(e(), "land-anyway"), `Landing ${e().branch} anyway.`) : undefined}
          />
        </Show>
        <Show when={e().run}>
          {(r) => (
            <a class="button button-sm button-ghost" href={runHref(props.projectId, r())} onClick={(ev) => ev.stopPropagation()}>
              See Why
            </a>
          )}
        </Show>
        <button
          type="button"
          class="button button-sm"
          aria-label={`Remove ${e().branch} from the merge queue`}
          title="Takes it off the queue. Its branch, folder, commits and drafts stay."
          disabled={!!act.busy()}
          onClick={(ev) => {
            ev.stopPropagation();
            void act.run("cancel", () => cancelEntry(e()), `Removed ${e().branch} from the merge queue.`);
          }}
        >
          Remove from Queue
        </button>
      </div>
    </li>
  );
}

/** A branch ready to land that nobody approved yet: Review Changes, and Land with its ▾. Land names the row's chat. */
function ReadyRow(props: { projectId: string; root: string; target?: string; how?: LandHow; ready: MergeReady; review: boolean; waitingId?: string; chatOf?: ChatOf; treesOf?: TreesOf; onChanged(): void }) {
  const r = () => props.ready;
  const act = useAct(props.onChanged);
  const confirm = createLandConfirm();
  const discard = createDiscard(() => ({ project: props.projectId, branch: r().branch, commit: r().commit }), props.onChanged);
  const openDiscard = () => {
    discard.opened();
    confirm.open("discard");
  };
  // Land names no chat: the server records the branch's owner by the same rule that put this row's chat here
  // (server/merge-queue/owners.ts).
  const doLand = (o: LandOptions = {}) =>
    void act.run("land", () => landBranch(props.root, r().branch, { ...o, commit: r().commit }), `Queued ${r().branch}${o.withoutReview ? " without review" : ""}${o.withoutSpecs ? " without its specs" : ""}.`);
  // The chip is the branch's chat's own readiness reading (Land's offer doesn't rest on it: the row is Ready to land,
  // not approved, by git's reading of the branch).
  const chip = () => readyRowChip(r(), r().session ? props.treesOf?.(r().session!) : undefined);
  const when = () => headWhen(r().headAt);
  // A setup branch's dry run at this head (§app.merge-queue/dry-runs): its chip, line and actions; never an older one's.
  const dry = (): BranchDryRun | undefined => (r().dryRun && r().dryRun!.commit === r().commit ? r().dryRun : undefined);
  const dryActs = () => (dry() ? dryRunActions(dry()!) : undefined);
  const press = usePress(props.onChanged);
  const target = () => props.target ?? "the target";
  const fixTarget = (): FixTarget => ({ projectId: props.projectId, target: target(), branch: r().branch, commit: r().commit, failure: dry()?.failure, offer: dry()?.fixOffer, chatTitle: (id) => props.chatOf?.(id)?.title });
  return (
    <li class="list-row mq-row mq-row-grid" classList={{ "mq-tap": !!r().session, "wt-queue-asking": !!confirm.ask() }} data-branch={r().branch} data-state="ready" ref={confirm.rowRef} onClick={rowOpens(() => r().session && chatHref(props.projectId, r().session!, props.chatOf))}>
      <div class="list-main">
        <RowHead projectId={props.projectId} branch={r().branch} session={r().session} archived={r().sessionArchived} chatOf={props.chatOf} />
        <p class="mq-facts">
          {/* One state chip: a dry run that hasn't passed at this head stands in for the chat's readiness. */}
          <Show when={dry() && dry()!.state !== "passed" ? dry() : undefined} fallback={<QueueChip row={chip()} title={chip().title} />}>
            {(d) => <QueueChip row={dryRunChip(d())} title={d().why} />}
          </Show>
          <span class="text-mono text-muted">{short(r().commit)}</span>
          <span>
            {readyFactsWords(r())}
            {/* When the branch last changed, in full on hover. */}
            <Show when={when()}>
              {(w) => (
                <>
                  {" · "}
                  <time class="mq-when" dateTime={w().iso} title={w().full} aria-label={`last commit ${w().full}`}>
                    {w().text}
                  </time>
                </>
              )}
            </Show>
          </span>
        </p>
        <BranchSummaryView summary={r().summary} projectId={props.projectId} branch={r().branch} />
        <Show when={dry()}>
          {(d) => <DryRunLines dryRun={d()} target={target()} chatTitle={(id) => props.chatOf?.(id)?.title} seeChecks={d().run ? mergeRunHref(props.projectId, d().run!) : undefined} />}
        </Show>
        <Show when={act.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
        <Show when={press.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
        <Show when={discard.partial()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
      </div>
      {/* A confirm replaces the row's actions while it is open. */}
      <LandConfirms confirm={confirm} branch={r().branch} ahead={r().ahead} target={props.target} how={props.how} drafts={r().draftsOnly} busy={!!act.busy()} onLand={doLand} discard={discard} firstLine={dry() && runsFirst(dry()) ? landFirstLine(r().commit, dry()!.why) : undefined} />
      <Show when={!confirm.ask()}>
        <div class="mq-row-act">
          <QueueReview projectId={props.projectId} branch={r().branch} scope={{ kind: "queue", project: props.projectId, branch: r().branch }} session={r().session} chatOf={props.chatOf} />
          <Show when={dryActs()?.stop}>
            <DryRunButton projectId={props.projectId} branch={r().branch} commit={r().commit} kind="stop" run={dry()?.state === "running" ? dry()?.run : undefined} waiting={dry()?.state === "waiting" ? (waitingIdOf(dry()) ?? props.waitingId) : undefined} press={press} />
          </Show>
          <Show when={dryActs()?.run}>{(k) => <DryRunButton projectId={props.projectId} branch={r().branch} commit={r().commit} kind={k()} press={press} />}</Show>
          <Show
            when={dryActs()?.primary === "fix"}
            fallback={
              <LandSplit branch={r().branch} review={props.review} busy={!!act.busy()} onAsk={() => confirm.open("land")} onLand={doLand} onWithoutSpecs={() => confirm.open("specs")} draftsOnly={!!r().draftsOnly} onDiscard={openDiscard} discardWhy={discard.refused()} discardLine={discardMenuLine(discard.preview())} onMenuOpen={() => void discard.check()} />
            }
          >
            <FixSplit
              fix={fixTarget()}
              press={press}
              onMenuOpen={() => void discard.check()}
              items={(Item) => (
                <>
                  <Show when={dryActs()!.menu.includes("again")}>
                    <Item label="Run Dry Run Again" aria={`Run the dry run of ${r().branch} again`} description="Runs its new or changed checks on this commit again." onRun={() => runDryRunPress(press, props.projectId, r().branch, r().commit)} />
                  </Show>
                  <Show when={dryActs()!.menu.includes("land")}>
                    <Item label="Land" aria={`Land ${r().branch}`} description="Asks first. A dry run runs first; it lands once it passes." onRun={() => confirm.open("land")} />
                  </Show>
                  <div class="popover-sep" role="separator" />
                  <Item label="Discard Branch…" aria={`Discard ${r().branch}`} description={discardMenuLine(discard.preview()) ?? undefined} disabled={discard.refused() ?? undefined} onRun={openDiscard} />
                </>
              )}
            />
          </Show>
        </div>
      </Show>
    </li>
  );
}
