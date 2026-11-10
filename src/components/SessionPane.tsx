import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import type { ExplanationInfo, SessionInsight, SessionSummary, TranscriptItem, WorkerInfo } from "../../shared/protocol";
import { fetchTranscriptLight } from "../lib/api";
import { explainCaption, explainHref, explainInterrupted, explainState, newestFirst } from "../lib/explain";
import { sessionIdOfPath } from "../lib/links";
import { absoluteTime, headChipSpend, headChipWords } from "../lib/spend";
import { activeTab, setActiveTab, toast } from "../lib/ui-state";
import { capTitle, workerLabel, workerTeam } from "../lib/workers";
import type { RewindControl } from "../lib/inputs";
import { paneShares } from "../lib/pane-shares";
import { openingTab, TABS, type TabId } from "../lib/pane-tabs";
import { sharingTabLabel } from "../lib/session-shares";
import { RemotePaneStatus } from "./RemoteStatus";
import { ContextTab } from "./ContextTab";
import { SessionDetails, SharingSection } from "./SessionDetails";
import { MemoryOutlineSection } from "./MemoryOutline";
import { SessionTimeline } from "./SessionTimeline";
import { createSessionSpend, SessionUsageTab } from "./SessionUsage";
import { type AgentsView, SubagentPane } from "./SubagentPane";
import { TimeSpentTab } from "./TimeSpent";
import { Chip, Icon } from "./ui";
import { DesignGallery } from "./DesignGallery";
import { DesignPageAssets } from "./DesignBriefImages";
import { trackSessionPane } from "../lib/time-spent";

/** The open session's insight, loaded once in App.tsx for the head, the strip and this pane. */
export interface PaneInsight {
  data: SessionInsight | null;
  /** Message of the latest failed load, cleared by the next success. */
  error: string | null;
  /** True until the first load settles (either way). */
  pending: boolean;
  /** Bumped when a load that followed a change to the session's file lands — never by the
      pane's own status poll — so the Session tab refetches the transcript only when it moved. */
  changed: number;
}

export type { TabId };

/**
 * The session detail pane: a head, a tab strip, and one tab's panel. Session is what the session
 * is (SessionDetails); Timeline is the session's one time axis; Agents is the subagents pane it grew
 * out of; Usage is what the session has spent (SessionUsage); Time Spent is where your time and the agent's went (TimeSpent); Context is what fills its window now (ContextTab); Sharing is its share links, with a
 * viewing-now badge on the tab; Skills says which skills loaded and when, here and in each worker; Gallery shows this chat's prototypes above its /explain pages. The tab is kept per
 * session path; with none kept, it opens on Agents while a worker is working, else on Session —
 * never on Usage, which its tab and the head's token chip open, or on Time Spent. Read-only throughout, except the
 * Timeline's rewind, which goes through the chat.
 */
export function SessionPane(props: {
  path: string;
  insight: PaneInsight;
  /** App-level session list row (undefined before the list loads), for Identity. */
  summary: SessionSummary | undefined;
  /** After Archive/Unarchive in the Session tab: re-read the session list, with the session's
      path and its new archived state (an archived one leaves the list). */
  onArchiveChanged(path: string, archived: boolean): void;
  /** After a group change in the Session tab: the same list, for the Groups region. */
  onGroupsChanged(): void;
  chatWorkers: WorkerInfo[] | null;
  selected: string | null;
  onSelect(id: string): void;
  onClose(): void;
  now: number;
  /** The open chat's rewind hook for the Timeline's input rows; absent while watching or before the
      chat opens. */
  rewind?: RewindControl;
  /** App's last successful rewind of this session, whoever started it: the pane re-reads the
      transcript on it, and the Timeline draws the boundary. Never set by a refusal. */
  rewound?: { path: string; entryId: string; changed: number } | null;
  /** The Timeline's "Inputs Only" filter. App holds it for as long as the pane is open, so /tree
      and the composer's inputs row can open the tab with it on; nothing is persisted. */
  inputsOnly?: boolean;
  onInputsOnly?(on: boolean): void;
  /** The tab actually showing, reported on open, on every change, and as null when the pane goes.
      The composer's triggers key `aria-expanded` off it: the kept tab alone can't answer, since a
      session nobody has tabbed shows the fallback while `activeTab` is still null. */
  onTab?(tab: TabId | null): void;
}) {
  // The transcript, read once for the whole pane: the Session tab and the Timeline both want
  // the same rows, and a fetch per tab meant a refetch on every tab switch. Light rows (no reply
  // text, tool output or image bytes): the pane reads every row but draws none of that, and a jump
  // from the Timeline mustn't wait behind the whole transcript downloading. It reloads when the
  // session's file moved (App's debounced insight reload) and after a rewind, whoever started it.
  const [items, setItems] = createSignal<TranscriptItem[] | null>(null);
  let run = 0;
  const loadItems = async () => {
    const mine = ++run;
    try {
      const next = await fetchTranscriptLight(props.path);
      if (mine === run) setItems(next);
    } catch {
      // The rows on screen stay; the next change to the file retries.
    }
  };
  createEffect(on(() => props.insight.changed, () => void loadItems()));
  createEffect(on(() => props.rewound?.changed, (changed) => changed && props.rewound?.path === props.path && void loadItems(), { defer: true }));
  onCleanup(() => run++);

  const sharing = paneShares(() => props.summary);

  const workers = () => props.chatWorkers ?? props.insight.data?.workers ?? [];
  const working = () => workers().filter((w) => w.working).length;
  /** The session's spend from the usage ledger, for the head chip, the Usage tab and the Agents
      tab's worker rows: one poll while the pane is open. */
  const sid = createMemo(() => props.summary?.id ?? sessionIdOfPath(props.path));
  const spend = createSessionSpend(sid);
  /** The head chip's figure, the Usage tab's headline: nothing until the ledger has answered, and
      nothing when nothing was spent. */
  const total = () => headChipSpend(spend.data(), sid());
  // Settled once, on open: a default that followed the working count would move the tab under
  // the reader when the last worker finished.
  const fallback: TabId = untrack(working) > 0 ? "agents" : "session";
  const tab = (): TabId => openingTab(activeTab(props.path), fallback);

  /** The Agents tab's half in a narrow pane (list or one worker), kept across tab switches for
      as long as the pane is open. */
  const [agentsView, setAgentsView] = createSignal<AgentsView | null>(null);

  createEffect(() => props.onTab?.(tab()));
  onCleanup(() => props.onTab?.(null));

  const tabEls: HTMLButtonElement[] = [];
  // The strip scrolls sideways in a narrow pane: keep the tab showing, on open and on every change,
  // so a tab a door opened (Gallery, Usage) is never off the end of the strip.
  createEffect(() => tabEls[TABS.findIndex((t) => t.id === tab())]?.scrollIntoView({ inline: "nearest", block: "nearest" }));
  let aside!: HTMLElement;
  onMount(() =>
    queueMicrotask(() => {
      // A narrow pane shows one half of the tab: the first of these it actually shows.
      const row =
        tab() === "agents"
          ? ['.subagent-row[aria-current="true"]', ".subagent-row", ".subagents-back"]
              .map((q) => aside.querySelector<HTMLElement>(q))
              .find((el) => el?.checkVisibility())
          : null;
      (row ?? tabEls[TABS.findIndex((t) => t.id === tab())])?.focus();
    }),
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    props.onClose();
  };
  /** Left/Right move focus along the strip (wrapping), Home/End jump; Enter or Space selects. */
  const onTabKey = (e: KeyboardEvent, i: number) => {
    const last = TABS.length - 1;
    const next =
      e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    tabEls[next]?.focus();
  };

  trackSessionPane(props.path, () => aside);

  return (
    <aside class="app-subagents" id="session-pane" data-time-session={props.path} aria-label="Session detail" ref={aside} onKeyDown={onKeyDown}>
      <header class="subagents-head">
        <h2 class="subagents-title">Session detail</h2>
        <Show when={working() > 0}>
          <span class="chip chip-count">{working()} working</span>
        </Show>
        <Show when={total()}>
          {(t) => (
            <button
              type="button"
              class="chip chip-count subagents-usage"
              aria-label={headChipWords(t()).label}
              title={headChipWords(t()).title}
              onClick={() => setActiveTab(props.path, "usage")}
            >
              {headChipWords(t()).text}
            </button>
          )}
        </Show>
        <button type="button" class="button button-icon button-ghost subagents-close" aria-label="Close session detail" onClick={() => props.onClose()}>
          <Icon name="chevron-right" />
        </button>
      </header>
      {/* A remote session's identity, mount and connection, on every tab (the identity chip even
          before its chat reports one). */}
      <RemotePaneStatus path={props.path} summary={props.summary} />
      {/* Named apart from the landmark: both saying "Session detail" made a reader announce the
          same name twice, nesting into itself. */}
      <div class="tabs session-tabs" role="tablist" aria-label="Session detail tabs">
        <For each={TABS}>
          {(t, i) => (
            <button
              type="button"
              role="tab"
              class={tab() === t.id ? "tab tab-active" : "tab"}
              id={`session-tab-${t.id}`}
              aria-selected={tab() === t.id ? "true" : "false"}
              aria-controls={tab() === t.id ? "session-tabpanel" : undefined}
              tabindex={tab() === t.id ? 0 : -1}
              ref={(el) => (tabEls[i()] = el)}
              aria-label={t.id === "sharing" ? sharingTabLabel(sharing.viewing()) : undefined}
              onClick={() => setActiveTab(props.path, t.id)}
              onKeyDown={(e) => onTabKey(e, i())}
            >
              {t.label}
              <Show when={t.id === "sharing" && sharing.viewing() > 0}>
                <span class="chip chip-count session-tab-badge" aria-hidden="true">
                  {sharing.viewing()}
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>
      <div class="session-panel" role="tabpanel" id="session-tabpanel" aria-labelledby={`session-tab-${tab()}`}>
        <Switch>
          <Match when={tab() === "session"}>
            <SessionTab
              path={props.path}
              insight={props.insight}
              summary={props.summary}
              items={items()}
              now={props.now}
              onArchiveChanged={props.onArchiveChanged}
              onGroupsChanged={props.onGroupsChanged}
              onClose={props.onClose}
            />
          </Match>
          <Match when={tab() === "timeline"}>
            <SessionTimeline
              path={props.path}
              items={items()}
              outline={props.insight.data?.outline ?? null}
              outlines={props.insight.data?.outlines}
              rewinds={props.insight.data?.rewinds}
              rewound={props.rewound}
              summary={props.summary}
              rewind={props.rewind}
              inputsOnly={props.inputsOnly ?? false}
              onInputsOnly={(on) => props.onInputsOnly?.(on)}
              pending={props.insight.pending}
              now={props.now}
              onReload={loadItems}
              onClose={props.onClose}
            />
          </Match>
          <Match when={tab() === "time"}>
            <div class="session-panel-scroll" tabindex="0">
              <TimeSpentTab path={props.path} />
            </div>
          </Match>
          <Match when={tab() === "agents"}>
            <SubagentPane
              path={props.path}
              chatWorkers={props.chatWorkers}
              insight={props.insight}
              selected={props.selected}
              onSelect={props.onSelect}
              view={agentsView()}
              onView={setAgentsView}
              overseer={!!props.summary?.overseer}
              spend={spend.data()}
            />
          </Match>
          <Match when={tab() === "usage"}>
            <SessionUsageTab spend={spend} workers={workers()} />
          </Match>
          <Match when={tab() === "context"}>
            <ContextTab path={props.path} workers={workers()} teams={props.insight.data?.teams} changed={props.insight.changed} />
          </Match>
          <Match when={tab() === "sharing"}>
            <div class="session-panel-scroll" tabindex="0">
              <Show when={props.summary}>
                {(s) => <SharingSection session={s()} shares={sharing.shares()} error={sharing.error()} now={props.now} onChanged={sharing.reload} />}
              </Show>
            </div>
          </Match>
          <Match when={tab() === "gallery"}>
            <GalleryTab path={props.path} insight={props.insight} now={props.now} />
          </Match>
        </Switch>
      </div>
    </aside>
  );
}

// ---- Session ----------------------------------------------------------------------------------

/**
 * The Session tab, fed from App's shared insight and the pane's shared transcript read, which the
 * Changes list needs — no fetch of its own.
 */
function SessionTab(props: {
  path: string;
  insight: PaneInsight;
  summary: SessionSummary | undefined;
  items: TranscriptItem[] | null;
  now: number;
  onArchiveChanged(path: string, archived: boolean): void;
  onGroupsChanged(): void;
  /** Closes the pane: a memory line's jump from the drawer band would otherwise land behind it. */
  onClose?: () => void;
}) {
  /** The poller keeps the last insight through a failure, so only a first-load failure shows;
      it retries on its own, so the banner offers no Retry. */
  const failure = () => (props.insight.data ? null : props.insight.error);

  return (
    <div class="session-panel-scroll" tabindex="0">
      <SessionDetails
        path={props.path}
        insight={props.insight.data}
        error={failure()}
        pending={props.insight.pending}
        summary={props.summary}
        items={props.items ?? []}
        now={props.now}
        onArchiveChanged={props.onArchiveChanged}
        onGroupsChanged={props.onGroupsChanged}
        gitChanged={props.insight.changed}
      />
      <MemoryOutlineSection path={props.path} now={props.now} onClose={props.onClose} />
    </div>
  );
}

// ---- Gallery ----------------------------------------------------------------------------------

/**
 * This session's /explain pages, newest first, as text rows: the Explanations page (from the
 * insight strip) owns thumbnails, and both open the same page through `explainHref`. Read off the shared insight.
 */
function GalleryTab(props: { path: string; insight: PaneInsight; now: number }) {
  const items = () => newestFirst(props.insight.data?.explanations ?? []);
  return (
    <div class="session-panel-scroll" tabindex="0">
      <DesignGallery path={props.path} />
      <DesignPageAssets path={props.path} />
      <h3 class="text-eyebrow gallery-explanations">Explanations</h3>
      <Show
        when={items().length > 0}
        fallback={
          <Show when={!props.insight.pending}>
            <div class="empty subagents-empty">
              <p class="empty-title">0 explanations in this session.</p>
              <p class="empty-body">
                Run <code>/explain &lt;topic&gt;</code> to add one.
              </p>
            </div>
          </Show>
        }
      >
        <ul class="list explain-list" aria-label="Explanations">
          <For each={items()}>{(item) => <ExplainRow item={item} now={props.now} />}</For>
        </ul>
      </Show>
    </div>
  );
}

/**
 * One explanation, in ExplainCard's three states: ok links out; failed (`error`) wrote no page, so
 * it is not a link and states its reason; noted (`note`) links out and carries the note.
 */
function ExplainRow(props: { item: ExplanationInfo; now: number }) {
  const state = () => explainState(props.item);
  const body = () => (
    <span class="list-main">
      <span class="list-title">{props.item.topic}</span>
      <Show when={props.item.summary}>
        <span class="explain-row-summary">{props.item.summary}</span>
      </Show>
      <span class="list-meta">{explainCaption(props.item, props.now)}</span>
      <Show when={state() === "failed"}>
        <span class="explain-row-state">{props.item.error}</span>
      </Show>
      <Show when={state() === "noted"}>
        <span class="explain-row-state text-muted">{props.item.note}</span>
      </Show>
    </span>
  );
  return (
    <li>
      <Show
        when={state() !== "failed"}
        fallback={
          <div class="list-row explain-row">
            {body()}
            <Show when={explainInterrupted(props.item)} fallback={<Chip tone="error">Failed</Chip>}>
              <Chip tone="warn">Interrupted</Chip>
            </Show>
          </div>
        }
      >
        <a class="list-row list-row-interactive explain-row" href={explainHref(props.item.id)}>
          <span class="visually-hidden">Explanation: </span>
          {body()}
        </a>
      </Show>
    </li>
  );
}
