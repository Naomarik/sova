import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import type { SessionGroup, SessionSummary, WorkerInfo } from "../../shared/protocol";
import { setSessionArchived } from "../lib/api";
import { shortModel } from "../lib/format";
import { groupHref } from "../lib/group-route";
import {
  defaultPaneWidth,
  HEAD_MENU_WIDTH,
  movePane,
  neighbourOf,
  readMode,
  stepWidth,
  TABS_ONLY_WIDTH,
  writeMode,
  type GroupLayoutMode,
} from "../lib/group-layout";
import type { RewindControl } from "../lib/inputs";
import {
  groupNameOf,
  loadSessionGroups,
  memberLabel,
  orderedMembers,
  quoted,
  removeGroup,
  sessionGroups,
  setGroupOrder,
  setSessionGroup,
  tabLabels,
} from "../lib/session-groups";
import { announce, setGroupComposerActive, toast } from "../lib/ui-state";
import { failureLines, partialClosing, partialTitle } from "../lib/fanout";
import { findEntryRow, transcriptRoot } from "../lib/jump";
import { clearPartial, pendingPartial } from "./FanoutDialog";
import { sessionWorking, type UsageTotalView } from "../lib/workers";
import type { PaneInsight, TabId } from "./SessionPane";
import { sessionHref } from "./Sidebar";
import { SessionView } from "./SessionView";
import { GroupComposer } from "./GroupComposer";
import type { FanoutSource } from "./FanoutDialog";
import type { ForkMarker } from "./Thread";
import { Banner, Icon } from "./ui";

/**
 * A pane's id, issued once per session path and kept for as long as the tab lives: it suffixes
 * every DOM id inside the pane, so Move Left must not renumber the view, and a member that leaves
 * and comes back finds its own ids again (spec/14-workspaces.md "A pane"). The path itself can't
 * be the id — it is long and full of characters an id shouldn't carry.
 */
const paneIds = new Map<string, string>();
let paneSeq = 0;
export function paneIdFor(path: string): string {
  let id = paneIds.get(path);
  if (!id) {
    id = `p${++paneSeq}`;
    paneIds.set(path, id);
  }
  return id;
}

/** The composer of a pane, for the focus moves. A disabled (read-only) one takes no focus. */
const composerOf = (path: string) => document.getElementById(`composer-input-${paneIdFor(path)}`) as HTMLTextAreaElement | null;

/**
 * The last Promote, per group: what the head's `Promoted: {title}` chip offers to undo. Module
 * state, so walking to the promoted session and back still finds the offer — that walk is when
 * a promote made by mistake is noticed. Never persisted: it is an undo for the gesture, not a
 * record of it, so a reload drops it (spec/14-workspaces.md "Group lifecycle").
 */
const [promoted, setPromoted] = createSignal<Record<string, { path: string; id: string; title: string; label: string | null; index: number }>>({});
const forgetPromoted = (groupId: string) =>
  setPromoted((m) => {
    if (!(groupId in m)) return m;
    const next = { ...m };
    delete next[groupId];
    return next;
  });

/**
 * The pane the workspace has focused, for the app shell outside it — the skip link's target, and
 * which session the shell treats as "the one on screen". It can't be read off the route: moving
 * between panes only REPLACES the URL (focus is not history), and replaceState fires no
 * hashchange, so a route-derived answer would name the pane you left.
 */
const [workspaceFocus, setWorkspaceFocus] = createSignal<string | null>(null);
export { workspaceFocus };

/** Never animate a scroll for someone who asked us not to (§0); read per call, not cached. */
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Whether a member is mid-turn: what the tab's live dot and Eliminate's refusal both read. */
const running = (s: SessionSummary | undefined) => !!s && (s.busy || sessionWorking(s) > 0);

/** What SessionView needs from App, forwarded through the workspace unchanged. */
export interface PaneWiring {
  listVersion: number;
  now: number;
  onRefresh(): void;
  onInsight(path: string, insight: PaneInsight | null): void;
  onWorkers(path: string, workers: WorkerInfo[] | null, usage: UsageTotalView | null): void;
  onRewindControl(path: string, control: RewindControl | null): void;
  onRewound(info: { path: string; entryId: string }): void;
  paneOn(path: string, tab: TabId): boolean;
  openPane(path: string, tab: TabId): void;
  toggleSubagents(path: string): void;
  showTimeline(path: string, inputsOnly?: boolean): void;
  inputsOnly(): string | null;
  subagentsPath(): string | null;
  onNewSession(path: string): Promise<string | null>;
  /** Open the fanout dialog with no source: new members for this workspace. */
  onFanOut(): void;
  /** Open it on one member, to fork THAT session (the pane flyout's "Fan Out…"). */
  onFanOutFrom(source: FanoutSource): void;
}

/**
 * A group as a workspace (spec/14-workspaces.md): every member side by side, each pane a whole
 * session view with its own transcript, composer and socket. `split` is one horizontally scrolled
 * row; `tabs` shows one member at a time and keeps the rest mounted, so a turn that lands while
 * you read another member is not lost. Under 768px there is no room for a split row, so the
 * workspace is tabs whatever is remembered.
 *
 * Membership and member ORDER are the server's (`SessionGroup.members`, the assignments map) and
 * change only through the group routes. What lives in this component is posture: which layout,
 * how wide a pane is, and which pane has the keyboard.
 */
export function GroupView(props: {
  group: SessionGroup;
  /** The group's sessions, from the session list; this puts them in the group's own order. */
  members: SessionSummary[];
  /** Every session, for Add Members: what this group could take in. */
  sessions: SessionSummary[];
  /** The pane the route names, or null when it names none. */
  focused: string | null;
  wiring: PaneWiring;
}) {
  const id = () => props.group.id;

  // ---- Layout --------------------------------------------------------------
  const [stored, setStored] = createSignal<GroupLayoutMode>(readMode(props.group.id) ?? "split");
  const [narrow, setNarrow] = createSignal(window.innerWidth < TABS_ONLY_WIDTH);
  /** Under this the head's tools don't fit beside the name, so they become one menu (§14). */
  const [narrowHead, setNarrowHead] = createSignal(window.innerWidth < HEAD_MENU_WIDTH);
  const [viewport, setViewport] = createSignal(window.innerWidth);
  /** Pane widths the user stepped, in memory only: a width is a posture for the task at hand. */
  const [widths, setWidths] = createSignal<Record<string, number>>({});
  // Another group, another posture: its own remembered layout, and nobody's widths.
  createEffect(
    on(id, (gid) => {
      setStored(readMode(gid) ?? "split");
      setWidths({});
    }, { defer: true }),
  );

  const onResize = () => {
    setNarrow(window.innerWidth < TABS_ONLY_WIDTH);
    setNarrowHead(window.innerWidth < HEAD_MENU_WIDTH);
    setViewport(window.innerWidth);
  };
  window.addEventListener("resize", onResize);
  onCleanup(() => {
    window.removeEventListener("resize", onResize);
    setGroupComposerActive(false); // nothing left to collapse under
  });

  /** What is remembered, unless the viewport is too narrow for a row of panes. */
  const mode = (): GroupLayoutMode => (narrow() ? "tabs" : stored());
  const setMode = (next: GroupLayoutMode) => {
    setStored(next);
    writeMode(id(), next);
    announce(next === "split" ? "Split view." : "Tabs.");
  };

  // ---- Members -------------------------------------------------------------
  /** The group's sessions in the group's own display order. */
  const rows = createMemo(() => orderedMembers(props.members, props.group));
  const panes = createMemo(() => rows().map((s) => s.path));
  const summaryOf = (path: string) => rows().find((m) => m.path === path);
  const labelOf = (path: string) => {
    const s = summaryOf(path);
    return s ? memberLabel(props.group, s.id) : null;
  };
  /** The pane's name, the same string the pane head shows and AT reads: "{label|title} · {model}". */
  const nameOf = (path: string) => {
    const s = summaryOf(path);
    const name = labelOf(path) || s?.title || "Session";
    const model = shortModel(s?.model);
    return model ? `${name} · ${model}` : name;
  };

  /** What each tab shows: the first thing that tells this member apart inside the group. */
  const tabText = createMemo(() => {
    const list = rows().map((m) => ({ title: m.title, model: m.model, label: memberLabel(props.group, m.id) }));
    const text = tabLabels(list);
    return new Map(rows().map((m, i) => [m.path, text[i] ?? m.title]));
  });

  /**
   * The group's fork point, and the ONLY source of a marker's position: `seed` is written when
   * pi-web itself fanned the group out. Lineage (`parent`/`parentId`) proves two members came from
   * one session but not WHICH entry they diverged at, so a hand-made group of forks gets no marker
   * — a marker in the wrong place is a false claim about what is shared (gate #10, §14 "Data").
   */
  const fork = createMemo<ForkMarker | undefined>(() => {
    const seed = props.group.seed;
    if (!seed) return undefined;
    const source = props.sessions.find((x) => x.path === seed.parentSessionPath);
    return {
      entryId: seed.leafId,
      title: source?.title ?? "the source session",
      // The source can be archived, renamed or gone; a missing file renders as plain text.
      path: source ? source.path : null,
    };
  });

  /**
   * Scroll every pane so its fork marker sits at the top of its scroll region. A pane whose branch
   * no longer holds the leaf (rewound past it) is left where it is and named in the announcement —
   * we never guess at a position. It is a scroll, not a state: nothing is pinned afterwards.
   */
  const alignToFork = () => {
    const seed = props.group.seed;
    if (!seed) return;
    const missed: string[] = [];
    let aligned = 0;
    for (const path of panes()) {
      const row = findEntryRow(seed.leafId, transcriptRoot(path));
      if (!row) {
        missed.push(nameOf(path));
        continue;
      }
      row.scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" });
      aligned += 1;
    }
    announce(
      missed.length === 0
        ? `Aligned ${aligned} ${aligned === 1 ? "member" : "members"} to the fork point.`
        : `Aligned ${aligned} ${aligned === 1 ? "member" : "members"}. ${missed.join(", ")} has no fork point on its branch.`,
    );
  };

  /**
   * The focused pane. The route names it, but moving between panes only replaces the URL (it is
   * not history) and replaceState fires no hashchange — so the choice lives here, seeded from the
   * route and falling back to the first pane. Without that the focus would follow the session
   * list's order, which changes whenever a member replies.
   */
  const [wanted, setWanted] = createSignal<string | null>(props.focused);
  createEffect(on(() => props.focused, (p) => p && setWanted(p), { defer: true }));
  createEffect(on(id, () => setWanted(null), { defer: true }));
  const active = createMemo(() => {
    const list = panes();
    const at = wanted();
    return at && list.includes(at) ? at : (list[0] ?? null);
  });

  // The route always names the focused pane, so a reload (and a copied link) comes back to it.
  createEffect(() => {
    const at = active();
    setWorkspaceFocus(at);
    if (at && at !== props.focused) history.replaceState(history.state, "", groupHref(id(), at));
  });
  onCleanup(() => setWorkspaceFocus(null));

  /**
   * Focus moves the user asked for (a tab, the pane menu, Ctrl+Alt+←/→) put the keyboard in that
   * pane and scroll it into view. Arriving at the workspace does not: the page has just loaded,
   * and stealing focus would fight a reader on its way through the head.
   */
  const focusPane = (path: string, moveFocus: boolean) => {
    if (!path) return;
    setWanted(path);
    if (!moveFocus) return;
    queueMicrotask(() => {
      const section = document.getElementById(`pane-${paneIdFor(path)}`);
      // A read-only member (TUI-owned, archived) has a disabled composer, which takes no focus at
      // all: the pane's own region does, so the keyboard still lands in the right pane.
      const composer = composerOf(path);
      (composer && !composer.disabled ? composer : section)?.focus();
      section?.scrollIntoView({ inline: "nearest", block: "nearest" });
      announce(`${nameOf(path)} — focused.`);
    });
  };

  /**
   * Ctrl+Alt+←/→ walks the row. Alt+Arrow is browser history and Ctrl+Arrow is word navigation in
   * every one of the N textareas on screen, so this is the binding left. It is registered while a
   * workspace is mounted and torn down with it, so it exists nowhere else in the product — on the
   * window rather than the row, because the press is just as meaningful with the focus still in
   * the workspace head or on a tab.
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.ctrlKey || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    const list = panes();
    const next = list[list.indexOf(active() ?? "") + (e.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    focusPane(next, true);
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  // ---- Pane actions --------------------------------------------------------
  const widthOf = (path: string) => widths()[path] ?? defaultPaneWidth(viewport());
  const resize = (path: string, direction: 1 | -1) => {
    const next = stepWidth(widthOf(path), direction);
    setWidths((m) => ({ ...m, [path]: next }));
    announce(`${nameOf(path)} — ${direction === 1 ? "wider" : "narrower"}, ${next} pixels.`);
  };

  /** Move Left / Move Right send the WHOLE order — that is what `PATCH {order}` means. */
  const move = async (path: string, direction: 1 | -1) => {
    const s = summaryOf(path);
    if (!s) return;
    const order = movePane(rows().map((m) => m.id), s.id, direction);
    const at = order.indexOf(s.id);
    if (!(await setGroupOrder(id(), order))) return;
    announce(`${nameOf(path)} — moved ${direction === 1 ? "right" : "left"}, position ${at + 1} of ${order.length}.`);
    // The thing you moved is the thing you are still looking at.
    queueMicrotask(() => document.getElementById(`pane-${paneIdFor(path)}`)?.scrollIntoView({ inline: "nearest", block: "nearest" }));
  };

  /** Takes the session out of the group — and, for Eliminate, archives it in the same gesture. */
  const detach = async (path: string, archive: boolean) => {
    const s = summaryOf(path);
    const title = s?.title ?? "this session";
    const next = neighbourOf(panes(), path);
    const result = await setSessionGroup(path, null);
    if (!result) return;
    let done: string;
    if (!archive) {
      // Remove-only on a session pi-web didn't start is the whole story, and says so: there was
      // never an archive half to leave out (§9 "Eliminate toast").
      done =
        s?.origin === "web"
          ? `Removed ${title} from ${quoted(props.group.name)}.`
          : `Removed ${title} from ${quoted(props.group.name)}. It wasn't started in pi-web, so nothing was archived.`;
    } else {
      try {
        await setSessionArchived(path, true);
        done = `Removed ${title} and archived it.`;
      } catch (err) {
        // The genuine race the pre-disabled rows can't cover: a turn started between the check and
        // the write. Both halves, and the server's own reason for the one that failed.
        done = `Removed ${title} from ${quoted(props.group.name)}, but couldn't archive it. ${(err as Error).message}`;
      }
    }
    // The server deleted this group in the same write (its last member left a fanout group), so
    // the route no longer names anything: say both things at once and leave.
    if (result.dissolved) done += ` Dissolved ${quoted(props.group.name)} — nothing was left in it.`;
    toast(done);
    announce(done);
    props.wiring.onRefresh();
    if (result.dissolved) {
      forgetPromoted(id());
      location.hash = "#/";
      return;
    }
    if (next) focusPane(next, true);
  };

  /** Promote: the member you picked is the answer, so it leaves the group and opens on its own. */
  const promote = async (path: string) => {
    const s = summaryOf(path);
    const title = s?.title ?? "this session";
    // Captured BEFORE the write, because ungrouping drops the member entry: without the label and
    // the place, Add Back would put the pane back nameless and at the end.
    const undo = { path, id: s?.id ?? "", title, label: labelOf(path), index: panes().indexOf(path) };
    const result = await setSessionGroup(path, null);
    if (!result) return;
    setPromoted((m) => ({ ...m, [id()]: undo }));
    props.wiring.onRefresh();
    let done = `Took ${title} out of ${quoted(props.group.name)}.`;
    if (result.dissolved) done += ` Dissolved ${quoted(props.group.name)} — nothing was left in it.`;
    toast(done);
    if (result.dissolved) forgetPromoted(id());
    location.hash = sessionHref(path);
  };

  /**
   * Undo the last Promote: one write that restores the member's label AND its place, because a
   * restore that half-works is worse than one that fails cleanly. A server that ignores `index`
   * lands it at the end, which the toast then says rather than claiming a place it didn't get.
   */
  const addBack = async () => {
    const undo = promoted()[id()];
    if (!undo) return;
    const result = await setSessionGroup(undo.path, id(), { label: undo.label ?? undefined, index: undo.index });
    if (!result) {
      toast(`Couldn't put this session back. ${quoted(props.group.name)} is unchanged.`);
      return;
    }
    forgetPromoted(id());
    props.wiring.onRefresh();
    // The server's own answer, not a guess: where did it actually land?
    await loadSessionGroups();
    const at = sessionGroups().find((g) => g.id === id())?.members?.findIndex((m) => m.id === undo.id);
    const back = `Put ${undo.title} back in ${quoted(props.group.name)}.`;
    const done = at !== undefined && at >= 0 && at !== undo.index ? `${back} It's at the end.` : back;
    toast(done);
    announce(done);
    focusPane(undo.path, true);
  };

  // ---- Group lifecycle (head) ---------------------------------------------
  const [confirming, setConfirming] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  /** The fanout that just made this group, when some members couldn't start. */
  const partial = () => {
    const p = pendingPartial();
    return p && p.groupId === id() ? p : null;
  };
  // Another group's workspace is not where this one's report belongs.
  createEffect(on(id, () => clearPartial(), { defer: true }));

  /**
   * Dissolve is Delete group under another word (§9): same route, but here it sits above open
   * transcripts, where "Delete" would read as deleting them. Both confirmations say the sessions
   * stay, because that is the thing a reader needs to believe before pressing it.
   */
  const dissolve = async () => {
    const n = panes().length;
    const name = props.group.name;
    setConfirming(false);
    if (!(await removeGroup(id()))) return;
    forgetPromoted(id());
    props.wiring.onRefresh();
    toast(
      n === 0
        ? `Dissolved ${quoted(name)}. It had no sessions.`
        : `Dissolved ${quoted(name)}. Its ${n} ${n === 1 ? "session is" : "sessions are"} ungrouped.`,
    );
    location.hash = "#/"; // the route no longer names anything
  };

  /** Sessions this group could take in: everything that isn't already in it. */
  const candidates = createMemo(() => props.sessions.filter((s) => s.groupId !== id()));

  const add = async (session: SessionSummary) => {
    setAdding(false);
    const from = session.groupId ? groupNameOf(sessionGroups(), session.groupId) : null;
    if (!(await setSessionGroup(session.path, id()))) return;
    props.wiring.onRefresh();
    toast(from ? `Moved ${session.title} from ${quoted(from)} to ${quoted(props.group.name)}.` : `Added ${session.title} to ${quoted(props.group.name)}.`);
    focusPane(session.path, true);
  };

  return (
    <>
      <header class="workspace-head">
        <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">
          <Icon name="chevron-left" />
        </a>
        <div class="workspace-head-main">
          <h1 class="workspace-title" tabindex="-1" title={props.group.name}>
            <bdi>{props.group.name}</bdi>
          </h1>
          <p class="workspace-meta">
            <span class="workspace-count">
              {panes().length} {panes().length === 1 ? "member" : "members"}
            </span>
          </p>
        </div>
        {/* An undo for the gesture that just emptied a pane, for as long as this tab remembers
            it. It carries the label and the position, so the pane comes back named what it was
            called and where it was. */}
        <Show when={promoted()[id()]}>
          {(undo) => (
            <span class="chip chip-count workspace-promoted" title={`${undo().title} was taken out of ${quoted(props.group.name)}`}>
              Promoted: {undo().title}
              <button type="button" class="button button-sm button-ghost" onClick={() => void addBack()}>
                Add Back
              </button>
            </span>
          )}
        </Show>
        {/* Wide enough for the tools to stand beside the name; under 640 they become one menu,
            because a row that sheds buttons as it narrows hides a different one at every width. */}
        <Show
          when={!narrowHead()}
          fallback={
            <HeadActions
              groupName={props.group.name}
              members={panes().length}
              candidates={candidates()}
              onAdd={(session) => void add(session)}
              onFanOut={props.wiring.onFanOut}
              onDissolve={() => void dissolve()}
            />
          }
        >
          {/* Below the split band there is nothing to toggle: 440px of pane doesn't fit beside
              anything, and a stored split preference is ignored rather than cleared. */}
          <Show when={!narrow()}>
            <div class="workspace-modes">
              <button
                type="button"
                class="button button-sm button-ghost"
                aria-pressed={mode() === "tabs"}
                title="Show one member at a time. The others keep running."
                onClick={() => setMode(mode() === "tabs" ? "split" : "tabs")}
              >
                Tabs
              </button>
            </div>
          </Show>
          <AddMembers
            groupName={props.group.name}
            candidates={candidates()}
            open={adding()}
            onOpen={setAdding}
            onAdd={(s) => void add(s)}
            onFanOut={props.wiring.onFanOut}
          />
          {/* Asked in place, in the head, like the sidebar's Delete group asks in its tool row. */}
          <Show
            when={confirming()}
            fallback={
              <button type="button" class="button button-sm button-ghost" onClick={() => setConfirming(true)}>
                Dissolve
              </button>
            }
          >
            <span class="workspace-dissolve">
              <span class="workspace-dissolve-question">
                {panes().length === 0
                  ? `Dissolve ${quoted(props.group.name)}? Nothing is in it.`
                  : `Dissolve ${quoted(props.group.name)}? Its ${panes().length} ${panes().length === 1 ? "session stays" : "sessions stay"} in the list.`}
              </span>
              <button type="button" class="button button-sm button-destructive" onClick={() => void dissolve()}>
                Dissolve
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          </Show>
        </Show>
      </header>

      <Show when={mode() === "tabs" && panes().length > 0}>
        <div class="workspace-tabs" role="tablist" aria-label="Members">
          <For each={panes()}>
            {(path) => (
              <button
                type="button"
                class="workspace-tab"
                role="tab"
                id={`ws-tab-${paneIdFor(path)}`}
                aria-selected={active() === path}
                aria-controls={`pane-${paneIdFor(path)}`}
                tabindex={active() === path ? 0 : -1}
                title={nameOf(path)}
                aria-label={`${labelOf(path) || summaryOf(path)?.title}${shortModel(summaryOf(path)?.model) ? `, ${shortModel(summaryOf(path)?.model)}` : ""}`}
                onClick={() => focusPane(path, true)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                  const list = panes();
                  const next = list[list.indexOf(path) + (e.key === "ArrowRight" ? 1 : -1)];
                  if (!next) return;
                  e.preventDefault();
                  focusPane(next, false);
                  document.getElementById(`ws-tab-${paneIdFor(next)}`)?.focus();
                }}
              >
                <span class="workspace-tab-title">{tabText().get(path)}</span>
                {/* The one sign of a pane that is mounted but not shown: a member mid-turn. */}
                <Show when={running(summaryOf(path))}>
                  <span class="live-dot" />
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={panes().length > 0}
        fallback={
          <div class="center-fill">
            <div class="empty">
              <Icon name="folder" class="empty-mark" />
              <p class="empty-title">{quoted(props.group.name)} has no sessions yet.</p>
              <p class="empty-body">Add some here, or drag a row onto the group in the sidebar.</p>
              <div class="cluster">
                <button type="button" class="button empty-action" onClick={() => setAdding(true)}>
                  <Icon name="plus" />
                  Add Members
                </button>
                <button type="button" class="button" onClick={props.wiring.onFanOut}>
                  Fan Out…
                </button>
              </div>
            </div>
          </div>
        }
      >
        {/* A creation that half-worked, reported where the members are rather than where the
            dialog was: the k that started are on screen behind this. */}
        <Show when={partial()}>
          {(p) => (
            <Banner
              tone="warn"
              title={partialTitle(panes().length, p().planned)}
              body={
                <>
                  <For each={failureLines(p().failed)}>{(line) => <span class="fanout-fail-line">{line}</span>}</For>
                  <span>{partialClosing(panes().length)}</span>
                </>
              }
              action={
                <>
                  <button type="button" class="button button-sm" onClick={() => setAdding(true)}>
                    Add Members
                  </button>
                  <button type="button" class="button button-sm button-ghost" onClick={clearPartial}>
                    Dismiss
                  </button>
                </>
              }
            />
          )}
        </Show>
        <div class="workspace-row" data-mode={mode()} aria-label="Members">
          <For each={panes()}>
            {(path) => {
              const paneId = paneIdFor(path);
              // The list can stop carrying a row for an instant; the pane keeps the last summary
              // it had rather than tearing itself down under the user.
              let last = summaryOf(path)!;
              const summary = () => (last = summaryOf(path) ?? last);
              return (
                <section
                  class="workspace-pane"
                  id={`pane-${paneId}`}
                  classList={{ "workspace-pane-focused": active() === path }}
                  role={mode() === "tabs" ? "tabpanel" : "region"}
                  /* Named the same in both modes, never by its tab: the live region's prefix IS
                     this string, and a name assembled differently per mode makes that prefix
                     byte-for-byte right in one of them and merely similar in the other. The tab's
                     aria-controls already ties the two together. */
                  aria-label={nameOf(path)}
                  tabindex="-1"
                  hidden={mode() === "tabs" && active() !== path}
                  style={mode() === "split" ? { "--workspace-pane-w": `${widthOf(path)}px` } : undefined}
                  onFocusIn={() => active() !== path && focusPane(path, false)}
                >
                  <SessionView
                    path={path}
                    summary={summary}
                    paneId={paneId}
                    label={() => labelOf(path)}
                    fork={fork()}
                    onFanOut={props.wiring.onFanOutFrom}
                    listVersion={props.wiring.listVersion}
                    now={props.wiring.now}
                    actions={
                      <PaneMenu
                        name={nameOf(path)}
                        groupName={props.group.name}
                        split={mode() === "split"}
                        first={panes()[0] === path}
                        last={panes()[panes().length - 1] === path}
                        eliminate={
                          summary().origin !== "web"
                            ? null
                            : summary().live
                              ? "This session is open in a terminal."
                              : running(summary())
                                ? "It's mid-turn. Stop it or wait, then eliminate it."
                                : ""
                        }
                        standaloneHref={sessionHref(path)}
                        onWider={() => resize(path, 1)}
                        onNarrower={() => resize(path, -1)}
                        onLeft={() => void move(path, -1)}
                        onRight={() => void move(path, 1)}
                        onFocus={() => focusPane(path, true)}
                        onRemove={() => void detach(path, false)}
                        onEliminate={() => void detach(path, true)}
                        onPromote={() => void promote(path)}
                      />
                    }
                    onRefresh={props.wiring.onRefresh}
                    onInsight={props.wiring.onInsight}
                    onWorkers={props.wiring.onWorkers}
                    onRewindControl={props.wiring.onRewindControl}
                    onRewound={props.wiring.onRewound}
                    paneOn={props.wiring.paneOn}
                    openPane={props.wiring.openPane}
                    toggleSubagents={props.wiring.toggleSubagents}
                    showTimeline={props.wiring.showTimeline}
                    inputsOnly={props.wiring.inputsOnly}
                    subagentsPath={props.wiring.subagentsPath}
                    onNewSession={props.wiring.onNewSession}
                  />
                </section>
              );
            }}
          </For>
        </div>
        {/* One composer for the whole workspace, under the row it writes to. Not rendered with no
            members: there is nobody to send to, and §14 says so rather than showing a dead box. */}
        <GroupComposer
          groupId={id()}
          members={rows()}
          nameOf={(sessionId) => {
            const m = rows().find((r) => r.id === sessionId);
            return m ? nameOf(m.path) : "This member";
          }}
          onRefresh={props.wiring.onRefresh}
          onActive={setGroupComposerActive}
        />
      </Show>
    </>
  );
}

/**
 * One pane's tools (spec/14-workspaces.md "A pane"), as a menu: at 440px a row of seven buttons
 * is not a thing a pane head can hold. What can be done to the pane (width, place, focus, open on
 * its own) and to its membership — three separate words on purpose: Promote takes it out and
 * opens it, Eliminate takes it out and archives it, Remove From Group only takes it out.
 */
function PaneMenu(props: {
  /** The pane's name, so every row here says which member it acts on. */
  name: string;
  /** The group's name, which the membership rows' titles quote. */
  groupName: string;
  /** Width and order only mean something in the split row. */
  split: boolean;
  first: boolean;
  last: boolean;
  /**
   * Eliminate's state: `null` when this session was not started in pi-web (there is nothing to
   * archive, so the row is absent), `""` when it can be eliminated, and otherwise the reason it
   * can't — said before the press rather than discovered as a half-finished gesture.
   */
  eliminate: string | null;
  standaloneHref: string;
  onWider(): void;
  onNarrower(): void;
  onLeft(): void;
  onRight(): void;
  onFocus(): void;
  onRemove(): void;
  onEliminate(): void;
  onPromote(): void;
}) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);

  const close = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const openMenu = () => {
    const r = trigger.getBoundingClientRect();
    // Same anchoring as the group menu, and inline for the same reason: `.model-menu`'s
    // `inset: auto; top: var(--menu-top)` is declared after any class that would move it.
    const up = innerHeight - r.bottom < 320;
    menu.style.setProperty("--menu-top", `${Math.round(r.bottom + 4)}px`);
    menu.style.setProperty("--menu-right", `${Math.max(0, Math.round(innerWidth - r.right))}px`);
    menu.style.top = up ? "auto" : "";
    menu.style.bottom = up ? `${Math.round(innerHeight - r.top + 4)}px` : "";
    menu.showPopover();
    queueMicrotask(() => menu.querySelector<HTMLElement>("[role=menuitem]")?.focus());
  };
  /** Every row closes the menu; the ones that move focus themselves don't take it back. */
  const run = (act: () => void, keepFocus = false) => {
    close();
    if (!keepFocus) trigger.focus();
    act();
  };

  const Item = (p: {
    label: string;
    /** The row's accessible name: every row says which member it acts on (§9 "Pane tool aria-labels"). */
    aria: string;
    title?: string;
    icon: JSX.Element;
    disabled?: string;
    onRun(): void;
    keepFocus?: boolean;
  }) => (
    <div
      class="mode-option group-option"
      role="menuitem"
      tabindex={0}
      aria-label={p.aria}
      aria-disabled={p.disabled ? "true" : undefined}
      title={p.disabled || p.title || undefined}
      onClick={() => !p.disabled && run(p.onRun, p.keepFocus)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (!p.disabled) run(p.onRun, p.keepFocus);
      }}
    >
      {p.icon}
      <span class="mode-option-text">
        <span class="mode-option-id">{p.label}</span>
        <Show when={p.disabled}>
          <span class="mode-option-note">{p.disabled}</span>
        </Show>
      </span>
    </div>
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="button button-icon button-ghost"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-label={`Pane actions · ${props.name}`}
        title="Pane actions"
        onClick={() => (open() ? close() : openMenu())}
      >
        <Icon name="more" />
      </button>
      <div ref={menu} class="model-menu group-menu" popover="auto" onToggle={(e) => setOpen((e as ToggleEvent).newState === "open")}>
        <div class="model-menu-list" role="menu" aria-label={`Pane actions · ${props.name}`}>
          <div class="model-menu-group" role="group" aria-label="This pane">
            <Item
              label="Open"
              aria={`Open ${props.name}`}
              title="Open this session on its own"
              icon={<Icon name="external" small />}
              keepFocus
              onRun={() => (location.hash = props.standaloneHref)}
            />
            <Show when={props.split}>
              <Item label="Wider" aria={`Make ${props.name} wider`} icon={<Icon name="chevron-right" small />} onRun={props.onWider} />
              <Item label="Narrower" aria={`Make ${props.name} narrower`} icon={<Icon name="chevron-left" small />} onRun={props.onNarrower} />
              <Item
                label="Move Left"
                aria={`Move ${props.name} left`}
                icon={<Icon name="chevron-left" small />}
                disabled={props.first ? "It's already first." : ""}
                onRun={props.onLeft}
              />
              <Item
                label="Move Right"
                aria={`Move ${props.name} right`}
                icon={<Icon name="chevron-right" small />}
                disabled={props.last ? "It's already last." : ""}
                onRun={props.onRight}
              />
            </Show>
            {/* Not in §9's row list: a workspace needs a way to put the keyboard in a pane that
                doesn't depend on reaching its composer, which a read-only member doesn't have. */}
            <Item label="Focus" aria={`Focus ${props.name}`} icon={<Icon name="chat" small />} keepFocus onRun={props.onFocus} />
          </div>
          <div class="model-menu-group" role="group" aria-label="This session's membership">
            <Item
              label="Promote"
              aria={`Promote ${props.name}`}
              title={`Take it out of ${quoted(props.groupName)} and open it on its own`}
              icon={<Icon name="arrow-right" small />}
              keepFocus
              onRun={props.onPromote}
            />
            <Item
              label="Remove From Group"
              aria={`Remove ${props.name} from the group`}
              title={
                props.eliminate === null
                  ? "This session wasn't started in pi-web, so removing it is all we can do — nothing is archived"
                  : `Take it out of ${quoted(props.groupName)} and stay here. Nothing is archived and nothing is deleted`
              }
              icon={<Icon name="close" small />}
              keepFocus
              onRun={props.onRemove}
            />
            {/* Absent, not disabled, when the session wasn't started in pi-web: there is nothing
                to archive, and it is a different gesture rather than a refusal. */}
            <Show when={props.eliminate !== null}>
              <Item
                label="Eliminate"
                aria={`Eliminate ${props.name}`}
                title={`Take it out of ${quoted(props.groupName)} and archive it. The transcript stays; unarchiving brings it back`}
                icon={<Icon name="archive" small />}
                disabled={props.eliminate!}
                keepFocus
                onRun={props.onEliminate}
              />
            </Show>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The §2 group popover in reverse (spec/14-workspaces.md "Group lifecycle"): instead of choosing a
 * group for one session, it chooses a session for this group. Ungrouped sessions come first,
 * because those are the ones adding costs nothing; a session already in another group is offered
 * too, with the group it would LEAVE named on the row — adding it moves it, and one group per
 * session is the rule that makes "this session's workspace" a fact.
 */
function AddMembers(props: {
  groupName: string;
  /** Every session not already in this group, in the list's own order. */
  candidates: SessionSummary[];
  open: boolean;
  onOpen(open: boolean): void;
  onAdd(session: SessionSummary): void;
  /** The last row: make new members instead of moving existing ones (§14b "Entry points"). */
  onFanOut(): void;
}) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const [query, setQuery] = createSignal("");

  /** Ungrouped first, then the ones a press would move out of another group. */
  const rows = createMemo(() => {
    const q = query().trim().toLowerCase();
    const hits = q ? props.candidates.filter((s) => s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)) : props.candidates;
    return [...hits.filter((s) => !s.groupId), ...hits.filter((s) => s.groupId)];
  });

  const close = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const openMenu = () => {
    const r = trigger.getBoundingClientRect();
    menu.style.setProperty("--menu-top", `${Math.round(r.bottom + 4)}px`);
    menu.style.setProperty("--menu-right", `${Math.max(0, Math.round(innerWidth - r.right))}px`);
    menu.style.top = "";
    menu.style.bottom = "";
    setQuery("");
    menu.showPopover();
    queueMicrotask(() => menu.querySelector<HTMLInputElement>("input")?.focus());
  };

  createEffect(() => {
    if (props.open && !menu.matches(":popover-open")) openMenu();
    if (!props.open) close();
  });

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="button button-sm button-ghost"
        aria-haspopup="menu"
        aria-expanded={props.open ? "true" : "false"}
        onClick={() => props.onOpen(!props.open)}
      >
        Add Members
      </button>
      <div
        ref={menu}
        class="model-menu group-menu"
        popover="auto"
        aria-label={`Add a session to ${quoted(props.groupName)}`}
        onToggle={(e) => props.onOpen((e as ToggleEvent).newState === "open")}
      >
        <div class="model-menu-search">
          <div class="search">
            <Icon name="search" />
            <input
              class="input"
              type="text"
              aria-label="Search sessions"
              placeholder="Title or folder"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
        </div>
        <div class="model-menu-list" role="menu" aria-label={`Add a session to ${quoted(props.groupName)}`}>
          <Show
            when={rows().length > 0}
            fallback={
              <p class="sidebar-region-note">
                {props.candidates.length === 0 ? "Every session is already in a group." : "No session matches."}
              </p>
            }
          >
            <For each={rows()}>
              {(session) => (
                <div
                  class="mode-option group-option"
                  role="menuitem"
                  tabindex={0}
                  onClick={() => props.onAdd(session)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    props.onAdd(session);
                  }}
                >
                  <span class="mode-option-text">
                    <span class="mode-option-id">{session.title}</span>
                    {/* Naming the group it would leave is the whole warning: adding moves it. */}
                    <Show when={session.groupId}>
                      <span class="mode-option-note">in {quoted(groupNameOf(sessionGroups(), session.groupId) ?? "another group")}</span>
                    </Show>
                  </span>
                </div>
              )}
            </For>
          </Show>
          {/* Adding an existing session moves it; this makes new ones. Last row, so the cheap
              gesture comes first and the creating one is a deliberate reach. */}
          <div class="model-menu-group" role="group" aria-label="Or make new members">
            <div
              class="mode-option group-option"
              role="menuitem"
              tabindex={0}
              onClick={() => {
                props.onOpen(false);
                props.onFanOut();
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                props.onOpen(false);
                props.onFanOut();
              }}
            >
              <span class="icon icon-sm" style={{ "--icon": "url(/icons/branch.svg)" }} aria-hidden="true" />
              <span class="mode-option-text">
                <span class="mode-option-id">Fan Out…</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The head's tools as one menu, under 640px (spec/14-workspaces.md "Shell"). Same actions, same
 * order, same words — only the container changes, because a row that drops controls as it narrows
 * hides a different one at every width and the user can't learn which.
 *
 * Dissolve asks INSIDE the menu here, rather than in the head: at this width the head has no room
 * for the question, and the reassurance it carries — the sessions stay in the list — is the half a
 * reader most needs before pressing it. A confirm with its question cut off is not one.
 */
function HeadActions(props: {
  groupName: string;
  members: number;
  candidates: SessionSummary[];
  onAdd(session: SessionSummary): void;
  onFanOut(): void;
  onDissolve(): void;
}) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const [asking, setAsking] = createSignal(false);
  const [picking, setPicking] = createSignal(false);

  const close = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const openMenu = () => {
    const r = trigger.getBoundingClientRect();
    menu.style.setProperty("--menu-top", `${Math.round(r.bottom + 4)}px`);
    menu.style.setProperty("--menu-right", `${Math.max(0, Math.round(innerWidth - r.right))}px`);
    setAsking(false);
    setPicking(false);
    menu.showPopover();
    queueMicrotask(() => menu.querySelector<HTMLElement>("[role=menuitem]")?.focus());
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="button button-icon button-ghost"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        /* The word is §9's, but the name says WHICH thing it acts on: three pane composers on this
           page already carry a "More Actions" trigger (§4b), and four identically named controls
           are four indistinguishable ones to AT. Same shape spec blessed for the pane menu. */
        aria-label={`More Actions · ${props.groupName}`}
        title="More Actions"
        onClick={() => (open() ? close() : openMenu())}
      >
        <Icon name="more" />
      </button>
      <div
        ref={menu}
        class="model-menu group-menu"
        popover="auto"
        onToggle={(e) => {
          const isOpen = (e as ToggleEvent).newState === "open";
          setOpen(isOpen);
          if (!isOpen) {
            setAsking(false);
            setPicking(false);
          }
        }}
      >
        <Show when={asking()}>
          <div class="group-tools">
            <p class="group-tools-question">
              {props.members === 0
                ? `Dissolve ${quoted(props.groupName)}? Nothing is in it.`
                : `Dissolve ${quoted(props.groupName)}? Its ${props.members} ${props.members === 1 ? "session stays" : "sessions stay"} in the list.`}
            </p>
            <button
              type="button"
              class="button button-sm button-destructive"
              onClick={() => {
                close();
                props.onDissolve();
              }}
            >
              Dissolve
            </button>
            <button type="button" class="button button-sm button-ghost" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </Show>
        <Show when={picking()}>
          <div class="model-menu-list" role="menu" aria-label={`Add a session to ${quoted(props.groupName)}`}>
            <Show
              when={props.candidates.length > 0}
              fallback={<p class="sidebar-region-note">Every session is already in a group.</p>}
            >
              <For each={props.candidates.slice(0, 40)}>
                {(session) => (
                  <div
                    class="mode-option group-option"
                    role="menuitem"
                    tabindex={0}
                    onClick={() => {
                      close();
                      props.onAdd(session);
                    }}
                  >
                    <span class="mode-option-text">
                      <span class="mode-option-id">{session.title}</span>
                      <Show when={session.groupId}>
                        <span class="mode-option-note">in {quoted(groupNameOf(sessionGroups(), session.groupId) ?? "another group")}</span>
                      </Show>
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
        <Show when={!asking() && !picking()}>
          <div class="model-menu-list" role="menu" aria-label={`Actions for ${quoted(props.groupName)}`}>
            <div class="mode-option group-option" role="menuitem" tabindex={0} onClick={() => setPicking(true)}>
              <Icon name="plus" small />
              <span class="mode-option-text">
                <span class="mode-option-id">Add Members</span>
              </span>
            </div>
            <div
              class="mode-option group-option"
              role="menuitem"
              tabindex={0}
              onClick={() => {
                close();
                props.onFanOut();
              }}
            >
              <span class="icon icon-sm" style={{ "--icon": "url(/icons/branch.svg)" }} aria-hidden="true" />
              <span class="mode-option-text">
                <span class="mode-option-id">Fan Out…</span>
              </span>
            </div>
            <div class="mode-option group-option" role="menuitem" tabindex={0} onClick={() => setAsking(true)}>
              <Icon name="close" small />
              <span class="mode-option-text">
                <span class="mode-option-id">Dissolve</span>
              </span>
            </div>
          </div>
        </Show>
      </div>
    </>
  );
}
