import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { AgentsInsight, ContextInfo, SessionGroup, SessionSummary, UsageInsight } from "../../shared/protocol";
import { fetchTargets } from "../lib/api";
import { type ArchiveGroupId, groupByArchiveDate, sessionsWord } from "../lib/archive";
import { relativeTime, shortModel, tildePath } from "../lib/format";
import { agentsHref, type GlancePart, usageGlance, usageHref } from "../lib/insights";
import { isMainThread, isTopSession } from "../lib/regions";
import { groupRemotePlaceOf, remoteMarkOf, remoteMarkSuffix, remoteMarkTitle } from "../lib/remote-mark";
import { summaryLineOf, summaryTitleOf } from "../lib/summary-row";
import { cwdLabel, remotePlaceOf, type TargetInfo } from "../lib/remote-session";
import { recentCount, recentSessions } from "../lib/recent";
import { type CwdGroup, groupByActivity, groupByCreation } from "../lib/session-order";
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
import { dualGet, dualSet } from "../lib/storage-keys";
import { monogram, setSpine, spine } from "../lib/spine";
import { createHoldGesture } from "../lib/hold-select";
import {
  clearSelection,
  isSelected,
  isTextEntry,
  selectionBusy,
  pruneSelection,
  selectedPaths,
  selectionMode,
  startSelection,
  toggleSelection,
} from "../lib/session-selection";
import { folderActive, folderOpen, folderOpenKey, readFolderOpenRaw, storedFolderOpen, writeFolderOpenRaw } from "../lib/folder-open";
import { groupOpen as groupOpenRule, groupsRegionOpen as groupsRegionOpenRule } from "../lib/group-open";
import { activeAgentCounts, activeTeamCount, sessionWorking } from "../lib/workers";
import { ActionMenu } from "./ActionMenu";
import { ArchiveCleanup } from "./ArchiveCleanup";
import { SelectionToolbar } from "./SelectionToolbar";
import { ContextRing } from "./ContextRing";
import { groupHref } from "../lib/group-route";
import { GroupNameField } from "./Groups";
import { RemoteGroupDot } from "./RemoteStatus";
import { Banner, Chip, Icon } from "./ui";
import { showSummaries } from "../lib/summary-line";

const ARCHIVE_KEY = "sova:archive-open";
/** Pre-rebrand spellings: read and mirrored while the rename bridge is open (lib/storage-keys.ts). */
const LEGACY_ARCHIVE_KEY = "pi-web:archive-open";
/** One key per Archive date section, same "1"/"0" values as ARCHIVE_KEY. */
const archiveDateKey = (id: ArchiveGroupId) => `sova:archive-date-open-${id}`;
const legacyArchiveDateKey = (id: ArchiveGroupId) => `pi-web:archive-date-open-${id}`;

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
/** Which folder sections are open, keyed by `folderOpenKey` (region + folder). Module state for
    the same reason: the folder rules mint fresh folder objects on every poll, so every folder section
    in the list is rebuilt a few seconds after the user collapses one. */
const [openFolders, setOpenFolders] = createSignal<Record<string, boolean>>({});
/** The Groups head's `+` has opened the new-group name field. */
const [newGroupField, setNewGroupField] = createSignal(false);

/** Collapsed on every page load, and never persisted (`lib/group-open`): the module state above
    holds the user's choice for as long as the page lives, and a reload starts closed again. */
const groupOpen = (id: string) => groupOpenRule(openGroups()[id]);
const onGroupToggle = (id: string, e: Event & { currentTarget: HTMLDetailsElement }) => {
  const open = e.currentTarget.open;
  if (open === groupOpen(id)) return; // our own `open` update, not the user's
  setOpenGroups((m) => ({ ...m, [id]: open }));
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

/** The row's state clauses, appended to its link's name (and to a spine tile's), so both say the same. */
const TUI_CLAUSE = ", open in a TUI";
const BUSY_CLAUSE = ", pi is replying in this session";

/** Busy (§2): this tab's own run wins over the last fetched list; Live wins over both. */
const sessionBusy = (s: SessionSummary) => !s.live && !!(localRunning()[s.path] ?? s.busy);

/**
 * One session row: a wordless status rail on the left, then the link itself. The rail buttons are
 * out of the tab order on purpose (a long list must not add two tab stops per row), so the link
 * keeps the same state in its accessible name that the old right-hand chips exposed.
 */
function SessionRow(props: { session: SessionSummary; selected: string | null; now: number; targets: TargetInfo[] }) {
  const s = () => props.session;
  /** The row's own remote mark (§2 "Remote sessions"): one row answers for itself, never its
      group's first row. */
  const mark = () => remoteMarkOf(s());
  /** Line 2: the outline's gist (what the session is for), the now line only as a fallback. */
  const summaryText = () => summaryLineOf(s());
  const summaryTitle = () => summaryTitleOf(s());
  const markTitle = () => {
    const m = mark();
    return m ? remoteMarkTitle(m, props.targets.find((t) => t.name === m.place.target)?.host) : "";
  };
  const isBusy = () => sessionBusy(s());
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
  /**
   * Press-and-hold — a mouse button held down, a thumb held on the row — selects this session and
   * turns the sidebar into selection mode (§2 "Selecting several sessions"). The press is off the
   * moment it stops being a press in place: a drag, a scroll (the list moving under a still
   * finger is `pointercancel` on touch and a `scroll` event on a mouse wheel), or the row going
   * away. What the fired hold leaves behind — a `click`, and on touch a `contextmenu` — is
   * swallowed below, or the row would navigate on top of the selection it just made.
   */
  const hold = createHoldGesture({
    onHold: () => {
      startSelection(s().path);
      announce(`Selecting sessions. ${s().title} selected.`);
    },
  });
  const cancelHold = () => hold.cancel();
  /** A release anywhere ends this press, even one that happened over another element. */
  const finishHold = () => {
    hold.finish();
    watchPress(false);
  };
  /**
   * Only while a press is in flight: one set of listeners per PRESSED row, never one per row on
   * screen. A scroll under the pointer moves the row out from under it; a window blur (an alt-tab,
   * a native drag taking over, an OS menu) means the pointerup may never arrive at all; and the
   * pointerup itself is watched on the window because a press that wandered off the row still has
   * to END — a press left "down" forever would suppress every later click on this row.
   */
  const watchPress = (on: boolean) => {
    if (on) {
      addEventListener("scroll", cancelHold, true);
      addEventListener("blur", cancelHold);
      addEventListener("pointerup", finishHold, true);
      addEventListener("pointercancel", cancelHold, true);
    } else {
      removeEventListener("scroll", cancelHold, true);
      removeEventListener("blur", cancelHold);
      removeEventListener("pointerup", finishHold, true);
      removeEventListener("pointercancel", cancelHold, true);
    }
  };
  /** Every way a press stops being ours, in one place. */
  const endPress = () => {
    hold.cancel();
    watchPress(false);
  };
  onCleanup(endPress);
  /** The rail's own controls (the state pills, the checkbox) are pressed, not held. */
  const onOwnControl = (e: PointerEvent) => e.target instanceof Element && !!e.target.closest("button, input, label");
  const selecting = () => selectionMode();
  const chosen = () => isSelected(s().path);

  return (
    <li
      class="session-row-shell"
      classList={{
        "session-row-shell-current": props.selected === s().path,
        "session-row-dragging": dragging()?.path === s().path,
        "session-row-shell-selecting": selecting(),
        "session-row-shell-selected": selecting() && chosen(),
      }}
      // The row itself is the drag source (the link inside is not: a browser drags links natively,
      // and that drag carries a URL, not a session). §2 "Groups": drag a row onto a group section.
      // In selection mode there is no drag at all: a press there is a hold or a toggle.
      draggable={selecting() ? "false" : "true"}
      onDragStart={(e) => {
        // A native drag can start before the pointer has moved the tolerance — the browser's own
        // threshold is smaller, and on some platforms a drag begins with no pointermove at all.
        // Once it has, this press is a drag: it must not also become a hold mid-flight.
        endPress();
        setGroupDragData(e, s().path);
        setDragging({ path: s().path, groupId: s().groupId ?? null });
      }}
      onDragEnd={() => {
        setDragging(null);
        setDropTarget(null);
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return; // right-click is not a hold
        if (onOwnControl(e)) return;
        hold.start({ x: e.clientX, y: e.clientY });
        watchPress(true);
      }}
      onPointerMove={(e) => hold.move({ x: e.clientX, y: e.clientY })}
      onPointerUp={() => {
        hold.finish();
        watchPress(false);
      }}
      onPointerCancel={endPress}
      // The pointer left this row before the hold fired — a slide off the row, or the list moving
      // under it — so this press is not a selection. AFTER the hold has fired, leaving means
      // nothing: the gesture is done, and the release (watched on the window) is what ends it.
      onPointerLeave={() => !hold.held() && endPress()}
      // Capture went to someone else (a native drag, a scrollbar, another element grabbing it),
      // so the pointerup belonging to this press will never arrive.
      onLostPointerCapture={endPress}
      // The long-press context menu belongs to the hold, not to the browser.
      onContextMenu={(e) => hold.suppressed() && e.preventDefault()}
    >
      <div class="session-rail">
        {/* The rail is where a row's state lives, so it is where the row is picked too: one 44px
            checkbox at the top of it, in selection mode only. Every copy of this row — Recent, a
            group, Live & web — reads the same selection, so all of them check together. */}
        <Show when={selecting()}>
          <label class="toggle session-select">
            <input
              type="checkbox"
              checked={chosen()}
              aria-label={`Select ${s().title}`}
              // An action in flight owns the selection it started with; the box says so rather
              // than silently ignoring the press (the store refuses it either way).
              disabled={selectionBusy()}
              onChange={() => toggleSelection(s().path)}
            />
            <span class="toggle-box" />
          </label>
        </Show>
        {/* At most one state: live wins over busy. TUI is a static word; Busy is a pulsing dot. */}
        <Show when={s().live}>
          <button
            type="button"
            tabindex="-1"
            class="session-rail-item session-rail-state session-rail-tui chip chip-accent"
            aria-label={`Open in a TUI. Pid ${s().live!.pid}, status ${s().live!.status}.`}
            title={tuiTitle()}
            onClick={() => toast(tuiTitle())}
          >
            TUI
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
        onClick={(e) => {
          // The hold already acted on this row; its click is the gesture's echo, not a choice.
          if (hold.suppressed()) {
            e.preventDefault();
            return;
          }
          // In selection mode a row is picked, not opened. Outside it, a click is a click.
          if (!selecting()) return;
          e.preventDefault();
          toggleSelection(s().path);
        }}
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
          {/* The summary row says what the session is FOR (the outline's gist), not what the agent
              just did: the row truncates after a few words, and "Committed dc63576…" tells a reader
              nothing about which session this is. Older snapshots carry no gist — those still show
              the "now" line rather than nothing, and the tooltip always has both. */}
          {/* Settings → General can hide it; the chip goes with it, the draft preview above stays. */}
          <Show when={showSummaries() && !s().draftPreview && summaryText()}>
            <div class="list-line list-summary-row">
              <p class="list-summary" title={summaryTitle()}>{summaryText()}</p>
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
            <Show when={mark()}>
              {(m) => (
                <span
                  class="text-muted"
                  style={{ display: "inline-flex", "align-items": "center", gap: "3px", flex: "none" }}
                  title={markTitle()}
                >
                  {/* One dot: this runs on another host. Never a pulse, never the rail — the live
                      dot's home is the pill. */}
                  <span class="chip-dot" style={{ width: "6px", height: "6px" }} />
                </span>
              )}
            </Show>
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
          <span class="visually-hidden">{TUI_CLAUSE}</span>
        </Show>
        <Show when={isBusy()}>
          <span class="visually-hidden">{BUSY_CLAUSE}</span>
        </Show>
        <Show when={working()}>{(n) => <span class="visually-hidden">, {workingNow(n())}</span>}</Show>
        {/* Remote-ness is a fact a row is picked by, so it rides the link's name — the same deal the
            rail's state gets, and the one the topic chip and the ring deliberately don't. */}
        <Show when={mark()}>{(m) => <span class="visually-hidden">{remoteMarkSuffix(m())}</span>}</Show>
      </a>
    </li>
  );
}

/** Sessions grouped by folder: the markup of spec/02-session-list.md §2 "Anatomy". The ORDER is the
    caller's — `groupByCreation` for Live & web, `groupByActivity` for the Archive and for a group
    (src/lib/session-order.ts) — so this component never decides what "newest" means.
    `level` is the heading level a folder label takes: h3 directly under a region, h4 inside a
    group, where the group's own label already sits at h3. Every folder collapses (§2 "Folder
    open/closed state"), so `searching` — which forces every one of them open — comes in too. */
function GroupList(props: {
  groups: CwdGroup[];
  selected: string | null;
  now: number;
  idPrefix: string;
  targets: TargetInfo[];
  searching: boolean;
  level?: 4;
}) {
  return (
    <For each={props.groups}>
      {(group, gi) => {
        // The label's remote form is the group's only while every row runs at one target and folder
        // (§2 "Remote sessions"): a mixed group keeps the plain folder label and its rows' marks speak.
        const remote = groupRemotePlaceOf(group.sessions, group.cwd);
        const host = () => (remote ? props.targets.find((t) => t.name === remote.target)?.host : undefined);
        const label = (name: string) => props.targets.find((t) => t.name === name)?.label || name;
        // Open/closed per region + folder, remembered for the browser session. The folder object
        // is rebuilt on every poll, so the choice lives in module state and sessionStorage, never
        // in this component.
        const key = folderOpenKey(props.idPrefix, group.cwd);
        const open = () =>
          folderOpen({
            stored: openFolders()[key] ?? storedFolderOpen(readFolderOpenRaw(props.idPrefix, group.cwd)),
            searching: props.searching,
          });
        // Folders start collapsed, so one holding an agent at work says so on its own head.
        const active = () => folderActive(group.sessions, localRunning());
        const onFolderToggle = (e: Event & { currentTarget: HTMLDetailsElement }) => {
          const now = e.currentTarget.open;
          if (now === open()) return; // our own `open` update, not the user's
          setOpenFolders((m) => ({ ...m, [key]: now }));
          writeFolderOpenRaw(props.idPrefix, group.cwd, now);
        };
        return (
          <details class="session-group" aria-labelledby={`${props.idPrefix}-${gi()}`} open={open()} onToggle={onFolderToggle}>
            {/* The heading stays a heading, and keeps its level: the <summary> is what toggles, the
                heading inside it is what the outline and `aria-labelledby` read. */}
            <summary class="session-group-head">
              <Dynamic
                component={props.level === 4 ? "h4" : "h3"}
                class="list-group-label"
                id={`${props.idPrefix}-${gi()}`}
                title={remote ? `${remote.target}${host() ? ` (${host()})` : ""}:${remote.remoteCwd}` : group.cwd}
              >
                <Icon name="chevron-right" small class="icon-twist" />
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
                <Show when={active()}>
                  <span class="session-group-active" title="An agent is working in this folder">
                    <span class="session-rail-dot" />
                    <span class="visually-hidden">, an agent is working here</span>
                  </span>
                </Show>
                <span class="text-num">{group.sessions.length}</span>
              </Dynamic>
            </summary>
            <ul class="list">
              <For each={group.sessions}>
                {(s) => <SessionRow session={s} selected={props.selected} now={props.now} targets={props.targets} />}
              </For>
            </ul>
          </details>
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
  /** A search is on, so the folder sections inside are forced open with every other region's. */
  searching: boolean;
  onChanged(): void;
}) {
  const group = () => props.group;
  const count = () => props.sessions.length;
  const over = () => dropTarget() === group().id;

  /** The confirm question, one sentence, in both its forms: what goes away, then what doesn't. */
  const question = () =>
    count() === 0
      ? `Delete ${quoted(group().name)}? Nothing is in it.`
      : `Delete ${quoted(group().name)}? Its ${sessionsWord(count())} stay${count() === 1 ? "s" : ""} in the list.`;

  const deleteGroup = async () => {
    const n = count();
    const name = group().name;
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
      {/* No folder icon here, unlike the cwd heads inside: a group is the user's own name for a set
          of sessions, not a folder on disk, and the icon claimed otherwise right above real ones. */}
      <summary class="list-group-label group-label" title={group().name}>
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="group-name">
          <bdi>{group().name}</bdi>
        </span>
        <span class="text-num">{count()}</span>
        {/* The group's own actions, on its own name row. `contain` is what makes a control inside a
            <summary> possible at all: without it every click in here would toggle the section. The
            trigger is quiet until the row is hovered or something in it takes focus (base.css), and
            always visible to the keyboard. */}
        <ActionMenu label={`Group actions · ${group().name}`} title="Group actions" class="group-actions" contain>
          {(menu) => (
            <Show
              when={menu.screen()}
              fallback={
                <div class="model-menu-list" role="menu" aria-label={`Group actions · ${group().name}`}>
                  {/* The workspace: every session of this group on screen at once (#/g/<id>).
                      Purely additive — the rows above still open one session at a time. */}
                  <menu.Item
                    label="Open workspace"
                    aria={`Open ${quoted(group().name)} as a workspace`}
                    title={`Open ${quoted(group().name)} as a workspace`}
                    icon={<Icon name="external" small />}
                    href={groupHref(group().id)}
                    disabled={count() === 0 ? "Nothing is in it yet. Drag a session here first." : ""}
                  />
                  <menu.Item
                    label="Rename…"
                    aria={`Rename ${quoted(group().name)}`}
                    icon={<Icon name="pencil" small />}
                    stayOpen
                    onRun={() => menu.show("rename")}
                  />
                  <menu.Item
                    label="Delete group…"
                    aria={`Delete ${quoted(group().name)}`}
                    icon={<Icon name="close" small />}
                    stayOpen
                    onRun={() => menu.show("delete")}
                  />
                </div>
              }
            >
              {/* The menu's second screen: one question at a time, in the menu the press came from,
                  so nothing moves in the list below while it is answered. */}
              <Show
                when={menu.screen() === "delete"}
                fallback={
                  <div class="group-menu-screen">
                    <GroupNameField
                      label={`Rename ${quoted(group().name)}`}
                      initial={group().name}
                      onDone={(name) => {
                        menu.dismiss();
                        if (name !== group().name) void renameGroup(group().id, name);
                      }}
                      onCancel={() => menu.dismiss()}
                    />
                  </div>
                }
              >
                <div class="group-menu-screen">
                  <p class="group-tools-question">{question()}</p>
                  <div class="cluster">
                    <button
                      type="button"
                      class="button button-sm button-destructive"
                      onClick={() => menu.run(() => void deleteGroup())}
                    >
                      Delete group
                    </button>
                    <button type="button" class="button button-sm button-ghost" onClick={() => menu.dismiss()}>
                      Cancel
                    </button>
                  </div>
                </div>
              </Show>
            </Show>
          )}
        </ActionMenu>
      </summary>
      <Show when={count() > 0} fallback={<p class="sidebar-region-note">No sessions yet. Drag one here.</p>}>
        <GroupList
          groups={groupByActivity(props.sessions)}
          selected={props.selected}
          now={props.now}
          idPrefix={`g-${group().id}`}
          targets={props.targets}
          searching={props.searching}
          level={4}
        />
      </Show>
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

/** A spine tile's title and accessible name: "{title} · {folder} · {model}", then the clauses the
    row's own link carries, verbatim, so the two surfaces can't drift. */
function tileLabel(s: SessionSummary): string {
  const head = [s.title, cwdLabel(s, home()), s.model ? shortModel(s.model) : ""].filter(Boolean).join(" · ");
  const working = sessionWorking(s);
  const mark = remoteMarkOf(s);
  return (
    head +
    (s.live ? TUI_CLAUSE : "") +
    (sessionBusy(s) ? BUSY_CLAUSE : "") +
    (working ? `, ${workingNow(working)}` : "") +
    (mark ? remoteMarkSuffix(mark) : "")
  );
}

/** The one dot a tile carries, if any: the rail's order, live over busy over working. */
function tileDot(s: SessionSummary): "live" | "busy" | "working" | null {
  if (s.live) return "live";
  if (sessionBusy(s)) return "busy";
  return sessionWorking(s) ? "working" : null;
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
  /** Opens the Settings dialog from the foot's gear. */
  onOpenSettings(): void;
  /** The viewport is ≥768px: the only width where the pane can collapse to the spine. */
  unfolded: boolean;
}) {
  const [query, setQuery] = createSignal("");
  const [showSkeleton, setShowSkeleton] = createSignal(false);
  const skeletonTimer = setTimeout(() => setShowSkeleton(true), 300);
  let search!: HTMLInputElement;
  let aside!: HTMLElement;
  // The tab's copy of the group list: the pane's region and the session pane's menu share it.
  onMount(() => void loadSessionGroups());

  /** The pane as the spine on screen: the stored choice, where the viewport allows it. */
  const collapsed = () => spine() && props.unfolded;
  /** Each state's own toggle. The one pressed is unmounted by the swap, so focus would fall to
      <body>: it moves to the toggle of the new state instead, when it was in the pane at all. */
  let collapseToggle: HTMLButtonElement | undefined;
  let expandToggle: HTMLButtonElement | undefined;
  const setCollapsed = (on: boolean, refocus = true) => {
    if (on === spine()) return;
    const hadFocus = aside.contains(document.activeElement);
    setSpine(on);
    announce(on ? "Sessions pane collapsed." : "Sessions pane expanded.");
    if (refocus && hadFocus) queueMicrotask(() => (on ? expandToggle : collapseToggle)?.focus());
  };
  /** The spine's Search, and "/" while collapsed: open the pane and put the cursor in the field. */
  const expandToSearch = () => {
    setCollapsed(false, false);
    queueMicrotask(() => search.focus());
  };

  // "/" anywhere outside a text field focuses search; Escape leaves selection mode; Ctrl/⌘+B
  // collapses or expands the pane.
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
      if (!props.unfolded) return; // collapse is a desktop affordance
      e.preventDefault();
      setCollapsed(!spine());
      return;
    }
    const t = e.target as HTMLInputElement | null;
    // Typing, not merely focused on a control: a row's checkbox is an <input> too, and Escape on
    // one has to leave selection mode like Escape anywhere else (src/lib/session-selection.ts).
    const inText = isTextEntry(t);
    // Escape is the way OUT of selection mode, on every keyboard, with no control to find first.
    // Not while a field has focus: there Escape belongs to the field (search clears, rename cancels).
    if (e.key === "Escape" && selectionMode() && !inText) {
      e.preventDefault();
      // Not while an action is running: leaving the mode under a run in flight is what let a
      // finished run put its leftovers back over a selection that had moved on.
      if (selectionBusy()) {
        announce("Something is still running. It'll be a moment.");
        return;
      }
      clearSelection();
      announce("Selection off.");
      return;
    }
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (inText) return;
    e.preventDefault();
    if (collapsed()) expandToSearch();
    else search.focus();
  };
  document.addEventListener("keydown", onKey);
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    clearTimeout(skeletonTimer);
  });

  /** Main threads only (src/lib/regions.ts): every region, search hit and count reads this. */
  const all = createMemo(() => (props.sessions ?? []).filter(isMainThread));
  /**
   * The selection lives in module state and is keyed by PATH, so a background poll can neither
   * reset it nor unpick a row whose object was rebuilt. The one thing a poll may change about it:
   * a session that is no longer in the list is no longer selected. `undefined` is a fetch in
   * flight, not an empty list — pruning against that would clear everything every few seconds.
   * Pruned against the UNFILTERED list: a worker session is still in the list, just not drawn.
   */
  createEffect(() => {
    const list = props.sessions;
    if (!list) return;
    pruneSelection(list.map((s) => s.path));
  });
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
  const topGroups = createMemo(() => groupByCreation(topHits()));
  /**
   * Recent (§2 "Recent"): the handful of sessions that moved last, said once more at the very top.
   * Purely additive, like a group — every row here is still in Live & web or the Archive below —
   * and built from `hits()`, so it narrows with the search and can never carry a row the rest of
   * the sidebar is hiding. How many rows is `recentCount()`, and §12's General tab is the only
   * place that writes it: this region has no controls of its own.
   */
  const recent = createMemo(() => recentSessions(hits(), recentCount()));
  // The Archive splits by date first (Today … Older), then by cwd inside each date section.
  const archiveSections = createMemo(() => {
    const sorted = [...archiveHits()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    return groupByArchiveDate(sorted, new Date(props.now)).map((d) => ({ ...d, groups: groupByActivity(d.items) }));
  });
  const archiveTotal = () => all().filter((s) => !isTop(s)).length;
  /**
   * Whether each region is on screen right now — ONE rule, read by the region's own `<Show>` and
   * by the spine's count button, which is that region's door. Deriving the spine's boxes from
   * anything else (a total, say) puts a door on the rail that opens onto nothing: under a search
   * with no hits the Archive's total is still 321 while the region itself is gone.
   */
  const showTop = () => !!props.sessions && all().length > 0 && (topHits().length > 0 || !query().trim());
  const showArchive = () => archiveHits().length > 0;

  // Groups (§2 "Groups"): the user's own sections, above every region. They cut across regions — a
  // group can hold a TUI-live session and an archived one — so they read the whole search-hit list,
  // not one region's slice.
  const searching = () => !!query().trim();
  const sections = createMemo(() => groupSections(hits(), sessionGroups(), searching()));
  /** A group's rows, from the same hit list the sections were built from. */
  const rowsOf = (id: string) => hits().filter((s) => s.groupId === id);
  /** With no query the region always stands: its head carries the `+` that makes a group, the
      feature's front door. While searching it appears only when a group has a match — or when a row is in flight
      and needs its "Remove from …" target, which a fruitless search would otherwise hide. */
  const groupsShown = () => !searching() || sections().length > 0 || !!dragging()?.groupId;

  /** The Groups region's own twist. Collapsed on every load and memory-only — unlike the Archive
      there is no stored choice to read, so nothing a past visit did can open it (§2 "Groups"). It
      is component state, not module state: the region is one node that outlives every poll. */
  const [groupsChosen, setGroupsChosen] = createSignal<boolean | undefined>(undefined);
  /** Forced open, without touching the choice, while a search is on (a matching group must not
      hide its hits), while a grouped row is in flight (its drop targets live in here), or while the
      new-group field is showing (it lives in here too, and the `+` can be pressed on a shut region). */
  const groupsRegionOpen = () =>
    groupsRegionOpenRule({
      chosen: groupsChosen(),
      searching: searching(),
      draggingGrouped: !!dragging()?.groupId,
      composing: newGroupField(),
    });
  const onGroupsRegionToggle = (e: Event & { currentTarget: HTMLDetailsElement }) => {
    const open = e.currentTarget.open;
    if (open === groupsRegionOpen()) return; // our own `open` update, not the user's
    setGroupsChosen(open);
  };

  /** The head's `+`. Held so the field can hand focus back to it: the field unmounts when it
      closes, and without this the caret would drop to <body>. */
  let newGroupToggle: HTMLButtonElement | undefined;
  /** Every way the new-group field closes — saved, cancelled, Escape, an empty blur — ends here.
      Focus goes back to the `+` only if it would otherwise be lost: a blur that saved because the
      user clicked or tabbed to something focusable has already put the caret where they wanted it.
      Checked a frame later, when that move (or the fall to <body>) has landed. */
  const closeNewGroup = () => {
    setNewGroupField(false);
    requestAnimationFrame(() => {
      const at = document.activeElement;
      if (!at || at === document.body || !at.isConnected) newGroupToggle?.focus();
    });
  };

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
  const [storedOpen, setStoredOpen] = createSignal(dualGet(sessionStorage, ARCHIVE_KEY, LEGACY_ARCHIVE_KEY) === "1");
  /** Forced open while searching, when the top is empty, or when the open session is archived. */
  const forcedOpen = () =>
    !!query().trim() || topHits().length === 0 || archiveHits().some((s) => s.path === props.selected);
  const archiveOpen = () => forcedOpen() || storedOpen();
  const onArchiveToggle = (e: Event & { currentTarget: HTMLDetailsElement }) => {
    const open = e.currentTarget.open;
    if (open === archiveOpen()) return; // our own `open` update, not the user's
    setStoredOpen(open);
    dualSet(sessionStorage, ARCHIVE_KEY, LEGACY_ARCHIVE_KEY, open ? "1" : "0");
  };
  // Date sections: collapsed by default, each remembering its own choice the same way.
  const [storedDateOpen, setStoredDateOpen] = createSignal<Partial<Record<ArchiveGroupId, boolean>>>({});
  const dateStored = (id: ArchiveGroupId) => storedDateOpen()[id] ?? dualGet(sessionStorage, archiveDateKey(id), legacyArchiveDateKey(id)) === "1";
  /** Forced open while searching, or when it holds the open session. */
  const dateOpen = (d: { id: ArchiveGroupId; items: SessionSummary[] }) =>
    !!query().trim() || d.items.some((s) => s.path === props.selected) || dateStored(d.id);
  const onDateToggle = (d: { id: ArchiveGroupId; items: SessionSummary[] }, e: Event & { currentTarget: HTMLDetailsElement }) => {
    const open = e.currentTarget.open;
    if (open === dateOpen(d)) return; // our own `open` update, not the user's
    setStoredDateOpen((m) => ({ ...m, [d.id]: open }));
    dualSet(sessionStorage, archiveDateKey(d.id), legacyArchiveDateKey(d.id), open ? "1" : "0");
  };
  const liveCount = () => all().filter((s) => s.live).length;
  const glance = createMemo(() => usageGlance(props.usage));
  /** The foot's usage glance in full words, for its tooltip and accessible name. */
  const glanceText = () => (glance().length ? `Usage: ${glance().map((p) => p.full).join(", ")}` : "");

  const clear = () => {
    setQuery("");
    search.focus();
  };

  /** A region count on the spine: open the pane and bring that region into view. The Archive is
      scrolled to, never forced open — its open state is the user's stored choice. */
  const expandToRegion = (find: () => HTMLElement | null | undefined, focus: (el: HTMLElement) => HTMLElement | null | undefined) => {
    setCollapsed(false, false);
    queueMicrotask(() => {
      const el = find();
      el?.scrollIntoView({ block: "start" });
      // The pressed item is gone with the spine: focus goes into the region, else to the toggle.
      const target = el ? focus(el) : null;
      if (target) target.focus({ preventScroll: true });
      else collapseToggle?.focus();
    });
  };
  const agentsWorking = () => activeAgentCounts(props.agents).agents;
  const tuiSentence = () => `${liveCount()} ${liveCount() === 1 ? "session" : "sessions"} open in a TUI`;

  /**
   * The collapsed pane: one 44px item per action the expanded pane offers, reading the same memos,
   * so a count can't disagree with the list it stands for. Wordless, so every item carries its
   * sentence as a title and an accessible name.
   */
  const Spine = () => {
    let tiles!: HTMLElement;
    // The open session's tile, if it is among the recent ones, starts in view.
    onMount(() => tiles.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest" }));
    return (
      <div class="spine">
        <div class="spine-head">
          <button
            ref={expandToggle}
            type="button"
            class="button button-icon spine-item"
            aria-expanded="false"
            title="Expand sessions pane · Ctrl/⌘+B"
            aria-label="Expand sessions pane"
            onClick={() => setCollapsed(false)}
          >
            <Icon name="panel-expand" />
          </button>
          <button type="button" class="button button-icon spine-item" title="New Session" aria-label="New Session" onClick={() => props.onNew()}>
            <Icon name="plus" />
          </button>
          <button type="button" class="button button-icon spine-item" title="Search sessions · /" aria-label="Search sessions" onClick={expandToSearch}>
            <Icon name="search" />
          </button>
        </div>

        <nav ref={tiles} class="spine-tiles pane" aria-label="Recent sessions">
          <For each={recent()}>
            {(s) => {
              const label = () => tileLabel(s);
              const dot = () => tileDot(s);
              return (
                <a
                  class="spine-tile"
                  href={sessionHref(s.path)}
                  aria-current={props.selected === s.path ? "page" : undefined}
                  title={label()}
                  aria-label={label()}
                >
                  <Show when={monogram(s.title)} fallback={<Icon name="chat" />}>
                    {(m) => (
                      <span class="spine-monogram" aria-hidden="true">
                        {m()}
                      </span>
                    )}
                  </Show>
                  <Show when={dot()}>{(d) => <span class={`spine-dot spine-dot-${d()}`} aria-hidden="true" />}</Show>
                </a>
              );
            }}
          </For>
        </nav>

        {/* Each count is a door into its region, so a 0 is no door at all: the section it would
            scroll to is not on screen. Both at 0, the box goes with them — an empty one would
            still draw its divider. */}
        <Show when={showTop() || showArchive()}>
          <div class="spine-regions">
            <Show when={showTop()}>
              <button
                type="button"
                class="button button-icon spine-item spine-region"
                title={`Live & web · ${sessionsWord(topHits().length)}`}
                aria-label={`Live & web · ${sessionsWord(topHits().length)}`}
                onClick={() =>
                  expandToRegion(
                    () => document.getElementById("r-top")?.closest("section"),
                    (el) => el.querySelector<HTMLElement>("summary, a"),
                  )
                }
              >
                <Icon name="chat" />
                <span class="spine-count text-num">{topHits().length}</span>
              </button>
            </Show>
            <Show when={showArchive()}>
              <button
                type="button"
                class="button button-icon spine-item spine-region"
                title={`Archive · ${sessionsWord(archiveHits().length)}`}
                aria-label={`Archive · ${sessionsWord(archiveHits().length)}`}
                onClick={() =>
                  expandToRegion(
                    () => aside.querySelector<HTMLElement>(".sidebar-archive > summary"),
                    (el) => el,
                  )
                }
              >
                <Icon name="archive" />
                <span class="spine-count text-num">{archiveHits().length}</span>
              </button>
            </Show>
          </div>
        </Show>

        {/* Status, not navigation: each says its sentence as a toast, and never opens the pane. */}
        <Show when={agentsWorking() > 0 || liveCount() > 0}>
          <div class="spine-stats">
            <Show when={agentsWorking() > 0}>
              <button
                type="button"
                class="button button-icon spine-item spine-stat"
                title={workingNow(agentsWorking())}
                aria-label={workingNow(agentsWorking())}
                onClick={() => toast(workingNow(agentsWorking()))}
              >
                <Icon name="worker" />
                <span class="spine-count text-num">{agentsWorking()}</span>
              </button>
            </Show>
            <Show when={liveCount() > 0}>
              <button type="button" class="button button-icon spine-item spine-stat" title={tuiSentence()} aria-label={tuiSentence()} onClick={() => toast(tuiSentence())}>
                <Icon name="terminal" />
                <span class="spine-count text-num">{liveCount()}</span>
              </button>
            </Show>
          </div>
        </Show>

        <div class="spine-foot">
          <a
            class="button button-icon spine-item"
            href={usageHref()}
            aria-current={props.insightsPage === "usage" ? "page" : undefined}
            title={glanceText() || "Usage"}
            aria-label={glanceText() || "Usage"}
          >
            <Icon name="gauge" />
          </a>
          <a
            class="button button-icon spine-item"
            href={agentsHref()}
            aria-current={props.insightsPage === "agents" ? "page" : undefined}
            title={agentsSentence(props.agents) ?? "Agents"}
            aria-label={agentsSentence(props.agents) ?? "Agents"}
          >
            <Icon name="worker" />
          </a>
          <button type="button" class="button button-icon spine-item" title="Settings" aria-label="Settings" onClick={() => props.onOpenSettings()}>
            <Icon name="settings" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <aside ref={aside} class="app-sidebar" aria-label="Sessions">
      {/* Collapsed, the pane's own body is not in the DOM at all — nothing hidden-but-readable. */}
      <Show when={!collapsed()} fallback={<Spine />}>
        <div class="sidebar-head">
          <a class="brand" href="#/">
            <span class="icon" style={{ "--icon": "url(/icons/sova-mark.svg)" }} aria-hidden="true" />
            sova
          </a>
          <span class="sidebar-spacer" />
          <button type="button" class="button" onClick={() => props.onNew()}>
            <Icon name="plus" />
            New Session
          </button>
          <Show when={props.unfolded}>
            <button
              ref={collapseToggle}
              type="button"
              class="button button-icon sidebar-spine-toggle"
              aria-expanded="true"
              title="Collapse sessions pane · Ctrl/⌘+B"
              aria-label="Collapse sessions pane"
              onClick={() => setCollapsed(true)}
            >
              <Icon name="panel-collapse" />
            </button>
          </Show>
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
            {/* The keyboard's (and the unsure pointer's) door into selection mode: press-and-hold is
                the accelerator, never the only way in (§2 "Selecting several sessions"). */}
            <Show when={props.sessions && all().length > 0 && !selectionMode()}>
              <button
                type="button"
                class="button button-sm button-ghost sidebar-select-start"
                title="Select several sessions to rename, group or archive them"
                onClick={() => {
                  startSelection();
                  announce("Selecting sessions. Pick rows with their checkboxes.");
                }}
              >
                <Icon name="check" small />
                Select
              </button>
            </Show>
          </div>
        </div>

        {/* Inside the sidebar, above the list: the rows it acts on stay on screen, on a phone too. */}
        <Show when={selectionMode()}>
          <SelectionToolbar sessions={all()} onRefresh={props.onRefresh} />
        </Show>

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

          {/* Recent (§2 "Recent"), above everything: a flat list, no folder sections — with 5 rows a
              folder head per row would be the region. It is a shortcut, not a place a session lives,
              so every row appears again in Live & web or the Archive below, and the region carries
              no controls: the count is Settings › General's, and only its. */}
          <Show when={props.sessions && recent().length > 0}>
            <section class="sidebar-region sidebar-recent" aria-labelledby="r-recent">
              <h2 class="sidebar-region-head" id="r-recent" title={`The ${recent().length} sessions that moved last. Change how many in Settings, under General.`}>
                Recent <span class="sidebar-region-count">· {recent().length}</span>
              </h2>
              <ul class="list">
                <For each={recent()}>
                  {(s) => <SessionRow session={s} selected={props.selected} now={props.now} targets={targets()} />}
                </For>
              </ul>
            </section>
          </Show>

          {/* The user's own groups, above every region (§2 "Groups"): the same rows and folder
              groups as below, plus the two controls that make a group and name it. */}
          <Show when={groupsShown()}>
            <details class="sidebar-region sidebar-groups" aria-labelledby="r-groups" open={groupsRegionOpen()} onToggle={onGroupsRegionToggle}>
              {/* The heading stays a heading, and keeps its level (the folder-head pattern): the
                  <summary> is what toggles, the <h2> inside it is what the outline and
                  `aria-labelledby` read. The Archive's head is a bare <summary>; this region has to
                  keep its `r-groups` heading, which every region above and below it has too. */}
              <summary class="sidebar-groups-summary">
                <h2 class="sidebar-region-head" id="r-groups">
                  <Icon name="chevron-right" small class="icon-twist" />
                  Groups{" "}
                  <span class="sidebar-region-count">
                    · {searching() ? `${sections().length} of ${sessionGroups().length}` : sessionGroups().length}
                  </span>
                  {/* Making a group is the region's one action, a `+` at the head's right end.
                      Not while searching: the field it opens is hidden then, and a fruitless search
                      hides the whole region. Its click and keydown stop here, as the group head's
                      `⋯` does, so a press is never read as a press on the summary. Fanout is NOT
                      here — it is a creation gesture, not a curation one, and its front door is the
                      welcome screen beside New Session (§14b "Entry points"). */}
                  <Show when={!searching()}>
                    <button
                      ref={newGroupToggle}
                      type="button"
                      class="button button-icon button-ghost group-new-toggle"
                      aria-label="New group"
                      title="New group"
                      onClick={(e) => {
                        e.stopPropagation();
                        setNewGroupField(true);
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Icon name="plus" small />
                    </button>
                  </Show>
                </h2>
              </summary>
              {/* The field opens where the region's rows start, forcing the region open while it
                  shows (lib/group-open), and hands focus back to the `+` when it closes. */}
              <Show when={!searching() && newGroupField()}>
                <div class="group-field-row">
                  <GroupNameField
                    label="New group name"
                    onDone={(name) => {
                      closeNewGroup();
                      void createGroup(name);
                    }}
                    onCancel={closeNewGroup}
                  />
                </div>
              </Show>
              <Show when={!searching() && sessionGroups().length === 0}>
                <p class="sidebar-region-note">No groups yet. Make one, then drag a session into it.</p>
              </Show>
              <For each={sections().map((s) => s.group)}>
                {(group) => (
                  <GroupBlock group={group} sessions={rowsOf(group.id)} selected={props.selected} now={props.now} targets={targets()} searching={searching()} onChanged={props.onRefresh} />
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
            </details>
          </Show>

          {/* Hidden when a search empties it; kept with a note when there's simply nothing on top. */}
          <Show when={showTop()}>
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
                <GroupList groups={topGroups()} selected={props.selected} now={props.now} idPrefix="t" targets={targets()} searching={searching()} />
              </Show>
            </section>
          </Show>

          <Show when={showArchive()}>
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
                    <GroupList groups={d.groups} selected={props.selected} now={props.now} idPrefix={`a-${d.id}`} targets={targets()} searching={searching()} />
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
          <div class="sidebar-foot-row">
            <a
              class="list-row list-row-interactive insights-row sidebar-foot-link"
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
            <button
              type="button"
              class="button button-icon sidebar-settings"
              title="Settings"
              aria-label="Settings"
              onClick={() => props.onOpenSettings()}
            >
              <Icon name="settings" small />
            </button>
          </div>
        </div>
      </Show>
    </aside>
  );
}
