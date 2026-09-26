import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import type { AgentsInsight, ContextInfo, SessionSummary, TeamInfo, TeamMember, WorkerInfo, WorktreeStatus } from "../../shared/protocol";
import { ApiError, fetchWorktrees, resumeWorker } from "../lib/api";
import {
  BOARD_FILTERS,
  BOARD_PAGE,
  type BoardFilter,
  type BoardRow,
  boardRows,
  boardTotals,
  filterCounts,
  gistTitle,
  inDefaultScope,
  money,
  soloWorkers,
  sortRows,
  STATE_WORD,
  teamForLink,
  totalsLine,
  treeLines,
  treeMerge,
  type TreeMerge,
  treeName,
  treeTitle,
  visibleRows,
  WORKTREES_POLL_MS,
  worktreePathsKey,
} from "../lib/agents-board";
import { clockTime, compactModel, relativeTime, shortModel, tildePath } from "../lib/format";
import { agentsHref, memberBadges, memberStatus, type MemberStatus, orderedMembers, splitTeamEvents, teamAnchor, teamFresh, teamHeadingId, teamKey, teamPause } from "../lib/insights";
import type { Poll } from "../lib/poll";
import { archiveSession, renameSession } from "../lib/session-actions";
import { archiveBlockReason } from "../lib/session-selection";
import { groupNameOf, loadSessionGroups, quoted, sessionGroups, setSessionGroup } from "../lib/session-groups";
import { summaryLineOf, summaryTitleOf } from "../lib/summary-row";
import { announce, copyText, home, localRunning, sessionContext, toast } from "../lib/ui-state";
import { capTitle } from "../lib/workers";
import "../agents-board.css";
import { ActionMenu } from "./ActionMenu";
import { ContextRing } from "./ContextRing";
import { MoveToGroupMenu } from "./Groups";
import { InsightsPage, iso, ListSkeleton } from "./InsightsPage";
import { TitleField } from "./SelectionToolbar";
import { sessionHref } from "./Sidebar";
import { Chip, CountChip, Icon, type Tone } from "./ui";

/** What a row needs from the page: the shared state and the gestures that reach past the board. */
interface BoardCtx {
  now: number;
  agents: AgentsInsight | undefined;
  treesOf(path: string): WorktreeStatus[] | undefined;
  /** The worktrees request failed or the server has no such route: unknown cells say "—". */
  treesDown: boolean;
  expanded(path: string): boolean;
  toggle(path: string): void;
  renaming(path: string): boolean;
  setRenaming(path: string | null): void;
  /** The team a `#/agents/<key>` link named, by key. */
  linkedTeam: string | null;
  onRefresh(): void;
  onArchiveChanged(path: string, archived: boolean): void;
  onOpenSubagents(path: string): void;
  refetchAgents(): void;
}

const STATE_TONE: Record<BoardRow["state"], Tone | "accent" | undefined> = { working: "accent", "needs-you": "warn", idle: undefined, archived: undefined };

/** A turn in flight as this tab knows it, newer than the list (the sidebar's rule). */
const busyOf = (s: SessionSummary) => !s.live && !!(localRunning()[s.path] ?? s.busy);

/** The row's context fill: the open session's live value wins over the list's tail value. */
function contextOf(s: SessionSummary): ContextInfo | null {
  const live = sessionContext()[s.path];
  if (live === "compacted") return null;
  if (live) return live;
  return s.context && s.context.window ? s.context : null;
}

function StateChip(props: { row: BoardRow; class?: string }) {
  return (
    <span class={props.class}>
      <Chip tone={STATE_TONE[props.row.state]} live={props.row.state === "working"} title={props.row.reason ?? undefined}>
        {STATE_WORD[props.row.state]}
      </Chip>
    </span>
  );
}

/** A tree's merge reading: a success chip when merged, else ↑ahead ↓behind, else a muted word. */
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
      <Match when={m().kind === "diverged" && (m() as Extract<TreeMerge, { kind: "diverged" }>)}>
        {(r) => (
          <span class="board-ahead text-mono text-num" aria-label={`${r().ahead} ahead, ${r().behind} behind`}>
            ↑{r().ahead} ↓{r().behind}
          </span>
        )}
      </Match>
      <Match when={m().kind === "unknown" && (m() as Extract<TreeMerge, { kind: "unknown" }>)}>
        {(r) => <span class="text-muted">{r().text}</span>}
      </Match>
    </Switch>
  );
}

function TreeLinesMark(props: { tree: WorktreeStatus }) {
  return (
    <Show when={treeLines(props.tree)}>
      {(l) => (
        <span class="board-lines text-mono text-num" aria-label={`${l().added} lines added, ${l().removed} removed`}>
          <span class="git-add">+{l().added}</span> <span class="git-del">−{l().removed}</span>
        </span>
      )}
    </Show>
  );
}

function DirtyMark(props: { tree: WorktreeStatus }) {
  return (
    <Show when={props.tree.dirty}>
      <span class="board-dirty" title="Uncommitted changes">
        <span class="visually-hidden">Uncommitted changes</span>
      </span>
    </Show>
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

/** The Worktrees cell: the first tree, and "+N" for the rest. */
function TreesCell(props: { trees: WorktreeStatus[] | undefined; down: boolean }) {
  return (
    <Show when={props.trees} fallback={<Dash words={props.down ? "Worktrees not read" : "Reading worktrees"} />}>
      {(trees) => (
        <Show when={trees()[0]} fallback={<Dash words="No worktree" />}>
          {(t) => (
            <span class="board-tree" title={trees().map(treeTitle).join("\n\n")}>
              <span class="board-tree-branch text-mono">{treeName(t())}</span>
              <TreeMergeMark tree={t()} />
              <TreeLinesMark tree={t()} />
              <DirtyMark tree={t()} />
              <Show when={trees().length > 1}>
                <CountChip title={`${trees().length} worktrees`}>+{trees().length - 1}</CountChip>
              </Show>
            </span>
          )}
        </Show>
      )}
    </Show>
  );
}

/** Resume a restored worker; the agents poll then shows it idle. */
function ResumeButton(props: { path: string | null; worker: WorkerInfo; name: string; onDone(): void }) {
  const [busy, setBusy] = createSignal(false);
  const run = async () => {
    const path = props.path;
    if (!path || busy()) return;
    setBusy(true);
    try {
      await resumeWorker(path, props.worker.id);
      const done = `${props.name} is running again, idle until you give it a task.`;
      toast(done);
      announce(done);
      props.onDone();
    } catch (err) {
      toast(`Couldn't resume ${props.name}. ${err instanceof ApiError || err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      class="button button-sm"
      aria-label={`Resume ${props.name}`}
      aria-disabled={busy() ? "true" : undefined}
      title={busy() ? "Resuming…" : "Start it again from its own transcript, idle"}
      onClick={() => void run()}
    >
      Resume
    </button>
  );
}

/** One worker, one line: name, badges, id and model in mono, the preview while working, status. */
function WorkerLine(props: {
  name: string;
  badges?: { label: string; title?: string }[];
  ejected?: boolean;
  worker: WorkerInfo | null;
  id: string;
  model?: string | null;
  status: MemberStatus;
  hostPath: string | null;
  owns?: string[];
  onResumed(): void;
}) {
  const w = () => props.worker;
  return (
    <li class="board-worker" title={props.owns?.length ? `Owns: ${props.owns.join(", ")}` : undefined}>
      <span class="board-worker-name">{props.name}</span>
      <For each={props.badges ?? []}>{(b) => <CountChip title={b.title}>{b.label}</CountChip>}</For>
      <Show when={props.ejected}>
        <Chip>Ejected</Chip>
      </Show>
      <span class="board-worker-meta text-mono">
        {props.id}
        <Show when={shortModel(props.model)}>{(m) => <> · {m()}</>}</Show>
      </span>
      <span class="board-worker-preview" title={w()?.working ? w()?.preview : undefined}>
        {w()?.working ? (w()?.preview ?? "") : ""}
        <Show when={props.status.asOf}>
          {(t) => (
            <span class="text-muted">
              as of <span class="text-mono">{clockTime(iso(t()))}</span>
            </span>
          )}
        </Show>
        <Show when={props.status.failed}>
          <span class="text-muted"> · last task failed</span>
        </Show>
      </span>
      <Chip tone={props.status.tone} live={props.status.live}>
        {props.status.text}
      </Chip>
      <Show when={w()?.status === "restored" && w()?.resumable}>
        <ResumeButton path={props.hostPath} worker={w()!} name={props.name} onDone={props.onResumed} />
      </Show>
    </li>
  );
}

/** A team inside its session's row: head, objective, members one line each, then its events. */
function TeamBlock(props: { team: TeamInfo; ctx: BoardCtx; hostPath: string | null }) {
  const key = () => teamKey(props.team);
  const live = () => props.team.live && teamFresh(props.ctx.agents, props.team);
  const events = () => splitTeamEvents(props.team);
  return (
    <section
      class="team-group board-team"
      classList={{ "board-team-linked": props.ctx.linkedTeam === key() }}
      id={teamAnchor(key())}
      aria-labelledby={teamHeadingId(key())}
      tabindex="-1"
    >
      <h4 class="board-team-head" id={teamHeadingId(key())}>
        <Icon name="worker" small />
        <span class="board-team-name">{props.team.name}</span>
        <span class="text-mono text-muted">{props.team.id}</span>
        <Show when={teamPause(props.team)}>
          {(p) => (
            <Chip tone="warn" title={p().detail ?? p().text}>
              Paused
            </Chip>
          )}
        </Show>
        <Show when={props.team.working > 0}>
          <CountChip>{props.team.working} working</CountChip>
        </Show>
      </h4>
      <Show when={props.team.objective}>
        <p class="board-team-objective" title={capTitle(props.team.objective)}>
          {props.team.objective}
        </p>
      </Show>
      <ul class="board-worker-list">
        <For each={orderedMembers(props.team)}>
          {(m: TeamMember) => (
            <WorkerLine
              name={m.role}
              badges={memberBadges(m, props.team)}
              ejected={m.ejectedAt !== undefined}
              worker={m.worker}
              id={m.workerId}
              model={m.worker?.model ?? m.model}
              status={memberStatus(m, live())}
              hostPath={props.hostPath}
              owns={m.ownedPaths}
              onResumed={props.ctx.refetchAgents}
            />
          )}
        </For>
      </ul>
      <Show when={props.team.events?.length}>
        <details class="board-team-events">
          <summary>
            <Icon name="chevron-right" small class="icon-twist" />
            Events ({props.team.events!.length})
          </summary>
          <ul class="team-event-list">
            <For each={[...events().earlier, ...events().recent]}>
              {(e) => (
                <li class="team-event" title={e.detail}>
                  <span class="text-mono team-event-time">{clockTime(e.at)}</span>
                  <span class="team-event-text">{e.text}</span>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
    </section>
  );
}

/** One tree in the open row: branch, path, the reading, lines, and uncommitted work in words. */
function TreeLine(props: { tree: WorktreeStatus }) {
  const t = () => props.tree;
  return (
    <li class="board-tree-line" title={treeTitle(t())}>
      <Icon name="branch" small />
      <span class="board-tree-branch text-mono">{treeName(t())}</span>
      <TreeMergeMark tree={t()} />
      <TreeLinesMark tree={t()} />
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

/** The ⋯ menu: every action the row has, the only door to them at folded width. */
function RowMenu(props: { row: BoardRow; ctx: BoardCtx; archive: { label: string; blocked: string | null } | null }) {
  const s = () => props.row.session;
  const gist = () => gistTitle(s());
  const setTitle = async (title: string | null) => {
    if (await renameSession(s(), title)) props.ctx.onRefresh();
  };
  const move = async (id: string | null) => {
    const before = groupNameOf(sessionGroups(), s().groupId);
    if (id === (s().groupId ?? null)) return;
    if (!(await setSessionGroup(s().path, id))) return;
    const after = groupNameOf(sessionGroups(), id ?? undefined);
    const done = id === null ? `Removed from ${before ? quoted(before) : "the group"}.` : `${before ? "Moved" : "Added"} to ${quoted(after ?? "the group")}.`;
    toast(done);
    announce(done);
    props.ctx.onRefresh();
  };
  return (
    <ActionMenu label={`Actions for ${quoted(s().title)}`} title="Session actions" class="board-more">
      {(menu) => (
        <Show
          when={menu.screen() === "groups"}
          fallback={
            <div class="model-menu-list" role="menu" aria-label={`Actions for ${quoted(s().title)}`}>
              <div class="model-menu-group" role="group" aria-label="Open">
                <menu.Item label="Open Session" aria={`Open ${quoted(s().title)}`} icon={<Icon name="arrow-right" small />} href={sessionHref(s().path)} />
                <menu.Item
                  label="Open Subagents"
                  aria={`Open the subagents pane of ${quoted(s().title)}`}
                  icon={<Icon name="worker" small />}
                  keepFocus
                  onRun={() => props.ctx.onOpenSubagents(s().path)}
                />
              </div>
              <div class="model-menu-group" role="group" aria-label="Title">
                <menu.Item label="Rename…" aria={`Rename ${quoted(s().title)}`} icon={<Icon name="pencil" small />} keepFocus onRun={() => props.ctx.setRenaming(s().path)} />
                <menu.Item
                  label="Use Gist as Title"
                  aria={`Use the gist as the title of ${quoted(s().title)}`}
                  icon={<Icon name="pencil" small />}
                  description={gist() ?? undefined}
                  disabled={gist() ? "" : summaryLineOf(s()) ? "The gist is already the title." : "No gist yet."}
                  onRun={() => void setTitle(gist())}
                />
                <menu.Item
                  label="Reset to Original Title"
                  aria={`Reset ${quoted(s().title)} to its original title`}
                  icon={<Icon name="undo" small />}
                  description={s().originalTitle}
                  disabled={s().originalTitle === undefined ? "Not renamed." : ""}
                  onRun={() => void setTitle(null)}
                />
              </div>
              <div class="model-menu-group" role="group" aria-label="Organize">
                <menu.Item
                  label="Move to Group…"
                  aria={`Move ${quoted(s().title)} into a group`}
                  icon={<Icon name="folder" small />}
                  description={groupNameOf(sessionGroups(), s().groupId) ?? undefined}
                  stayOpen
                  onRun={() => {
                    void loadSessionGroups();
                    menu.show("groups");
                  }}
                />
                <Show when={props.archive}>
                  {(a) => (
                    <menu.Item
                      label={a().label}
                      aria={`${a().label} ${quoted(s().title)}`}
                      icon={<Icon name="archive" small />}
                      disabled={a().blocked ?? ""}
                      onRun={() => {
                        const path = s().path;
                        const next = !s().archived;
                        void archiveSession(path, next).then((ok) => ok && props.ctx.onArchiveChanged(path, next));
                      }}
                    />
                  )}
                </Show>
                <menu.Item label="Copy Path" aria={`Copy the path of ${quoted(s().title)}`} icon={<Icon name="copy" small />} onRun={() => void copyText(s().path, "Copied path.")} />
              </div>
            </div>
          }
        >
          <div class="model-menu-list" role="menu" aria-label="Move to group">
            <div class="model-menu-group" role="group" aria-label="Groups">
              <div class="list-group-label">Groups</div>
              <For each={[{ id: null as string | null, name: "No group" }, ...sessionGroups().map((g) => ({ id: g.id as string | null, name: g.name }))]}>
                {(g) => (
                  <menu.Item
                    label={g.name}
                    aria={g.id ? `Move ${quoted(s().title)} to ${quoted(g.name)}` : `Take ${quoted(s().title)} out of its group`}
                    icon={<Icon name={g.id === (s().groupId ?? null) ? "check" : "folder"} small />}
                    onRun={() => void move(g.id)}
                  />
                )}
              </For>
            </div>
          </div>
        </Show>
      )}
    </ActionMenu>
  );
}

function BoardRowView(props: { row: BoardRow; ctx: BoardCtx }) {
  const r = () => props.row;
  const s = () => r().session;
  const trees = () => props.ctx.treesOf(s().path);
  const open = () => props.ctx.expanded(s().path);
  const detailId = () => `board-detail-${s().id}`;
  const gist = () => summaryLineOf(s());
  /** Archive/Unarchive: only for what you started in Sova, or already archived; the reason when it can't. */
  const archive = () => {
    const x = s();
    if (!x.archived && x.origin !== "web") return null;
    const reason = archiveBlockReason({ ...x, busy: busyOf(x) });
    return { label: x.archived ? "Unarchive" : "Archive", blocked: reason ? `Can't archive: ${reason}.` : null };
  };
  const runArchive = () => {
    const a = archive();
    if (!a || a.blocked) return;
    const path = s().path;
    const next = !s().archived;
    void archiveSession(path, next).then((ok) => ok && props.ctx.onArchiveChanged(path, next));
  };
  const saveTitle = async (title: string | null) => {
    props.ctx.setRenaming(null);
    if (await renameSession(s(), title)) props.ctx.onRefresh();
  };
  /** A press on the row's bare surface (not a control) opens or closes it: the phone's tap. */
  const onLineClick = (e: MouseEvent) => {
    if ((e.target as Element).closest("a, button, input, textarea, select, form, [role=menuitem], summary")) return;
    props.ctx.toggle(s().path);
  };
  const workersLine = () => (r().total > 0 ? `${r().working}/${r().total} working` : "");

  return (
    <li class="board-row" data-state={r().state} classList={{ "board-row-open": open() }}>
      <div class="board-line" onClick={onLineClick}>
        <div class="board-cell board-session">
          <span class="board-rail" aria-hidden="true" />
          <button
            type="button"
            class="button button-icon button-ghost board-twist"
            aria-expanded={open() ? "true" : "false"}
            aria-controls={detailId()}
            aria-label={`${open() ? "Hide" : "Show"} workers and worktrees of ${quoted(s().title)}`}
            onClick={() => props.ctx.toggle(s().path)}
          >
            <Icon name="chevron-right" small class="board-twist-icon" />
          </button>
          <div class="board-session-main">
            <Show
              when={props.ctx.renaming(s().path)}
              fallback={
                <p class="board-title-line">
                  <button
                    type="button"
                    class="board-title board-title-edit"
                    title={s().originalTitle ? `Rename. Originally ${quoted(s().originalTitle!)}` : "Rename this session in Sova"}
                    onClick={() => props.ctx.setRenaming(s().path)}
                  >
                    <span class="visually-hidden">Rename: </span>
                    {s().title}
                  </button>
                  <span class="board-title board-title-text" title={s().title}>
                    {s().title}
                  </span>
                  <StateChip row={r()} class="board-state-inline" />
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
              <Show when={workersLine()}>{(w) => <span>{w()}</span>}</Show>
              <span>{relativeTime(s().lastActiveAt, props.ctx.now)}</span>
            </p>
          </div>
        </div>

        <div class="board-cell board-activity">
          <span class="board-model text-mono" title={s().model ?? undefined}>
            {compactModel(s().model) ?? "—"}
          </span>
          <Show when={contextOf(s())}>{(c) => <ContextRing info={c()} />}</Show>
          <span class="board-when" title={s().lastActiveAt}>
            {relativeTime(s().lastActiveAt, props.ctx.now)}
          </span>
          <StateChip row={r()} class="board-state-cell" />
        </div>

        <div class="board-cell board-workers">
          <Show when={r().total > 0} fallback={<Dash words="No workers" />}>
            <span class="board-count">
              <span class="text-num">
                {r().working}/{r().total}
              </span>{" "}
              working
            </span>
          </Show>
          <For each={r().teams}>
            {(t) => (
              <CountChip href={agentsHref(teamKey(t))} title={t.objective ? capTitle(`${t.name}: ${t.objective}`) : t.name}>
                {t.name}
              </CountChip>
            )}
          </For>
          <Show when={r().spend !== null}>
            <span class="board-spend text-mono text-num" title="What its workers have spent so far">
              {money(r().spend!)}
            </span>
          </Show>
        </div>

        <div class="board-cell board-trees">
          <TreesCell trees={trees()} down={props.ctx.treesDown} />
        </div>

        <div class="board-cell board-actions">
          <a class="button button-icon button-ghost board-act" href={sessionHref(s().path)} aria-label={`Open ${quoted(s().title)}`} title="Open session">
            <Icon name="arrow-right" />
          </a>
          <button
            type="button"
            class="button button-icon button-ghost board-act board-act-wide"
            aria-label={`Open the subagents pane of ${quoted(s().title)}`}
            title="Open subagents pane"
            onClick={() => props.ctx.onOpenSubagents(s().path)}
          >
            <Icon name="worker" />
          </button>
          <Show when={archive()} fallback={<span class="board-act-gap board-act-wide" aria-hidden="true" />}>
            {(a) => (
              <button
                type="button"
                class="button button-icon button-ghost board-act board-act-wide"
                aria-label={`${a().label} ${quoted(s().title)}`}
                aria-disabled={a().blocked ? "true" : undefined}
                title={a().blocked ?? `${a().label} session`}
                onClick={runArchive}
              >
                <Icon name={s().archived ? "undo" : "archive"} />
              </button>
            )}
          </Show>
          <span class="board-act-wide board-move">
            <MoveToGroupMenu session={s()} onChanged={props.ctx.onRefresh} iconOnly />
          </span>
          <RowMenu row={r()} ctx={props.ctx} archive={archive()} />
        </div>
      </div>

      <Show when={open()}>
        <div class="board-detail" id={detailId()}>
          <Show when={r().reason}>
            {(why) => (
              <p class="board-reason">
                <Icon name="alert-circle" small />
                {why()}
              </p>
            )}
          </Show>
          <Show when={soloWorkers(r().agent).length > 0}>
            <ul class="board-worker-list" aria-label="Workers">
              <For each={soloWorkers(r().agent)}>
                {(w) => (
                  <WorkerLine
                    name={w.name}
                    worker={w}
                    id={w.id}
                    model={w.model}
                    status={memberStatus({ workerId: w.id, role: w.name, orchestrator: false, backend: w.backend ?? "", ownedPaths: [], addedAt: 0, worker: w }, !!r().agent?.fresh)}
                    hostPath={r().agent?.path ?? null}
                    onResumed={props.ctx.refetchAgents}
                  />
                )}
              </For>
            </ul>
          </Show>
          <For each={r().teams}>{(t) => <TeamBlock team={t} ctx={props.ctx} hostPath={r().agent?.path ?? null} />}</For>
          <Show when={trees()?.length}>
            <ul class="board-tree-list" aria-label="Worktrees">
              <For each={trees()}>{(t) => <TreeLine tree={t} />}</For>
            </ul>
          </Show>
          <Show when={r().total === 0 && !trees()?.length}>
            <p class="board-none">
              {STATE_WORD[r().state]} · no workers{trees() ? " and no worktree" : ""}.
            </p>
          </Show>
          <Show when={r().total > 0 && !r().agent}>
            <p class="board-none">Its workers are listed while a pi runs it.</p>
          </Show>
        </div>
      </Show>
    </li>
  );
}

/** `#/agents`: every session on one board, its workers, team and worktrees folded inside. */
export function AgentsView(props: {
  agents: Poll<AgentsInsight>;
  sessions: SessionSummary[] | undefined;
  now: number;
  /** Team to focus (from `#/agents/<teamKey>`): its session opens and the team is scrolled to. */
  focusTeam: string | null;
  titleRef(el: HTMLHeadingElement): void;
  onRefresh(): void;
  onArchiveChanged(path: string, archived: boolean): void;
  onOpenSubagents(path: string): void;
}) {
  const [filter, setFilter] = createSignal<BoardFilter | null>(null);
  const [query, setQuery] = createSignal("");
  const [limit, setLimit] = createSignal(BOARD_PAGE);
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [trees, setTrees] = createSignal<ReadonlyMap<string, WorktreeStatus[]>>(new Map());
  const [treesDown, setTreesDown] = createSignal(false);
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
  const linkedKey = () => linked()?.split("\n")[0] ?? null;
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
  /** Paths, not rows: a poll hands back fresh row objects, and a row keyed by its path keeps its DOM (and a rename field's focus). */
  const pagedPaths = createMemo(() => paged().map((r) => r.session.path), undefined, { equals: (a, b) => a.length === b.length && a.every((p, i) => p === b[i]) });

  /**
   * Which sessions the worktrees request names. The rendered rows — except under Unmerged, which
   * needs a reading to decide what renders at all, so it asks for the default scope instead.
   * A string, so the poll below restarts only when the SET changes, never on a fresh list.
   */
  const treesKey = createMemo(() =>
    worktreePathsKey(filter() === "unmerged" ? sortRows(rows().filter(inDefaultScope)).slice(0, limit()) : paged()),
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
      setTreesDown(false);
    } catch {
      // No route yet (an older server), or git trouble: the column says "—", nothing else does.
      setTreesDown(true);
    }
  };
  createEffect(
    on(treesKey, (key) => {
      void readTrees(key);
      const t = setInterval(() => void readTrees(key), WORKTREES_POLL_MS);
      onCleanup(() => clearInterval(t));
    }),
  );

  const totals = createMemo(() => boardTotals(rows().filter(inDefaultScope), trees().values(), props.now));
  const counts = createMemo(() => filterCounts(rows(), treesOf));

  /** The link, once its session's row is on the board: a team found before the list loads waits for it. */
  const linkReady = createMemo(() => {
    const v = linked();
    return v && byPath().has(v.split("\n")[1]!) ? v : null;
  });
  // Open the linked team's session and bring the team into view, once per link: polls don't steal focus.
  let focused: string | null = null;
  createEffect(
    on(linkReady, (v) => {
      const key = props.focusTeam;
      if (!v || !key || key === focused) return;
      const [teamKeyNow, parent] = v.split("\n") as [string, string];
      setOpen((s) => (s.has(parent) ? s : new Set([...s, parent])));
      requestAnimationFrame(() => {
        const el = document.getElementById(teamAnchor(teamKeyNow));
        if (!el) return;
        focused = key;
        el.scrollIntoView({ block: "center" });
        el.focus({ preventScroll: true });
      });
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
    get treesDown() {
      return treesDown();
    },
    expanded: (p) => open().has(p),
    toggle: (p) =>
      setOpen((s) => {
        const next = new Set(s);
        if (!next.delete(p)) next.add(p);
        return next;
      }),
    renaming: (p) => renaming() === p,
    setRenaming,
    get linkedTeam() {
      return linkedKey();
    },
    onRefresh: () => props.onRefresh(),
    onArchiveChanged: (p, a) => props.onArchiveChanged(p, a),
    onOpenSubagents: (p) => props.onOpenSubagents(p),
    refetchAgents: () => props.agents.refetch(),
  };

  const meta = () => (props.sessions ? totalsLine(totals()) : undefined);
  const metaTitle = () =>
    "Sessions working, sessions live, what workers of sessions active today have spent, and unmerged branches in the worktrees read so far.";

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
      meta={meta() ? <span title={metaTitle()}>{meta()}</span> : undefined}
      refreshLabel="Refresh Agents"
      onRefresh={() => {
        props.agents.refetch();
        props.onRefresh();
        void readTrees(treesKey());
      }}
      error={props.agents.error()}
      errorTitle="Couldn't load agents."
      busy={!props.sessions && props.agents.pending()}
      titleRef={props.titleRef}
    >
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
          <p class="board-count-line" aria-live="polite">
            {shown().length} {shown().length === 1 ? "session" : "sessions"}
            {filter() ? "" : query().trim() ? " across every session" : " live or open in Sova"}
          </p>
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
              <span>Worktrees</span>
              <span />
            </div>
            <ul class="board-list" aria-label="Sessions">
              <For each={pagedPaths()}>{(path) => <Show when={byPath().get(path)}>{(r) => <BoardRowView row={r()} ctx={ctx} />}</Show>}</For>
            </ul>
          </div>
          <Show when={shown().length > limit()}>
            <button type="button" class="button board-more-rows" onClick={() => setLimit((n) => n + BOARD_PAGE)}>
              Show {Math.min(BOARD_PAGE, shown().length - limit())} More
            </button>
          </Show>
        </Show>
      </Show>
    </InsightsPage>
  );
}

/** Each chip's absence, in words, after the live fact. */
const BOARD_EMPTY: Record<Exclude<BoardFilter, "live">, string> = {
  "needs-you": "Nothing is waiting on you.",
  "has-workers": "No session has workers.",
  unmerged: "No unmerged branch in the worktrees read so far.",
  archived: "Nothing is archived.",
};
