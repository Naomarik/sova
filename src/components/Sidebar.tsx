import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { AgentsInsight, ContextInfo, SessionGroup, SessionSummary, UsageInsight } from "../../shared/protocol";
import { fetchTargets } from "../lib/api";
import { type ArchiveGroupId, groupByArchiveDate, sessionsWord } from "../lib/archive";
import { relativeTime, shortModel, tildePath } from "../lib/format";
import { agentsHref, type GlancePart, usageGlance, usageHref } from "../lib/insights";
import { isTopSession } from "../lib/regions";
import { remotePlaceOf, type TargetInfo } from "../lib/remote-session";
import {
  createGroup,
  dragHasRow,
  groupDragPath,
  groupNameOf,
  groupSections,
  loadSessionGroups,
  quoted,
  removeGroup,
  renameGroup,
  sessionGroups,
  setGroupDragData,
  setSessionGroup,
} from "../lib/session-groups";
import { announce, home, localRunning, sessionContext, toast } from "../lib/ui-state";
import { activeAgentCounts, activeTeamCount, sessionWorking } from "../lib/workers";
import { ArchiveCleanup } from "./ArchiveCleanup";
import { ContextRing } from "./ContextRing";
import { GroupNameField } from "./Groups";
import { RemoteGroupDot } from "./RemoteStatus";
import { Banner, Chip, Icon } from "./ui";

interface Group {
  cwd: string;
  sessions: SessionSummary[];
}

function groupByCwd(sessions: SessionSummary[]): Group[] {
  const byCwd = new Map<string, SessionSummary[]>();
  const sorted = [...sessions].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  for (const s of sorted) {
    const list = byCwd.get(s.cwd);
    if (list) list.push(s);
    else byCwd.set(s.cwd, [s]);
  }
  // Map keeps insertion order, and the first session seen per cwd is its newest.
  return [...byCwd].map(([cwd, list]) => ({ cwd, sessions: list }));
}

const ARCHIVE_KEY = "pi-web:archive-open";
/** One key per Archive date section, same "1"/"0" values as ARCHIVE_KEY. */
const archiveDateKey = (id: ArchiveGroupId) => `pi-web:archive-date-open-${id}`;
/** One key per group section; unlike the Archive's dates, a group opens by default — it is the
    user's own curation, and a collapsed group would hide the sessions they just filed away. */
const groupOpenKey = (id: string) => `pi-web:group-open-${id}`;

/**
 * The row being dragged, and the drop target under the pointer. Module state, because one drag
 * spans the row that started it and the group sections it passes over, and a tab can only drag
 * one thing at a time. `groupId` is where the row is now, which is what decides whether a drop
 * moves it or does nothing.
 */
const [dragging, setDragging] = createSignal<{ path: string; groupId: string | null } | null>(null);
const [dropTarget, setDropTarget] = createSignal<string | "remove" | null>(null);

/** Whether a drag over `element` has left it: a dragleave fires whenever the pointer crosses into
    a child, so the drop state must only clear once the pointer is outside the whole target. */
const leftTarget = (e: DragEvent, el: HTMLElement) => !(e.relatedTarget instanceof Node) || !el.contains(e.relatedTarget);

/** Which group sections are open, and which of their inline controls is showing. Module state for
    the same reason as the drag: a group's section is rebuilt whenever the session list refreshes
    (every few seconds), and an open group, or a rename in progress, must survive that. */
const [openGroups, setOpenGroups] = createSignal<Record<string, boolean>>({});
const [editingGroup, setEditingGroup] = createSignal<string | null>(null);
const [confirmingGroup, setConfirmingGroup] = createSignal<string | null>(null);
/** The "New group" row has turned into its name field. */
const [newGroupField, setNewGroupField] = createSignal(false);

/** Open by default (unlike the Archive's dates): a group is the user's own curation, so hiding it
    would hide the sessions they just filed. The choice persists in sessionStorage, as the Archive's does. */
const groupOpen = (id: string) => openGroups()[id] ?? sessionStorage.getItem(groupOpenKey(id)) !== "0";
const onGroupToggle = (id: string, e: Event & { currentTarget: HTMLDetailsElement }) => {
  const open = e.currentTarget.open;
  if (open === groupOpen(id)) return; // our own `open` update, not the user's
  setOpenGroups((m) => ({ ...m, [id]: open }));
  sessionStorage.setItem(groupOpenKey(id), open ? "1" : "0");
};

/**
 * Drops the dragged row into `groupId` (`null` takes it out of the group it is in). Says what
 * happened through the toast stack and the polite region, and returns whether the list should be
 * re-read. A drop back where the row already is does nothing at all.
 */
async function applyDrop(groupId: string | null): Promise<boolean> {
  const from = dragging();
  setDragging(null);
  setDropTarget(null);
  if (!from || from.groupId === groupId) return false;
  const before = from.groupId ? groupNameOf(sessionGroups(), from.groupId) : null;
  const after = groupId ? groupNameOf(sessionGroups(), groupId) : null;
  if (!(await setSessionGroup(from.path, groupId))) return false;
  const done = groupId === null ? `Removed from ${before ? quoted(before) : "its group"}.` : `${before ? "Moved" : "Added"} to ${quoted(after ?? "the group")}.`;
  toast(done);
  announce(done);
  return true;
}

export const sessionHref = (path: string) => `#/s/${encodeURIComponent(path)}`;

/** "3 subagents working now" / "1 subagent working now" — rail title, toast and hidden row text. */
const workingNow = (n: number) => `${n} ${n === 1 ? "subagent" : "subagents"} working now`;

/**
 * One session row: a wordless status rail on the left, then the link itself. The rail buttons are
 * out of the tab order on purpose (a long list must not add two tab stops per row), so the link
 * keeps the same state in its accessible name that the old right-hand chips exposed.
 */
function SessionRow(props: { session: SessionSummary; selected: string | null; now: number }) {
  const s = () => props.session;
  // Busy (§2): this tab's own run wins over the last fetched list; Live wins over both.
  const isBusy = () => !s().live && !!(localRunning()[s().path] ?? s().busy);
  const tuiTitle = () => `Open in a TUI · pid ${s().live!.pid} · ${s().live!.status}`;
  const working = () => sessionWorking(s());
  /** The row's context fill: the open session's live value wins over the list's tail value, and a
      just-compacted session shows no ring (the head is where "compacted" is said in words). */
  const contextOf = (s: SessionSummary): ContextInfo | null => {
    const live = sessionContext()[s.path];
    if (live === "compacted") return null;
    if (live) return live;
    const fromList = s.context;
    return fromList && fromList.window ? fromList : null;
  };
  return (
    <li
      class="session-row-shell"
      classList={{ "session-row-shell-current": props.selected === s().path, "session-row-dragging": dragging()?.path === s().path }}
      // The row itself is the drag source (the link inside is not: a browser drags links natively,
      // and that drag carries a URL, not a session). §2 "Groups": drag a row onto a group section.
      draggable="true"
      onDragStart={(e) => {
        setGroupDragData(e, s().path);
        setDragging({ path: s().path, groupId: s().groupId ?? null });
      }}
      onDragEnd={() => {
        setDragging(null);
        setDropTarget(null);
      }}
    >
      <div class="session-rail">
        {/* At most one state: live wins over busy. TUI is static now; Busy is what pulses. */}
        <Show when={s().live}>
          <button
            type="button"
            tabindex="-1"
            class="session-rail-item session-rail-state chip chip-accent"
            aria-label={`Open in a TUI. Pid ${s().live!.pid}, status ${s().live!.status}.`}
            title={tuiTitle()}
            onClick={() => toast(tuiTitle())}
          >
            <span class="session-rail-dot" />
          </button>
        </Show>
        <Show when={isBusy()}>
          <button
            type="button"
            tabindex="-1"
            class="session-rail-item session-rail-state chip chip-info chip-live"
            aria-label="pi is replying in this session"
            title="pi is replying in this session"
            onClick={() => toast("pi is replying in this session")}
          >
            <span class="session-rail-dot" />
          </button>
        </Show>
        <Show when={working()}>
          {(n) => (
            <button
              type="button"
              tabindex="-1"
              class="session-rail-item session-rail-count"
              // One moving thing per row: the icon only pulses when Busy isn't already pulsing.
              classList={{ "session-rail-count-live": !isBusy() }}
              aria-label={workingNow(n())}
              title={workingNow(n())}
              onClick={() => toast(workingNow(n()))}
            >
              <span class="text-num">{n()}</span>
              <Icon name="worker" small />
            </button>
          )}
        </Show>
      </div>
      <a
        class="list-row list-row-interactive session-row"
        href={sessionHref(s().path)}
        draggable={false}
        aria-current={props.selected === s().path ? "page" : undefined}
      >
        <div class="list-main">
          <p class="list-title" classList={{ "list-title-muted": s().title === "Untitled" }} title={s().title}>
            {s().title}
          </p>
          {/* A never-sent session kept in the list by its stored draft: line 2 says so, in the place
              a summary would take, so the row is as tall as its neighbours. The pencil is
              decorative; the hidden word is what the row's accessible name says. */}
          <Show when={s().draftPreview}>
            {(preview) => (
              <div class="list-line list-summary-row">
                <Icon name="pencil" small />
                <p class="list-summary" title={`Draft: ${preview()}`}>
                  <span class="visually-hidden">Draft: </span>
                  {preview()}
                </p>
              </div>
            )}
          </Show>
          <Show when={!s().draftPreview && s().outlineNow}>
            <div class="list-line list-summary-row">
              <p class="list-summary" title={s().outlineNow}>{s().outlineNow}</p>
              <Show when={s().outlineTopics}>
                {(n) => (
                  <Show when={n() > 0}>
                    <span class="chip chip-count session-topics" title={`${n()} topics in this session`}>
                      <span class="text-num">{n()}</span>
                    </span>
                  </Show>
                )}
              </Show>
            </div>
          </Show>
          <div class="list-line list-meta-row">
            <p class="list-meta">
              {relativeTime(s().lastActiveAt, props.now)}
              <Show when={s().model}>
                {" · "}
                <span class="text-mono" title={s().model!}>
                  {shortModel(s().model)}
                </span>
              </Show>
            </p>
            <Show when={contextOf(s())}>{(c) => <ContextRing info={c()} />}</Show>
          </div>
        </div>
        {/* AT parity with the old chips: the rail is wordless, so the state lives in the link's name. */}
        <Show when={s().live}>
          <span class="visually-hidden">, open in a TUI</span>
        </Show>
        <Show when={isBusy()}>
          <span class="visually-hidden">, pi is replying in this session</span>
        </Show>
        <Show when={working()}>{(n) => <span class="visually-hidden">, {workingNow(n())}</span>}</Show>
      </a>
    </li>
  );
}

/** Sessions grouped by folder, newest first: the markup of spec/02-session-list.md §2 "Anatomy".
    `level` is the heading level a folder label takes: h3 directly under a region, h4 inside a
    group, where the group's own label already sits at h3. */
function GroupList(props: { groups: Group[]; selected: string | null; now: number; idPrefix: string; targets: TargetInfo[]; level?: 4 }) {
  return (
    <For each={props.groups}>
      {(group, gi) => {
        // A remote session's cwd is a local placeholder mirroring the remote folder (§2 "Remote sessions").
        const remote = remotePlaceOf(group.sessions[0] ?? { cwd: group.cwd });
        const host = () => (remote ? props.targets.find((t) => t.name === remote.target)?.host : undefined);
        const label = (name: string) => props.targets.find((t) => t.name === name)?.label || name;
        return (
          <section class="session-group" aria-labelledby={`${props.idPrefix}-${gi()}`}>
            <Dynamic
              component={props.level === 4 ? "h4" : "h3"}
              class="list-group-label"
              id={`${props.idPrefix}-${gi()}`}
              title={remote ? `${remote.target}${host() ? ` (${host()})` : ""}:${remote.remoteCwd}` : group.cwd}
            >
              <Icon name={remote ? "terminal" : "folder"} small />
              {/* Remote: the target's label stays whole and the folder on it truncates from the left
                  like a local path, but never as "~": the target's $HOME isn't ours. */}
              <Show when={remote}>
                {(r) => (
                  <>
                    <span>{label(r().target)}</span>
                    {/* The connection as the open chat last reported it: after the label, never
                        on a row's rail, and it never pulses, so it can't read as the live dot. */}
                    <RemoteGroupDot target={r().target} />
                    <span aria-hidden="true">·</span>
                  </>
                )}
              </Show>
              <span class="session-group-path">
                <bdi>{remote ? remote.remoteCwd : tildePath(group.cwd, home())}</bdi>
              </span>
              <span class="text-num">{group.sessions.length}</span>
            </Dynamic>
            <ul class="list">
              <For each={group.sessions}>
                {(s) => <SessionRow session={s} selected={props.selected} now={props.now} />}
              </For>
            </ul>
          </section>
        );
      }}
    </For>
  );
}

/**
 * One user-made group: a collapsible section above Live & web that holds the same folder groups and
 * rows as every other region (spec/02-session-list.md §2 "Groups"). It keeps its own Rename and Delete, and
 * it is a drop target while a row is being dragged. An empty group stays visible — that is what a
 * group is when the user makes it, and dragging a row in is how it fills.
 */
function GroupBlock(props: {
  /** The group itself: its identity is what keeps this section mounted across list polls (§2 "Groups"). */
  group: SessionGroup;
  /** The rows it holds right now, from the sidebar's search-hit list. */
  sessions: SessionSummary[];
  selected: string | null;
  now: number;
  targets: TargetInfo[];
  onChanged(): void;
}) {
  const group = () => props.group;
  const count = () => props.sessions.length;
  const over = () => dropTarget() === group().id;

  const deleteGroup = async () => {
    const n = count();
    const name = group().name;
    setConfirmingGroup(null);
    if (!(await removeGroup(group().id))) return;
    toast(
      n === 0
        ? `Deleted ${quoted(name)}. It had no sessions.`
        : `Deleted ${quoted(name)}. Its ${sessionsWord(n)} ${n === 1 ? "is" : "are"} ungrouped.`,
    );
    props.onChanged(); // the rows it held carry a groupId that is gone
  };

  return (
    <details
      class="group-section"
      classList={{ "group-section-drop": over() }}
      open={groupOpen(group().id)}
      onToggle={(e) => onGroupToggle(group().id, e)}
      onDragOver={(e) => {
        if (!dragHasRow(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        if (!over()) setDropTarget(group().id);
      }}
      onDragLeave={(e) => {
        if (over() && leftTarget(e, e.currentTarget)) setDropTarget(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (groupDragPath(e)) void applyDrop(group().id).then((changed) => changed && props.onChanged());
      }}
    >
      <summary class="list-group-label group-label" title={group().name}>
        <Icon name="chevron-right" small class="icon-twist" />
        <Icon name="folder" small />
        <span class="group-name">
          <bdi>{group().name}</bdi>
        </span>
        <span class="text-num">{count()}</span>
      </summary>
      <Show when={count() > 0} fallback={<p class="sidebar-region-note">No sessions yet. Drag one here.</p>}>
        <GroupList
          groups={groupByCwd(props.sessions)}
          selected={props.selected}
          now={props.now}
          idPrefix={`g-${group().id}`}
          targets={props.targets}
          level={4}
        />
      </Show>
      {/* Rename and Delete in place, in the section's own quiet tool row (as the Archive does
          with Cleanup): a button inside a <summary> would fight the section's own toggle. */}
      <div class="group-tools">
        <Show
          when={editingGroup() === group().id}
          fallback={
            <Show
              when={confirmingGroup() === group().id}
              fallback={
                <>
                  <button type="button" class="button button-sm button-ghost" onClick={() => setEditingGroup(group().id)}>
                    Rename
                  </button>
                  <button type="button" class="button button-sm button-ghost" onClick={() => setConfirmingGroup(group().id)}>
                    Delete group
                  </button>
                </>
              }
            >
              <p class="group-tools-question">
                {count() === 0
                  ? `Delete ${quoted(group().name)}? Nothing is in it.`
                  : `Delete ${quoted(group().name)}? Its ${sessionsWord(count())} stay${count() === 1 ? "s" : ""} in the list.`}
              </p>
              <button type="button" class="button button-sm button-destructive" onClick={() => void deleteGroup()}>
                Delete group
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={() => setConfirmingGroup(null)}>
                Cancel
              </button>
            </Show>
          }
        >
          <GroupNameField
            label={`Rename ${quoted(group().name)}`}
            initial={group().name}
            onDone={(name) => {
              setEditingGroup(null);
              if (name !== group().name) void renameGroup(group().id, name);
            }}
            onCancel={() => setEditingGroup(null)}
          />
        </Show>
      </div>
    </details>
  );
}

/** Usage foot row: every provider at a glance ("C 47%  O 95%  OL 80%  Z 0%  DS $4.29"), or the page name. */
function UsageGlance(props: { parts: GlancePart[] }) {
  return (
    <Show when={props.parts.length > 0} fallback="Usage">
      <For each={props.parts}>
        {(p) => (
          // Stale wins over high: an old 95% isn't a current warning.
          <span class="usage-glance-item" classList={{ "usage-glance-item-high": p.high && !p.stale, "usage-glance-item-stale": p.stale }}>
            <span class="usage-glance-tag">{p.abbr}</span>
            {/* A credit provider shows the money left; a window provider its percentage. */}
            <span class="text-num">{p.amount ?? `${p.pct}%`}</span>
          </span>
        )}
      </For>
    </Show>
  );
}

/** What the Agents foot row counts: live agents, the sessions holding them, then active teams. */
function agentsParts(agents: AgentsInsight | undefined): { n: number; word: string }[] {
  const live = activeAgentCounts(agents);
  const teams = activeTeamCount(agents);
  const out: { n: number; word: string }[] = [];
  if (live.agents > 0) out.push({ n: live.agents, word: live.agents === 1 ? "agent" : "agents" });
  if (live.sessions > 0) out.push({ n: live.sessions, word: live.sessions === 1 ? "session" : "sessions" });
  if (teams > 0) out.push({ n: teams, word: teams === 1 ? "team" : "teams" });
  return out;
}

/** The same counts as one plain sentence, for the row's title and accessible name. */
function agentsSentence(agents: AgentsInsight | undefined): string | undefined {
  const live = activeAgentCounts(agents);
  const teams = activeTeamCount(agents);
  const clauses: string[] = [];
  if (live.agents > 0) {
    const a = `${live.agents} active ${live.agents === 1 ? "agent" : "agents"}`;
    clauses.push(`${a} in ${live.sessions} ${live.sessions === 1 ? "session" : "sessions"}`);
  }
  if (teams > 0) clauses.push(`${teams} ${teams === 1 ? "team" : "teams"}`);
  return clauses.length > 0 ? clauses.join(", ") : undefined;
}

/** Agents foot row: live agents, their sessions, then active teams; 0s are left out. */
function AgentsGlance(props: { agents: AgentsInsight | undefined }) {
  const parts = () => agentsParts(props.agents);
  return (
    <Show when={parts().length > 0} fallback="Agents">
      <For each={parts()}>
        {(p, i) => (
          <>
            {i() > 0 && " · "}
            <span class="text-num">{p.n}</span> {p.word}
          </>
        )}
      </For>
    </Show>
  );
}

export function Sidebar(props: {
  sessions: SessionSummary[] | undefined;
  loading: boolean;
  error: string | null;
  selected: string | null;
  now: number;
  onRefresh(): void;
  onNew(): void;
  usage: UsageInsight | undefined;
  agents: AgentsInsight | undefined;
  /** The insights page that's open (`#/usage` or `#/agents`), for aria-current on its foot row. */
  insightsPage: "usage" | "agents" | null;
}) {
  const [query, setQuery] = createSignal("");
  const [showSkeleton, setShowSkeleton] = createSignal(false);
  const skeletonTimer = setTimeout(() => setShowSkeleton(true), 300);
  let search!: HTMLInputElement;
  // The tab's copy of the group list: the pane's region and the session pane's menu share it.
  onMount(() => void loadSessionGroups());

  // "/" anywhere outside a text field focuses search.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    search.focus();
  };
  document.addEventListener("keydown", onKey);
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    clearTimeout(skeletonTimer);
  });

  const all = () => props.sessions ?? [];
  // Labels for remote groups: refetched only when the set of targets the list uses changes.
  const usedTargets = createMemo(
    () => [...new Set(all().map((s) => remotePlaceOf(s)?.target).filter(Boolean))].sort().join("\n") || false,
  );
  const [targetsRes] = createResource(usedTargets, () => fetchTargets().catch(() => [] as TargetInfo[]));
  const targets = () => targetsRes.latest ?? [];
  const hits = createMemo(() => {
    const q = query().trim().toLowerCase();
    // A remote session is found by its target and remote folder, not by its placeholder path.
    const where = (s: SessionSummary) => {
      const r = remotePlaceOf(s);
      return r ? `${r.target} ${targets().find((t) => t.name === r.target)?.label ?? ""} ${r.remoteCwd}` : s.cwd;
    };
    return q ? all().filter((s) => `${s.title} ${where(s)} ${s.model ?? ""}`.toLowerCase().includes(q)) : all();
  });
  // Pane rule: live, or web-spawned and not archived, stays on top (src/lib/regions.ts).
  const isTop = isTopSession;
  const topHits = createMemo(() => hits().filter(isTop));
  const archiveHits = createMemo(() => hits().filter((s) => !isTop(s)));
  // Each region groups by cwd on its own, so a folder can appear in both.
  const topGroups = createMemo(() => groupByCwd(topHits()));
  // The Archive splits by date first (Today … Older), then by cwd inside each date section.
  const archiveSections = createMemo(() => {
    const sorted = [...archiveHits()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    return groupByArchiveDate(sorted, new Date(props.now)).map((d) => ({ ...d, groups: groupByCwd(d.items) }));
  });
  const archiveTotal = () => all().filter((s) => !isTop(s)).length;

  // Groups (§2 "Groups"): the user's own sections, above every region. They cut across regions — a
  // group can hold a TUI-live session and an archived one — so they read the whole search-hit list,
  // not one region's slice.
  const searching = () => !!query().trim();
  const sections = createMemo(() => groupSections(hits(), sessionGroups(), searching()));
  /** A group's rows, from the same hit list the sections were built from. */
  const rowsOf = (id: string) => hits().filter((s) => s.groupId === id);
  /** With no query the region always stands: it holds the "New group" row, the feature's front
      door. While searching it appears only when a group has a match — or when a row is in flight
      and needs its "Remove from …" target, which a fruitless search would otherwise hide. */
  const groupsShown = () => !searching() || sections().length > 0 || !!dragging()?.groupId;

  // A groupId this tab doesn't know means the local group list is behind (another tab, another
  // server): without this the row would silently vanish from the Groups region until a reload.
  // Asked once per newly seen id, so a stale id can't turn into a poll of its own.
  let askedGroups = new Set<string>();
  createEffect(() => {
    const known = new Set(sessionGroups().map((g) => g.id));
    const missing = new Set((hits().map((s) => s.groupId).filter((id): id is string => !!id && !known.has(id))));
    if (missing.size === 0 || [...missing].every((id) => askedGroups.has(id))) return;
    askedGroups = new Set([...askedGroups, ...missing]);
    void loadSessionGroups();
  });

  // Collapsed by default; the user's own choice persists for the tab (spec/02-session-list.md §2 "Regions").
  const [storedOpen, setStoredOpen] = createSignal(sessionStorage.getItem(ARCHIVE_KEY) === "1");
  /** Forced open while searching, when the top is empty, or when the open session is archived. */
  const forcedOpen = () =>
    !!query().trim() || topHits().length === 0 || archiveHits().some((s) => s.path === props.selected);
  const archiveOpen = () => forcedOpen() || storedOpen();
  const onArchiveToggle = (e: Event & { currentTarget: HTMLDetailsElement }) => {
    const open = e.currentTarget.open;
    if (open === archiveOpen()) return; // our own `open` update, not the user's
    setStoredOpen(open);
    sessionStorage.setItem(ARCHIVE_KEY, open ? "1" : "0");
  };
  // Date sections: collapsed by default, each remembering its own choice the same way.
  const [storedDateOpen, setStoredDateOpen] = createSignal<Partial<Record<ArchiveGroupId, boolean>>>({});
  const dateStored = (id: ArchiveGroupId) => storedDateOpen()[id] ?? sessionStorage.getItem(archiveDateKey(id)) === "1";
  /** Forced open while searching, or when it holds the open session. */
  const dateOpen = (d: { id: ArchiveGroupId; items: SessionSummary[] }) =>
    !!query().trim() || d.items.some((s) => s.path === props.selected) || dateStored(d.id);
  const onDateToggle = (d: { id: ArchiveGroupId; items: SessionSummary[] }, e: Event & { currentTarget: HTMLDetailsElement }) => {
    const open = e.currentTarget.open;
    if (open === dateOpen(d)) return; // our own `open` update, not the user's
    setStoredDateOpen((m) => ({ ...m, [d.id]: open }));
    sessionStorage.setItem(archiveDateKey(d.id), open ? "1" : "0");
  };
  const liveCount = () => all().filter((s) => s.live).length;
  const glance = createMemo(() => usageGlance(props.usage));
  /** The foot's usage glance in full words, for its tooltip and accessible name. */
  const glanceText = () => (glance().length ? `Usage: ${glance().map((p) => p.full).join(", ")}` : "");

  const clear = () => {
    setQuery("");
    search.focus();
  };


  return (
    <aside class="app-sidebar" aria-label="Sessions">
      <div class="sidebar-head">
        <a class="brand" href="#/">
          <span class="icon" style={{ "--icon": "url(/icons/pi-web-mark.svg)" }} aria-hidden="true" />
          pi-web
        </a>
        <span class="sidebar-spacer" />
        <button
          type="button"
          class="button button-icon button-ghost"
          aria-label="Refresh Sessions"
          title="Refresh Sessions"
          aria-disabled={props.loading ? "true" : undefined}
          onClick={() => !props.loading && props.onRefresh()}
        >
          <Icon name="refresh" />
        </button>
        <button type="button" class="button" onClick={() => props.onNew()}>
          <Icon name="plus" />
          New Session
        </button>
      </div>

      <div class="sidebar-search" role="search">
        <label class="visually-hidden" for="session-search">
          Search sessions
        </label>
        <div class="search">
          <Icon name="search" />
          <input
            ref={search}
            class="input"
            id="session-search"
            type="search"
            placeholder="Title, folder, or model"
            aria-describedby="session-count"
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              if (query()) setQuery("");
              else search.blur();
            }}
          />
          <Show when={query()}>
            <button type="button" class="button button-icon" aria-label="Clear Search" onClick={clear}>
              <Icon name="close" small />
            </button>
          </Show>
        </div>
        <div class="spread">
          <p class="search-count" id="session-count" aria-live="polite">
            <Show when={props.sessions}>
              <Show when={query().trim()} fallback={`${all().length} sessions`}>
                {hits().length} of {all().length} sessions
              </Show>
            </Show>
          </p>
          {/* Always every live session, even while the search filters. */}
          <Show when={liveCount() > 0}>
            <Chip tone="accent" count title="Sessions open in a TUI">
              {liveCount()} TUI
            </Chip>
          </Show>
        </div>
      </div>

      <nav class="sidebar-list pane" aria-label="Session list" aria-busy={props.sessions === undefined && props.loading ? "true" : undefined}>
        <Show when={props.error}>
          <div class="transcript-banner">
            <Banner
              tone="error"
              title="Couldn't read your sessions."
              body={
                <>
                  <code>~/.pi/agent/sessions</code> wasn't changed. Check the server is running, then retry. <span class="text-muted">({props.error})</span>
                </>
              }
              action={
                <button type="button" class="button button-sm" onClick={() => props.onRefresh()}>
                  Retry
                </button>
              }
            />
          </div>
        </Show>

        <Show when={props.sessions === undefined && props.loading && showSkeleton()}>
          <div class="stack-2">
            <For each={[1, 2, 3, 4, 5, 6]}>{() => <div class="skeleton skeleton-row" />}</For>
          </div>
        </Show>

        <Show when={props.sessions && all().length === 0}>
          <div class="empty">
            <p class="empty-title">
              0 sessions in <code>~/.pi/agent/sessions</code>.
            </p>
            <p class="empty-body">
              Start one here, or run <code>pi</code> in a terminal. It'll show up in this list.
            </p>
            <button type="button" class="button empty-action" onClick={() => props.onNew()}>
              New Session
            </button>
          </div>
        </Show>

        <Show when={all().length > 0 && hits().length === 0}>
          <div class="empty">
            <p class="empty-title">
              0 of {all().length} match “{query().trim()}”.
            </p>
            <p class="empty-body">We search titles, folders, and models.</p>
            <button type="button" class="button empty-action" onClick={clear}>
              Clear Search
            </button>
          </div>
        </Show>

        {/* The user's own groups, above every region (§2 "Groups"): the same rows and folder
            groups as below, plus the two controls that make a group and name it. */}
        <Show when={groupsShown()}>
          <section class="sidebar-region sidebar-groups" aria-labelledby="r-groups">
            <h2 class="sidebar-region-head" id="r-groups">
              Groups{" "}
              <span class="sidebar-region-count">
                · {searching() ? `${sections().length} of ${sessionGroups().length}` : sessionGroups().length}
              </span>
            </h2>
            {/* Making a group is the region's one action, and it stays where it is: the field
                replaces the row in place, so nothing moves while the user types. */}
            <Show when={!searching()}>
              <Show
                when={newGroupField()}
                fallback={
                  <button type="button" class="list-row list-row-interactive group-new" onClick={() => setNewGroupField(true)}>
                    <Icon name="plus" small />
                    <span class="list-title">New group</span>
                  </button>
                }
              >
                <div class="group-field-row">
                  <GroupNameField
                    label="New group name"
                    onDone={(name) => {
                      setNewGroupField(false);
                      void createGroup(name);
                    }}
                    onCancel={() => setNewGroupField(false)}
                  />
                </div>
              </Show>
            </Show>
            <Show when={!searching() && sessionGroups().length === 0}>
              <p class="sidebar-region-note">No groups yet. Make one, then drag a session into it.</p>
            </Show>
            <For each={sections().map((s) => s.group)}>
              {(group) => (
                <GroupBlock group={group} sessions={rowsOf(group.id)} selected={props.selected} now={props.now} targets={targets()} onChanged={props.onRefresh} />
              )}
            </For>
            {/* Only while a grouped row is in flight: dropping here takes it out of its group. */}
            <Show when={dragging()?.groupId}>
              <div
                class="group-remove"
                classList={{ "group-remove-over": dropTarget() === "remove" }}
                onDragOver={(e) => {
                  if (!dragHasRow(e)) return;
                  e.preventDefault();
                  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                  if (dropTarget() !== "remove") setDropTarget("remove");
                }}
                onDragLeave={(e) => {
                  if (dropTarget() === "remove" && leftTarget(e, e.currentTarget)) setDropTarget(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (groupDragPath(e)) void applyDrop(null).then((changed) => changed && props.onRefresh());
                }}
              >
                <Icon name="close" small />
                Remove from {quoted(groupNameOf(sessionGroups(), dragging()?.groupId ?? undefined) ?? "its group")}
              </div>
            </Show>
          </section>
        </Show>

        {/* Hidden when a search empties it; kept with a note when there's simply nothing on top. */}
        <Show when={props.sessions && all().length > 0 && (topHits().length > 0 || !query().trim())}>
          <section class="sidebar-region" aria-labelledby="r-top">
            <h2 class="sidebar-region-head" id="r-top">
              Live &amp; web{" "}
              <span class="sidebar-region-count">
                · {query().trim() ? `${topHits().length} of ${all().length - archiveTotal()}` : topHits().length}
              </span>
            </h2>
            <Show
              when={topHits().length > 0}
              fallback={<p class="sidebar-region-note">0 sessions open in a TUI, or started here and not archived. The archive below has the rest.</p>}
            >
              <GroupList groups={topGroups()} selected={props.selected} now={props.now} idPrefix="t" targets={targets()} />
            </Show>
          </section>
        </Show>

        <Show when={archiveHits().length > 0}>
          <details class="sidebar-region sidebar-archive" open={archiveOpen()} onToggle={onArchiveToggle}>
            <summary class="sidebar-region-head">
              <Icon name="chevron-right" small class="icon-twist" />
              <span>Archive</span>
              <span class="sidebar-region-count">
                · {query().trim() ? `${archiveHits().length} of ${archiveTotal()}` : archiveHits().length}
              </span>
            </summary>
            <For each={archiveSections()}>
              {(d) => (
                <details class="archive-date" open={dateOpen(d)} onToggle={(e) => onDateToggle(d, e)}>
                  <summary class="list-group-label archive-date-label">
                    <Icon name="chevron-right" small class="icon-twist" />
                    <span class="archive-date-name">{d.label}</span>
                    <span class="text-num">{d.items.length}</span>
                  </summary>
                  <GroupList groups={d.groups} selected={props.selected} now={props.now} idPrefix={`a-${d.id}`} targets={targets()} />
                </details>
              )}
            </For>
            {/* Cleanup ignores the search, so it's hidden while one filters the list. */}
            <Show when={!query().trim()}>
              <ArchiveCleanup sessions={all()} selected={props.selected} onDeleted={() => props.onRefresh()} />
            </Show>
          </details>
        </Show>
      </nav>

      <div class="sidebar-foot">
        <a
          class="list-row list-row-interactive insights-row"
          href={usageHref()}
          aria-current={props.insightsPage === "usage" ? "page" : undefined}
          title={glanceText() || undefined}
          aria-label={glanceText() || undefined}
        >
          <Icon name="gauge" />
          <span class="insights-row-text" classList={{ "usage-glance": glance().length > 0 }}>
            <UsageGlance parts={glance()} />
          </span>
        </a>
        <a
          class="list-row list-row-interactive insights-row"
          href={agentsHref()}
          aria-current={props.insightsPage === "agents" ? "page" : undefined}
          title={agentsSentence(props.agents)}
          aria-label={agentsSentence(props.agents)}
        >
          <Icon name="worker" />
          <span class="insights-row-text">
            <AgentsGlance agents={props.agents} />
          </span>
        </a>
      </div>
    </aside>
  );
}
