import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, untrack, type JSX } from "solid-js";
import { newestTopics, topicTime } from "../../shared/outline-order";
import type { AgentsInsight, ContextInfo, OutlineTopic, SessionSummary, WorktreeStatus } from "../../shared/protocol";
import { type AgentsAnswer, fetchSessionInsight, fetchWorktrees, getUsageSessions, getUsageToday } from "../lib/api";
import { wantAgentsTokens } from "../lib/agents-feed";
import {
  BOARD_FILTERS,
  BOARD_PAGE,
  type BoardFilter,
  boardGroups,
  type BoardRow,
  boardRows,
  boardTotals,
  filterCounts,
  inDefaultScope,
  type RateCell,
  rateCell,
  ROW_TOPICS,
  rowDetail,
  rowHasDetail,
  type RowRate,
  rateReader,
  sameRateCell,
  sortRows,
  STATE_WORD,
  teamChips,
  teamForLink,
  totalsLine,
  treeMerge,
  type TreeMerge,
  treeName,
  treeTitle,
  visibleRows,
  workersChips,
  workersLine,
  WORKTREES_POLL_MS,
  worktreePathsKey,
} from "../lib/agents-board";
import { compactModel, relativeTime, tildePath } from "../lib/format";
import { browserZone, costsHref, type CostsQuery, DEFAULT_COSTS_QUERY } from "../lib/cost-history";
import { agentsHref, teamKey } from "../lib/insights";
import { hostOf } from "../lib/mesh";
import { createPoll, type Poll } from "../lib/poll";
import { renameSession } from "../lib/session-actions";
import { archiveBlockReason } from "../lib/archive-block";
import { quoted } from "../lib/session-groups";
import { summaryLineOf, summaryTitleOf } from "../lib/summary-row";
import { home, localRunning, sessionContext } from "../lib/ui-state";
import { capTitle } from "../lib/workers";
import "../agents-board.css";
import { RowMenu } from "./SessionRowMenu";
import { ContextRing } from "./ContextRing";
import { CostsTab } from "./CostsTab";
import { PerformanceTab } from "./PerformanceTab";
import { DEFAULT_PERF_QUERY, type PerfQuery, perfHref } from "../lib/perf";
import { InsightsPage, ListSkeleton } from "./InsightsPage";
import { TitleField } from "./TitleField";
import { sessionHref } from "./Sidebar";
import { Chip, CountChip, Icon } from "./ui";

/** What a row needs from the page: the shared state and the gestures that reach past the board. */
interface BoardCtx {
  now: number;
  agents: AgentsInsight | undefined;
  treesOf(path: string): WorktreeStatus[] | undefined;
  expanded(path: string): boolean;
  toggle(path: string): void;
  renaming(path: string): boolean;
  setRenaming(path: string | null): void;
  onRefresh(): void;
  onArchiveChanged(path: string, archived: boolean): void;
  onOpenSubagents(path: string): void;
  /** The session whose Session details pane is open beside the board, if any. */
  detailsPath: string | null;
  onOpenDetails(path: string): void;
  /** That session's Session details pane, on its Agents tab: a team chip's click. */
  onOpenAgents(path: string): void;
  /** USD its workers have spent (the usage ledger), when above zero; null before the answer. */
  workersSpend(sessionId: string): number | null;
  /** Its tokens a minute (§app.insights/session-token-rate), by session id, read once per answer and 30 s step; none when idle. */
  rateOf(sessionId: string): RowRate | undefined;
  /** The server sends per-session tokens at all (an older one doesn't). */
  tokensReported: boolean;
}

/** Spend moves with every call, but a minute is fresh enough for a head figure and a row's chip. */
const USAGE_POLL_MS = 60_000;

/** A turn in flight as this tab knows it, newer than the list (the sidebar's rule). */
const busyOf = (s: SessionSummary) => !s.live && !!(localRunning()[s.path] ?? s.busy);

/** The row's context fill: the open session's live value wins over the list's tail value. */
function contextOf(s: SessionSummary): ContextInfo | null {
  const live = sessionContext()[s.path];
  if (live === "compacted") return null;
  if (live) return live;
  return s.context && s.context.window ? s.context : null;
}

/** A tree's merge reading: a success chip when merged, else "unmerged" in words, else a muted word. No counts. */
function TreeMergeMark(props: { tree: WorktreeStatus }) {
  const m = createMemo(() => treeMerge(props.tree));
  return (
    <Switch>
      <Match when={m().kind === "merged" && (m() as Extract<TreeMerge, { kind: "merged" }>)}>
        {(r) => (
          <Chip tone="success" title={r().title}>
            {r().text}
          </Chip>
        )}
      </Match>
      <Match when={m().kind === "unmerged" && (m() as Extract<TreeMerge, { kind: "unmerged" }>)}>
        {(r) => (
          <span class="board-unmerged" title={r().title}>
            {r().text}
          </span>
        )}
      </Match>
      <Match when={m().kind === "unknown" && (m() as Extract<TreeMerge, { kind: "unknown" }>)}>
        {(r) => <span class="text-muted">{r().text}</span>}
      </Match>
    </Switch>
  );
}

/** "—" for a cell with nothing to say, with the words for AT. */
function Dash(props: { words: string }) {
  return (
    <span class="board-dash">
      <span aria-hidden="true">—</span>
      <span class="visually-hidden">{props.words}</span>
    </span>
  );
}

/** The Tokens/min cell, and the folded micro line's figure: one line, or a muted dash that says why. */
function RateMark(props: { cell: RateCell; micro?: boolean }) {
  return (
    <Show when={props.cell.figure} fallback={props.micro ? null : <span class="board-dash" title={props.cell.title}><span aria-hidden="true">—</span><span class="visually-hidden">{props.cell.title}</span></span>}>
      {(f) => (
        <span class={props.micro ? "board-rate" : "board-cell-line board-rate text-num"} title={props.cell.title}>
          <span aria-hidden="true">{f()}</span>
          <span class="visually-hidden">{props.cell.title}</span>
        </span>
      )}
    </Show>
  );
}

/** One tree in the open row: branch, merged or unmerged, uncommitted work in words, whose, and its path. */
function TreeLine(props: { tree: WorktreeStatus }) {
  const t = () => props.tree;
  return (
    <li class="board-tree-line" title={treeTitle(t())}>
      <Icon name="branch" small />
      <span class="board-tree-branch text-mono">{treeName(t())}</span>
      <TreeMergeMark tree={t()} />
      <Show when={t().dirty}>
        <span class="board-dirty-word">
          <span class="board-dirty" aria-hidden="true" />
          uncommitted
        </span>
      </Show>
      <Show when={t().source === "worker"}>
        <span class="text-caption text-muted">a worker's</span>
      </Show>
      <span class="board-tree-path text-mono text-muted">{tildePath(t().path, home())}</span>
    </li>
  );
}

/** The topics an open row lists: read once when it opens, kept while it stays open, never polled. */
type RowTopics = { kind: "reading" } | { kind: "failed" } | { kind: "read"; topics: OutlineTopic[] };

/** The open row: what the session is about and where it stands. Mounted only while the row is open. */
function RowDetailView(props: { row: BoardRow; ctx: BoardCtx; id: string }) {
  const s = () => props.row.session;
  const d = createMemo(() => rowDetail(props.row, props.ctx.treesOf(s().path)));
  const [topics, setTopics] = createSignal<RowTopics | null>(null);
  // Once per opening: a row whose outline has topics reads their headings, nothing else does.
  if (d().topics) {
    let alive = true;
    onCleanup(() => (alive = false));
    setTopics({ kind: "reading" });
    fetchSessionInsight(s().path).then(
      (res) => alive && setTopics({ kind: "read", topics: newestTopics(res.outline?.topics ?? []).slice(0, ROW_TOPICS) }),
      () => alive && setTopics({ kind: "failed" }),
    );
  }
  return (
    <Show when={rowHasDetail(d())}>
      <div class="board-detail" id={props.id}>
        <Show when={d().reason}>
          {(why) => (
            <p class="board-reason">
              <Icon name="alert-circle" small />
              {why()}
            </p>
          )}
        </Show>
        <Show when={d().questions}>
          {(q) => (
            <p class="board-note">
              <Icon name="chat" small />
              {q()}
            </p>
          )}
        </Show>
        <Show when={d().error}>
          {(err) => (
            <p class="board-note board-note-error">
              <Icon name="alert-circle" small />
              {err()}
            </p>
          )}
        </Show>
        <Show when={d().now}>{(now) => <p class="board-now">{now()}</p>}</Show>
        <Show when={topics()}>
          {(t) => (
            <Switch>
              <Match when={t().kind === "reading"}>
                <p class="board-none">Reading topics…</p>
              </Match>
              <Match when={t().kind === "failed"}>
                <p class="board-none">Couldn't read the topics.</p>
              </Match>
              <Match when={t().kind === "read" && (t() as Extract<RowTopics, { kind: "read" }>).topics.length > 0 && (t() as Extract<RowTopics, { kind: "read" }>)}>
                {(r) => (
                  <ul class="board-topic-list" aria-label="Recent topics">
                    <For each={r().topics}>
                      {(topic) => (
                        <li class="board-topic">
                          <span class="board-topic-heading" title={topic.heading}>
                            {topic.heading}
                          </span>
                          <span class="board-topic-when">{relativeTime(topicTime(topic), props.ctx.now)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                )}
              </Match>
            </Switch>
          )}
        </Show>
        <Show when={d().trees.length > 0}>
          <ul class="board-tree-list" aria-label="Worktrees">
            <For each={d().trees}>{(t) => <TreeLine tree={t} />}</For>
          </ul>
        </Show>
      </div>
    </Show>
  );
}

function BoardRowView(props: { row: BoardRow; ctx: BoardCtx }) {
  const r = () => props.row;
  const s = () => r().session;
  const trees = () => props.ctx.treesOf(s().path);
  const open = () => props.ctx.expanded(s().path);
  /** The twist shows only when the open row has something to say. */
  const hasDetail = createMemo(() => rowHasDetail(rowDetail(r(), trees())));
  const detailId = () => `board-detail-${s().id}`;
  const detailsOpen = () => props.ctx.detailsPath === s().path;
  const gist = () => summaryLineOf(s());
  /** Archive/Unarchive: only for what you started in Sova, or already archived; the reason when it can't. */
  const archive = () => {
    const x = s();
    if (!x.archived && x.origin !== "web") return null;
    const reason = archiveBlockReason({ ...x, busy: busyOf(x) });
    return { label: x.archived ? "Unarchive" : "Archive", blocked: reason ? `Can't archive: ${reason}.` : null };
  };
  const saveTitle = async (title: string | null) => {
    props.ctx.setRenaming(null);
    if (await renameSession(s(), title)) props.ctx.onRefresh();
  };
  /**
   * A click anywhere on the row that isn't a control opens the session, as Open does. Controls
   * keep their own action, the rename field and its hint never open it, and neither does a click
   * that ends a text selection in the row, one with a modifier, or one on a menu panel the row
   * owns (a popover: it paints in the top layer but stays in the row's DOM).
   */
  const onRowClick = (e: MouseEvent & { currentTarget: HTMLLIElement }) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target as Element;
    if (!e.currentTarget.contains(target)) return;
    if (target.closest("a, button, input, textarea, select, label, form, summary, [role=menuitem], [popover], .board-rename")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return;
    location.hash = sessionHref(s().path);
  };
  const teams = createMemo(() => teamChips(r().teams));
  /** Its tokens a minute: redrawn only when the words change. */
  const rate = createMemo(() => rateCell(s(), props.ctx.rateOf(s().id), { reported: props.ctx.tokensReported, remote: hostOf(s().path) !== null }), undefined, {
    equals: sameRateCell,
  });
  /** The title is a real link: a click that ends a text selection in the row doesn't follow it. */
  const onTitleClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const row = (e.currentTarget as Element).closest(".board-row");
    const sel = window.getSelection();
    if (row && sel && !sel.isCollapsed && sel.anchorNode && row.contains(sel.anchorNode)) e.preventDefault();
  };

  return (
    <li class="board-row" id={`board-row-${s().id}`} data-state={r().state} classList={{ "board-row-open": open() && hasDetail() }} onClick={onRowClick}>
      <div class="board-line">
        <div class="board-cell board-session">
          <span class="board-rail" aria-hidden="true" />
          <Show when={hasDetail()} fallback={<span class="board-twist-gap" aria-hidden="true" />}>
            <button
              type="button"
              class="button button-icon button-ghost board-twist"
              aria-expanded={open() ? "true" : "false"}
              aria-controls={detailId()}
              aria-label={`${open() ? "Hide" : "Show"} where ${quoted(s().title)} stands`}
              title={open() ? "Hide details" : "Show details"}
              onClick={() => props.ctx.toggle(s().path)}
            >
              <Icon name="chevron-right" small class="board-twist-icon" />
            </button>
          </Show>
          <div class="board-session-main">
            <Show
              when={props.ctx.renaming(s().path)}
              fallback={
                <p class="board-title-line">
                  <a
                    class="board-title"
                    href={sessionHref(s().path)}
                    title={s().originalTitle ? `${s().title}\nOriginally ${quoted(s().originalTitle!)}` : s().title}
                    onClick={onTitleClick}
                  >
                    {s().title}
                  </a>
                  {/* The rail and the group heading show the state; this says it to a screen reader. */}
                  <span class="visually-hidden">, {r().word}</span>
                </p>
              }
            >
              <div class="board-rename">
                <TitleField
                  initial={s().title}
                  label={`Rename ${quoted(s().title)}`}
                  describedBy={`board-rename-hint-${s().id}`}
                  blurSaves
                  onDone={(t) => void saveTitle(t)}
                  onCancel={() => props.ctx.setRenaming(null)}
                />
                <p class="text-caption text-muted" id={`board-rename-hint-${s().id}`}>
                  Kept in Sova only. Empty restores {quoted(s().originalTitle ?? s().title)}.
                </p>
              </div>
            </Show>
            <Show when={gist()} fallback={<p class="board-gist board-gist-path text-mono">{tildePath(s().cwd, home())}</p>}>
              <p class="board-gist" title={summaryTitleOf(s())}>
                {gist()}
              </p>
            </Show>
            {/* Folded width: the Activity and Workers columns as one micro line. */}
            <p class="board-micro">
              <Show when={compactModel(s().model)}>{(m) => <span class="text-mono">{m()}</span>}</Show>
              <Show when={r().total > 0 && workersLine(r())}>{(w) => <span>{w()}</span>}</Show>
              <span>{relativeTime(s().lastActiveAt, props.ctx.now)}</span>
              <Show when={rate().figure}>
                <RateMark cell={rate()} micro />
              </Show>
            </p>
          </div>
        </div>

        {/* Each cell is at most 2 lines: what matters first, the rest muted under it. */}
        <div class="board-cell board-activity">
          <span class="board-cell-line board-activity-line">
            <span class="board-model text-mono" title={s().model ?? undefined}>
              {compactModel(s().model) ?? "—"}
            </span>
            <Show when={contextOf(s())}>{(c) => <ContextRing info={c()} />}</Show>
            <span class="board-when" title={s().model ? `${s().model}\n${s().lastActiveAt}` : s().lastActiveAt}>
              {relativeTime(s().lastActiveAt, props.ctx.now)}
            </span>
          </span>
        </div>

        <div class="board-cell board-workers">
          <Show when={workersLine(r(), props.ctx.workersSpend(s().id))} fallback={<Dash words="No workers" />}>
            {(line) => (
              <span class="board-cell-line board-count text-num" title="Workers working, workers in all, and what they have spent, at any depth, at API prices">
                {line()}
              </span>
            )}
          </Show>
          <Show when={teams().shown.length > 0}>
            <span class="board-cell-line board-cell-sub board-teams">
              <For each={teams().shown}>
                {(t) => (
                  <a
                    class="chip chip-count board-team"
                    href={agentsHref(teamKey(t))}
                    title={t.objective ? capTitle(`${t.name}: ${t.objective}`) : t.name}
                    onClick={(e) => {
                      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                      e.preventDefault();
                      props.ctx.onOpenAgents(s().path);
                    }}
                  >
                    {t.name}
                  </a>
                )}
              </For>
              <Show when={teams().rest > 0}>
                <button
                  type="button"
                  class="chip chip-count board-team board-team-more"
                  aria-label={`${teams().rest} more ${teams().rest === 1 ? "team" : "teams"}: open the Agents tab of ${quoted(s().title)}`}
                  title={`${r().teams.length} teams`}
                  onClick={() => props.ctx.onOpenAgents(s().path)}
                >
                  +{teams().rest}
                </button>
              </Show>
              {/* From 1000 to 1599px the chips collapse into this one count. */}
              <button
                type="button"
                class="chip chip-count board-team board-team-all"
                aria-label={`${teamsWord(r().teams.length)}: open the Agents tab of ${quoted(s().title)}`}
                title={r().teams.map((t) => t.name).join(", ")}
                onClick={() => props.ctx.onOpenAgents(s().path)}
              >
                {teamsWord(r().teams.length)}
              </button>
            </span>
          </Show>
        </div>

        <div class="board-cell board-tokens">
          <RateMark cell={rate()} />
        </div>

        <div class="board-cell board-actions">
          <button
            type="button"
            class="button button-icon button-ghost board-act board-act-details"
            aria-label={`Session details of ${quoted(s().title)}`}
            aria-controls="session-pane"
            aria-expanded={detailsOpen() ? "true" : "false"}
            title="Session details"
            onClick={() => props.ctx.onOpenDetails(s().path)}
          >
            <Icon name="info" />
          </button>
          <RowMenu row={r()} ctx={props.ctx} archive={archive()} />
        </div>
      </div>

      <Show when={open()}>
        <RowDetailView row={r()} ctx={props.ctx} id={detailId()} />
      </Show>
    </li>
  );
}

/** The Costs and Performance tabs' filters (and Performance's sort) when you last left them, for this tab's life: Board → Costs brings it back. */
let lastCosts: CostsQuery = DEFAULT_COSTS_QUERY;
let lastPerf: PerfQuery = DEFAULT_PERF_QUERY;

type AgentsTab = "board" | "costs" | "performance";

/** Board, Costs and Performance. Tabs switch views and the address says which; the tab bar is the
    skill's (Left/Right move along it and wrap, Home/End jump, Enter or Space selects). */
function AgentsTabs(props: { tab: AgentsTab }) {
  const tabs = [
    { id: "board", label: "Board", href: () => agentsHref() },
    { id: "costs", label: "Costs", href: () => costsHref(lastCosts) },
    { id: "performance", label: "Performance", href: () => perfHref(lastPerf) },
  ] as const;
  const els: HTMLButtonElement[] = [];
  const selected = (id: string) => id === props.tab;
  const onKey = (e: KeyboardEvent, i: number) => {
    const last = tabs.length - 1;
    const next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    els[next]?.focus();
  };
  return (
    <div class="tabs agents-tabs" role="tablist" aria-label="Agents">
      <For each={tabs}>
        {(t, i) => (
          <button
            type="button"
            role="tab"
            class="tab"
            id={`agents-tab-${t.id}`}
            aria-selected={selected(t.id) ? "true" : "false"}
            aria-controls={selected(t.id) ? "agents-tabpanel" : undefined}
            tabindex={selected(t.id) ? 0 : -1}
            ref={(el) => (els[i()] = el)}
            onClick={() => {
              if (!selected(t.id)) location.hash = t.href();
            }}
            onKeyDown={(e) => onKey(e, i())}
          >
            {t.label}
          </button>
        )}
      </For>
    </div>
  );
}

/** `#/agents`: every session on one board; what it's about, where it stands and its worktrees folded inside. */
export function AgentsView(props: {
  agents: Poll<AgentsAnswer>;
  sessions: SessionSummary[] | undefined;
  now: number;
  /** Team a `#/agents/<teamKey>` link names: its session stays on the board and its pane opens on Agents. */
  focusTeam: string | null;
  titleRef(el: HTMLHeadingElement): void;
  onRefresh(): void;
  onArchiveChanged(path: string, archived: boolean): void;
  onOpenSubagents(path: string): void;
  detailsPath: string | null;
  onOpenDetails(path: string): void;
  onOpenAgents(path: string): void;
  /** The Costs tab's query, when `#/agents/costs` is the address; null elsewhere. */
  costs: CostsQuery | null;
  /** The Performance tab's query, when `#/agents/performance` is the address; null elsewhere. */
  performance: PerfQuery | null;
}) {
  /** Off the board: Costs or Performance. The board's polls and its head line rest there. */
  const onCosts = () => props.costs !== null || props.performance !== null;
  const tab = (): AgentsTab => (props.costs ? "costs" : props.performance ? "performance" : "board");
  // Back on a tab from the board, the filter you left it with.
  createEffect(() => props.costs && (lastCosts = props.costs));
  createEffect(() => props.performance && (lastPerf = props.performance));
  const [costsTick, setCostsTick] = createSignal(0);
  const [filter, setFilter] = createSignal<BoardFilter | null>(null);
  const [query, setQuery] = createSignal("");
  const [limit, setLimit] = createSignal(BOARD_PAGE);
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [trees, setTrees] = createSignal<ReadonlyMap<string, WorktreeStatus[]>>(new Map());
  const treesOf = (path: string) => trees().get(path);

  // A new chip or search starts at the top of the list again.
  createEffect(on([filter, query], () => setLimit(BOARD_PAGE), { defer: true }));

  const rows = createMemo(() => boardRows(props.sessions ?? [], props.agents.data(), busyOf));

  /** The linked team's key and parent session, as one string so the effect below fires on a change of VALUE. */
  const linked = createMemo(() => {
    const key = props.focusTeam;
    const t = key ? teamForLink(props.agents.data(), key) : null;
    return t ? `${teamKey(t)}\n${t.parentPath}` : null;
  });
  const pinned = () => linked()?.split("\n")[1] ?? null;

  const shown = createMemo(() => visibleRows(rows(), { filter: filter(), query: query(), treesOf, pinned: pinned() }));
  /** The rendered rows: a page of them, and the linked team's session wherever it sorts. */
  const paged = createMemo(() => {
    const list = shown().slice(0, limit());
    const pin = pinned();
    const extra = pin && !list.some((r) => r.session.path === pin) ? shown().find((r) => r.session.path === pin) : undefined;
    return extra ? [...list, extra] : list;
  });
  const byPath = createMemo(() => new Map(paged().map((r) => [r.session.path, r])));
  /** The rendered rows under their headings: paging cuts the one sorted list, the groups only split what renders. */
  const groups = createMemo(() => boardGroups(paged()));
  /** A heading counts every row the chip and search show in its state, rendered or not. */
  const groupCounts = createMemo(() => new Map(boardGroups(shown()).map((g) => [g.key, g.rows.length])));
  /** Keys and paths, not rows: a poll hands back fresh row objects, and a row keyed by its path keeps its DOM (and a rename field's focus). */
  const groupKeys = createMemo(() => groups().map((g) => g.key), undefined, { equals: sameList });
  const headed = () => groupKeys().length > 1;

  /**
   * Which sessions the worktrees request names. The rendered rows — except under Unmerged, which
   * needs a reading to decide what renders at all, so it asks for the default scope instead.
   * A string, so the poll below restarts only when the SET changes, never on a fresh list.
   */
  const treesKey = createMemo(() =>
    onCosts() ? "" : worktreePathsKey(filter() === "unmerged" ? sortRows(rows().filter(inDefaultScope)).slice(0, limit()) : paged()),
  );
  const readTrees = async (key: string) => {
    if (!key || document.hidden) return;
    try {
      const res = await fetchWorktrees(key.split(","));
      if (treesKey() !== key) return; // the rows moved on while this was in flight
      setTrees((prev) => {
        const next = new Map(prev);
        for (const s of res.sessions) next.set(s.sessionPath, s.trees);
        return next;
      });
    } catch {
      // No route yet (an older server), or git trouble: the readings stay unread, nothing says so.
    }
  };
  createEffect(
    on(treesKey, (key) => {
      void readTrees(key);
      const t = setInterval(() => void readTrees(key), WORKTREES_POLL_MS);
      onCleanup(() => clearInterval(t));
    }),
  );

  // Spend, all of it from the usage ledger: today's for the head, and the shown rows' workers'.
  const today = createPoll(() => getUsageToday(browserZone()), USAGE_POLL_MS);
  const [spends, setSpends] = createSignal<ReadonlyMap<string, number>>(new Map());
  /** The rendered rows' session ids, as one string: the poll restarts only when the SET changes. */
  const spendKey = createMemo(() => (onCosts() ? "" : paged().map((r) => r.session.id).join(",")));
  const readSpends = async (key: string) => {
    if (!key || document.hidden) return;
    try {
      const res = await getUsageSessions(key.split(","));
      if (spendKey() !== key) return;
      setSpends(workersChips(res));
    } catch {
      // The helper starting or down: the chips stay as they were; the Costs tab says why.
    }
  };
  createEffect(
    on(spendKey, (key) => {
      void readSpends(key);
      const t = setInterval(() => void readSpends(key), USAGE_POLL_MS);
      onCleanup(() => clearInterval(t));
    }),
  );

  // Tokens a minute (§app.insights/session-token-rate): the app's agents poll asks for them only while
  // the board is shown (the poll itself pauses while the tab is hidden); entering the board asks at once.
  createEffect(() => {
    if (onCosts()) return;
    onCleanup(wantAgentsTokens());
    if (!untrack(() => props.agents.data()?.tokensAsked)) props.agents.refetch();
  });
  // Every row's means at once, worked out again only when the answer's tokens read differently and on
  // one 30 s tick, the sidebar's rule: only while a shown row has tokens and the tab is visible.
  const [tabVisible, setTabVisible] = createSignal(!document.hidden);
  const onVisibility = () => setTabVisible(!document.hidden);
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisibility));
  const [rateClock, setRateClock] = createSignal(0);
  const readRates = rateReader();
  /** The same Map while the tokens read the same within a step: an identical poll redraws nothing. */
  const rates = createMemo(() => readRates(props.agents.data()?.tokens, rateClock(), Date.now()));
  const rateTicking = createMemo(() => {
    if (onCosts() || !tabVisible()) return false;
    const t = props.agents.data()?.tokens;
    return !!t && paged().some((r) => t[r.session.id] !== undefined);
  });
  createEffect(() => {
    if (!rateTicking()) return;
    const t = setInterval(() => setRateClock((n) => n + 1), 30_000);
    onCleanup(() => clearInterval(t));
  });

  const totals = createMemo(() => boardTotals(rows().filter(inDefaultScope), trees().values(), today.data()));
  const counts = createMemo(() => filterCounts(rows(), treesOf));

  /** The link, once its session's row is on the board: a team found before the list loads waits for it. */
  const linkReady = createMemo(() => {
    const v = linked();
    return v && byPath().has(v.split("\n")[1]!) ? v : null;
  });
  // Open the linked team's session's pane on Agents and bring its row into view, once per link:
  // polls don't open it again.
  let focused: string | null = null;
  createEffect(
    on(linkReady, (v) => {
      const key = props.focusTeam;
      if (!v || !key || key === focused) return;
      focused = key;
      const row = byPath().get(v.split("\n")[1]!);
      if (!row) return;
      props.onOpenAgents(row.session.path);
      requestAnimationFrame(() => document.getElementById(`board-row-${row.session.id}`)?.scrollIntoView({ block: "nearest" }));
    }),
  );

  const ctx: BoardCtx = {
    get now() {
      return props.now;
    },
    get agents() {
      return props.agents.data();
    },
    treesOf,
    expanded: (p) => open().has(p),
    toggle: (p) =>
      setOpen((s) => {
        const next = new Set(s);
        if (!next.delete(p)) next.add(p);
        return next;
      }),
    renaming: (p) => renaming() === p,
    setRenaming,
    onRefresh: () => props.onRefresh(),
    onArchiveChanged: (p, a) => props.onArchiveChanged(p, a),
    onOpenSubagents: (p) => props.onOpenSubagents(p),
    get detailsPath() {
      return props.detailsPath;
    },
    onOpenDetails: (p) => props.onOpenDetails(p),
    onOpenAgents: (p) => props.onOpenAgents(p),
    workersSpend: (sid) => spends().get(sid) ?? null,
    rateOf: (id) => rates().get(id),
    /** A missing `tokens` means an older server only on an answer that asked for them. */
    get tokensReported() {
      const d = props.agents.data();
      return !d?.tokensAsked || d.tokens !== undefined;
    },
  };

  const meta = () => (props.sessions ? totalsLine(totals()) : undefined);
  const metaTitle = () =>
    "Sessions working, sessions live, what this device has spent since midnight at API prices (every call, subscriptions included), and unmerged branches in the worktrees read so far.";

  const emptyLine = () => {
    const t = totals();
    const f = filter();
    const live = t.live === 0 ? "No session is live right now." : `${t.live} ${t.live === 1 ? "session" : "sessions"} live.`;
    if (query().trim()) return { title: `${live} Nothing matches ${quoted(query().trim())}.`, body: f ? "Clear the search or the filter to see more." : "Clear the search to see the board again." };
    if (f === "live") return { title: live, body: "Sessions show up here while a pi runs them." };
    if (f) return { title: `${live} ${BOARD_EMPTY[f]}`, body: "Clear the filter to see the board again." };
    return { title: `${live} Nothing started in Sova is open.`, body: "Sessions that run, and the ones you start here, show up until you archive them." };
  };

  return (
    <InsightsPage
      title="Agents"
      meta={onCosts() && meta() ? <span title={metaTitle()}>{meta()}</span> : undefined}
      refreshLabel="Refresh Agents"
      onRefresh={() => {
        props.agents.refetch();
        props.onRefresh();
        today.refetch();
        if (onCosts()) setCostsTick((n) => n + 1);
        else {
          void readTrees(treesKey());
          void readSpends(spendKey());
        }
      }}
      error={props.agents.error()}
      errorTitle="Couldn't load agents."
      busy={!props.sessions && props.agents.pending()}
      titleRef={props.titleRef}
      class="agents-page"
    >
      <AgentsTabs tab={tab()} />
      <Show when={props.costs}>{(q) => <CostsTab query={q()} sessions={props.sessions} now={props.now} tick={costsTick()} />}</Show>
      <Show when={props.performance}>{(q) => <PerformanceTab query={q()} now={props.now} tick={costsTick()} />}</Show>
      <Show when={!onCosts()}>
      <div class="agents-tabpanel" id="agents-tabpanel" role="tabpanel" aria-labelledby="agents-tab-board">
      <Show when={props.sessions} fallback={<ListSkeleton groups={1} rows={3} />}>
        <div class="board-bar">
          <label class="search board-search">
            <Icon name="search" small />
            <span class="visually-hidden">Search sessions</span>
            <input
              class="input"
              type="search"
              placeholder="Search title, gist, path, branch"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape" || !query()) return;
                e.preventDefault();
                setQuery("");
              }}
            />
          </label>
          <div class="board-filters" role="group" aria-label="Filter sessions">
            <For each={BOARD_FILTERS}>
              {(f) => (
                <button
                  type="button"
                  class="board-filter"
                  aria-pressed={filter() === f.id ? "true" : "false"}
                  onClick={() => setFilter((cur) => (cur === f.id ? null : f.id))}
                >
                  <Show when={filter() === f.id}>
                    <Icon name="check" small />
                  </Show>
                  {f.label}
                  <span class="board-filter-count text-num">{counts()[f.id]}</span>
                </button>
              )}
            </For>
          </div>
          {/* The count and the totals, directly above the board: on this tab the totals are never in the head. */}
          <div class="board-caption">
            <p class="board-count-line" aria-live="polite">
              {shown().length} {shown().length === 1 ? "session" : "sessions"}
              {filter() ? "" : query().trim() ? " across every session" : " live or open in Sova"}
            </p>
            <Show when={meta()}>
              <p class="board-totals" title={metaTitle()}>
                {meta()}
              </p>
            </Show>
          </div>
        </div>

        <Show
          when={paged().length > 0}
          fallback={
            <div class="card">
              <div class="empty">
                <Icon name="worker" class="empty-mark" />
                <p class="empty-title">{emptyLine().title}</p>
                <p class="empty-body">{emptyLine().body}</p>
              </div>
            </div>
          }
        >
          <div class="card board">
            <div class="board-head" aria-hidden="true">
              <span>Session</span>
              <span>Activity</span>
              <span>Workers</span>
              <span>Tokens/min</span>
              <span />
            </div>
            <For each={groupKeys()}>
              {(key) => {
                const group = () => groups().find((g) => g.key === key);
                const paths = createMemo(() => group()?.rows.map((r) => r.session.path) ?? [], undefined, { equals: sameList });
                return (
                  <>
                    {/* A heading per state, only when more than one has rows; each group is its own list, named by it. */}
                    <Show when={headed()}>
                      <h2 class="board-group-head" id={`board-group-${key}`} data-state={key}>
                        {group()?.label} · <span class="text-num">{groupCounts().get(key) ?? 0}</span>
                      </h2>
                    </Show>
                    <ul class="board-list" aria-label={headed() ? undefined : "Sessions"} aria-labelledby={headed() ? `board-group-${key}` : undefined}>
                      <For each={paths()}>{(path) => <Show when={byPath().get(path)}>{(r) => <BoardRowView row={r()} ctx={ctx} />}</Show>}</For>
                    </ul>
                  </>
                );
              }}
            </For>
          </div>
          <Show when={shown().length > limit()}>
            <button type="button" class="button board-more-rows" onClick={() => setLimit((n) => n + BOARD_PAGE)}>
              Show {Math.min(BOARD_PAGE, shown().length - limit())} More
            </button>
          </Show>
        </Show>
      </Show>
      </div>
      </Show>
    </InsightsPage>
  );
}

const teamsWord = (n: number) => `${n} ${n === 1 ? "team" : "teams"}`;

const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Each chip's absence, in words, after the live fact. */
const BOARD_EMPTY: Record<Exclude<BoardFilter, "live">, string> = {
  "needs-you": "Nothing is waiting on you.",
  "has-workers": "No session has workers.",
  unmerged: "No unmerged branch in the worktrees read so far.",
  archived: "Nothing is archived.",
};
