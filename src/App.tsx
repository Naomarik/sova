import { batch, createEffect, createMemo, createResource, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Portal } from "solid-js/web";
import type { SessionInsight, SessionSummary, TeamInfo, WorkerInfo } from "../shared/protocol";
import { createSession, fetchAgents, fetchExplanations, fetchSessionInsight, fetchUsage, getThemes, listSessions, setSessionArchived } from "./lib/api";
import { agentsHref, insightsRouteFromHash, legacyInsightsTarget } from "./lib/insights";
import { createThenArchive, dropArchived, newSessionCwd } from "./lib/new-session";
import { cwdLabel } from "./lib/remote-session";
import { createPoll } from "./lib/poll";
import { homeFromSessionPath, shortModel } from "./lib/format";
import { reconcileTheme } from "./lib/theme";
import type { RewindControl } from "./lib/inputs";
import { activeTab, home, setActiveTab, setHome, toast } from "./lib/ui-state";
import { sessionWorking, type UsageTotalView, workingSplit } from "./lib/workers";
import { ChatView, type ChatRefusal } from "./components/ChatView";
import { AgentsView } from "./components/AgentsView";
import { ContextGauge, ContextMetaPrefix, contextDescribedBy } from "./components/ContextGauge";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { ExplainGrid } from "./components/ExplainGallery";
import { InsightStrip } from "./components/InsightStrip";
import { RemoteChip, RemoteHeadChip } from "./components/RemoteStatus";
import { SessionPane, type PaneInsight, type TabId } from "./components/SessionPane";
import { sessionHref, Sidebar } from "./components/Sidebar";
import { SidebarResizer } from "./components/SidebarResizer";
import { UsageView } from "./components/UsageView";
import { WatchView } from "./components/WatchView";
import { Banner, Chip, CountChip, GlobalRegions, Icon } from "./components/ui";

/** Why a session is open read-only. */
type WatchWhy = "tui" | "recent";

/** How the open session is shown. Decided once when it's opened, then changed only by events. */
type Decision =
  | { path: string; mode: "chat"; force: boolean; autofocus?: boolean }
  | { path: string; mode: "watch"; why: WatchWhy; ageSec?: number; listVersion: number };

function pathFromHash(): string | null {
  const m = /^#\/s\/(.+)$/.exec(location.hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/**
 * Insights moved from one `#/insights` page to `#/usage` and `#/agents`. Old links are swapped in
 * place: replaceState adds no history entry (so Back skips the dead URL) and fires no hashchange;
 * callers parse the hash right after.
 */
function redirectLegacyInsights() {
  const to = legacyInsightsTarget(location.hash);
  if (to) history.replaceState(history.state, "", to);
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title &&
  a.lastActiveAt === b.lastActiveAt &&
  a.model === b.model &&
  a.outlineNow === b.outlineNow &&
  a.outlineAt === b.outlineAt &&
  a.live?.pid === b.live?.pid &&
  a.live?.status === b.live?.status &&
  a.live?.workers?.working === b.live?.workers?.working &&
  a.live?.workers?.total === b.live?.workers?.total &&
  a.archived === b.archived &&
  // A group change touches neither the file nor the title: without this the row keeps its old
  // object and a session just dragged into a group would never leave Live & web.
  a.groupId === b.groupId;

/** Keeps the previous object for unchanged rows so <For> updates the list in place (focus survives). */
function reuseUnchanged(next: SessionSummary[], prev: SessionSummary[] | undefined): SessionSummary[] {
  if (!prev) return next;
  const old = new Map(prev.map((s) => [s.path, s]));
  return next.map((s) => {
    const o = old.get(s.path);
    return o && sameSummary(o, s) ? o : s;
  });
}

/** While a session is watched, poll the list so live status (and TUI exit) shows up on its own. */
const WATCH_POLL_MS = 10_000;

/** While a run is in flight, re-read the list often enough that the Busy chip clears itself when
    the run settles in a session nobody is looking at. Idle costs nothing: the interval only
    exists while something is busy. */
const BUSY_POLL_MS = 5_000;

/** Insights polling (paused while the tab is hidden). The usage file itself changes ≤ every 3 min. */
const USAGE_POLL_MS = 60_000;
const AGENTS_POLL_MS = 5_000;
/** The explanations store only changes when a /explain subagent finishes; the sidebar row can wait. */
const EXPLAIN_POLL_MS = 60_000;
/** Session insight (outline, teams) reloads this long after the session's file last changed. */
const SESSION_INSIGHT_DEBOUNCE_MS = 1500;
/** While the session pane is open, its worker status and file paths refresh this often. */
const PANE_INSIGHT_POLL_MS = 3000;

const folded = () => window.matchMedia("(max-width: 767px)").matches;

/** The compact worker chip says its count in words for AT and on hover: "3 subagents working now". */
const subagentsWorkingNow = (n: number) => `${n} ${n === 1 ? "subagent" : "subagents"} working now`;

export function App() {
  const [listError, setListError] = createSignal<string | null>(null);
  /** Bumped on every successful list load, so views can tell a fresh list from a stale one. */
  const [listVersion, setListVersion] = createSignal(0);
  /** Sessions we just created: shown before the list catches up, and — because a never-sent one
      is a hidden husk — the row (and the open view's summary) it keeps while this tab lives. */
  const created = new Map<string, SessionSummary>();
  /** Bumped when `created` gains an entry: the Map isn't reactive, and the new row must show now. */
  const [createdVersion, setCreatedVersion] = createSignal(0);
  /**
   * The open session's summary, kept when a list reload stops carrying it (see the fetcher): a
   * never-sent session whose draft was just cleared is a hidden husk again, and emptying the
   * composer must not pull the open view out from under the user. The view only — the sidebar
   * stays the list's truth, so the row does go away — and the next route change drops this.
   */
  const [openKept, setOpenKept] = createSignal<SessionSummary | null>(null);
  // The fetcher never rejects: on failure it keeps the previous list and reports the error,
  // so reading the resource never throws.
  const [sessions, { refetch }] = createResource<SessionSummary[] | undefined>(async (_, { value }) => {
    try {
      const next = reuseUnchanged(await listSessions(), value);
      // An open never-sent session stays readable when a later list drops it: clearing its draft to
      // empty makes it a hidden husk again, and the view must not vanish with the row. Only then —
      // a titled session that leaves the list really is gone, and says so. Later loads don't undo
      // this: the summary is kept until the route moves to another session.
      const open = pathFromHash();
      const openNow = open ? next.find((s) => s.path === open) : undefined;
      if (openNow) setOpenKept(openNow.title === "Untitled" ? openNow : null);
      setListError(null);
      setListVersion((v) => v + 1);
      const h = next[0] && homeFromSessionPath(next[0].path);
      if (h) setHome(h);
      return next;
    } catch (err) {
      setListError((err as Error).message);
      return value;
    }
  });
  const list = () => sessions.latest; // keeps the old list on screen while refreshing
  /**
   * The sidebar's rows: the server list plus the sessions this tab created that the server does
   * not carry — a new session is a hidden husk until its first user message or a stored draft, so
   * until then this is where its row comes from. A path on both lists takes the server's row
   * (that one carries the draft preview), and clearing a draft to empty leaves the open session
   * readable — through `created` here, or `openKept` for one this tab didn't start.
   */
  const sidebarSessions = createMemo(() => {
    createdVersion();
    const l = list();
    if (!l || created.size === 0) return l;
    const listed = new Set(l.map((s) => s.path));
    const extra = [...created.values()].filter((s) => !listed.has(s.path));
    return extra.length ? [...l, ...extra] : l;
  });

  redirectLegacyInsights();
  const [route, setRoute] = createSignal<string | null>(pathFromHash());
  createEffect(
    on(route, (p) => {
      const kept = openKept();
      if (kept && kept.path !== p) setOpenKept(null);
    }),
  );
  const [insightsRoute, setInsightsRoute] = createSignal(insightsRouteFromHash(location.hash));
  /** Team card to scroll to on `#/agents/<teamId>`. */
  const focusTeam = () => {
    const r = insightsRoute();
    return r?.page === "agents" ? r.team : null;
  };
  // The theme has been on the document since before first paint, out of the localStorage cache
  // (main.tsx). This is the one check that it still exists: an id whose file was deleted, renamed
  // or broken falls back to dark (§0). A fetch that fails changes nothing — an unreachable server
  // is not a reason to lose the theme you picked.
  void getThemes()
    .then(reconcileTheme)
    .catch(() => {});
  const usage = createPoll(fetchUsage, USAGE_POLL_MS);
  const agents = createPoll(fetchAgents, AGENTS_POLL_MS);
  const explanations = createPoll(fetchExplanations, EXPLAIN_POLL_MS);
  /** The landing page renders the grid only when it has rows; the empty state stays in the modal. */
  const explained = createMemo(() => {
    const items = explanations.data();
    return items && items.length > 0 ? items : null;
  });
  const [decision, setDecision] = createSignal<Decision | null>(null);
  const [creating, setCreating] = createSignal(false);
  /** The Settings modal, opened from the sidebar foot's gear. */
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [chatModel, setChatModel] = createSignal<string | null>(null);
  /** The open chat's rewind, for the Timeline's input rows; tagged with its path, so a pane for
      another session never gets it. */
  const [rewindControl, setRewindControl] = createSignal<RewindControl | null>(null);
  /**
   * The newest rewind that landed in a chat, whoever asked for it (a Timeline row, the composer's
   * Undo last turn). `changed` is minted here and only grows, like PaneInsight.changed: the pane
   * re-reads its rows on a bump, so two rewinds to the same message still refresh. A refusal never
   * gets here, so it changes nothing. The path gates the fan-out: one session's rewind must never
   * refresh another's pane.
   */
  const [rewound, setRewound] = createSignal<{ path: string; entryId: string; changed: number } | null>(null);
  const noteRewound = (info: { path: string; entryId: string }) =>
    setRewound((prev) => ({ path: info.path, entryId: info.entryId, changed: (prev?.changed ?? 0) + 1 }));
  const [now, setNow] = createSignal(Date.now());

  const refresh = () => void refetch();
  const onFocus = () => {
    setNow(Date.now());
    refresh();
  };
  const onHash = () => {
    redirectLegacyInsights();
    setRoute(pathFromHash());
    setInsightsRoute(insightsRouteFromHash(location.hash));
  };
  window.addEventListener("focus", onFocus);
  window.addEventListener("hashchange", onHash);
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("hashchange", onHash);
    clearInterval(tick);
  });

  const summary = createMemo(() => {
    const p = route();
    if (!p) return null;
    const kept = openKept(); // only for the session on screen; see where it is set
    return list()?.find((s) => s.path === p) ?? created.get(p) ?? (kept?.path === p ? kept : null);
  });

  /**
   * Default for a freshly opened session: TUI-owned → read-only; else try chat without force.
   * The server is the authority on unknown writers: it refuses with code "recent" (before hello,
   * so nothing can be sent) and we fall back to read-only with Chat Anyway.
   */
  const defaultDecision = (s: SessionSummary): Decision =>
    s.live ? { path: s.path, mode: "watch", why: "tui", listVersion: listVersion() } : { path: s.path, mode: "chat", force: false };

  // Decide once per opened session, as soon as its summary is known.
  createEffect(() => {
    const p = route();
    const s = summary();
    if (!p) return setDecision(null);
    if (!s || decision()?.path === p) return;
    setChatModel(null);
    setDecision(defaultDecision(s));
  });

  // At folded width, opening a session swaps the column: move focus to its title.
  let titleEl: HTMLHeadingElement | undefined;
  createEffect(on(route, (p) => p && folded() && queueMicrotask(() => titleEl?.focus()), { defer: true }));
  let insightsTitleEl: HTMLHeadingElement | undefined;
  // A team deep link focuses its card instead (AgentsView), at every width.
  createEffect(
    on(() => insightsRoute()?.page, (page) => page && !focusTeam() && folded() && queueMicrotask(() => insightsTitleEl?.focus()), { defer: true }),
  );

  /** Opens a session we just created: chat right away, composer focused. */
  const adoptCreated = (s: SessionSummary) => {
    created.set(s.path, s);
    setCreatedVersion((v) => v + 1);
    setCreating(false);
    refresh();
    // Route and decision move together: "hashchange" fires later, and until then the decide
    // effect would pair this decision with the old route and replace it, autofocus and all.
    location.hash = sessionHref(s.path);
    batch(() => {
      onHash();
      setDecision({ path: s.path, mode: "chat", force: false, autofocus: true });
    });
  };

  /**
   * An Archive/Unarchive landed (the chat's own gesture, the pane's, the info modal's). An archived
   * session leaves the server's list — a message-less one is deleted outright — so the row this tab
   * froze at creation has to go with it, or the sidebar keeps a row for a session that is gone.
   * Off the dead session first: the route change unmounts its view before the refetched list can
   * pull the summary out from under it.
   */
  const onArchived = (path: string, archived: boolean) => {
    if (archived && route() === path) {
      location.hash = "#/";
      batch(onHash);
    }
    if (dropArchived(created, path, archived)) setCreatedVersion((v) => v + 1);
    refresh();
  };

  /**
   * A bare "/new" typed in `source` (§4d): a new session in the same folder, then `source` goes to
   * the Archive. Resolves to the folder label once the new session exists, null if none was made.
   * Only web-spawned sessions can be archived; one with subagents working stays open, since
   * archiving closes its runtime and they'd die with it.
   */
  const startNewFrom = async (source: string): Promise<string | null> => {
    const s = summary();
    const cwd = newSessionCwd(s?.cwd, list() ?? []);
    if (!cwd) {
      toast("No folder to start in. Pick one.");
      setCreating(true);
      return null;
    }
    const workersBusy = (s ? sessionWorking(s) > 0 : false) || (chatWorkers.path === source && chatWorkers.list.some((w) => w.working));
    const archivable = s?.origin === "web" && !workersBusy;
    const out = await createThenArchive(cwd, archivable ? source : null, {
      create: createSession,
      archive: (path) => setSessionArchived(path, true),
    });
    if (!out.ok) {
      toast(`Couldn't start a new session. ${out.error}`);
      return null;
    }
    // The source was archived: drop its frozen row too, else the husk lingers beside the new one.
    if (archivable && !out.archiveError) dropArchived(created, source, true);
    if (out.archiveError) toast(`New session started, but the previous one couldn't be archived. ${out.archiveError}`);
    else if (s?.origin === "web" && workersBusy) toast("New session started. The previous one stays open while its subagents work.");
    adoptCreated(out.session);
    return cwdLabel(out.session, home());
  };

  const openChat = (force: boolean) => {
    const d = decision();
    if (d) setDecision({ path: d.path, mode: "chat", force, autofocus: true });
  };
  const onRefused = (kind: ChatRefusal) => {
    const d = decision();
    if (!d) return;
    refresh();
    const s = summary();
    const age = s ? Math.round((Date.now() - Date.parse(s.lastActiveAt)) / 1000) : NaN;
    setDecision({
      path: d.path,
      mode: "watch",
      why: kind === "busy" ? "tui" : "recent",
      ageSec: Number.isFinite(age) && age >= 0 ? age : undefined,
      listVersion: listVersion(),
    });
  };

  // Remount the view (and its socket) when the session, mode, or force flag changes.
  const viewKey = createMemo(() => {
    const d = decision();
    if (!d || !summary()) return null;
    return d.mode === "chat" ? `chat:${d.force}:${d.path}` : `watch:${d.why}:${d.path}`;
  });

  createEffect(() => {
    if (decision()?.mode !== "watch") return;
    const t = setInterval(refresh, WATCH_POLL_MS);
    onCleanup(() => clearInterval(t));
  });

  /** Any row claiming a run in flight (the sidebar's Busy chip's fallback source). */
  const anyBusy = createMemo(() => (list() ?? []).some((s) => s.busy));
  createEffect(() => {
    if (!anyBusy()) return;
    const t = setInterval(refresh, BUSY_POLL_MS);
    onCleanup(() => clearInterval(t));
  });

  const folderCount = () => new Set((list() ?? []).map((s) => s.cwd)).size;

  // ---- Subagents pane: open for one session path, closed whenever the route changes ----------
  const [subagents, setSubagents] = createSignal<{ path: string; selected: string | null } | null>(null);
  /** The open chat's live workers (WS "workers"), reconciled by id so pane rows keep identity,
      with the runtime's session-lifetime token Σ beside them. */
  const [chatWorkers, setChatWorkers] = createStore<{ path: string | null; list: WorkerInfo[]; usage: UsageTotalView | null }>(
    { path: null, list: [], usage: null },
  );
  createEffect(on(route, () => setSubagents(null), { defer: true }));
  /** The session view's insight store, published for the pane (a sibling of <main>). */
  const [paneInsight, setPaneInsight] = createSignal<{ path: string; insight: PaneInsight } | null>(null);
  /** The pane's session: open, for the session on screen. */
  const subagentsPath = () => {
    const p = subagents()?.path;
    return p && p === route() && viewKey() ? p : null;
  };
  let subagentsTrigger: HTMLElement | null = null;
  const closeSubagents = () => {
    setSubagents(null);
    const trigger = subagentsTrigger?.isConnected ? subagentsTrigger : document.querySelector<HTMLElement>(".run-status-link");
    subagentsTrigger = null;
    queueMicrotask(() => (trigger ?? document.getElementById("transcript"))?.focus());
  };
  /** Whether the pane is open for `path` on `tab`: what each opener's aria-expanded reports. */
  const paneOn = (path: string, tab: TabId) => subagentsPath() === path && activeTab(path) === tab;
  /**
   * Each opener toggles its own tab: open on that tab closes the pane; closed, or open on the
   * other tab, opens it there. Escape and the pane's close button close it whatever the tab.
   */
  const openPane = (path: string, tab: TabId) => {
    if (paneOn(path, tab)) return closeSubagents();
    const open = subagentsPath() === path;
    if (!open) subagentsTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActiveTab(path, tab);
    if (!open) setSubagents({ path, selected: null });
  };
  /** The composer's subagents row and /subagents promise the workers: Agents. */
  const toggleSubagents = (path: string) => openPane(path, "agents");
  /**
   * The Timeline's "Inputs Only" filter: the path whose pane has it on, else null. In memory, and
   * only while the pane is open — it goes off whenever the pane closes, however it closes — so the
   * one thing that outlives a press is the door that asked for it.
   */
  const [inputsOnly, setInputsOnly] = createSignal<string | null>(null);
  createEffect(on(subagentsPath, (p) => p || setInputsOnly(null)));
  /**
   * The Timeline tab, opened (never toggled shut). /timeline and the outline strip's button open it
   * unfiltered; /tree and the composer's inputs row open it on your own messages, where each row
   * can rewind. Either way the door sets the filter, even on a pane already showing the tab.
   */
  const showTimeline = (path: string, only = false) => {
    setInputsOnly(only ? path : null);
    if (!paneOn(path, "timeline")) openPane(path, "timeline");
  };

  return (
    <>
      <a class="button skip-link" href="#transcript">
        Skip to Transcript
      </a>
      <div class="app" data-view={route() || insightsRoute() ? "session" : "list"}>
        <Sidebar
          sessions={sidebarSessions()}
          loading={sessions.loading}
          error={listError()}
          selected={route()}
          now={now()}
          usage={usage.data()}
          agents={agents.data()}
          insightsPage={insightsRoute()?.page ?? null}
          onRefresh={refresh}
          onNew={() => setCreating(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <main class="app-main">
          <Show
            when={!insightsRoute()}
            fallback={
              <Switch>
                <Match when={insightsRoute()?.page === "usage"}>
                  <UsageView usage={usage} now={now()} titleRef={(el) => (insightsTitleEl = el)} />
                </Match>
                <Match when={insightsRoute()?.page === "agents"}>
                  <AgentsView
                    agents={agents}
                    sessions={list()}
                    now={now()}
                    focusTeam={focusTeam()}
                    titleRef={(el) => (insightsTitleEl = el)}
                  />
                </Match>
              </Switch>
            }
          >
            <Show
              when={viewKey()}
              keyed
              fallback={
                <Show
                  when={!route() || !list()}
                  fallback={
                    <div class="center-fill">
                      <div class="empty">
                        <p class="empty-title">Couldn't find this session.</p>
                        <p class="empty-body">It isn't in the list of sessions on disk anymore.</p>
                        <a class="button empty-action" href="#/">
                          Back to Sessions
                        </a>
                      </div>
                    </div>
                  }
                >
                  <div class="welcome">
                    <div class="welcome-head">
                      <div class="empty">
                        <Icon name="chat" class="empty-mark" />
                        <p class="empty-title">
                          <Show when={list()} fallback="Loading sessions.">
                            {list()!.length} sessions across {folderCount()} folders.
                          </Show>
                        </p>
                        <p class="empty-body">Pick one to read it, or start a new one.</p>
                        <button type="button" class="button empty-action" onClick={() => setCreating(true)}>
                          <Icon name="plus" />
                          New Session
                        </button>
                      </div>
                    </div>
                    <Show when={explained()}>
                      {(list) => (
                        <section class="explain-section" aria-labelledby="explain-section-title">
                          <h2 class="explain-section-head" id="explain-section-title">
                            Explained <span class="text-num">{list().length}</span>
                          </h2>
                          <ExplainGrid explanations={list()} now={now()} />
                        </section>
                      )}
                    </Show>
                  </div>
                </Show>
              }
            >
              {(_key) => {
                const d = decision()!;
                const s = () => summary() ?? created.get(d.path)!;
                const model = () => (d.mode === "chat" ? chatModel() ?? s().model : s().model);
                const author = () => shortModel(model()) ?? "pi";

                // Outline, teams and workers of this session; reloaded (debounced) when its file
                // changes, and polled while the session pane is open for it — the one poller of
                // this endpoint. The pane reads this same store.
                const [insight, setInsight] = createStore<PaneInsight>({ data: null, error: null, pending: true, changed: 0 });
                let insightRun = 0;
                /** Set when the file changed; the next load to land says so through `changed`. */
                let fileMoved = false;
                const loadInsight = async () => {
                  const mine = ++insightRun;
                  try {
                    const next = await fetchSessionInsight(d.path);
                    if (mine !== insightRun) return;
                    // Keyed by id so open topics stay open when a newer outline lands.
                    batch(() => {
                      setInsight("data", reconcile(next, { key: "id" }));
                      setInsight("error", null);
                    });
                  } catch (err) {
                    // Secondary to the transcript: keep the last outline, the next change retries.
                    if (mine !== insightRun) return;
                    setInsight("error", (err as Error).message);
                  }
                  batch(() => {
                    setInsight("pending", false);
                    if (fileMoved) setInsight("changed", (n) => n + 1);
                    fileMoved = false;
                  });
                };
                let insightTimer: ReturnType<typeof setTimeout> | undefined;
                const reloadInsight = () => {
                  clearTimeout(insightTimer);
                  insightTimer = setTimeout(() => {
                    fileMoved = true;
                    void loadInsight();
                  }, SESSION_INSIGHT_DEBOUNCE_MS);
                };
                onCleanup(() => {
                  clearTimeout(insightTimer);
                  insightRun++;
                });
                void loadInsight();
                createEffect(() => {
                  if (subagentsPath() !== d.path) return;
                  void loadInsight();
                  const t = setInterval(() => document.hidden || void loadInsight(), PANE_INSIGHT_POLL_MS);
                  onCleanup(() => clearInterval(t));
                });
                const pane = { path: d.path, insight };
                setPaneInsight(pane);
                onCleanup(() => setPaneInsight((p) => (p === pane ? null : p)));
                const working = () => sessionWorking(s());
                /** The busiest live team: where the head chip links. */
                const liveTeam = () =>
                  (insight.data?.teams ?? []).filter((t) => t.live).reduce<TeamInfo | null>((b, t) => (!b || t.working > b.working ? t : b), null);
                const team = () => insight.data?.teams[0] ?? null;
                /** What's working, by kind: team members and plain subagents are different things. */
                const split = () => workingSplit(working(), insight.data?.workers, insight.data?.teams);
                return (
                  <>
                    <header class="session-head">
                      <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">
                        <Icon name="chevron-left" />
                      </a>
                      <div class="session-head-main">
                        <h1 class="session-head-title" tabindex="-1" ref={titleEl} title={s().title} aria-describedby={contextDescribedBy(d.path)}>
                          {s().title}
                        </h1>
                        <p class="session-head-meta">
                          <ContextMetaPrefix path={d.path} />
                          <span class="text-mono" title={cwdLabel(s(), null)}>
                            {cwdLabel(s(), home())}
                          </span>
                          {/* Chat sessions show the model as the picker trigger instead. */}
                          <Show when={model() && d.mode !== "chat"}>
                            <span aria-hidden="true">·</span>
                            <span class="text-mono" title={model()!}>
                              {shortModel(model())}
                            </span>
                          </Show>
                        </p>
                      </div>
                      <ContextGauge path={d.path} />
                      <Show
                        when={working() > 0}
                        fallback={
                          <Show when={!s().live && team()}>
                            {(t) => <CountChip title={t().name}>Team · {t().members.length}</CountChip>}
                          </Show>
                        }
                      >
                        <Show
                          when={liveTeam()}
                          fallback={
                            <a class="chip chip-count session-head-working" href={agentsHref()} title={subagentsWorkingNow(working())} aria-label={subagentsWorkingNow(working())}>
                              <span class="text-num">{working()}</span>
                              <Icon name="worker" small />
                            </a>
                          }
                        >
                          {(t) => (
                            <CountChip href={agentsHref(t().id)} title={t().name}>
                              Team · {working()} working
                            </CountChip>
                          )}
                        </Show>
                      </Show>
                      {/* The identity, always there for a remote session; the connection chip
                          beside it reports liveness separately. */}
                      <RemoteChip path={d.path} summary={s()} />
                      <RemoteHeadChip path={d.path} onOpen={() => openPane(d.path, "session")} />
                      <Show when={s().live}>
                        <Chip tone="accent" title={`Open in pi in a terminal · pid ${s().live!.pid} · ${s().live!.status}`}>
                          TUI
                        </Chip>
                      </Show>
                      <button
                        type="button"
                        class="button button-icon button-ghost session-details-open"
                        aria-label="Session details"
                        title="Session details"
                        aria-controls="session-pane"
                        aria-expanded={paneOn(d.path, "session")}
                        onClick={() => openPane(d.path, "session")}
                      >
                        <Icon name="info" />
                      </button>
                    </header>
                    <InsightStrip
                      outline={insight.data?.outline ?? null}
                      explanations={insight.data?.explanations}
                      now={now()}
                      onOpenTimeline={() => showTimeline(d.path)}
                    />

                    <Switch>
                      <Match when={d.mode === "watch" && d}>
                        {(w) => (
                          <WatchView
                            path={d.path}
                            author={author()}
                            streaming={!!s().live}
                            onAppend={reloadInsight}
                            workersWorking={working()}
                            workersTotal={insight.data?.workers?.length ?? 0}
                            workersSplit={split()}
                            onShowWorkers={() => toggleSubagents(d.path)}
                            workersOpen={paneOn(d.path, "agents")}
                            stateBanner={
                              <Switch>
                                <Match when={w().why === "recent"}>
                                  <Banner
                                    tone="warn"
                                    title="Another pi process may be writing this session."
                                    body={`${w().ageSec !== undefined ? `It changed ${w().ageSec}s ago` : "It changed"} from a process we can't identify, and no TUI claims it, so we only read it. Chatting here would put 2 writers on one file.`}
                                    action={
                                      <button type="button" class="button button-sm" onClick={() => openChat(true)}>
                                        Chat Anyway
                                      </button>
                                    }
                                  />
                                </Match>
                                <Match when={!s().live && listVersion() > w().listVersion}>
                                  <Banner
                                    tone="info"
                                    title="The TUI closed this session."
                                    body="You can chat in it here now."
                                    action={
                                      <button type="button" class="button button-sm" onClick={() => openChat(false)}>
                                        Open for Chat
                                      </button>
                                    }
                                  />
                                </Match>
                              </Switch>
                            }
                            readOnly={
                              w().why === "recent"
                                ? { icon: "attention", text: "Read only while another process may be writing this file." }
                                : { icon: "attention", text: "Read only while this session is open in the TUI." }
                            }
                          />
                        )}
                      </Match>
                      <Match when={d.mode === "chat" && d}>
                        {(c) => {
                          onCleanup(() => setChatWorkers({ path: null, list: [], usage: null }));
                          return (
                            <ChatView
                              path={d.path}
                              summary={() => s()}
                              cwdLabel={cwdLabel(s(), home())}
                              author={author()}
                              force={c().force}
                              autofocus={c().autofocus}
                              onModel={(m) => {
                                setChatModel(m);
                                // The sidebar row reads the list: re-read it after a switch.
                                if (m && m !== s().model) refresh();
                              }}
                              onRewindControl={setRewindControl}
                              onRewound={noteRewound}
                              inputsOpen={paneOn(d.path, "timeline") && inputsOnly() === d.path}
                              paneTab={subagentsPath() === d.path ? activeTab(d.path) : null}
                              onShowTimeline={(only) => showTimeline(d.path, only)}
                              onRefused={onRefused}
                              onStarted={() => refresh()}
                              onArchiveChanged={onArchived}
                              onGroupsChanged={refresh}
                              onSettled={() => {
                                refresh();
                                reloadInsight();
                              }}
                              onWorkers={(w, usage) =>
                                batch(() => {
                                  setChatWorkers("path", d.path);
                                  setChatWorkers("list", reconcile(w, { key: "id" }));
                                  setChatWorkers("usage", usage);
                                })
                              }
                              onShowWorkers={() => toggleSubagents(d.path)}
                              workersOpen={paneOn(d.path, "agents")}
                              onNewSession={() => startNewFrom(d.path)}
                              teams={insight.data?.teams}
                            />
                          );
                        }}
                      </Match>
                    </Switch>
                  </>
                );
              }}
            </Show>
          </Show>
        </main>

        <Show when={subagentsPath()} keyed>
          {(path) => (
            <Show when={paneInsight()?.path === path}>
              <SessionPane
                path={path}
                insight={paneInsight()!.insight}
                summary={summary() ?? undefined}
                onArchiveChanged={onArchived}
                onGroupsChanged={refresh}
                chatWorkers={chatWorkers.path === path ? chatWorkers.list : null}
                chatUsage={chatWorkers.path === path ? chatWorkers.usage : null}
                rewind={rewindControl()?.path === path ? rewindControl()! : undefined}
                rewound={rewound()?.path === path ? rewound()! : null}
                inputsOnly={inputsOnly() === path}
                onInputsOnly={(on) => setInputsOnly(on ? path : null)}
                selected={subagents()?.selected ?? null}
                onSelect={(id) => setSubagents({ path, selected: id })}
                onClose={closeSubagents}
                now={now()}
              />
            </Show>
          )}
        </Show>

        <SidebarResizer />
      </div>

      <Show when={creating()}>
        <Portal>
          <NewSessionDialog
            prefill={newSessionCwd(summary()?.cwd, list() ?? []) ?? ""}
            knownCwds={[...new Set((list() ?? []).map((s) => s.cwd))]}
            onCancel={() => setCreating(false)}
            onCreated={adoptCreated}
          />
        </Portal>
      </Show>
      <Show when={settingsOpen()}>
        <Portal>
          <SettingsDialog onClose={() => setSettingsOpen(false)} />
        </Portal>
      </Show>
      <GlobalRegions />
    </>
  );
}
