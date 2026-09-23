import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import type { GroupSeed, SessionGroup, SessionSummary, WorkerInfo } from "../../shared/protocol";
import { GROUP_LABEL_MAX } from "../../shared/protocol";
import { setSessionArchived, unassignSessionById } from "../lib/api";
import { groupHref } from "../lib/group-route";
import {
  defaultPaneWidth,
  fitPaneWidth,
  HEAD_MENU_WIDTH,
  movePane,
  neighbourOf,
  PANE_MIN_WIDTH,
  paneWidths,
  readMode,
  stepFrom,
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
  paneNames,
  quoted,
  removeGroup,
  sessionGroups,
  setGroupOrder,
  setMemberLabel,
  setSessionGroup,
  tabLabels,
} from "../lib/session-groups";
import { announce, home, setGroupComposerActive, toast } from "../lib/ui-state";
import { cwdLabel } from "../lib/remote-session";
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
import { ActionMenu, type ActionMenuApi } from "./ActionMenu";
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
  onArchiveChanged(path: string, archived: boolean): void;
  onInsight(path: string, insight: PaneInsight | null): void;
  onWorkers(path: string, workers: WorkerInfo[] | null, usage: UsageTotalView | null): void;
  onRewindControl(path: string, control: RewindControl | null): void;
  onRewound(info: { path: string; entryId: string }): void;
  /** A session a pane just created (a Fork): the app adopts and opens it. */
  onCreated(session: SessionSummary): void;
  paneOn(path: string, tab: TabId): boolean;
  openPane(path: string, tab: TabId): void;
  toggleSubagents(path: string): void;
  showTimeline(path: string, inputsOnly?: boolean): void;
  inputsOnly(): string | null;
  subagentsPath(): string | null;
  onNewSession(path: string): Promise<string | null>;
  /** Open the fanout dialog for this workspace: new members, landing here. Carries the group's
   *  `seed` when it has one, so the dialog can offer forking from the SAME point the existing
   *  members came from — "two more of these" (§14b "Entry points") — and undefined for a
   *  hand-made group, which stays destination-only. */
  onFanOut(seed?: GroupSeed): void;
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
  /**
   * The group id AS A MEMO, and every `on(gid, …)` below reads this, not `id`. Solid's `on` does
   * not equality-gate a plain accessor's result — it re-fires whenever any signal READ while
   * evaluating the accessor changes, and `() => props.group.id` reads `props.group` itself,
   * which is a fresh object every time the groups re-load. Three effects keyed on that accessor
   * therefore re-fired on EVERY background groups refresh: the one that resets `widths` threw
   * away every Wider/Narrower/Fit width ~one fetch later (measured: styles written, then reset
   * ~283ms after the click), and the one that re-reads the groups re-triggered ITSELF on its own
   * response — a standing fetch loop. The memo equality-gates on the id string, so the effects
   * fire on an actual group CHANGE, which is all any of them means.
   */
  const gid = createMemo(() => props.group.id);

  // ---- Layout --------------------------------------------------------------
  const [stored, setStored] = createSignal<GroupLayoutMode>(readMode(props.group.id) ?? "split");
  const [narrow, setNarrow] = createSignal(window.innerWidth < TABS_ONLY_WIDTH);
  /** Under this the head's tools don't fit beside the name, so they become one menu (§14). */
  const [narrowHead, setNarrowHead] = createSignal(window.innerWidth < HEAD_MENU_WIDTH);
  const [viewport, setViewport] = createSignal(window.innerWidth);
  /**
   * A pane's width, in memory only: a number the user stepped it to, or `"fit"` — the one posture
   * that follows the row (`Fit All`, §14 "Layout: split"). A number is a posture for the task at
   * hand and is kept through a resize; "fit" is a standing instruction to stand in the row with no
   * scrollbar, and is re-derived every time the row changes — a pane with no entry joins it while
   * any pane in the row is "fit" (paneWidths). Nothing here is persisted, like §1's sessions pane.
   */
  const [widths, setWidths] = createSignal<Record<string, number | "fit">>({});
  // Another group, another posture: its own remembered layout, and nobody's widths.
  createEffect(
    on(gid, (next) => {
      setStored(readMode(next) ?? "split");
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
  const rowsById = createMemo(() => new Map(rows().map((s) => [s.id, s])));
  const summaryOf = (path: string) => rows().find((m) => m.path === path);
  const labelOf = (path: string) => {
    const s = summaryOf(path);
    return s ? memberLabel(props.group, s.id) : null;
  };

  /**
   * Every summary this tab has ever seen, by session id. A member whose file vanishes keeps its
   * pane (the ghost below), and the pane keeps its NAME — "the one that read the tests" is worth
   * more than a uuid when the only thing left of the member is the registry's memory of it.
   */
  const lastSeen = new Map<string, SessionSummary>();
  createEffect(() => {
    for (const s of rows()) lastSeen.set(s.id, s);
  });

  /**
   * A list load has landed since this workspace mounted. Until one has, a group member with no
   * row is "not loaded yet", never "gone": the fanout dialog refreshes the list and navigates in
   * the same breath, and the first paint can race that refresh — a just-created member is the
   * one case "file is gone" must never be said about.
   */
  const [listSettled, setListSettled] = createSignal(false);
  createEffect(on(() => props.wiring.listVersion, () => setListSettled(true), { defer: true }));

  /**
   * The group's members whose file is gone (§14 "Member states" — gone from disk): the pane
   * STAYS, as an `.empty` with `Remove From Group`, because the assignment outlives the file on
   * purpose (the server never prunes it on the listing pass) — a member that silently drops out
   * of the row between polls is exactly the loss this state exists to prevent. Detected only
   * against the WHOLE session list, never this group's filter: a member moved to another group
   * out-of-band has no row here but a live file, and "gone" would be a lie about a session that
   * is merely elsewhere.
   */
  const ghosts = createMemo(() => {
    const members = props.group.members;
    if (!members || !listSettled()) return [];
    const anywhere = new Set(props.sessions.map((s) => s.id));
    const out: { id: string; label: string | null; seen?: SessionSummary }[] = [];
    for (const m of members) {
      if (anywhere.has(m.id)) continue;
      out.push({ id: m.id, label: m.label ?? null, seen: lastSeen.get(m.id) });
    }
    return out;
  });
  /** A ghost's pane key: the session id, in the same key space the paths live in. */
  const ghostKey = (id: string) => `gone:${id}`;
  const ghostOf = (key: string) => (key.startsWith("gone:") ? ghosts().find((g) => ghostKey(g.id) === key) : undefined);

  /**
   * The pane keys in display order: a session's path, or `gone:{id}` for a ghost. Group order
   * first (ghosts in their members[] place — the row the member held is the row its absence
   * shows in), then any summary the group's array never learned about, exactly as
   * `orderedMembers` appends them.
   */
  const panes = createMemo<string[]>(() => {
    const members = props.group.members;
    if (!members || members.length === 0) return rows().map((s) => s.path);
    const ghostIds = new Set(ghosts().map((g) => g.id));
    const byId = rowsById();
    const out: string[] = [];
    const seen = new Set<string>();
    for (const m of members) {
      const s = byId.get(m.id);
      if (s) {
        seen.add(s.id);
        out.push(s.path);
      } else if (ghostIds.has(m.id)) {
        seen.add(m.id);
        out.push(ghostKey(m.id));
      }
    }
    for (const s of rows()) if (!seen.has(s.id)) out.push(s.path);
    return out;
  });

  /**
   * The pane names (§14 "A pane"): ONE rule, shared with the tabs, implemented once in
   * `paneNames` — `{label} · {model}`, `{title} · {model}`, or for members that share a title
   * with no label (the canonical `opus ×3` fanout) the model with its `#n` ALONE. The head, the
   * pane's aria-label and the live region's prefix all read this map, so a repeat can never be
   * named differently on two surfaces — it was: the pane names had no suffix at all while the
   * tabs did, and three same-model forks were three panes with one name.
   */
  const names = createMemo(() => {
    const input = [
      ...rows().map((s) => ({ title: s.title, model: s.model, label: memberLabel(props.group, s.id) })),
      ...ghosts().map((g) => ({ title: g.seen?.title ?? "This member", model: g.seen?.model ?? null, label: g.label })),
    ];
    const text = paneNames(input);
    const out = new Map<string, string>();
    rows().forEach((s, i) => out.set(s.path, text[i] ?? s.title));
    ghosts().forEach((g, i) => out.set(ghostKey(g.id), text[rows().length + i] ?? g.seen?.title ?? "This member"));
    return out;
  });
  const nameOf = (key: string) => names().get(key) ?? "This member";

  /** What each tab shows: the first thing that tells this member apart inside the group. */
  const tabText = createMemo(() => {
    const list = [
      ...rows().map((m) => ({ title: m.title, model: m.model, label: memberLabel(props.group, m.id) })),
      ...ghosts().map((g) => ({ title: g.seen?.title ?? "This member", model: g.seen?.model ?? null, label: g.label })),
    ];
    const text = tabLabels(list);
    const out = new Map<string, string>();
    rows().forEach((m, i) => out.set(m.path, text[i] ?? m.title));
    ghosts().forEach((g, i) => out.set(ghostKey(g.id), text[rows().length + i] ?? g.seen?.title ?? "This member"));
    return out;
  });

  /**
   * The group's fork point, and the ONLY source of a marker's position: `seed` is written when
   * Sova itself fanned the group out. Lineage (`parent`/`parentId`) proves two members came from
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
   *
   * A HIDDEN pane (tabs mode) cannot be scrolled at all — `display: none` has no scroll offsets —
   * so its alignment is remembered and lands the moment the pane is shown, and the announcement
   * says that rather than counting a scroll that didn't happen. Counting it would be the
   * announcement overstating something the user cannot check.
   */
  const [pendingAlign, setPendingAlign] = createSignal<Set<string>>(new Set());
  const scrollToMarker = (path: string) => {
    const seed = props.group.seed;
    if (!seed) return false;
    const row = findEntryRow(seed.leafId, transcriptRoot(path));
    if (!row) return false;
    row.scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" });
    return true;
  };
  const alignToFork = () => {
    const seed = props.group.seed;
    if (!seed) return;
    const missed: string[] = [];
    const deferred = new Set<string>();
    let aligned = 0;
    for (const key of panes()) {
      if (ghostOf(key)) continue; // no transcript exists to align
      if (mode() === "tabs" && active() !== key) {
        deferred.add(key);
        continue;
      }
      if (!scrollToMarker(key)) missed.push(nameOf(key));
      else aligned += 1;
    }
    setPendingAlign(deferred);
    const head =
      missed.length === 0
        ? `Aligned ${aligned} ${aligned === 1 ? "member" : "members"}${deferred.size > 0 ? " now." : " to the fork point."}`
        : `Aligned ${aligned} ${aligned === 1 ? "member" : "members"}. ${missed.join(", ")} has no fork point on its branch.`;
    const tail =
      deferred.size > 0
        ? ` ${[...deferred].map(nameOf).join(", ")} will align when you open ${deferred.size === 1 ? "its" : "their"} tab.`
        : "";
    announce(head + tail);
  };
  // The deferred alignments land the moment their pane is shown: a tab switch (which is also how
  // Ctrl+Alt+←/→ arrives, through focusPane) or a return to split, where every pane is visible.
  createEffect(() => {
    const pending = pendingAlign();
    if (pending.size === 0) return;
    if (mode() === "tabs") {
      const at = active();
      if (!at || !pending.has(at) || !scrollToMarker(at)) return;
      setPendingAlign((s) => {
        const next = new Set(s);
        next.delete(at);
        return next;
      });
      return;
    }
    for (const key of [...pending]) {
      if (!scrollToMarker(key)) continue;
      setPendingAlign((s) => new Set([...s].filter((k) => k !== key)));
    }
  });

  /**
   * The focused pane. The route names it, but moving between panes only replaces the URL (it is
   * not history) and replaceState fires no hashchange — so the choice lives here, seeded from the
   * route and falling back to the first pane. Without that the focus would follow the session
   * list's order, which changes whenever a member replies.
   */
  const [wanted, setWanted] = createSignal<string | null>(props.focused);
  createEffect(on(() => props.focused, (p) => p && setWanted(p), { defer: true }));
  createEffect(on(gid, () => setWanted(null), { defer: true }));
  // The list poll eventually shows an out-of-band change (a dissolve or rename from another
  // client); a workspace mount or group switch is the one moment we KNOW the user is about to read
  // the group, so the groups are re-read right then rather than left to the poll's grace period —
  // a renamed head or a dead route id lingering past navigation reads as a bug, not staleness.
  createEffect(on(gid, () => void loadSessionGroups()));
  const active = createMemo(() => {
    const list = panes();
    const at = wanted();
    return at && list.includes(at) ? at : (list[0] ?? null);
  });

  // The route always names the focused pane, so a reload (and a copied link) comes back to it.
  createEffect(() => {
    const at = active();
    setWorkspaceFocus(at);
    // A ghost's pane key (`gone:{id}`) is not a path: it must never reach the route, where a
    // reload would read it back as a focused member that cannot be found.
    if (at && !at.startsWith("gone:") && at !== props.focused) history.replaceState(history.state, "", groupHref(id(), at));
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
  /**
   * The row's own content width, measured: what an unstepped pane fills. A ResizeObserver rather
   * than a read at render, because the row is in the document only after the render that asks for
   * this number — and because the sidebar's own resizer and the window move it without either of
   * them being a signal here. 0 until the first callback, which the observer delivers after the
   * row's first layout, before that frame paints.
   *
   * The content box, fractional, never `clientWidth`: clientWidth is rounded, and at a fractional
   * zoom it can round UP, so N floored shares of it could still pass the real row by half a pixel
   * and bring the scrollbar back. The row has no padding or border, so its content box is the row.
   * The division floors (autoPaneWidth, fitPaneWidth).
   */
  const [rowWidth, setRowWidth] = createSignal(0);
  const watchRow = (el: HTMLElement) => {
    // The observer fires once on observe, after the row's first layout and before that frame paints,
    // so the fitted width is what the first painted frame shows (a read here is too early: a ref
    // callback runs before the element is in the document).
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setRowWidth(entry.contentRect.width);
    });
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  };
  /** Every pane's width in the row right now (paneWidths: stepped, fitted, or the row's share),
      derived from what the user chose and what the row measures, never stored. */
  const paneWidthMap = createMemo(() => paneWidths(panes(), widths(), rowWidth(), viewport()));
  /**
   * A pane's width: what the user stepped it to, else what the row has room for. The two are one
   * expression on purpose — `Wider`/`Narrower` start from the number on screen, so a pane that
   * auto-fit to 560px must BE 560px here, or the first press would jump it back to 34vw.
   */
  const widthOf = (key: string) => paneWidthMap()[key] ?? defaultPaneWidth(viewport());
  const resize = (key: string, direction: 1 | -1) => {
    const now = widthOf(key);
    const next = stepFrom(now, direction);
    // No move, no announcement: a fitted (sub-floor) width is a dead end for `Narrower`, and
    // saying "narrower" over an unchanged width would be the announcement lying about the click.
    if (next === now) return;
    setWidths((m) => ({ ...m, [key]: next }));
    announce(`${nameOf(key)} — ${direction === 1 ? "wider" : "narrower"}, ${next} pixels.`);
  };
  /**
   * `Fit all` (§14 "Layout: split"): every pane to the ONE width at which they all stand in the
   * row with no scrollbar — the row's measured width (its content box, `rowWidth()`) divided by
   * the pane count, floored, and capped at `PANE_MAX_WIDTH`. The press stores the posture, not the
   * number, so that width is re-derived every time the row changes. That width is allowed below the
   * 440 floor, which nothing else is: the floor exists for
   * a transcript and a composer each on their own, and a comparison the user asked to see side by
   * side is the one thing worth trading it for (4×440 = 1760px, so a 4-way fanout never fits at
   * any viewport without this). A pane fitted under 440px carries an inline `min-width: 0`
   * alongside the width, because the stylesheet's floor would otherwise quietly re-apply (inline
   * beats it; no CSS change needed). Memory only, like every width: a posture, not a setting.
   *
   * A row nobody has stepped is already this wide (autoPaneWidth), so the press usually only says
   * the number — but it is not a no-op even then: it leaves the panes FITTED, which is the posture
   * that keeps following the row through a resize (unstepped panes also follow; a pane stepped to a
   * number does not). What it still uniquely changes is a row full of stepped widths, and the
   * widths below the floor that only this may set.
   */
  const fitAll = () => {
    const n = panes().length;
    const w = fitPaneWidth(rowWidth(), n);
    setWidths(() => {
      const next: Record<string, "fit"> = {};
      for (const key of panes()) next[key] = "fit";
      return next;
    });
    announce(`Fitted ${n} ${n === 1 ? "member" : "members"} at ${w} pixels each${w < PANE_MIN_WIDTH ? ", below the 440 floor a single pane keeps" : ""}.`);
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

  /**
   * Rename a member — the comparison's naming act (§14b "Member labels"). The useful name ("the
   * one that read the tests") is only known AFTER reading output, which is why the dialog sets no
   * label and this gesture lives in the pane that output is read in. One write, the whole-group
   * PATCH {labels}: the pane names, tabs and announcements all move in the same tick because the
   * store's copy is replaced with the server's answer. The announcement reads the NEW name — the
   * pane's accessible name just changed, and AT should hear the one that is true now.
   */
  const rename = async (path: string, label: string | null) => {
    const sess = summaryOf(path);
    if (!sess) return;
    if (!(await setMemberLabel(id(), sess.id, label))) return;
    const now = nameOf(path);
    const said = label ? `${now} — renamed.` : `${now} — label cleared.`;
    toast(label ? `Renamed to ${quoted(label)}.` : "Label cleared — the pane shows the title again.");
    announce(said);
  };

  /**
   * Takes a file-gone member out of the group: the `.empty` pane's one action. By session id,
   * because there is no file left to resolve a path through — the wire's `{ id, groupId: null }`
   * form. Everything downstream is detach's: the group may dissolve under the write (its last
   * member, Sova's own name), and that is said and routed, not inferred.
   */
  const removeGone = async (g: { id: string; label: string | null; seen?: SessionSummary }) => {
    const name = nameOf(ghostKey(g.id));
    const next = neighbourOf(panes(), ghostKey(g.id));
    let result: { dissolved?: boolean } | null = null;
    try {
      result = await unassignSessionById(g.id);
    } catch (err) {
      toast(`Couldn't remove this member. ${(err as Error).message}`);
      return;
    }
    let done = `Removed ${name} from ${quoted(props.group.name)}.`;
    if (result?.dissolved) done += ` Dissolved ${quoted(props.group.name)} — nothing was left in it.`;
    toast(done);
    announce(done);
    await loadSessionGroups(); // the member entry is the group's copy, not the list's
    props.wiring.onRefresh();
    if (result?.dissolved) {
      forgetPromoted(id());
      location.hash = "#/";
      return;
    }
    if (next && !next.startsWith("gone:")) focusPane(next, true);
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
      // Remove-only on a session Sova didn't start is the whole story, and says so: there was
      // never an archive half to leave out (§9 "Eliminate toast").
      done =
        s?.origin === "web"
          ? `Removed ${title} from ${quoted(props.group.name)}.`
          : `Removed ${title} from ${quoted(props.group.name)}. It wasn't started in Sova, so nothing was archived.`;
    } else {
      try {
        await setSessionArchived(path, true);
        props.wiring.onArchiveChanged(path, true);
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

  // ---- Completion roll-up (§14 "The workspace meta line") ------------------
  /**
   * The ids the last accepted shared send reached — the roll-up's anchor. "3 of 5 replied" is a
   * claim about a SEND, not about idle-vs-busy: without the anchor it would count members that
   * never got the message. A box send replaces the set; a partial banner's retry UNIONS it (the
   * straggler is watched alongside the ones already answering). Accepted, not answered — the
   * route returns on acceptance, and the counts move as the turns do.
   */
  const [sentTo, setSentTo] = createSignal<string[] | null>(null);
  /**
   * Per-path turn errors, each pane's own ChatView reporting its latest state (§03): a member
   * whose turn FAILED must never read as "replied" — the roll-up counts it separately, so the
   * workspace's one line cannot hide a broken member behind a progress count. Cleared by the
   * pane itself the moment a newer turn starts.
   */
  const [turnErrors, setTurnErrors] = createSignal<Record<string, string | null>>({});
  const noteTurnError = (path: string, message: string | null) =>
    setTurnErrors((m) => (m[path] === message ? m : { ...m, [path]: message }));
  const noteSent = (ids: string[], kind: "send" | "retry") =>
    setSentTo((prev) => (kind === "retry" && prev ? [...new Set([...prev, ...ids])] : ids));
  // Another group, another exchange: the roll-up is about THIS workspace's last send.
  createEffect(
    on(gid, () => {
      setSentTo(null);
      setTurnErrors({});
    }, { defer: true }),
  );
  /** Replied / working / errored over the anchored set, read live off the list and the panes. */
  const roll = createMemo(() => {
    const ids = sentTo();
    if (!ids || ids.length === 0) return null;
    const byId = rowsById();
    const errors = turnErrors();
    let replied = 0;
    let working = 0;
    let errored = 0;
    for (const mid of ids) {
      const row = byId.get(mid);
      if (row && errors[row.path] != null) errored += 1;
      else if (row && running(row)) working += 1;
      else replied += 1;
    }
    return { total: ids.length, replied, working, errored };
  });
  /** The meta line's roll-up sentence: the count first, failures always named, work last. */
  const rollLine = (): string | null => {
    const r = roll();
    if (!r) return null;
    const parts = [`${r.replied} of ${r.total} replied`];
    if (r.errored > 0) parts.push(`${r.errored} errored`);
    if (r.working > 0) parts.push(`${r.working} still working`);
    return parts.join(" · ");
  };

  /**
   * The meta line's place half: the cwd every member shares, or the count of folders when they
   * don't — "2 folders" says the comparison spans two working contexts, and the title carries the
   * full list. Read from the members, so a member that moves folders moves the line.
   */
  const cwdMeta = createMemo(() => {
    const cwds = [...new Set(rows().map((m) => m.cwd))];
    if (cwds.length === 0) return null;
    if (cwds.length === 1) {
      const one = rows().find((m) => m.cwd === cwds[0])!;
      return { label: cwdLabel(one, home()), title: one.cwd };
    }
    return { label: `${cwds.length} folders`, title: cwds.join("\n") };
  });

  // ---- Group lifecycle (head) ---------------------------------------------
  const [confirming, setConfirming] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  /**
   * Open Add Members from wherever the user is: the wide head's popover and the narrow head's
   * menu BOTH key off `adding`, so the empty state's and the partial banner's buttons work at
   * every width — under 640 no popover is mounted, and a button that flips a signal nobody
   * listens to is a dead button.
   */
  const requestAdd = () => setAdding(true);
  /** The fanout that just made this group, when some members couldn't start. */
  const partial = () => {
    const p = pendingPartial();
    return p && p.groupId === id() ? p : null;
  };
  // Another group's workspace is not where this one's report belongs.
  createEffect(on(gid, () => clearPartial(), { defer: true }));

  /**
   * Dissolve is Delete group under another word (§9): same route, but here it sits above open
   * transcripts, where "Delete" would read as deleting them. Both confirmations say the sessions
   * stay, because that is the thing a reader needs to believe before pressing it.
   */
  const dissolve = async () => {
    const n = rows().length; // files in the list; a file-gone member has nothing that stays
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
            {/* The cwd when every member shares one, else how many folders this comparison
                spans — the one fact that says "these are not the same task" (§9 "Title and meta"). */}
            <Show when={cwdMeta()}>
              {(m) => (
                <>
                  <span aria-hidden="true">·</span>
                  <span class="text-mono" title={m().title}>
                    {m().label}
                  </span>
                </>
              )}
            </Show>
            {/* The last shared send, rolled up: who has replied. Failures are always named —
                "3 of 5 replied" must never be able to hide a broken member (§14 "Member states"). */}
            <Show when={rollLine()}>
              {(line) => (
                <>
                  <span aria-hidden="true">·</span>
                  <span class="workspace-roll">{line()}</span>
                </>
              )}
            </Show>
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
              members={rows().length}
              candidates={candidates()}
              seeded={!!props.group.seed}
              onAlign={alignToFork}
              onAdd={(session) => void add(session)}
              onFanOut={() => props.wiring.onFanOut(props.group.seed)}
              onDissolve={() => void dissolve()}
              addOpen={adding()}
              onAddOpen={setAdding}
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
              {/* A fit needs at least two panes to have anything to divide, and only means
                  anything in the split row the Tabs toggle leaves standing (§14 "Layout: split"). */}
              <Show when={mode() === "split" && panes().length > 1}>
                <button
                  type="button"
                  class="button button-sm button-ghost"
                  title="Make every pane narrow enough to stand in the row side by side. Below 440px a pane trades solo reading for comparison; Wider steps back to the floor."
                  onClick={fitAll}
                >
                  Fit All
                </button>
              </Show>
            </div>
          </Show>
          {/* Absent for a group Sova didn't fan out: there is nothing to align to, and gate #10
              forbids inferring a fork point from lineage. A hand-made group that ADOPTS a seed
              gains this button, which §9 notes is adoption's one visible trace. */}
          <Show when={props.group.seed}>
            <button type="button" class="button button-sm button-ghost workspace-align" onClick={alignToFork}>
              <span class="icon icon-sm" style={{ "--icon": "url(/icons/branch.svg)" }} aria-hidden="true" />
              Align to Fork
            </button>
          </Show>
          <AddMembers
            groupName={props.group.name}
            candidates={candidates()}
            open={adding()}
            onOpen={setAdding}
            onAdd={(s) => void add(s)}
            onFanOut={() => props.wiring.onFanOut(props.group.seed)}
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
                /* The pane's own accessible name, byte for byte: the strip and the pane must
                   agree on what a member is called, and a repeat's #n is the difference between
                   three names and one (§14 "Announcements"). */
                aria-label={nameOf(path)}
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
            {/* Two empty states, and the difference is whether this group ever HAD members. A
                fanout group with none left did not fail to fill: its sessions were deleted
                outside Sova, and "no sessions yet" would be the wrong story about the same
                screen. `seed` is the only thing that tells them apart — a group Sova fanned
                out, or a hand-made one that adopted lineage. */}
            <Show
              when={props.group.seed}
              fallback={
                <div class="empty">
                  <Icon name="folder" class="empty-mark" />
                  <p class="empty-title">{quoted(props.group.name)} has no sessions yet.</p>
                  <p class="empty-body">Add some here, or drag a row onto the group in the sidebar.</p>
                  <div class="cluster">
                    <button type="button" class="button empty-action" onClick={requestAdd}>
                      <Icon name="plus" />
                      Add Members
                    </button>
                    <button type="button" class="button" onClick={() => props.wiring.onFanOut(undefined)}>
                      Fan Out…
                    </button>
                  </div>
                </div>
              }
            >
              {/* Seed + no members. The group knows those two facts and NOTHING about why, so the
                  copy must not pick a cause: this is reachable by deletion outside Sova AND by a
                  user-named group whose members were removed or promoted, files intact. The old
                  wording asserted the first, which is a falsehood in the second — and the datum
                  that would separate them doesn't exist anywhere in the group. */}
              <div class="empty">
                <Icon name="folder" class="empty-mark" />
                <p class="empty-title">{quoted(props.group.name)} has no sessions left.</p>
                <p class="empty-body">
                  They were removed from the group, or their files were deleted outside Sova. Dissolving it
                  takes the name and the fork point, and nothing else.
                </p>
                <button type="button" class="button empty-action button-destructive" onClick={() => void dissolve()}>
                  Dissolve
                </button>
              </div>
            </Show>
          </div>
        }
      >
        {/* A creation that half-worked, reported where the members are rather than where the
            dialog was: the k that started are on screen behind this. */}
        <Show when={partial()}>
          {(p) => (
            <Banner
              tone="warn"
              /* The count the DIALOG knows (`created`), never the pane count: fanning 3 into a
                 group of 2 with one failure is "2 of 3 created", not "4 of 3" — the existing
                 members were never part of this creation. */
              title={partialTitle(p().created ?? panes().length, p().planned)}
              body={
                <>
                  <For each={failureLines(p().failed)}>{(line) => <span class="fanout-fail-line">{line}</span>}</For>
                  <span>{partialClosing(p().created ?? panes().length)}</span>
                </>
              }
              action={
                <>
                  <button type="button" class="button button-sm" onClick={requestAdd}>
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
        <div class="workspace-row" data-mode={mode()} aria-label="Members" ref={watchRow}>
          <For each={panes()}>
            {(key) => {
              const paneId = paneIdFor(key);
              const ghost = ghostOf(key);
              // A member whose file is gone keeps its pane as the specced `.empty` (§14 "Member
              // states" — gone from disk): the pane disappearing between polls is silent loss, the
              // one thing this surface's whole refusal grammar exists to prevent. Still a pane in
              // every other sense — same order, same tab, same name from what this tab last saw.
              if (ghost) {
                return (
                  <section
                    class="workspace-pane"
                    id={`pane-${paneId}`}
                    classList={{ "workspace-pane-focused": active() === key }}
                    role={mode() === "tabs" ? "tabpanel" : "region"}
                    aria-label={nameOf(key)}
                    tabindex="-1"
                    hidden={mode() === "tabs" && active() !== key}
                    style={mode() === "split" ? { "--workspace-pane-w": `${widthOf(key)}px`, ...(widthOf(key) < PANE_MIN_WIDTH ? { "min-width": "0" } : {}) } : undefined}
                    onFocusIn={() => active() !== key && focusPane(key, false)}
                  >
                    <div class="center-fill">
                      <div class="empty">
                        <p class="empty-title">This session's file is gone.</p>
                        <p class="empty-body">
                          Its transcript was deleted outside Sova, so there's nothing left to read. Removing it from the
                          group is all that's left.
                        </p>
                        <button type="button" class="button empty-action" onClick={() => void removeGone(ghost)}>
                          Remove From Group
                        </button>
                      </div>
                    </div>
                  </section>
                );
              }
              const path = key;
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
                  /* A fitted width may sit below the 440 floor the stylesheet re-asserts as
                     min-width; the inline override is what lets an explicit Fit win (§14). */
                  style={
                    mode() === "split"
                      ? { "--workspace-pane-w": `${widthOf(path)}px`, ...(widthOf(path) < PANE_MIN_WIDTH ? { "min-width": "0" } : {}) }
                      : undefined
                  }
                  onFocusIn={() => active() !== path && focusPane(path, false)}
                >
                  <SessionView
                    path={path}
                    summary={summary}
                    paneId={paneId}
                    /* The pre-assembled name (repeat-suffix aware): one rule for the head, the
                       aria-label and the announcements (§14 "A pane"). */
                    name={() => nameOf(path)}
                    fork={fork()}
                    onFanOut={props.wiring.onFanOutFrom}
                    listVersion={props.wiring.listVersion}
                    now={props.wiring.now}
                    onTurnError={noteTurnError}
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
                        label={labelOf(path)}
                        standaloneHref={sessionHref(path)}
                        onWider={() => resize(path, 1)}
                        onNarrower={() => resize(path, -1)}
                        onLeft={() => void move(path, -1)}
                        onRight={() => void move(path, 1)}
                        onFocus={() => focusPane(path, true)}
                        onRename={(label) => void rename(path, label)}
                        onRemove={() => void detach(path, false)}
                        onEliminate={() => void detach(path, true)}
                        onPromote={() => void promote(path)}
                      />
                    }
                    onRefresh={props.wiring.onRefresh}
                    onArchiveChanged={props.wiring.onArchiveChanged}
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
                onCreated={props.wiring.onCreated}
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
          /* File-gone members are still members: the foot counts them so a send that the server
             refuses on one is a confirmation, not a discovery (§14 "The group composer"). */
          gone={ghosts().map((g) => g.id)}
          nameOf={(sessionId) => {
            const m = rows().find((r) => r.id === sessionId);
            if (m) return nameOf(m.path);
            const ghost = ghosts().find((g) => g.id === sessionId);
            return ghost ? nameOf(ghostKey(ghost.id)) : "This member";
          }}
          onRefresh={props.wiring.onRefresh}
          onActive={setGroupComposerActive}
          onSent={noteSent}
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
   * Eliminate's state: `null` when this session was not started in Sova (there is nothing to
   * archive, so the row is absent), `""` when it can be eliminated, and otherwise the reason it
   * can't — said before the press rather than discovered as a half-finished gesture.
   */
  eliminate: string | null;
  /** The member's label today, or null: what `Rename` starts the field from (§14b "Member labels"). */
  label: string | null;
  standaloneHref: string;
  onWider(): void;
  onNarrower(): void;
  onLeft(): void;
  onRight(): void;
  onFocus(): void;
  /** Set a label (`string`) or clear it (`null`) — the comparison's naming act. */
  onRename(label: string | null): void;
  onRemove(): void;
  onEliminate(): void;
  onPromote(): void;
}) {
  /**
   * The rename screen: the menu's one non-menu screen, same shape as the narrow head's dissolve
   * question. The field starts from the current label, `maxlength` is the wire's own
   * GROUP_LABEL_MAX, and an empty field CLEARS the label — that is the gesture's other half, and
   * a disabled Save would hide it. Enter saves, Escape cancels, both keep the menu's focus rules.
   */
  let nameInput!: HTMLInputElement;
  const startNaming = (menu: ActionMenuApi) => {
    menu.show("rename");
    queueMicrotask(() => nameInput?.focus());
  };
  const saveName = (menu: ActionMenuApi) => {
    const raw = nameInput?.value.trim() ?? "";
    menu.show(null);
    menu.run(() => props.onRename(raw.length > 0 ? raw : null), true);
  };

  return (
    <ActionMenu label={`Pane actions · ${props.name}`} title="Pane actions">
      {(menu) => (
        // The rename screen: the menu's one input, given the whole menu while it is up — the
        // same "one question at a time" shape the narrow head's dissolve ask uses. Empty CLEARS
        // the label (that half of the gesture is invisible if Save refuses it), Enter saves,
        // Escape cancels, and the field caps at the wire's GROUP_LABEL_MAX.
        <Show
          when={menu.screen() === "rename"}
          fallback={
            <div class="model-menu-list" role="menu" aria-label={`Pane actions · ${props.name}`}>
              <div class="model-menu-group" role="group" aria-label="This member">
                <menu.Item
                  label="Rename…"
                  aria={`Rename ${props.name}`}
                  title="Give this member your own name — the useful one is only known after reading its output"
                  icon={<Icon name="pencil" small />}
                  stayOpen
                  onRun={() => startNaming(menu)}
                />
              </div>
              <div class="model-menu-group" role="group" aria-label="This pane">
                <menu.Item
                  label="Open"
                  aria={`Open ${props.name}`}
                  title="Open this session on its own"
                  icon={<Icon name="external" small />}
                  keepFocus
                  onRun={() => (location.hash = props.standaloneHref)}
                />
                <Show when={props.split}>
                  <menu.Item label="Wider" aria={`Make ${props.name} wider`} icon={<Icon name="chevron-right" small />} onRun={props.onWider} />
                  <menu.Item label="Narrower" aria={`Make ${props.name} narrower`} icon={<Icon name="chevron-left" small />} onRun={props.onNarrower} />
                  <menu.Item
                    label="Move Left"
                    aria={`Move ${props.name} left`}
                    /* The keyboard hint lives where it is first needed: order moves are mouseless
                       by nature, and the row hint was nowhere in the product. */
                    title={`Swap ${props.name} with its left-hand neighbour. Ctrl+Alt+← moves focus, not the pane.`}
                    icon={<Icon name="chevron-left" small />}
                    disabled={props.first ? "It's already first." : ""}
                    onRun={props.onLeft}
                  />
                  <menu.Item
                    label="Move Right"
                    aria={`Move ${props.name} right`}
                    title={`Swap ${props.name} with its right-hand neighbour. Ctrl+Alt+→ moves focus, not the pane.`}
                    icon={<Icon name="chevron-right" small />}
                    disabled={props.last ? "It's already last." : ""}
                    onRun={props.onRight}
                  />
                </Show>
                {/* Not in §9's row list: a workspace needs a way to put the keyboard in a pane that
                    doesn't depend on reaching its composer, which a read-only member doesn't have. */}
                <menu.Item label="Focus" aria={`Focus ${props.name}`} icon={<Icon name="chat" small />} keepFocus onRun={props.onFocus} />
              </div>
              <div class="model-menu-group" role="group" aria-label="This session's membership">
                <menu.Item
                  label="Promote"
                  aria={`Promote ${props.name}`}
                  title={`Take it out of ${quoted(props.groupName)} and open it on its own`}
                  icon={<Icon name="arrow-right" small />}
                  keepFocus
                  onRun={props.onPromote}
                />
                <menu.Item
                  label="Remove From Group"
                  aria={`Remove ${props.name} from the group`}
                  title={
                    props.eliminate === null
                      ? "This session wasn't started in Sova, so removing it is all we can do — nothing is archived"
                      : `Take it out of ${quoted(props.groupName)} and stay here. Nothing is archived and nothing is deleted`
                  }
                  icon={<Icon name="close" small />}
                  keepFocus
                  onRun={props.onRemove}
                />
                {/* Absent, not disabled, when the session wasn't started in Sova: there is nothing
                    to archive, and it is a different gesture rather than a refusal. */}
                <Show when={props.eliminate !== null}>
                  <menu.Item
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
          }
        >
          <div class="model-menu-list">
            <div class="group-menu-field">
              <input
                ref={nameInput}
                class="input"
                type="text"
                aria-label={`Name ${props.name}`}
                maxlength={GROUP_LABEL_MAX}
                placeholder={props.name}
                value={props.label ?? ""}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveName(menu);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    menu.dismiss(); // Escape means "leave this screen AND the menu", as everywhere else
                  }
                }}
              />
            </div>
            <div class="cluster">
              <button type="button" class="button button-sm" onClick={() => saveName(menu)}>
                Save
              </button>
              <button
                type="button"
                class="button button-sm button-ghost"
                onClick={() => {
                  menu.show(null);
                  menu.focusTrigger();
                }}
              >
                Cancel
              </button>
            </div>
            <p class="sidebar-region-note">Empty clears the label — the pane shows the title again.</p>
          </div>
        </Show>
      )}
    </ActionMenu>
  );
}

/**
 * One menu row, keyboard-complete: a menuitem is not a button, and a row that answers only to a
 * pointer is invisible to AT. Shared by the pane-head picker's ad-hoc rows so Enter and Space
 * work everywhere this file draws a menu (the same gap the narrow head had).
 */
function MenuRow(props: { aria: string; title?: string; icon?: JSX.Element; onRun(): void; close?: () => void; children: JSX.Element }) {
  return (
    <div
      class="mode-option group-option"
      role="menuitem"
      tabindex={0}
      aria-label={props.aria}
      title={props.title}
      onClick={() => {
        props.close?.();
        props.onRun();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        props.close?.();
        props.onRun();
      }}
    >
      {props.icon}
      <span class="mode-option-text">{props.children}</span>
    </div>
  );
}

/**
 * The addable sessions, filtered by the same search at every width (§14 "Group lifecycle"):
 * ungrouped first — adding those costs nothing — then ones a press would move out of another
 * group, each naming the group it leaves. One implementation for both heads, because the narrow
 * head used to lose the search and silently cap at 40 rows, which is a different picker wearing
 * the same label. `Fan Out…` rides last, carrying the group's seed so the dialog can offer
 * forking from the members' own starting point ("two more of these", §14b "Entry points").
 */
function MemberPicker(props: {
  groupName: string;
  candidates: SessionSummary[];
  onAdd(session: SessionSummary): void;
  onFanOut(seed?: GroupSeed): void;
  /** Closes the popover the picker lives in, before the fanout dialog opens over it. */
  close(): void;
}) {
  const [query, setQuery] = createSignal("");

  /** Ungrouped first, then the ones a press would move out of another group. */
  const rows = createMemo(() => {
    const q = query().trim().toLowerCase();
    const hits = q ? props.candidates.filter((s) => s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)) : props.candidates;
    return [...hits.filter((s) => !s.groupId), ...hits.filter((s) => s.groupId)];
  });

  return (
    <>
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
              <MenuRow
                aria={`Add ${session.title} to ${quoted(props.groupName)}`}
                onRun={() => props.onAdd(session)}
              >
                <span class="mode-option-id">{session.title}</span>
                {/* Naming the group it would leave is the whole warning: adding moves it. */}
                <Show when={session.groupId}>
                  <span class="mode-option-note">in {quoted(groupNameOf(sessionGroups(), session.groupId) ?? "another group")}</span>
                </Show>
              </MenuRow>
            )}
          </For>
        </Show>
        {/* Adding an existing session moves it; this makes new ones. Last row, so the cheap
            gesture comes first and the creating one is a deliberate reach. */}
        <div class="model-menu-group" role="group" aria-label="Or make new members">
          <MenuRow
            aria={`Fan out into ${quoted(props.groupName)}`}
            icon={<span class="icon icon-sm" style={{ "--icon": "url(/icons/branch.svg)" }} aria-hidden="true" />}
            onRun={() => props.onFanOut()}
            close={props.close}
          >
            <span class="mode-option-id">Fan Out…</span>
          </MenuRow>
        </div>
      </div>
    </>
  );
}

/**
 * The §2 group popover in reverse (spec/14-workspaces.md "Group lifecycle"): instead of choosing a
 * group for one session, it chooses a session for this group. The body is `MemberPicker`, shared
 * with the narrow head's menu so both widths offer the same search, the same list and the same
 * last row.
 */
function AddMembers(props: {
  groupName: string;
  /** Every session not already in this group, in the list's own order. */
  candidates: SessionSummary[];
  open: boolean;
  onOpen(open: boolean): void;
  onAdd(session: SessionSummary): void;
  /** The last row: make new members instead of moving existing ones (§14b "Entry points"). */
  onFanOut(seed?: GroupSeed): void;
}) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;

  const close = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const openMenu = () => {
    const r = trigger.getBoundingClientRect();
    menu.style.setProperty("--menu-top", `${Math.round(r.bottom + 4)}px`);
    menu.style.setProperty("--menu-right", `${Math.max(0, Math.round(innerWidth - r.right))}px`);
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
        <MemberPicker
          groupName={props.groupName}
          candidates={props.candidates}
          onAdd={props.onAdd}
          onFanOut={props.onFanOut}
          close={close}
        />
      </div>
    </>
  );
}

/**
 * The head's tools as one menu, under 640px (spec/14-workspaces.md "Shell"). Same actions, same
 * order, same words — and now the same Add Members PICKER the wide head has, not a truncated
 * list: the spec's "filtered by the same search" holds at every width, and `addOpen` is the same
 * signal the empty state's and the partial banner's buttons flip, so Add Members works from
 * anywhere at any width.
 *
 * Dissolve asks INSIDE the menu here, rather than in the head: at this width the head has no room
 * for the question, and the reassurance it carries — the sessions stay in the list — is the half a
 * reader most needs before pressing it. A confirm with its question cut off is not one.
 */
function HeadActions(props: {
  groupName: string;
  members: number;
  candidates: SessionSummary[];
  /** The group has a fork point, so Align to Fork is offered — same rule as the wide head. */
  seeded: boolean;
  onAdd(session: SessionSummary): void;
  onAlign(): void;
  onFanOut(seed?: GroupSeed): void;
  onDissolve(): void;
  /** The shared Add Members state: flips true from OUTSIDE the head (empty state, partial
   *  banner), and the menu answers by opening straight into the picker. */
  addOpen: boolean;
  onAddOpen(open: boolean): void;
}) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const [asking, setAsking] = createSignal(false);
  const [picking, setPicking] = createSignal(false);

  const close = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  /** One opener, one target: the menu opens INTO a state (its rows, or the picker), because
   *  openMenu-then-set-state resets the very state the opener just asked for — the bug shape of
   *  a setter called before the displayer that re-initializes it. */
  const openInto = (pick: boolean) => {
    const r = trigger.getBoundingClientRect();
    menu.style.setProperty("--menu-top", `${Math.round(r.bottom + 4)}px`);
    menu.style.setProperty("--menu-right", `${Math.max(0, Math.round(innerWidth - r.right))}px`);
    setAsking(false);
    setPicking(pick);
    menu.showPopover();
    queueMicrotask(() =>
      (pick ? menu.querySelector<HTMLInputElement>("input") : menu.querySelector<HTMLElement>("[role=menuitem]"))?.focus(),
    );
  };
  const openMenu = () => openInto(false);
  const openPicking = () => openInto(true);

  createEffect(() => {
    if (props.addOpen && !picking()) openPicking();
    if (!props.addOpen && picking() && menu.matches(":popover-open")) close();
  });

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
            props.onAddOpen(false);
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
          <MemberPicker
            groupName={props.groupName}
            candidates={props.candidates}
            onAdd={props.onAdd}
            onFanOut={props.onFanOut}
            close={close}
          />
        </Show>
        <Show when={!asking() && !picking()}>
          <div class="model-menu-list" role="menu" aria-label={`Actions for ${quoted(props.groupName)}`}>
            <Show when={props.seeded}>
              <MenuRow
                aria={`Align every pane of ${quoted(props.groupName)} to its fork point`}
                icon={<span class="icon icon-sm" style={{ "--icon": "url(/icons/branch.svg)" }} aria-hidden="true" />}
                onRun={props.onAlign}
                close={close}
              >
                <span class="mode-option-id">Align to Fork</span>
              </MenuRow>
            </Show>
            <MenuRow aria={`Add a session to ${quoted(props.groupName)}`} icon={<Icon name="plus" small />} onRun={() => openPicking()}>
              <span class="mode-option-id">Add Members</span>
            </MenuRow>
            <MenuRow
              aria={`Fan out into ${quoted(props.groupName)}`}
              icon={<span class="icon icon-sm" style={{ "--icon": "url(/icons/branch.svg)" }} aria-hidden="true" />}
              onRun={() => props.onFanOut()}
              close={close}
            >
              <span class="mode-option-id">Fan Out…</span>
            </MenuRow>
            <MenuRow aria={`Dissolve ${quoted(props.groupName)}`} icon={<Icon name="close" small />} onRun={() => setAsking(true)}>
              <span class="mode-option-id">Dissolve</span>
            </MenuRow>
          </div>
        </Show>
      </div>
    </>
  );
}
