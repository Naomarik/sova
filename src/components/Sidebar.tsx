import { ProfileShelf } from "./ProfileShelf";
import { profileIconName } from "../lib/profiles";
import { createEffect, createMemo, createResource, createSignal, For, type JSX, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import type { AgentsInsight, AttentionDigest, ContextInfo, OverseerInfo, SessionGroup, SessionSummary, UsageInsight } from "../../shared/protocol";
import { OVERSEER_HASH, overseerButtonLabel } from "../lib/overseer";
import { openOverview } from "../lib/overview-route";
import { autoTitleSessions, fetchTargets, sessionsDir as fetchSessionsDir, setSessionArchived } from "../lib/api";
import { nameableRows, nameLabel, nameSessions, namingIn, setNaming } from "../lib/auto-title";
import { type ArchiveGroupId, groupByArchiveDate, sessionsWord, startOfDay } from "../lib/archive";
import { relativeTime, shortModel, tildePath } from "../lib/format";
import { agentsHref, type GlancePart, usageGlance, usageHref } from "../lib/insights";
import { isMainThread, isOrdinarySession, isOrgSession, isTopSession } from "../lib/regions";
import {
  eyeLabel,
  doneOpen as doneOpenRule,
  isClearedOverseer,
  overseerEye,
  regionCount,
  rowLine,
  orgCount,
  orgNeedsYouRows,
  orgProjectItems,
  orgPlaceLabel,
  orgRows,
  ORGS_KEY,
  orgSearchText,
  orgSectionOpen as orgSectionOpenRule,
  orgSections,
  orgsRegionOpen as orgsRegionOpenRule,
  orgTitle,
  type OrgProject,
  type OrgSection,
  projectCount,
  storedOrgsOpen,
} from "../lib/org-region";
import { groupRemotePlaceOf, remoteMarkOf, remoteMarkSuffix, remoteMarkTitle } from "../lib/remote-mark";
import { summaryLineOf, summaryTitleOf } from "../lib/summary-row";
import { archiveDragOf, archivedDropToast, blockedDropSentence, orgProjectOf, unarchivedToast } from "../lib/drag-archive";
import { cwdLabel, remotePlaceOf, type TargetInfo } from "../lib/remote-session";
import { recentCount, recentSessions } from "../lib/recent";
import { NEEDS_YOU_KEY, needsYouCut, needsYouOpen as needsYouOpenRule, needsYouRows, needsYouShown, needsYouTitle, storedNeedsYouOpen } from "../lib/needs-you";
import { type CwdGroup, groupByActivity, groupByCreation } from "../lib/session-order";
import {
  createGroup,
  groupNameOf,
  groupSections,
  loadSessionGroups,
  quoted,
  removeGroup,
  renameGroup,
  sessionGroups,
  setSessionGroup,
} from "../lib/session-groups";
import { announce, hasLocalDraft, home, localRunning, sessionContext, toast } from "../lib/ui-state";
import { showsDraftMark } from "../lib/draft-mark";
import { overlaid, rowLeadMark, rowNeedsYou, SIGNAL_CLASS, SIGNAL_ICON, signalTitle, signalWords, stalledPaths, tagSearchText, tagsTitle, turnErrorTitle } from "../lib/signals";
import { readinessBadge, readinessRowChip, readinessTitle } from "../lib/readiness";
import { requestListRefresh } from "../lib/list-refresh";
import { orgHref } from "../lib/orgs-route";
import { marksOverlay, openSessionFeed } from "../lib/session-feed";
import { reuseUnchanged } from "../lib/summary-diff";
import { readKey, removeKey, writeKey } from "../lib/storage-keys";
import { monogram, setSpine, spine } from "../lib/spine";
import { ARCHIVE_TILE, createRowPress, type DragInfo, dropAction, dropTiles, type TileId } from "../lib/drag-overlay";
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
import { providerWait, watchProviderWaits } from "../lib/provider-waiting";
import { waitingSentence } from "../../shared/provider-limits";
import { ActionMenu } from "./ActionMenu";
import { ArchiveCleanup } from "./ArchiveCleanup";
import { SelectionToolbar } from "./SelectionToolbar";
import { ContextRing } from "./ContextRing";
import { CancelHeldButton } from "./HeldAct";
import { heldWaitLine } from "../lib/pipeline-view";
import { waitingWords } from "../lib/working-hours";
import { groupHref } from "../lib/group-route";
import { GroupNameField } from "./Groups";
import { draggingPath, dragSuppressesClick, DropOverlay, openNewGroupFor, startRowDrag } from "./DropOverlay";
import { RemoteGroupDot } from "./RemoteStatus";
import { Banner, Icon, trapFocus } from "./ui";
import { SHARES_HREF } from "../lib/session-shares";
import { showSummaries } from "../lib/summary-line";
import {
  effectiveHostFilter,
  HOST_FILTER_KEY,
  hostFilterShown,
  hostLabel,
  hostOf,
  meshPeers,
  passesHostFilter,
  peerInfo,
  peerUnavailable,
  sessionHrefOn,
} from "../lib/mesh";
import { MeshHostMenu } from "./MeshHostMenu";
import { connectedCount, hostFilterAsk } from "../lib/mesh-details";
import { openMonitor } from "../lib/monitor-nav";

const ARCHIVE_KEY = "sova:archive-open";
/** One key per Archive date section, same "1"/"0" values as ARCHIVE_KEY. */
const archiveDateKey = (id: ArchiveGroupId) => `sova:archive-date-open-${id}`;

/** Which group sections are open, and which of their inline controls is showing. Module state:
    a group's section is rebuilt whenever the session list refreshes
    (every few seconds), and an open group, or a rename in progress, must survive that. */
/** The sessions waiting on a team gone quiet (the digest's decide items): a quiet line-1 mark on
    every copy of the row, so module state like the drag, set by the Sidebar from its digest. */
const [stalled, setStalled] = createSignal<ReadonlySet<string>>(new Set());
const [openGroups, setOpenGroups] = createSignal<Record<string, boolean>>({});
/** Which folder sections are open, keyed by `folderOpenKey` (region + folder). Module state for
    the same reason: the folder rules mint fresh folder objects on every poll, so every folder section
    in the list is rebuilt a few seconds after the user collapses one. */
const [openFolders, setOpenFolders] = createSignal<Record<string, boolean>>({});
/** Which org sections (by org id) and Done tails (by org id + project id + group) the user opened or
    closed: memory only, module state for the same reason as the groups — rebuilt on every poll. */
const [openOrgs, setOpenOrgs] = createSignal<Record<string, boolean>>({});
const [openDone, setOpenDone] = createSignal<Record<string, boolean>>({});
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
 * Files the dropped row into `groupId` (`null` takes it out of the group it is in). Says what
 * happened through the toast stack and the polite region, and returns whether the list should be
 * re-read. A drop back where the row already is does nothing at all. The overlay has already
 * refused what can't happen (lib/drag-overlay); the server refuses it again.
 */
async function applyDrop(from: DragInfo, groupId: string | null): Promise<boolean> {
  if (from.groupId === groupId) return false;
  const before = from.groupId ? groupNameOf(sessionGroups(), from.groupId) : null;
  const after = groupId ? groupNameOf(sessionGroups(), groupId) : null;
  if (!(await setSessionGroup(from.path, groupId))) return false;
  const done = groupId === null ? `Removed from ${before ? quoted(before) : "its group"}.` : `${before ? "Moved" : "Added"} to ${quoted(after ?? "the group")}.`;
  toast(done);
  announce(done);
  return true;
}

/** A session's link: `#/s/<path>`, or `#/p/<host>/s/<path>` for one that lives on a peer. */
export const sessionHref = (path: string) => sessionHrefOn(hostOf(path), path);

/**
 * A peer's session carries its host's name beside the time; a host that can't be reached says so
 * in a word too. A session on this host carries nothing, exactly as before the mesh.
 */
function HostMark(props: { host: string }) {
  const peer = () => peerInfo(props.host);
  const down = () => (peer() ? peerUnavailable(peer()!) : null);
  return (
    <span class="session-host" classList={{ "session-host-down": !!down() }} title={down() ?? `On ${hostLabel(props.host)}`}>
      <Show when={down()}>
        <span class="chip-dot" />
      </Show>
      <span class="session-host-name">{hostLabel(props.host)}</span>
      <Show when={down()}>
        <span>down</span>
      </Show>
    </span>
  );
}

/** The host clause of a peer row's accessible name. */
const hostClause = (host: string) => {
  const peer = peerInfo(host);
  return `, on ${hostLabel(host)}${peer && peerUnavailable(peer) ? ", which can't be reached" : ""}`;
};

/** "3 subagents working now" / "1 subagent working now" — rail title, toast and hidden row text. */
const workingNow = (n: number) => `${n} ${n === 1 ? "subagent" : "subagents"} working now`;

/** The row's state clauses, appended to its link's name (and to a spine tile's), so both say the same. */
const TUI_CLAUSE = ", open in a TUI";
const BUSY_CLAUSE = ", pi is replying in this session";

/** Busy: this tab's own run wins over the last fetched list; Live wins over both. */
const sessionBusy = (s: SessionSummary) => !s.live && !!(localRunning()[s.path] ?? s.busy);

/**
 * A project's current overseer, on its heading (§app.session-list/organizations): an eye, not a row.
 * One mark at most, from the list alone: Busy's pulsing dot, else the turn-error mark, else the
 * unread dot. Tinted and `aria-current` while its conversation is open, like the global eye.
 */
function OverseerEye(props: { session: SessionSummary; project: string; selected: string | null }) {
  const eye = createMemo(() => overseerEye(props.session, { selected: props.selected, busy: sessionBusy(props.session) }));
  const label = () => eyeLabel(props.project, eye().mark);
  return (
    <a
      class="button button-icon button-ghost org-overseer"
      href={`#/s/${encodeURIComponent(props.session.path)}`}
      aria-current={eye().current ? "page" : undefined}
      aria-label={label()}
      title={label()}
    >
      <Icon name="eye" small />
      <Switch>
        <Match when={eye().mark === "working"}>
          <span class="org-overseer-mark session-rail-dot" aria-hidden="true" />
        </Match>
        <Match when={eye().mark === "error"}>
          <Icon name="alert-circle" small class="org-overseer-mark session-turn-error" />
        </Match>
        <Match when={eye().mark === "unread"}>
          <span class="org-overseer-mark session-unread" aria-hidden="true" />
        </Match>
      </Switch>
    </a>
  );
}

/**
 * One session row: a wordless status rail on the left, then the link itself. The rail buttons are
 * out of the tab order on purpose (a long list must not add two tab stops per row), so the link
 * keeps the same state in its accessible name that the old right-hand chips exposed.
 */
function SessionRow(props: {
  session: SessionSummary;
  selected: string | null;
  now: number;
  targets: TargetInfo[];
  /** Needs you only: the digest's sentence, which takes line 2's place (`title`: every sentence). */
  detail?: { text: string; title: string } | null;
  /** The Organizations region's Needs you only: where the row lives, "{org} · {project}". */
  place?: string;
}) {
  const s = () => props.session;
  /** The row's own remote mark: one row answers for itself, never its
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
  /** While its turn's model request waits on the provider's limit, the busy mark says so (§app.provider-limits/waiting-shown). */
  watchProviderWaits(isBusy);
  const busyWords = () => {
    const w = providerWait(s().id);
    return w ? waitingSentence(w) : "pi is replying in this session";
  };
  /** Line 1's "needs you" mark (src/lib/signals.ts): the server's kinds, never on the open or a running session. */
  const needsYou = createMemo(() => rowNeedsYou(s(), { selected: props.selected, busy: isBusy(), stalled: stalled().has(s().path) }));
  /** Line 1's leading state mark (src/lib/signals.ts): the turn-error mark, else the unread dot. */
  const leadMark = () => rowLeadMark(s(), props.selected);
  /** Line 3's merge-readiness badge (src/lib/readiness.ts): the server's answer, worded. */
  const badge = () => readinessBadge(s().readiness);
  /** Line 3's leading chip: ready to merge, or waiting for your OK. */
  const readyChip = () => readinessRowChip(s().readiness);
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
   * Press-and-hold — a mouse button held down, a thumb held on the row — lifts the row; letting go
   * in place selects this session and turns the sidebar into selection mode. A lifted row that
   * moves, or a mouse press that moves 6px, is a drag instead: it opens the drop overlay
   * (§app.session-list/drop-overlay), which owns the gesture from then on. The press is off the
   * moment it stops being a press in place: a scroll (the list moving under a still finger is
   * `pointercancel` on touch and a `scroll` event on a mouse wheel), or the row going away. What a
   * lift or a drag leaves behind — a `click`, and on touch a `contextmenu` — is swallowed below, or
   * the row would navigate on top of what the gesture just did.
   */
  const select = () => {
    startSelection(s().path);
    announce(`Selecting sessions. ${s().title} selected.`);
  };
  let shell: HTMLLIElement | undefined;
  let pointerId = 0;
  let pointerKind = "mouse";
  /** The row is held: it rises off the list, and the list stops scrolling under it. */
  const [lifted, setLifted] = createSignal(false);
  /** The row in flight, as the drop needs it, decided once when the drag starts. */
  const dragInfo = (): DragInfo => {
    const row = s();
    const host = hostOf(row.path);
    return {
      path: row.path,
      title: row.title,
      groupId: row.groupId ?? null,
      org: isOrgSession(row),
      orgProject: orgProjectOf(row),
      peer: host ? hostLabel(host) : null,
      // Busy as the row shows it: this tab's own run is newer than the last fetched list.
      archive: archiveDragOf({ ...row, busy: localRunning()[row.path] ?? row.busy }),
      archived: !!row.archived,
    };
  };
  const press = createRowPress({
    onLift: () => {
      setLifted(true);
      // A short buzz where a phone has one: the row has come off the list.
      if (pointerKind !== "mouse") navigator.vibrate?.(10);
    },
    onDrag: (at) => {
      setLifted(false);
      watchPress(false);
      if (shell) startRowDrag(dragInfo(), at, pointerId, shell, pointerKind);
    },
  });
  const cancelPress = () => {
    press.cancel();
    setLifted(false);
    watchPress(false);
  };
  /** The press ended in place: a lifted row is selected. */
  const releasePress = () => {
    const wasLifted = press.finish();
    setLifted(false);
    watchPress(false);
    if (wasLifted) select();
  };
  const movePress = (e: PointerEvent) => e.pointerId === pointerId && press.move({ x: e.clientX, y: e.clientY });
  const cancelOwn = (e: PointerEvent) => e.pointerId === pointerId && cancelPress();
  const releaseOwn = (e: PointerEvent) => e.pointerId === pointerId && releasePress();
  /**
   * Only while a press is in flight: one set of listeners per PRESSED row, never one per row on
   * screen. The moves are watched on the window, so a mouse that leaves the row on its way to 6px
   * is still a drag. A scroll under the pointer moves the row out from under it; a window blur
   * (an alt-tab, an OS menu) means the pointerup may never arrive at all; and the pointerup itself
   * is watched on the window because a press that wandered off the row still has to END — a press
   * left "down" forever would suppress every later click on this row.
   */
  const watchPress = (on: boolean) => {
    const f = on ? addEventListener : removeEventListener;
    f("pointermove", movePress as EventListener, true);
    f("scroll", cancelPress, true);
    f("blur", cancelPress);
    f("pointerup", releaseOwn as EventListener, true);
    f("pointercancel", cancelOwn as EventListener, true);
  };
  onCleanup(cancelPress);
  /** A lifted row, or one in flight, must not scroll the list under the finger. Non-passive, and
      on the row from the start: a listener added once the touch has begun may not be asked. */
  const holdStill = (e: TouchEvent) => {
    if (e.cancelable && (press.phase() === "lifted" || draggingPath() === s().path)) e.preventDefault();
  };
  onMount(() => shell?.addEventListener("touchmove", holdStill, { passive: false }));
  onCleanup(() => shell?.removeEventListener("touchmove", holdStill));
  /** The rail's own controls (the state pills, the checkbox) are pressed, not held. */
  const onOwnControl = (e: PointerEvent) => e.target instanceof Element && !!e.target.closest("button, input, label");
  const selecting = () => selectionMode();
  const chosen = () => isSelected(s().path);

  return (
    <li
      ref={shell}
      class="session-row-shell"
      classList={{
        "session-row-shell-current": props.selected === s().path,
        "session-row-dragging": draggingPath() === s().path,
        "session-row-lifted": lifted(),
        "session-row-shell-selecting": selecting(),
        "session-row-shell-selected": selecting() && chosen(),
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return; // right-click is not a hold
        if (onOwnControl(e) || draggingPath()) return;
        pointerId = e.pointerId;
        pointerKind = e.pointerType;
        // In selection mode there is no drag at all: a press there is a hold or a toggle.
        press.start({ x: e.clientX, y: e.clientY }, e.pointerType, !selecting());
        watchPress(true);
      }}
      onPointerCancel={cancelPress}
      // A pointer that leaves the row before the hold is not a press in place — except a mouse
      // that may still drag, whose moves the window keeps watching (6px is a drag, wherever it goes).
      onPointerLeave={(e) => {
        if (press.phase() !== "pressed") return;
        if (e.pointerType === "mouse" && !selecting()) return;
        cancelPress();
      }}
      // Capture went to someone else (a scrollbar, another element grabbing it), so the pointerup
      // belonging to this press will never arrive. A drag that took the capture has already
      // ended the press, so this changes nothing for it.
      onLostPointerCapture={() => press.phase() !== "idle" && cancelPress()}
      // The long-press context menu belongs to the hold, not to the browser.
      onContextMenu={(e) => (press.suppressed() || draggingPath()) && e.preventDefault()}
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
        {/* At most one state: live wins over busy. TUI is a static word; Busy is a pulsing dot.
            The wrapper is layout-neutral outside selection mode; in it, it hangs the state under
            the checkbox so the box alone decides where the row's middle is. */}
        <div class="session-rail-states">
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
              aria-label={busyWords()}
              title={busyWords()}
              onClick={() => toast(busyWords())}
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
                // One moving thing per row: the figure only pulses when Busy isn't already pulsing.
                classList={{ "session-rail-count-live": !isBusy() }}
                aria-label={workingNow(n())}
                title={workingNow(n())}
                onClick={() => toast(workingNow(n()))}
              >
                <span class="text-num">{n()}</span>
              </button>
            )}
          </Show>
        </div>
      </div>
      <a
        class="list-row list-row-interactive session-row"
        href={sessionHref(s().path)}
        draggable={false}
        aria-current={props.selected === s().path ? "page" : undefined}
        onClick={(e) => {
          // A hold or a drag already acted on this row; its click is the gesture's echo, not a choice.
          if (press.suppressed() || dragSuppressesClick(s().path)) {
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
          {/* An unsent draft in any session that has been sent in: a pencil before the title, so
              it's found again without opening every row. Line 1, not the rail — the rail is the
              session's state, and a draft is the user's own, not the session's. The pencil is
              decorative; the hidden word puts "Draft" in the row's accessible name. */}
          <p class="list-title" classList={{ "list-title-muted": s().title === "Untitled" }} title={s().title}>
            {/* One leading state mark, since you last had it open (the server's seen store): the last
                turn stopped with an error, else something happened here. The open session never
                shows either: you are looking at it. The words are for AT. */}
            <Switch>
              <Match when={leadMark() === "error" && s().turnError}>
                {(e) => (
                  <>
                    <span class="session-signal-wrap" title={turnErrorTitle(e())}>
                      <Icon name="alert-circle" small class="session-turn-error" />
                    </span>
                    <span class="visually-hidden">Turn failed. </span>
                  </>
                )}
              </Match>
              <Match when={leadMark() === "unread"}>
                <span class="session-unread" aria-hidden="true" />
                <span class="visually-hidden">New activity. </span>
              </Match>
            </Switch>
            {/* What the session waits on you for: its open alignment questions (a count, until they are
                answered), else what the last finished turn says (Settings → Decisions, gone once you've
                seen the session). One mark, the most urgent kind, its shape and word per kind. */}
            <Show when={needsYou()}>
              {(m) => (
                <>
                  <span class="session-signal-wrap" title={signalTitle(m())}>
                    {/* Open questions show as the accent count alone; its color is the mark. */}
                    <Show
                      when={m().kind === "questions" && m().align}
                      fallback={<Icon name={SIGNAL_ICON[m().kind]} small class={SIGNAL_CLASS[m().kind]} />}
                    >
                      {(a) => (
                        <span class="session-signal-count text-num" aria-hidden="true">
                          {a().openQuestions}
                        </span>
                      )}
                    </Show>
                  </span>
                  <span class="visually-hidden">{signalWords(m())}</span>
                </>
              )}
            </Show>
            <Show when={showsDraftMark(s(), hasLocalDraft(s().path))}>
              <Icon name="pencil" small class="list-title-draft" />
              <span class="visually-hidden">Draft. </span>
            </Show>
            {/* Its profile (§chat.profiles/after-first-message): the icon, the label as its title. */}
            <Show when={s().profile}>
              {(p) => (
                <>
                  <span class="session-profile-badge" title={`Profile: ${p().label}`}>
                    <Icon name={profileIconName(p().icon)} small />
                  </span>
                  <span class="visually-hidden">Profile {p().label}. </span>
                </>
              )}
            </Show>
            {s().title}
            {/* A baton session (§app/baton): who holds the baton now. */}
            <Show when={s().baton?.holder}>{(h) => <span class="session-baton-holder"> · {h()}</span>}</Show>
          </p>
          {/* A never-sent session kept in the list by its stored draft: line 2 says so, in the place
              a summary would take, so the row is as tall as its neighbours. The pencil is
              decorative; the hidden word is what the row's accessible name says. */}
          {/* In Needs you, line 2 is why the session is there ("2 open questions in al_3 …"), in place of the
              draft preview or the gist: that sentence is the region's reason to exist. */}
          <Show when={props.detail}>
            {(d) => (
              <div class="list-line list-summary-row">
                <p class="list-summary" title={d().title}>
                  {d().text}
                </p>
              </div>
            )}
          </Show>
          <Show when={!props.detail && s().draftPreview}>
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
          {/* Settings → General can hide it; the topic count goes with it, the draft preview above stays. */}
          <Show when={!props.detail && showSummaries() && !s().draftPreview && summaryText()}>
            <div class="list-line list-summary-row">
              <p class="list-summary" title={summaryTitle()}>{summaryText()}</p>
              <Show when={s().outlineTopics}>
                {(n) => (
                  <Show when={n() > 0}>
                    <span class="session-topics text-num" title={`${n()} topics in this session`}>{n()}</span>
                  </Show>
                )}
              </Show>
            </div>
          </Show>
          <div class="list-line list-meta-row">
            {/* Ready or waiting leads the line, at one left edge down the list; it never truncates. */}
            <Show when={readyChip()}>
              {(c) => (
                <span class={`chip chip-${c().tone} session-readiness-chip`} title={readinessTitle(s().readiness) ?? undefined}>
                  <span class="chip-dot" aria-hidden="true" />
                  {c().label}
                </span>
              )}
            </Show>
            <Show when={hostOf(s().path)}>{(h) => <HostMark host={h()} />}</Show>
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
            <p class="list-meta" title={tagsTitle(s().tags) ?? undefined}>
              {relativeTime(s().lastActiveAt, props.now)}
              {/* The merge-readiness badge, between the time and the model. The topic is search-only. */}
              <Show when={badge()}>
                {(w) => (
                  <>
                    {" · "}
                    <span class="session-readiness" title={readinessTitle(s().readiness) ?? undefined}>
                      {w()}
                    </span>
                  </>
                )}
              </Show>
              {/* The region's Needs you says where the row lives in the model's place. */}
              <Show
                when={props.place}
                fallback={
                  <Show when={s().model}>
                    {" · "}
                    <span class="text-mono" title={s().model!}>
                      {shortModel(s().model)}
                    </span>
                  </Show>
                }
              >
                {(p) => (
                  <>
                    {" · "}
                    <span class="org-place">{p()}</span>
                  </>
                )}
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
          <span class="visually-hidden">{providerWait(s().id) ? `, ${busyWords()}` : BUSY_CLAUSE}</span>
        </Show>
        <Show when={working()}>{(n) => <span class="visually-hidden">, {workingNow(n())}</span>}</Show>
        {/* Remote-ness is a fact a row is picked by, so it rides the link's name — the same deal the
            rail's state gets, and the one the topic chip and the ring deliberately don't. */}
        <Show when={mark()}>{(m) => <span class="visually-hidden">{remoteMarkSuffix(m())}</span>}</Show>
        <Show when={hostOf(s().path)}>{(h) => <span class="visually-hidden">{hostClause(h())}</span>}</Show>
      </a>
    </li>
  );
}

/** `<For>` keyed by a string the caller names rather than by object identity. Folder sections,
    date sections and rows are rebuilt as new objects on every poll, so a plain `<For>` over them
    tore down and rebuilt every node each time; keyed by cwd, id or path, each one is built once
    and its item accessor updates in place. The last item is held while a removed key is being
    disposed, so an accessor read in that gap never sees `undefined`. */
function ForKey<T>(props: { each: readonly T[]; by: (item: T) => string; children: (item: () => T, index: () => number) => JSX.Element }) {
  const byKey = createMemo(() => new Map(props.each.map((x) => [props.by(x), x])));
  const keys = createMemo(() => props.each.map(props.by));
  return (
    <For each={keys()}>
      {(k, i) => {
        let last = byKey().get(k)!;
        return props.children(() => (last = byKey().get(k) ?? last), i);
      }}
    </For>
  );
}

/** Sessions grouped by folder: the markup of the session list "Anatomy". The ORDER is the
    caller's — `groupByCreation` for Live & web, `groupByActivity` for the Archive and for a group
    (src/lib/session-order.ts) — so this component never decides what "newest" means.
    `level` is the heading level a folder label takes: h3 directly under a region, h4 inside a
    group, where the group's own label already sits at h3. Every folder collapses (the session list "Folder
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
    <ForKey each={props.groups} by={(g) => g.cwd}>
      {(group, gi) => {
        // Keyed by cwd (ForKey): this section is built once per folder and `group()` follows each
        // poll's fresh object, so everything read from it below stays an accessor.
        const cwd = group().cwd;
        // The label's remote form is the group's only while every row runs at one target and folder:
        // a mixed group keeps the plain folder label and its rows' marks speak.
        const remote = createMemo(() => groupRemotePlaceOf(group().sessions, cwd));
        const host = () => {
          const r = remote();
          return r ? props.targets.find((t) => t.name === r.target)?.host : undefined;
        };
        const label = (name: string) => props.targets.find((t) => t.name === name)?.label || name;
        // Open/closed per region + folder, remembered for the browser session. The folder object
        // is rebuilt on every poll, so the choice lives in module state and sessionStorage, never
        // in this component.
        const key = folderOpenKey(props.idPrefix, cwd);
        const open = () =>
          folderOpen({
            stored: openFolders()[key] ?? storedFolderOpen(readFolderOpenRaw(props.idPrefix, cwd)),
            searching: props.searching,
          });
        // Rows are built the first time the folder is open and kept after it closes: a folder
        // never opened costs its head alone (§app.session-list/content-rules, open/closed state).
        let built = false;
        const rowsBuilt = createMemo(() => built || (built = open()));
        // Folders start collapsed, so one holding an agent at work says so on its own head.
        const active = () => folderActive(group().sessions, localRunning());
        const onFolderToggle = (e: Event & { currentTarget: HTMLDetailsElement }) => {
          const now = e.currentTarget.open;
          if (now === open()) return; // our own `open` update, not the user's
          setOpenFolders((m) => ({ ...m, [key]: now }));
          writeFolderOpenRaw(props.idPrefix, cwd, now);
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
                title={(() => {
                  const r = remote();
                  return r ? `${r.target}${host() ? ` (${host()})` : ""}:${r.remoteCwd}` : cwd;
                })()}
              >
                <Icon name="chevron-right" small class="icon-twist" />
                <Icon name={remote() ? "terminal" : "folder"} small />
                {/* Remote: the target's label stays whole and the folder on it truncates from the left
                    like a local path, but never as "~": the target's $HOME isn't ours. */}
                <Show when={remote()}>
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
                  <bdi>{remote()?.remoteCwd ?? tildePath(cwd, home())}</bdi>
                </span>
                <Show when={active()}>
                  <span class="session-group-active" title="An agent is working in this folder">
                    <span class="session-rail-dot" />
                    <span class="visually-hidden">, an agent is working here</span>
                  </span>
                </Show>
                <span class="text-num">{group().sessions.length}</span>
              </Dynamic>
            </summary>
            <ul class="list">
              <Show when={rowsBuilt()}>
                <ForKey each={group().sessions} by={(s) => s.path}>
                  {(s) => <SessionRow session={s()} selected={props.selected} now={props.now} targets={props.targets} />}
                </ForKey>
              </Show>
            </ul>
          </details>
        );
      }}
    </ForKey>
  );
}

/**
 * One user-made group: a collapsible section above Live & web that holds the same folder groups and
 * rows as every other region. It keeps its own Rename and Delete, and
 * it is a drop target while a row is being dragged. An empty group stays visible — that is what a
 * group is when the user makes it, and dragging a row in is how it fills.
 */
function GroupBlock(props: {
  /** The group itself: its identity is what keeps this section mounted across list polls. */
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
      open={groupOpen(group().id)}
      onToggle={(e) => onGroupToggle(group().id, e)}
    >
      {/* No folder icon here, unlike the cwd heads inside: a group is the user's own name for a set
          of sessions, not a folder on disk, and the icon claimed otherwise right above real ones. */}
      <summary class="list-group-label group-label" title={group().name}>
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="group-name">
          <bdi>{group().name}</bdi>
        </span>
        <span class="text-num">{count()}</span>
        <NameSessionsButton section={`g-${group().id}`} rows={props.sessions} onDone={props.onChanged} />
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
                    disabled={count() === 0 ? "Nothing is in it yet. Drag a session into it first." : ""}
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
      <Show when={count() > 0} fallback={<p class="sidebar-region-note">No sessions yet. Drag a session to file it here.</p>}>
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

/**
 * A section head's Name sessions button (§app.session-list/auto-titles): shown while the section
 * holds a row with no stored title, it asks each row's host to name those rows, then refetches
 * the list. Nothing else is said — no toast, no undo; the titles changing is the answer. Its click
 * and keydown stop here, so a press inside a <summary> never toggles the section.
 */
function NameSessionsButton(props: { section: string; rows: readonly SessionSummary[]; onDone(): void }) {
  const rows = createMemo(() => nameableRows(props.rows));
  const busy = () => namingIn(props.section);
  // While it runs, the label keeps the count it was pressed with: a poll mid-run can shrink it.
  const [pressed, setPressed] = createSignal(0);
  const label = () => (busy() ? nameLabel(pressed(), true) : nameLabel(rows().length));
  const press = async () => {
    const paths = rows().map((s) => s.path);
    if (busy() || paths.length === 0) return;
    setPressed(paths.length);
    setNaming(props.section, true);
    try {
      await nameSessions(paths, { hostOf, post: (batch) => autoTitleSessions(batch) });
    } finally {
      setNaming(props.section, false);
      props.onDone();
    }
  };
  return (
    <Show when={busy() || rows().length > 0}>
      <button
        type="button"
        class="button button-icon button-ghost name-sessions"
        aria-label={label()}
        title={label()}
        aria-busy={busy() ? "true" : undefined}
        disabled={busy()}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          void press();
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Icon name="pencil" small />
      </button>
    </Show>
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

/** The sova wordmark, a link to the list (`#/`): the list's head, and the overview's head on a
    phone (§app.shell/overview). */
export function BrandLink() {
  return (
    <a class="brand" href="#/">
      <span class="icon" style={{ "--icon": "url(/icons/sova-mark.svg)" }} aria-hidden="true" />
      sova
    </a>
  );
}

export function Sidebar(props: {
  sessions: SessionSummary[] | undefined;
  loading: boolean;
  error: string | null;
  selected: string | null;
  now: number;
  onRefresh(): void;
  /** After a row dropped on the drop overlay's Archive archives a session, or its Undo brings it back. */
  onArchiveChanged(path: string, archived: boolean): void;
  onNew(): void;
  usage: UsageInsight | undefined;
  /** The open chat's recorded Claude login, whose reading the glance's C shows; absent: the login
      in use for new chats. */
  claudeLogin?: string | null;
  agents: AgentsInsight | undefined;
  /** The insights page that's open (`#/usage` or `#/agents`), for aria-current on its foot row. */
  insightsPage: "usage" | "agents" | null;
  /** `#/shares` is open, for aria-current on its foot row (§app.session-share/shares-page). */
  sharesOpen?: boolean;
  /** Opens the Settings dialog from the foot's gear. */
  onOpenSettings(): void;
  /** The viewport is ≥768px: the only width where the pane can collapse to the spine. */
  unfolded: boolean;
  /** The Overseer's counts for its entry button; undefined until the first read. */
  overseer?: OverseerInfo;
  /** `#/overseer` is the route: the button is the current page, and its unread count is moot. */
  overseerOpen?: boolean;
  /** The attention digest (App's one poll): the Needs you region lists its act tier. */
  attention?: AttentionDigest;
}) {
  const [query, setQuery] = createSignal("");
  /** The host filter as remembered (lib/mesh.ts); what applies is `hostFilter()`, which reads All
      while its host isn't known or the filter isn't shown. A memo, so the search hits re-run only
      when the filter's value moves, not on every mesh poll that rebuilds the peer list. */
  const [storedHostFilter, setStoredHostFilter] = createSignal(readKey(localStorage, HOST_FILTER_KEY));
  const hostFilter = createMemo(() => effectiveHostFilter(storedHostFilter(), meshPeers(), hostFilterShown()));
  const chooseHostFilter = (value: string | null) => {
    setStoredHostFilter(value);
    if (value === null) removeKey(localStorage, HOST_FILTER_KEY);
    else writeKey(localStorage, HOST_FILTER_KEY, value);
  };
  // "Open Through This Host" in the mesh details: the filter takes that host (a fresh ask each time).
  createEffect(on(hostFilterAsk, (ask) => ask && chooseHostFilter(ask.value), { defer: true }));
  /** The one toolbar line (both widths) has the search open: opened by its icon or "/", and
      held open by a query, so a row tapped and left finds it as it was. */
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [showSkeleton, setShowSkeleton] = createSignal(false);
  const skeletonTimer = setTimeout(() => setShowSkeleton(true), 300);
  let search!: HTMLInputElement;
  let searchToggle: HTMLButtonElement | undefined;
  let aside!: HTMLElement;
  // The tab's copy of the group list: the pane's region and the session pane's menu share it.
  onMount(() => void loadSessionGroups());

  /**
   * A row dropped on the drop overlay (§app.session-list/drop-overlay). The overlay says which tile
   * was under the pointer; the rules say what that means, and a refused tile only says why.
   */
  const onOverlayDrop = (d: DragInfo, tile: TileId | null) => {
    const act = dropAction(tile, dropTiles(d, sessionGroups(), groupCounts()));
    if (act.kind === "group") void applyDrop(d, act.groupId).then((changed) => changed && props.onRefresh());
    else if (act.kind === "archive") void archiveByDrag(d);
    else if (act.kind === "new") openNewGroupFor(d);
    else if (act.kind === "refused") {
      const said = tile === ARCHIVE_TILE ? (blockedDropSentence(d.archive) ?? act.reason) : act.reason;
      toast(said);
      announce(said);
    }
  };
  /** `Create and Move` in the New group dialog: one action, two requests. */
  const createAndMove = async (d: DragInfo, name: string) => {
    const group = await createGroup(name); // a failure has already said why
    if (group && (await applyDrop(d, group.id))) props.onRefresh();
  };
  const archiveByDrag = async (d: DragInfo) => {
    if (d.archive.kind !== "archive") return; // the overlay refused it already
    let deleted: boolean;
    try {
      // A never-sent session is deleted rather than archived (lib/drag-archive); the answer says which.
      deleted = !!(await setSessionArchived(d.path, true)).deleted;
    } catch (err) {
      const failed = `Couldn't archive this session. ${(err as Error).message}`;
      toast(failed);
      announce(failed);
      return;
    }
    const done = archivedDropToast(deleted, d.orgProject);
    // Keyed: the next archive's toast replaces this one, so only the latest Undo is on screen.
    toast(done.text, done.undo ? { key: "archive-undo", action: { label: "Undo", run: () => undoArchive(d.path, d.orgProject) } } : undefined);
    announce(done.text);
    props.onArchiveChanged(d.path, true);
  };
  const undoArchive = async (path: string, org: string | null) => {
    try {
      await setSessionArchived(path, false);
    } catch (err) {
      const failed = `Couldn't unarchive this session. ${(err as Error).message}`;
      toast(failed);
      announce(failed);
      return;
    }
    const done = unarchivedToast(org);
    toast(done);
    announce(done);
    props.onArchiveChanged(path, false);
  };

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
  /** The spine's Search, and "/" while collapsed: open the pane and its search line, cursor in
      the field. The field exists only while the line is open, so the line opens here too. */
  const expandToSearch = () => {
    setCollapsed(false, false);
    setSearchOpen(true);
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
    else openSearch();
  };
  document.addEventListener("keydown", onKey);
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    clearTimeout(skeletonTimer);
  });

  // Decision marks arrive over the session feed as they change, and so does word that the list itself
  // changed (a session a TUI just started): that re-reads it, and the attention digest with it (App,
  // lib/list-refresh.ts), since the Organizations region's Needs you lists the digest's items: a reply
  // or a Get Link in another tab clears its row at once, not at the digest's next 10 s read. The list
  // poll stays the fallback.
  openSessionFeed(requestListRefresh);
  /** Main threads only (src/lib/regions.ts): every region, search hit and count reads this. Each row
      carries the feed's marks over the list's (a peer's row keeps its own); `reuseUnchanged` keeps a
      row's object across feed messages that don't touch it, so rows update in place. */
  const all = createMemo<SessionSummary[]>((prev) =>
    reuseUnchanged(
      // A cleared project overseer conversation is drawn nowhere: its overseer's History opens it.
      (props.sessions ?? []).filter((s) => isMainThread(s) && !isClearedOverseer(s)).map((s) => overlaid(s, marksOverlay(), !!hostOf(s.path))),
      prev,
    ),
  );
  /** The folder the server lists sessions from (its own agent dir's), read once the list is empty. */
  const isEmpty = createMemo(() => !!props.sessions && all().length === 0);
  const [dirInfo] = createResource(
    () => isEmpty() || undefined,
    () => fetchSessionsDir().catch(() => null),
  );
  const sessionsDir = () => {
    const d = dirInfo();
    return d ? tildePath(d.sessionsDir, d.home) : null;
  };
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
    // The host filter narrows first; with the mesh off it is always All and changes nothing.
    const h = hostFilter();
    const pool = h === null ? all() : all().filter((s) => passesHostFilter(h, s.path));
    // An org row is also found by its org, its project and the baton holder (lib/org-region); it
    // only ever shows in the Organizations region, so that is the only place such a hit appears.
    return q
      ? pool.filter((s) => `${s.title} ${where(s)} ${s.model ?? ""} ${tagSearchText(s.tags)} ${orgSearchText(s)}`.toLowerCase().includes(q))
      : pool;
  });
  /** Every ordinary surface — Needs you, Recent, Groups, Live & web, the Archive and its cleanup —
      reads these, never `all()`/`hits()`: an organization's session lives only in its own region. */
  const ordinary = createMemo(() => all().filter(isOrdinarySession));
  /** Each group's session count, as its section counts them, for its tile in the overlay. */
  const groupCounts = createMemo(() => new Map(groupSections(ordinary(), sessionGroups(), false).map((x) => [x.group.id, x.sessions.length])));
  const ordinaryHits = createMemo(() => hits().filter(isOrdinarySession));
  const orgHits = createMemo(() => hits().filter(isOrgSession));
  // Pane rule: live, or web-spawned and not archived, stays on top (src/lib/regions.ts).
  const isTop = isTopSession;
  const topHits = createMemo(() => ordinaryHits().filter(isTop));
  const archiveHits = createMemo(() => ordinaryHits().filter((s) => !isTop(s)));
  // Each region groups by cwd on its own, so a folder can appear in both.
  const topGroups = createMemo(() => groupByCreation(topHits()));
  /**
   * Recent: the handful of sessions that moved last, said once more at the very top.
   * Purely additive, like a group — every row here is still in Live & web or the Archive below —
   * and built from `hits()`, so it narrows with the search and can never carry a row the rest of
   * the sidebar is hiding. How many rows is `recentCount()`, and the settings dialog spec's General tab is the only
   * place that writes it: this region has no controls of its own.
   */
  const recent = createMemo(() => recentSessions(hits(), recentCount()));
  /**
   * Needs you: the sessions the attention digest says are blocked on you (lib/needs-you), above
   * Recent. A shortcut like Recent — every row is still where it lives — and built from `hits()`
   * too, so the search narrows it and its count is always its rows. The open session stays listed.
   */
  const needsYou = createMemo(() => needsYouRows(props.attention, ordinaryHits()));
  createEffect(() => setStalled(stalledPaths(props.attention)));
  /** ONE rule for the region and its spine door: rows, and proactivity known and not Off. */
  const showNeedsYou = () => !!props.sessions && needsYouShown(props.overseer?.proactivity, needsYou().length);
  const needsYouCutNote = () => needsYouCut(props.attention);
  const needsYouDetail = (path: string) => {
    const r = needsYou().find((row) => row.session.path === path);
    return r?.detail ? { text: r.detail, title: r.details.join(" ") } : null;
  };
  // The Archive splits by date first (Today … Older), then by cwd inside each date section.
  // The date sections move only when the calendar day does, so they read the start of today,
  // not the 30 s clock: a tick that stays inside one day re-runs nothing below.
  const today = createMemo(() => startOfDay(props.now));
  const archiveSections = createMemo(() => {
    const sorted = [...archiveHits()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    return groupByArchiveDate(sorted, new Date(today())).map((d) => ({ ...d, groups: groupByActivity(d.items) }));
  });
  const archiveTotal = () => ordinary().filter((s) => !isTop(s)).length;
  /**
   * Whether each region is on screen right now — ONE rule, read by the region's own `<Show>` and
   * by the spine's count button, which is that region's door. Deriving the spine's boxes from
   * anything else (a total, say) puts a door on the rail that opens onto nothing: under a search
   * with no hits the Archive's total is still 321 while the region itself is gone.
   */
  const showTop = () => !!props.sessions && all().length > 0 && (topHits().length > 0 || !query().trim());
  const showArchive = () => archiveHits().length > 0;

  // Groups: the user's own sections, above every region. They cut across regions — a
  // group can hold a TUI-live session and an archived one — so they read the whole search-hit list,
  // not one region's slice.
  const searching = () => !!query().trim();
  // Org sessions are never grouped, so an assignment made before that rule is kept but not drawn.
  const sections = createMemo(() => groupSections(ordinaryHits(), sessionGroups(), searching()));
  /** A group's rows, from the same hit list the sections were built from. */
  const rowsOf = (id: string) => ordinaryHits().filter((s) => s.groupId === id);
  /** With no query the region always stands: its head carries the `+` that makes a group, the
      feature's front door. While searching it appears only when a group has a match. */
  const groupsShown = () => !searching() || sections().length > 0;

  /** The Groups region's own twist. Collapsed on every load and memory-only — unlike the Archive
      there is no stored choice to read, so nothing a past visit did can open it. It
      is component state, not module state: the region is one node that outlives every poll. */
  const [groupsChosen, setGroupsChosen] = createSignal<boolean | undefined>(undefined);
  /** Forced open, without touching the choice, while a search is on (a matching group must not
      hide its hits), or while the
      new-group field is showing (it lives in here too, and the `+` can be pressed on a shut region). */
  const groupsRegionOpen = () =>
    groupsRegionOpenRule({
      chosen: groupsChosen(),
      searching: searching(),
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

  // Collapsed by default; the user's own choice persists for the tab.
  const [storedOpen, setStoredOpen] = createSignal(readKey(sessionStorage, ARCHIVE_KEY) === "1");
  /** Forced open while searching, when the top is empty, or when the open session is archived. */
  const forcedOpen = () =>
    !!query().trim() || topHits().length === 0 || archiveHits().some((s) => s.path === props.selected);
  const archiveOpen = () => forcedOpen() || storedOpen();
  const onArchiveToggle = (e: Event & { currentTarget: HTMLDetailsElement }) => {
    const open = e.currentTarget.open;
    if (open === archiveOpen()) return; // our own `open` update, not the user's
    setStoredOpen(open);
    writeKey(sessionStorage, ARCHIVE_KEY, open ? "1" : "0");
  };
  // Needs you: OPEN by default, unlike the Archive; a collapse is remembered for the tab the same way.
  const [needsYouStored, setNeedsYouStored] = createSignal(storedNeedsYouOpen(readKey(sessionStorage, NEEDS_YOU_KEY)));
  /** Forced open while searching, so every hit is visible. */
  const needsYouRegionOpen = () => needsYouOpenRule({ stored: needsYouStored(), searching: searching() });
  const onNeedsYouToggle = (e: Event & { currentTarget: HTMLDetailsElement }) => {
    const open = e.currentTarget.open;
    if (open === needsYouRegionOpen()) return; // our own `open` update, not the user's
    setNeedsYouStored(open);
    writeKey(sessionStorage, NEEDS_YOU_KEY, open ? "1" : "0");
  };
  /**
   * Organizations (lib/org-region): the only place org sessions are listed. Its own Needs you first,
   * then org → project → groups (Conversations, Conflicts to settle, Builds), each with a Done tail. Open by default, a collapse remembered for the tab.
   */
  const orgs = createMemo(() => orgSections(orgHits()));
  /** The region counts rows: a project's eye is not one. */
  const orgRowCount = () => regionCount(orgs());
  const orgTotal = () => regionCount(orgSections(all().filter(isOrgSession)));
  const orgNeedsYou = createMemo(() => orgNeedsYouRows(props.attention, orgHits()));
  /** Its Needs you items that are no session: projects to pick a main stakeholder for. */
  const orgItems = createMemo(() => orgProjectItems(props.attention, query()));
  const orgWaitingCount = () => orgNeedsYou().length + orgItems().length;
  const orgNeedsYouDetail = (path: string) => {
    const r = orgNeedsYou().find((row) => row.session.path === path);
    // r12: an open offer's invitees not reached yet (their hours haven't come) are said after the row's own detail.
    const waiting = waitingWords(props.attention?.items.find((it) => it.path === path && it.waiting?.length)?.waiting ?? r?.session.baton?.waiting, props.now);
    const text = [r?.detail, waiting].filter(Boolean).join(" · ");
    return text ? { text, title: [...(r?.details ?? []), waiting ?? ""].filter(Boolean).join(" ") } : null;
  };
  const waitingTitle = (k: number) => (k === 1 ? "1 session waiting on you." : `${k} sessions waiting on you.`);
  const orgNeedsTitle = (k: number) =>
    k === 1 ? "The 1 organization session waiting on you." : `The ${k} organization sessions waiting on you, newest first.`;
  /** A project's label title: its root, read off the project overseer's folder, else its name. */
  const projectTitle = (p: OrgProject) => (p.overseer ? tildePath(p.overseer.cwd, home()) : p.name);
  /** Paths waiting on the operator, for the org heads' warn dot. */
  const orgWaiting = createMemo(() => new Set(orgNeedsYou().map((r) => r.session.path)));
  const waitingIn = (rows: readonly SessionSummary[]) => rows.filter((r) => orgWaiting().has(r.path)).length;
  /** ONE rule for the region and its spine door: any org row among the hits (an archived project's
      counts only while it waits on you, in the region's own Needs you). */
  const showOrgs = () => !!props.sessions && (orgs().length > 0 || orgNeedsYou().length > 0 || orgItems().length > 0);
  const [orgsStored, setOrgsStored] = createSignal(storedOrgsOpen(readKey(sessionStorage, ORGS_KEY)));
  const orgsOpen = () =>
    orgsRegionOpenRule({
      stored: orgsStored(),
      searching: searching(),
      holdsSelected: orgHits().some((s) => s.path === props.selected),
    });
  const onOrgsToggle = (e: Event & { currentTarget: HTMLDetailsElement }) => {
    const open = e.currentTarget.open;
    if (open === orgsOpen()) return; // our own `open` update, not the user's
    setOrgsStored(open);
    writeKey(sessionStorage, ORGS_KEY, open ? "1" : "0");
  };
  const holds = (rows: readonly SessionSummary[]) => rows.some((r) => r.path === props.selected);
  const orgOpen = (o: OrgSection) => orgSectionOpenRule({ chosen: openOrgs()[o.id], searching: searching(), holdsSelected: holds(orgRows(o)) });
  const onOrgToggle = (o: OrgSection, e: Event & { currentTarget: HTMLDetailsElement }) => {
    const open = e.currentTarget.open;
    if (open === orgOpen(o)) return;
    setOpenOrgs((m) => ({ ...m, [o.id]: open }));
  };
  /** A group's Done tail, keyed by org, project and group: collapsed by default, forced open by a search or the open session. */
  const groupDoneOpen = (key: string, rows: readonly SessionSummary[]) =>
    doneOpenRule({ chosen: openDone()[key], searching: searching(), holdsSelected: holds(rows) });
  const onGroupDoneToggle = (key: string, rows: readonly SessionSummary[], e: Event & { currentTarget: HTMLDetailsElement }) => {
    const open = e.currentTarget.open;
    if (open === groupDoneOpen(key, rows)) return;
    setOpenDone((m) => ({ ...m, [key]: open }));
  };
  /** A project row: line 2 names a settle session's conflict, or why a conversation hasn't started. */
  const ProjectRow = (r: { session: SessionSummary }) => {
    const line = () => rowLine(r.session);
    return <SessionRow session={r.session} selected={props.selected} now={props.now} targets={targets()} detail={line() ? { text: line()!, title: line()! } : null} />;
  };
  const rowList = (rows: readonly SessionSummary[]) => (
    <ul class="list">
      <For each={rows}>{(s) => <ProjectRow session={s} />}</For>
    </ul>
  );
  /** One group of a project: its label and count, the live states, then its collapsed Done. */
  const ProjectGroup = (g: { key: string; label: string; title: string; doneTitle: string; states: { label: string; rows: SessionSummary[] }[]; done: SessionSummary[] }) => {
    const count = () => g.states.reduce((n, x) => n + x.rows.length, 0) + g.done.length;
    return (
      <Show when={count() > 0}>
        <section class="org-group" aria-label={`${g.label}, ${count()}`}>
          <h5 class="list-group-label org-group-label" title={g.title}>
            {g.label} <span class="text-num">{count()}</span>
          </h5>
          <For each={g.states}>
            {(st) => (
              <Show when={st.rows.length > 0}>
                <Show when={st.label}>
                  <h6 class="org-state-label">
                    {st.label} <span class="text-num">{st.rows.length}</span>
                  </h6>
                </Show>
                {rowList(st.rows)}
              </Show>
            )}
          </For>
          <Show when={g.done.length > 0}>
            <details class="archive-date org-done" open={groupDoneOpen(g.key, g.done)} onToggle={(e) => onGroupDoneToggle(g.key, g.done, e)}>
              <summary class="list-group-label archive-date-label" title={g.doneTitle}>
                <Icon name="chevron-right" small class="icon-twist" />
                <span class="archive-date-name">Done</span>
                <span class="text-num">{g.done.length}</span>
              </summary>
              {rowList(g.done)}
            </details>
          </Show>
        </section>
      </Show>
    );
  };
  // Date sections: collapsed by default, each remembering its own choice the same way.
  const [storedDateOpen, setStoredDateOpen] = createSignal<Partial<Record<ArchiveGroupId, boolean>>>({});
  const dateStored = (id: ArchiveGroupId) => storedDateOpen()[id] ?? readKey(sessionStorage, archiveDateKey(id)) === "1";
  /** Forced open while searching, or when it holds the open session. */
  const dateOpen = (d: { id: ArchiveGroupId; items: SessionSummary[] }) =>
    !!query().trim() || d.items.some((s) => s.path === props.selected) || dateStored(d.id);
  const onDateToggle = (d: { id: ArchiveGroupId; items: SessionSummary[] }, e: Event & { currentTarget: HTMLDetailsElement }) => {
    const open = e.currentTarget.open;
    if (open === dateOpen(d)) return; // our own `open` update, not the user's
    setStoredDateOpen((m) => ({ ...m, [d.id]: open }));
    writeKey(sessionStorage, archiveDateKey(d.id), open ? "1" : "0");
  };
  const liveCount = () => all().filter((s) => s.live).length;
  const glance = createMemo(() => usageGlance(props.usage, props.claudeLogin));
  /** The foot's usage glance in full words, for its tooltip and accessible name. */
  const glanceText = () => (glance().length ? `Usage: ${glance().map((p) => p.full).join(", ")}` : "");

  const clear = () => {
    setQuery("");
    search.focus();
  };
  const toolbarOpen = () => searchOpen() || query() !== "";
  /** The folded line's search icon (and "/"): the field takes the line, with the cursor in it. */
  const openSearch = () => {
    setSearchOpen(true);
    queueMicrotask(() => search.focus());
  };
  /** Close Search, or Escape on an empty field: the query goes, and the line folds back. */
  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
    queueMicrotask(() => searchToggle?.focus());
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
  /** The Organizations door: its sessions, and who is waiting, so nothing waits unseen behind the spine. */
  const orgsDoorLabel = () => {
    const k = orgWaitingCount();
    return `Organizations · ${sessionsWord(orgRowCount())}${k > 0 ? ` · ${k} waiting on you` : ""}`;
  };
  const tuiSentence = () => `${liveCount()} ${liveCount() === 1 ? "session" : "sessions"} open in a TUI`;

  /**
   * The Overseer's door, with the count of Overseer messages you haven't read. In the toolbar it
   * is a labelled button (`labelled`): the eye, the word, then the count as an inline pill; on the
   * spine it is the bare eye with the corner pill. Who needs you is the Needs you region's to say,
   * not the eye's. Alt+O does the same (App).
   */
  const OverseerButton = (p: { class: string; labelled?: boolean }) => {
    // The Overseer's own messages, so it shows whatever the proactivity; moot while it is open.
    const unread = () => (props.overseerOpen ? 0 : (props.overseer?.unread ?? 0));
    const label = () => overseerButtonLabel(unread());
    return (
      <a
        class={`button overseer-entry ${p.labelled ? "button-sm overseer-entry-word" : "button-icon"} ${p.class}`}
        href={OVERSEER_HASH}
        aria-current={props.overseerOpen ? "page" : undefined}
        aria-label={label()}
        title={`${label()} · Alt+O`}
      >
        <Icon name="eye" small={p.labelled || undefined} />
        <Show when={p.labelled}>Overseer</Show>
        <Show when={unread() > 0}>
          <span class="overseer-entry-count text-num" aria-hidden="true">
            {unread() > 99 ? "99+" : unread()}
          </span>
        </Show>
      </a>
    );
  };

  /** The session filter, in the toolbar line while the search is open (both widths). */
  const SearchField = () => (
    <div class="search">
      <Icon name="search" />
      <input
        ref={search}
        class="input"
        id="session-search"
        type="search"
        placeholder="Title, folder, or tag"
        aria-describedby="session-count"
        autocomplete="off"
        spellcheck={false}
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          if (query()) setQuery("");
          else closeSearch();
        }}
      />
      <Show when={query()}>
        <button type="button" class="button button-icon" aria-label="Clear Search" onClick={clear}>
          <Icon name="close" small />
        </button>
      </Show>
    </div>
  );
  const SearchCount = (p: { hidden: boolean }) => (
    <p class="search-count" classList={{ "visually-hidden": p.hidden }} id="session-count" aria-live="polite">
      <Show when={props.sessions}>
        <Show when={query().trim() || hostFilter() !== null} fallback={`${all().length} sessions`}>
          {hits().length} of {all().length} sessions
        </Show>
      </Show>
    </p>
  );
  /** The keyboard's (and the unsure pointer's) door into selection mode: press-and-hold is the
      accelerator, never the only way in. */
  const SelectStart = () => (
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
  );

  /** The foot's four rows, as §app.insights/sidebar-foot draws them: the host filter (mesh only),
      the Usage glance with its monitor button, Agents with its Settings gear, and Shares. On the
      desktop they sit in `.sidebar-foot`; on a phone the foot bar's sheet holds them, verbatim. */
  const FootRows = () => (
    <>
      {/* Only with the mesh on and a peer: one host's sessions, or All, and the mesh details. */}
      <Show when={hostFilterShown()}>
        <MeshHostMenu value={hostFilter()} onChange={chooseHostFilter} />
      </Show>
      {/* The monitor button takes the gear's exact markup, so the two stack in one column. */}
      <div class="sidebar-foot-row">
        <a
          class="list-row list-row-interactive insights-row sidebar-foot-link"
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
        <button type="button" class="button button-icon sidebar-settings" title="Resource monitor" aria-label="Resource monitor" onClick={() => openMonitor()}>
          <Icon name="activity" small />
        </button>
      </div>
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
      {/* Every public link, and who is looking (§app.session-share/shares-page). */}
      <a class="list-row list-row-interactive insights-row sidebar-foot-link" href={SHARES_HREF} aria-current={props.sharesOpen ? "page" : undefined}>
        <Icon name="external" />
        <span class="insights-row-text">Shares</span>
      </a>
    </>
  );

  /**
   * Folded (<768): the foot as one 44px bar under the list (§app.insights/sidebar-foot-phone) —
   * the mesh's connected count (while the mesh is on), the agents at work (the worker icon and
   * the count), and every provider's usage cap as the glance shows it. Tapping the bar opens the
   * rows as a bottom sheet, verbatim. Focus leaves and returns with the sheet (trapFocus).
   */
  const PhoneFoot = () => {
    const [sheetOpen, setSheetOpen] = createSignal(false);
    const close = () => setSheetOpen(false);
    /** The bar's accessible name: the facts in words, then what the tap does. */
    const barName = () => {
      const facts: string[] = [];
      if (hostFilterShown()) {
        const c = connectedCount(meshPeers());
        facts.push(`${c.up} of ${c.total} hosts connected`);
      }
      facts.push(workingNow(agentsWorking()));
      const caps = glance().map((p) => p.full);
      if (caps.length) facts.push(caps.join(", "));
      return `${facts.join(". ")}. Open hosts, usage, agents and shares.`;
    };
    return (
      <>
        <button
          type="button"
          class="sidebar-footbar"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen()}
          aria-label={barName()}
          onClick={() => setSheetOpen(true)}
        >
          <Show when={hostFilterShown()}>
            <span class="sidebar-footbar-seg">
              <span class="text-num">{connectedCount(meshPeers()).up}/{connectedCount(meshPeers()).total}</span>
            </span>
          </Show>
          <span class="sidebar-footbar-seg">
            <Icon name="worker" small />
            <span class="text-num">{agentsWorking()}</span>
          </span>
          {/* Every provider the glance would show, in its order (at most the five): never one
              invented number, and the line never wraps — what can't fit clips, like the glance. */}
          <For each={glance()}>
            {(p) => (
              <span
                class="sidebar-footbar-seg sidebar-footbar-cap"
                classList={{ "sidebar-footbar-cap-high": p.high && !p.stale, "sidebar-footbar-cap-stale": p.stale }}
              >
                <span class="sidebar-footbar-tag">{p.abbr}</span> <span class="text-num">{p.amount ?? `${p.pct}%`}</span>
              </span>
            )}
          </For>
        </button>
        <Show when={sheetOpen()}>
          <Portal>
            <div class="scrim" onClick={close} />
            <div
              class="modal sidebar-foot-sheet"
              role="dialog"
              aria-modal="true"
              aria-label="Hosts, usage, agents and shares"
              ref={(el) => trapFocus(el)}
              onKeyDown={(e) => {
                if (e.key === "Escape") close();
              }}
            >
              <div class="sheet-grip" aria-hidden="true" />
              <FootRows />
            </div>
          </Portal>
        </Show>
      </>
    );
  };

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
          <OverseerButton class="spine-item" />
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
        <Show when={showNeedsYou() || showTop() || showOrgs() || showArchive()}>
          <div class="spine-regions">
            <Show when={showNeedsYou()}>
              <button
                type="button"
                class="button button-icon spine-item spine-region"
                title={`Needs you · ${sessionsWord(needsYou().length)}`}
                aria-label={`Needs you · ${sessionsWord(needsYou().length)}`}
                onClick={() =>
                  expandToRegion(
                    () => aside.querySelector<HTMLElement>(".sidebar-needs-you > summary"),
                    (el) => el,
                  )
                }
              >
                <Icon name="alert-circle" />
                <span class="spine-count text-num">{needsYou().length}</span>
              </button>
            </Show>
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
            <Show when={showOrgs()}>
              <button
                type="button"
                class="button button-icon spine-item spine-region"
                title={orgsDoorLabel()}
                aria-label={orgsDoorLabel()}
                onClick={() =>
                  expandToRegion(
                    () => aside.querySelector<HTMLElement>(".sidebar-orgs > summary"),
                    (el) => el,
                  )
                }
              >
                <Icon name="building" />
                <span class="spine-count text-num">{orgRowCount()}</span>
                <Show when={orgWaitingCount() > 0}>
                  <span class="spine-dot spine-dot-warn" aria-hidden="true" />
                </Show>
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
          <button type="button" class="button button-icon spine-item" title="Resource monitor" aria-label="Resource monitor" onClick={() => openMonitor()}>
            <Icon name="activity" />
          </button>
          <a
            class="button button-icon spine-item"
            href={agentsHref()}
            aria-current={props.insightsPage === "agents" ? "page" : undefined}
            title={agentsSentence(props.agents) ?? "Agents"}
            aria-label={agentsSentence(props.agents) ?? "Agents"}
          >
            <Icon name="worker" />
          </a>
          <a class="button button-icon spine-item" href={SHARES_HREF} aria-current={props.sharesOpen ? "page" : undefined} title="Shares" aria-label="Shares">
            <Icon name="external" />
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
          <BrandLink />
          {/* A phone's way to the overview (§app.shell/overview): wide, it is always beside the list. */}
          <Show when={!props.unfolded}>
            <button type="button" class="button button-icon button-ghost sidebar-overview" aria-label="Overview" title="Overview" onClick={openOverview}>
              <Icon name="grid" />
            </button>
          </Show>
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
          {/* One toolbar line at every width. At rest: the count, Select, the search icon, and the
              labelled Overseer at the right end. Open: only the field and Close Search — the count
              stays in the DOM, visually hidden, as the field's description and the live count. */}
          <div class="sidebar-toolbar">
            <SearchCount hidden={toolbarOpen()} />
            <Show
              when={toolbarOpen()}
              fallback={
                <>
                  <SelectStart />
                  <button
                    ref={searchToggle}
                    type="button"
                    class="button button-icon button-ghost"
                    aria-label="Search sessions"
                    title="Search sessions · /"
                    onClick={openSearch}
                  >
                    <Icon name="search" small />
                  </button>
                  <OverseerButton class="button-ghost" labelled />
                </>
              }
            >
              <SearchField />
              <button type="button" class="button button-icon" aria-label="Close Search" title="Close Search" onClick={closeSearch}>
                <Icon name="close" />
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
                <Show when={sessionsDir()} fallback="0 sessions yet.">
                  {(dir) => (
                    <>
                      0 sessions in <code>{dir()}</code>.
                    </>
                  )}
                </Show>
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
              <p class="empty-body">We search titles, folders, models, and tags.</p>
              <button type="button" class="button empty-action" onClick={clear}>
                Clear Search
              </button>
            </div>
          </Show>

          {/* Needs you, first in the list: the sessions blocked on you, from the attention digest.
              A shortcut like Recent below it — every row is still where it lives — and flat for the
              same reason. Open by default; a collapse holds for the tab (lib/needs-you). */}
          <Show when={showNeedsYou()}>
            <details class="sidebar-region sidebar-needs-you" aria-labelledby="r-needs-you" open={needsYouRegionOpen()} onToggle={onNeedsYouToggle}>
              {/* The Groups head's pattern: the <summary> toggles, the <h2> is what the outline reads. */}
              <summary class="sidebar-needs-you-summary">
                <h2 class="sidebar-region-head" id="r-needs-you" title={needsYouTitle(needsYou().length)}>
                  <Icon name="chevron-right" small class="icon-twist" />
                  Needs you <span class="sidebar-region-count">· {needsYou().length}</span>
                </h2>
              </summary>
              <ul class="list">
                {/* Keyed on the session objects, which `hits()` keeps across polls: a row is updated
                    in place, never remounted, when only the digest changed. */}
                <For each={needsYou().map((r) => r.session)}>
                  {(s) => <SessionRow session={s} selected={props.selected} now={props.now} targets={targets()} detail={needsYouDetail(s.path)} />}
                </For>
              </ul>
              <Show when={needsYouCutNote()}>
                <p class="sidebar-region-note">Some sessions may not be listed: this list stops at the 30 most urgent items.</p>
              </Show>
            </details>
          </Show>

          {/* Recent, above everything else: a flat list, no folder sections — with 5 rows a
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

          {/* The user's own groups, above every region: the same rows and folder
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
                      `⋯` does, so a press is never read as a press on the summary. */}
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
            </details>
          </Show>

          {/* Profiles, under Groups and above Live & web (§app.session-list/profile-shelf): a shortcut, grouped by profile. Never in Recent (lib/recent). */}
          <ProfileShelf
            sessions={all()}
            cwd={props.sessions?.find((x) => x.path === props.selected)?.cwd ?? null}
            searching={!!query().trim()}
            row={(s) => <SessionRow session={s} selected={props.selected} now={props.now} targets={targets()} />}
          />

          {/* Hidden when a search empties it            </details>
          </Show>

          {/* Hidden when a search empties it; kept with a note when there's simply nothing on top. */}
          <Show when={showTop()}>
            <section class="sidebar-region" aria-labelledby="r-top">
              <h2 class="sidebar-region-head" id="r-top">
                Live &amp; web{" "}
                <span class="sidebar-region-count">
                  · {query().trim() ? `${topHits().length} of ${ordinary().length - archiveTotal()}` : topHits().length}
                </span>
                <NameSessionsButton section="t" rows={topHits()} onDone={props.onRefresh} />
              </h2>
              <Show
                when={topHits().length > 0}
                fallback={<p class="sidebar-region-note">0 sessions open in a TUI, or started here and not archived. The archive below has the rest.</p>}
              >
                <GroupList groups={topGroups()} selected={props.selected} now={props.now} idPrefix="t" targets={targets()} searching={searching()} />
              </Show>
            </section>
          </Show>

          {/* Organizations, last before the Archive (lib/org-region): the only place an org's
              sessions are listed. Its own Needs you first, then org → project → rows, each project
              in groups, each with a collapsed Done tail. Open by default; a collapse holds for the tab. */}
          <Show when={showOrgs()}>
            <details class="sidebar-region sidebar-orgs" aria-labelledby="r-orgs" open={orgsOpen()} onToggle={onOrgsToggle}>
              <summary class="sidebar-orgs-summary">
                <h2
                  class="sidebar-region-head"
                  id="r-orgs"
                  title="Hand-offs, project overseers, and the coding sessions they started, by organization and project."
                >
                  <Icon name="chevron-right" small class="icon-twist" />
                  Organizations{" "}
                  <span class="sidebar-region-count">· {searching() ? `${orgRowCount()} of ${orgTotal()}` : orgRowCount()}</span>
                  {/* Nothing waits unseen: the warn dot and count stay on the head, open or shut. */}
                  <Show when={orgWaitingCount() > 0}>
                    <span class="chip chip-warn org-needs-chip" title={waitingTitle(orgWaitingCount())}>
                      <i class="chip-dot" />
                      <span class="text-num">{orgWaitingCount()}</span> waiting
                    </span>
                  </Show>
                  <Show when={!orgsOpen() && folderActive(orgHits(), localRunning())}>
                    <span class="session-group-active" title="An agent is working in one of these sessions">
                      <span class="session-rail-dot" />
                      <span class="visually-hidden">, an agent is working here</span>
                    </span>
                  </Show>
                  <NameSessionsButton section="o" rows={orgHits()} onDone={props.onRefresh} />
                </h2>
              </summary>
              <Show when={orgWaitingCount() > 0}>
                <section class="org-needs" aria-labelledby="r-orgs-needs">
                  <h3 class="list-group-label org-needs-label" id="r-orgs-needs" title={orgNeedsTitle(orgWaitingCount())}>
                    <span class="org-needs-dot" aria-hidden="true" />
                    Needs you
                    <span class="text-num">{orgWaitingCount()}</span>
                  </h3>
                  <ul class="list">
                    <For each={orgNeedsYou().map((r) => r.session)}>
                      {(s) => (
                        <SessionRow
                          session={s}
                          selected={props.selected}
                          now={props.now}
                          targets={targets()}
                          detail={orgNeedsYouDetail(s.path)}
                          place={orgPlaceLabel(s)}
                        />
                      )}
                    </For>
                    {/* A project's own item (a held act, a conflict to settle, a stakeholder to pick): no
                        session, the row opens the project page. A held act recounts its minutes and has Cancel. */}
                    <For each={orgItems()}>
                      {(it) => {
                        // Recounted on the list's clock, read at the real time: the clock lags up to a tick, and a count must never run high.
                        const detail = () => (it.held ? heldWaitLine(it.held, Math.max(props.now, Date.now())) : it.detail);
                        return (
                          <li classList={{ "org-needs-held": !!it.held }}>
                            <a class="list-row list-row-interactive org-needs-item" href={it.href} title={detail()}>
                              <span class="list-main">
                                <span class="list-title">{it.title}</span>
                                <span class="list-meta org-needs-item-detail">{detail()}</span>
                                <span class="list-meta">{it.where}</span>
                              </span>
                            </a>
                            <Show when={it.held && it.org ? { held: it.held, orgId: it.org.orgId } : null}>
                              {(h) => <CancelHeldButton orgId={h().orgId} holdId={h().held.id} what={h().held.what} class="org-needs-cancel" />}
                            </Show>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </section>
              </Show>
              <For each={orgs()}>
                {(o) => {
                  const count = () => orgCount(o);
                  const waiting = () => waitingIn(orgRows(o));
                  return (
                    <details class="group-section org-section" open={orgOpen(o)} onToggle={(e) => onOrgToggle(o, e)}>
                      <summary class="list-group-label group-label org-label" title={orgTitle(o.name, count(), waiting())}>
                        <Icon name="chevron-right" small class="icon-twist" />
                        <span class="group-name">
                          <bdi>{o.name}</bdi>
                        </span>
                        <Show when={waiting() > 0}>
                          <span class="org-needs-dot" aria-hidden="true" />
                          <span class="visually-hidden">, {waiting()} waiting on you</span>
                        </Show>
                        <Show when={folderActive(orgRows(o), localRunning())}>
                          <span class="session-group-active" title="An agent is working in one of these sessions">
                            <span class="session-rail-dot" />
                            <span class="visually-hidden">, an agent is working here</span>
                          </span>
                        </Show>
                        <span class="text-num">{count()}</span>
                        <a
                          class="button button-icon button-ghost org-link"
                          href={orgHref(o.id)}
                          aria-label={`Open the ${o.name} page`}
                          title={`Open the ${o.name} page`}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <Icon name="arrow-right" small />
                        </a>
                      </summary>
                      <For each={o.projects}>
                        {(p) => (
                          <div class="org-project">
                            <div class="org-project-head">
                              <h4 class="list-group-label org-project-label" title={projectTitle(p)}>
                                <span class="org-project-name">
                                  <bdi>{p.name}</bdi>
                                </span>
                                <span class="text-num">{projectCount(p)}</span>
                              </h4>
                              <Show when={p.overseer}>{(po) => <OverseerEye session={po()} project={p.name} selected={props.selected} />}</Show>
                            </div>
                            <ProjectGroup
                              key={`${o.id}\n${p.id}\nconversations`}
                              label="Conversations"
                              title="Gathering sessions and offers sent to people."
                              doneTitle="Done or closed, and the ones you archived."
                              states={[
                                { label: "Not started", rows: p.conversations.notStarted },
                                { label: "In progress", rows: p.conversations.inProgress },
                              ]}
                              done={p.conversations.done}
                            />
                            <ProjectGroup
                              key={`${o.id}\n${p.id}\nconflicts`}
                              label="Conflicts to settle"
                              title="Sessions asking someone to settle two decisions that disagree."
                              doneTitle="Done or closed, and the ones you archived."
                              states={[
                                { label: "Not started", rows: p.conflicts.notStarted },
                                { label: "In progress", rows: p.conflicts.inProgress },
                              ]}
                              done={p.conflicts.done}
                            />
                            <ProjectGroup
                              key={`${o.id}\n${p.id}\nbuilds`}
                              label="Builds"
                              title="Coding sessions this project started."
                              doneTitle="Merged, and the ones you archived."
                              states={[{ label: "", rows: p.builds.active }]}
                              done={p.builds.done}
                            />
                            <Show when={p.other.length > 0}>{rowList(p.other)}</Show>
                          </div>
                        )}
                      </For>
                    </details>
                  );
                }}
              </For>
            </details>
          </Show>

          <Show when={showArchive()}>
            <details class="sidebar-region sidebar-archive" open={archiveOpen()} onToggle={onArchiveToggle}>
              <summary class="sidebar-region-head">
                <Icon name="chevron-right" small class="icon-twist" />
                <span>Archive</span>
                <span class="sidebar-region-count">
                  · {query().trim() ? `${archiveHits().length} of ${archiveTotal()}` : archiveHits().length}
                </span>
                <NameSessionsButton section="a" rows={archiveHits()} onDone={props.onRefresh} />
              </summary>
              <ForKey each={archiveSections()} by={(d) => d.id}>
                {(d) => (
                  <details class="archive-date" open={dateOpen(d())} onToggle={(e) => onDateToggle(d(), e)}>
                    <summary class="list-group-label archive-date-label">
                      <Icon name="chevron-right" small class="icon-twist" />
                      <span class="archive-date-name">{d().label}</span>
                      <span class="text-num">{d().items.length}</span>
                    </summary>
                    <GroupList groups={d().groups} selected={props.selected} now={props.now} idPrefix={`a-${d().id}`} targets={targets()} searching={searching()} />
                  </details>
                )}
              </ForKey>
              {/* Cleanup ignores the search, so it's hidden while one filters the list. */}
              <Show when={!query().trim()}>
                <ArchiveCleanup sessions={ordinary()} selected={props.selected} onDeleted={() => props.onRefresh()} />
              </Show>
            </details>
          </Show>

        </nav>
        {/* Portalled: the full-screen overlay a dragged row opens, and its New group dialog. */}
        <DropOverlay groups={sessionGroups()} counts={groupCounts()} onDrop={onOverlayDrop} onCreate={(d, name) => void createAndMove(d, name)} />

        {/* Unfolded: the foot's rows, always on screen. Folded: one 44px bar that opens them as a
            bottom sheet, verbatim (§app.insights/sidebar-foot-phone). */}
        <Show when={props.unfolded} fallback={<PhoneFoot />}>
          <div class="sidebar-foot">
            <FootRows />
          </div>
        </Show>
      </Show>
    </aside>
  );
}
