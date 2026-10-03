import { setProfileStartAdopt } from "./lib/profile-start";
import { batch, createEffect, createMemo, createResource, createSignal, Match, on, onCleanup, Show, Switch, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Portal } from "solid-js/web";
import type { ChatClaudeLogin, SessionSummary, WorkerInfo } from "../shared/protocol";
import { reuseUnchanged } from "./lib/summary-diff";
import { OptimisticArchive, type ArchiveMutation } from "./lib/optimistic-archive";
import { setAgentsFeedSource } from "./lib/agents-feed";
import { setExplanationsFeedSource } from "./lib/explanations-feed";
import {
  ApiError,
  createSession,
  fetchAgents,
  fetchExplanations,
  fetchExtensions,
  fetchMesh,
  fetchMeshHello,
  fetchMeshSessions,
  fetchUsage,
  getAttention,
  getOverseer,
  getSessionSummaryById,
  getThemes,
  listSessions,
  setSessionArchived,
} from "./lib/api";
import { socketReconnects } from "./lib/socket";
import { actSessionCount, setAppBadge } from "./lib/push";
import { firstBaseline, helloStep, HELLO_POLL_MS, meshReadInit, pathOfViewKey, sessionViewKey, watchMove, HOST_CONFIRM_MS, seedPeerList, setHostCheck, type HelloBaseline, type PendingHost, type HelloChange, sessionHrefOn } from "./lib/mesh";
import { hostLabel, hostOf, isMeshHash, joinHostLists, linkedSessionRow, meshRetryDelay, meshState, meshOn, meshPeers, mergePeerLists, noteHost, notePeerOrgs, notePeerProjects, notePeerSessions, peerInfo, peerUnavailable, sameMeshInfo, sessionRouteFromHash, setMeshState } from "./lib/mesh";
import { isOverseerHash, isOverseerShortcut, OVERSEER_HASH, OVERSEER_POLL_MS, overseerHistoryId } from "./lib/overseer";
import { sessionIdFromHash, setGroupLinkIndex, setSessionIndex } from "./lib/session-links";
import { agentsHref, insightsRouteFromHash, legacyInsightsTarget } from "./lib/insights";
import { transcriptRoot } from "./lib/jump";
import { groupRouteFromHash } from "./lib/group-route";
import { extHref, extRouteFromHash } from "./lib/ext-route";
import { orgsRouteFromHash } from "./lib/orgs-route";
import { projectsRouteFromHash } from "./lib/projects-route";
import { onListRefresh } from "./lib/list-refresh";
import { OrgsView } from "./components/OrgsView";
import { ProjectsView } from "./components/ProjectsView";
import { loadSessionGroups, sessionGroups, sessionGroupsLoaded } from "./lib/session-groups";
import { createThenArchive, dropArchived, newSessionCwd, offersCwd } from "./lib/new-session";
import { showHiddenFolders } from "./lib/hidden-folders";
import { cwdLabel } from "./lib/remote-session";
import { startRecentPreload } from "./lib/recent-preload";
import { createPoll } from "./lib/poll";
import { homeFromSessionPath } from "./lib/format";
import { reconcileTheme } from "./lib/theme";
import { rememberedWidth, setSpine, spine, spineWidth } from "./lib/spine";
import { isOverviewHash, leaveOverview } from "./lib/overview-route";
import { sessionsGlance } from "./lib/home-sessions";
import { applySidebarWidth } from "./lib/sidebar-width";
import { closeSettings, openSettings, settingsOpenAt } from "./lib/settings-nav";
import type { RewindControl } from "./lib/inputs";
import { activeTab, groupSendAll, home, setActiveTab, setAdopter, setHome, toast } from "./lib/ui-state";
import { createPaneInsight } from "./lib/pane-insight";
import { sessionWorking, type UsageTotalView } from "./lib/workers";
import { AgentsView } from "./components/AgentsView";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { ExplanationsCard, ExplanationsView } from "./components/ExplanationsView";
import { ExtensionCards, ExtensionView } from "./components/ExtensionView";
import { HomeSessionsCard } from "./components/HomeSessionsCard";
import { OverviewActions } from "./components/OverviewActions";
import { AccessPage } from "./components/AccessPage";
import { OverviewOrgsCard } from "./components/OverviewOrgsCard";
import { MeshCard, MeshView, StaleTabBanner } from "./components/MeshView";
import { SharesPage } from "./components/SharesPage";
import { isSharesHash } from "./lib/session-shares";
import { SharePage } from "./components/SharePage";
import { shareRouteFromHash } from "./lib/share-slice";
import { MeshDetails } from "./components/MeshDetails";
import { closeMeshDetails, meshDetailsOpen } from "./lib/mesh-details";
import { ResourceMonitor } from "./components/ResourceMonitor";
import { closeMonitor, monitorOpen } from "./lib/monitor-nav";
import { GroupView, paneIdFor, workspaceFocus, type PaneWiring } from "./components/GroupView";
import { OverseerView } from "./components/OverseerView";
import { SessionPane, type PaneInsight, type TabId } from "./components/SessionPane";
import { SessionView } from "./components/SessionView";
import { BrandLink, sessionHref, Sidebar } from "./components/Sidebar";
import { SidebarResizer } from "./components/SidebarResizer";
import { UsageView } from "./components/UsageView";
import { GlobalRegions, Icon } from "./components/ui";

/** The session the hash names. A peer's (`#/p/<host>/s/<path>`) records its host first, so every
    request the view makes for it goes there even before the peer's list has loaded. */
function pathFromHash(): string | null {
  const r = sessionRouteFromHash(location.hash);
  if (!r) return null;
  if (r.host) noteHost(r.path, r.host);
  return r.path;
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

/** While a run is in flight, re-read the list often enough that the Busy chip clears itself when
    the run settles in a session nobody is looking at. Idle costs nothing: the interval only
    exists while something is busy. */
const BUSY_POLL_MS = 5_000;

/** Insights polling (paused while the tab is hidden). The usage file itself changes ≤ every 3 min. */
const USAGE_POLL_MS = 60_000;
const AGENTS_POLL_MS = 5_000;
/** The explanations store only changes when a /explain subagent finishes; the overview card and
    the Explanations page can wait a minute for a new one. */
const EXPLAIN_POLL_MS = 60_000;

/** `#/overseer` (null: another route), with the earlier file `#/overseer/h/<id>` names. */
const overseerRouteFromHash = (hash: string) => (isOverseerHash(hash) ? { historyId: overseerHistoryId(hash) } : null);
/** Installed extensions and their health; the server caches each health probe for 10 s. */
const EXTENSIONS_POLL_MS = 15_000;
/** While a peer is configured, its status and its sessions are re-read this often. Never with none. */
const MESH_POLL_MS = 15_000;
const folded = () => window.matchMedia("(max-width: 767px)").matches;

/** Live `matchMedia` (the ExplainTiles pattern): the spine is a desktop affordance, so it only
    shows while the viewport is unfolded, and a resize across 768px swaps it in or out. */
function createMediaQuery(query: string) {
  const mql = window.matchMedia(query);
  const [matches, setMatches] = createSignal(mql.matches);
  const onChange = () => setMatches(mql.matches);
  mql.addEventListener("change", onChange);
  onCleanup(() => mql.removeEventListener("change", onChange));
  return matches;
}

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
  /** Sessions a link opened that the list doesn't carry (`#/sid/<id>`, resolved by the server):
      the view's summary only, never a sidebar row. */
  const [linked, setLinked] = createSignal<Record<string, SessionSummary>>({});
  // The fetcher never rejects: on failure it keeps the previous list and reports the error,
  // so reading the resource never throws.
  const [archiveVersion, setArchiveVersion] = createSignal(0);
  const archiveChanges = new OptimisticArchive(() => setArchiveVersion((v) => v + 1));
  const [sessions, { refetch }] = createResource<SessionSummary[] | undefined>(async (_, { value }): Promise<SessionSummary[] | undefined> => {
    const revision = archiveChanges.revision;
    try {
      const answer = await listSessions();
      if (revision !== archiveChanges.revision) return sessions.latest;
      const next = reuseUnchanged(answer, value);
      archiveChanges.observe(next, (path) => !hostOf(path));
      setSessionIndex(next);
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
      if (revision !== archiveChanges.revision) return sessions.latest;
      setListError((err as Error).message);
      return value;
    }
  });
  const list = createMemo<SessionSummary[] | undefined>((previous) => {
    archiveVersion();
    return archiveChanges.apply(sessions.latest, previous);
  }); // keeps the old list on screen while refreshing

  // ---- The peer mesh: dormant unless GET /api/mesh names a peer ------------------------------
  /** Why the mesh couldn't be read (a server without the mesh routes, say). The page then reads
      as mesh off; only a peer's own link says it (see `peerDown`). */
  const [meshError, setMeshError] = createSignal<string | null>(null);
  /** Failures in a row, and the retry they scheduled (only for a failure that may pass). */
  let meshFailures = 0;
  let meshRetry: ReturnType<typeof setTimeout> | undefined;
  /** The host the first answer came from: the one that served this page, whatever answers later. */
  let servedBy: { id: string; label: string } | null = null;
  /** GET /api/mesh has answered, or failed (which reads as off): a `#/sid/` link waits for it. */
  const [meshSettled, setMeshSettled] = createSignal(false);
  const loadMesh = () =>
    fetchMesh(meshReadInit(meshOn()))
      .then((s) => {
        meshFailures = 0;
        servedBy ??= { id: s.self.id, label: s.self.label || s.self.hostname };
        // An answer that says what the last one did keeps the last state: every poll would
        // otherwise hand each reader of the mesh a fresh object (lib/mesh `sameMeshInfo`).
        setMeshState((prev) => (sameMeshInfo(prev, s) ? prev : s));
        setMeshError(null);
        setMeshSettled(true);
      })
      .catch((err: Error) => {
        setMeshError(err.message);
        setMeshSettled(true);
        const wait = meshRetryDelay(err instanceof ApiError ? err.status : 0, ++meshFailures);
        clearTimeout(meshRetry);
        if (wait !== null) meshRetry = setTimeout(() => void loadMesh(), wait);
      });
  void loadMesh();
  onCleanup(() => clearTimeout(meshRetry));
  /** Each peer's last good session list, by peer id. */
  const [peerLists, setPeerLists] = createSignal<ReadonlyMap<string, SessionSummary[]>>(new Map());
  /** The first GET /api/mesh/sessions has answered or failed: a peer's session a link names is known by now. */
  const [peersSettled, setPeersSettled] = createSignal(false);
  const loadPeerSessions = async () => {
    if (!meshOn()) return;
    const revision = archiveChanges.revision;
    try {
      const answer = await fetchMeshSessions();
      if (revision !== archiveChanges.revision) return;
      const next = mergePeerLists(peerLists(), answer, meshPeers());
      for (const [host, rows] of next) archiveChanges.observe(rows, (path) => hostOf(path) === host);
      for (const p of meshPeers()) {
        const rows = next.get(p.id) ?? [];
        notePeerSessions(p.id, rows.map((s) => s.path));
        // Its organizations' pages route there too (§mesh.remote-sessions/org-pages).
        notePeerOrgs(p.id, [...new Set(rows.flatMap((s) => (s.org ? [s.org.orgId] : [])))]);
        // And its projects' (placed or not).
        notePeerProjects(p.id, [...new Set(rows.flatMap((s) => (s.project ? [s.project.projectId] : s.org?.projectId ? [s.org.projectId] : [])))]);
      }
      setPeerLists(next);
    } catch {
      // Keep the last lists: the peers' own status (GET /api/mesh) says what is down.
    } finally {
      // An answer an archive change made stale still settles: the next poll brings the lists.
      setPeersSettled(true);
    }
  };
  // Gated on the boolean, not on the mesh state: the effect read `meshOn()` straight, which reads
  // the whole state, so every mesh poll re-ran it — an extra peer-session fetch and a restarted
  // interval each time (CLAUDE.md, the `on(deps)` note).
  const meshIsOn = createMemo(meshOn);
  createEffect(() => {
    if (!meshIsOn()) {
      if (untrack(peerLists).size) setPeerLists(new Map());
      return;
    }
    void untrack(loadPeerSessions);
    const t = setInterval(() => {
      if (document.hidden) return;
      void loadMesh();
      void loadPeerSessions();
    }, MESH_POLL_MS);
    onCleanup(() => clearInterval(t));
  });
  /** The mesh going off closes Mesh details for good: it doesn't reappear when the mesh comes back. */
  createEffect(() => {
    if (!meshOn()) closeMeshDetails();
  });
  /** This host's sessions, then every peer's: the sidebar's list. With no peer it IS `list()`. */
  const allSessions = createMemo(() => {
    const l = list();
    const peers = peerLists();
    if (!l || peers.size === 0) return l;
    return joinHostLists(l, peers);
  });
  /**
   * The sidebar's rows: the server list plus the sessions this tab created that the server does
   * not carry — a new session is a hidden husk until its first user message or a stored draft, so
   * until then this is where its row comes from. A path on both lists takes the server's row
   * (that one carries the draft preview), and clearing a draft to empty leaves the open session
   * readable — through `created` here, or `openKept` for one this tab didn't start.
   */
  const sidebarSessions = createMemo<SessionSummary[] | undefined>((previous) => {
    archiveVersion();
    createdVersion();
    const l = allSessions();
    if (!l || created.size === 0) return archiveChanges.apply(l, previous);
    const listed = new Set(l.map((s) => s.path));
    const extra = [...created.values()].filter((s) => !listed.has(s.path));
    return archiveChanges.apply(extra.length ? [...l, ...extra] : l, previous);
  });
  // Recent's sessions stay in memory, fetched in the background, so opening one paints at once.
  startRecentPreload(sidebarSessions);

  redirectLegacyInsights();
  /** `#/overview`: the overview as a phone's own page (§app.shell/overview); wide, it is the
      empty main column as always. */
  const [overviewRoute, setOverviewRoute] = createSignal(isOverviewHash(location.hash));
  const [accessRoute, setAccessRoute] = createSignal(location.hash === "#/access");
  const [route, setRoute] = createSignal<string | null>(pathFromHash());
  createEffect(
    on(route, (p) => {
      const kept = openKept();
      if (kept && kept.path !== p) setOpenKept(null);
    }),
  );
  const [groupRoute, setGroupRoute] = createSignal(groupRouteFromHash(location.hash));
  // `sova://g/` links in messages resolve against the groups this tab knows (lib/session-links).
  createEffect(() => sessionGroupsLoaded() && setGroupLinkIndex(sessionGroups()));
  const [insightsRoute, setInsightsRoute] = createSignal(insightsRouteFromHash(location.hash));
  const [overseerRoute, setOverseerRoute] = createSignal(overseerRouteFromHash(location.hash));
  const [extRoute, setExtRoute] = createSignal(extRouteFromHash(location.hash));
  const [meshRoute, setMeshRoute] = createSignal(isMeshHash(location.hash));
  /** `#/shares`: every public link this host and its peers serve (§app.session-share/shares-page). */
  const [sharesRoute, setSharesRoute] = createSignal(isSharesHash(location.hash));
  /** The share page (#/share/<session>): pick a slice and share it (§app.session-share/share-page). */
  const [shareRoute, setShareRoute] = createSignal(shareRouteFromHash(location.hash));
  /** An org page's address names its host when the org is a peer's: noted before the page reads it. */
  const orgsRouteOf = (hash: string) => {
    const r = orgsRouteFromHash(hash);
    if (r && r.kind !== "list" && r.host) notePeerOrgs(r.host, [r.id]);
    return r;
  };
  const [orgsRoute, setOrgsRoute] = createSignal(orgsRouteOf(location.hash));
  /** A project page's address names its host when the project is a peer's: noted before the page reads it. */
  const projectsRouteOf = (hash: string) => {
    const r = projectsRouteFromHash(hash);
    if (r && r.kind !== "list" && r.host) notePeerProjects(r.host, [r.projectId]);
    return r;
  };
  const [projectsRoute, setProjectsRoute] = createSignal(projectsRouteOf(location.hash));
  /** The extension on screen: the view is keyed by this, so a sub-route change never remounts it
      (which would reload the extension's iframe). */
  const extId = createMemo(() => extRoute()?.id ?? null);
  /** The extension asked to fill the window (ext-contract §3.7); ExtensionView owns it. */
  const [extMaximized, setExtMaximized] = createSignal(false);
  /** Team whose session's pane opens on Agents, on `#/agents/<teamKey>` (or a bare team id from an older link). */
  const focusTeam = () => {
    const r = insightsRoute();
    return r?.page === "agents" ? r.team : null;
  };
  // The theme has been on the document since before first paint, out of the localStorage cache
  // (main.tsx). This is the one check that it still exists: an id whose file was deleted, renamed
  // or broken falls back to dark. A fetch that fails changes nothing — an unreachable server
  // is not a reason to lose the theme you picked.
  void getThemes()
    .then(reconcileTheme)
    .catch(() => {});
  const usage = createPoll(fetchUsage, USAGE_POLL_MS);
  const agents = createPoll(fetchAgents, AGENTS_POLL_MS);
  setAgentsFeedSource(agents.data);
  const explanations = createPoll(fetchExplanations, EXPLAIN_POLL_MS);
  setExplanationsFeedSource(explanations.data);
  const overseer = createPoll(getOverseer, OVERSEER_POLL_MS);
  /** The attention digest, read once for the page on the entry button's cadence: the sidebar's
      Needs you region, the home card and the app badge all read it. */
  const attention = createPoll(getAttention, OVERSEER_POLL_MS);
  // The app badge (an installed app, with notifications allowed): the sessions that need you, kept
  // current from the digest this page already reads; zero clears it (lib/push.ts).
  const badgeCount = createMemo(() => {
    const d = attention.data();
    return d ? actSessionCount(d) : null;
  });
  createEffect(() => {
    const n = badgeCount();
    if (n !== null) setAppBadge(n);
  });
  const extensions = createPoll(fetchExtensions, EXTENSIONS_POLL_MS);
  /** The landing page shows the Extensions section only when something is installed. */
  const installed = createMemo(() => {
    const items = extensions.data();
    return items && items.length > 0 ? items : null;
  });
  const [creating, setCreating] = createSignal(false);
  // The Settings modal is opened from the sidebar foot's gear, and at Modes by the mode menu's
  // "Configure Delegate" (lib/settings-nav.ts holds which tab, so either can open it).
  /** Each open chat's rewind, for the Timeline's input rows. By path: a workspace has several
      chats open at once, and the pane must get the one whose session it is showing. */
  const [rewindControls, setRewindControls] = createSignal<Record<string, RewindControl>>({});
  const setRewindControl = (path: string, control: RewindControl | null) =>
    setRewindControls((m) => {
      if (!control) {
        if (!(path in m)) return m;
        const next = { ...m };
        delete next[path];
        return next;
      }
      return { ...m, [path]: control };
    });
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
  /** The sessions pane as the 64px spine (lib/spine.ts): the user's choice, on a wide viewport. */
  const unfolded = createMediaQuery("(min-width: 768px)");
  const collapsed = () => spine() && unfolded();
  // One knob: the collapsed pane is `--sidebar-width` set to `--spine-width`, and nothing else in the
  // CSS knows about it. Expanding writes back the width the resizer last applied.
  createEffect(() => {
    const root = document.documentElement;
    applySidebarWidth(root, collapsed() ? spineWidth(root) : rememberedWidth());
  });
  const onFocus = () => {
    setNow(Date.now());
    refresh();
    void loadPeerSessions();
    overseer.refetch();
    attention.refetch();
  };
  /**
   * A session link from a message (`sova://s/<id>`) the list couldn't resolve points at
   * `#/sid/<id>`: swapped in place for the session's own route. The list first, peers' rows
   * included (a peer's session opens on its host); a session it doesn't carry (it omits those
   * with no user message) is asked of this host's server, and only the server's "not found" says
   * the session is gone.
   */
  let resolvingId: string | null = null;
  const resolveSessionIdRoute = () => {
    const id = sessionIdFromHash(location.hash);
    if (!id) return;
    // "wait": the effect below comes back here once the lists land
    const s = linkedSessionRow(id, list(), peerLists(), meshSettled() && (!meshOn() || peersSettled()));
    if (s === "wait") return;
    if (s) {
      history.replaceState(history.state, "", sessionHref(s.path));
      return;
    }
    if (resolvingId === id) return;
    resolvingId = id;
    void getSessionSummaryById(id)
      .then(
        (found) => {
          setLinked((m) => ({ ...m, [found.path]: found }));
          if (sessionIdFromHash(location.hash) === id) history.replaceState(history.state, "", sessionHref(found.path));
        },
        (err) => {
          if (sessionIdFromHash(location.hash) !== id) return;
          toast(err instanceof ApiError && err.status === 404 ? "That session is gone." : `Couldn't open that session. ${(err as Error).message}`);
          history.replaceState(history.state, "", "#/");
        },
      )
      .finally(() => {
        resolvingId = null;
        onHash();
      });
  };
  const onHash = () => {
    redirectLegacyInsights();
    resolveSessionIdRoute();
    setRoute(pathFromHash());
    setGroupRoute(groupRouteFromHash(location.hash));
    setInsightsRoute(insightsRouteFromHash(location.hash));
    setOverseerRoute(overseerRouteFromHash(location.hash));
    setExtRoute(extRouteFromHash(location.hash));
    setMeshRoute(isMeshHash(location.hash));
    setSharesRoute(isSharesHash(location.hash));
    setShareRoute(shareRouteFromHash(location.hash));
    setOrgsRoute(orgsRouteOf(location.hash));
    setProjectsRoute(projectsRouteOf(location.hash));
    setOverviewRoute(isOverviewHash(location.hash));
    setAccessRoute(location.hash === "#/access");
  };
  // A `#/sid/` route opened before the first list load resolves when the lists land.
  createEffect(on([list, peerLists, meshSettled, peersSettled], () => sessionIdFromHash(location.hash) && onHash(), { defer: true }));
  /** Alt+O: the Overseer, from anywhere (lib/overseer `isOverseerShortcut`). */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isOverseerShortcut(e)) return;
    e.preventDefault();
    if (location.hash !== OVERSEER_HASH) location.hash = OVERSEER_HASH;
  };
  window.addEventListener("focus", onFocus);
  window.addEventListener("hashchange", onHash);
  window.addEventListener("keydown", onKeyDown);
  // A view that changed a session's list fields (a baton strip's hand-off, take back, approve) asks
  // for the list and the Needs you digest now rather than at the next poll (lib/list-refresh.ts).
  const offListRefresh = onListRefresh(window, { list: refresh, attention: () => attention.refetch() });
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("hashchange", onHash);
    window.removeEventListener("keydown", onKeyDown);
    offListRefresh();
    clearInterval(tick);
  });

  // ---- The stale-tab check: the front door can move this tab to another host -----------------
  // Only with the mesh on (no front door exists without it). The tab remembers the hello of the
  // host it was loaded from and asks again whenever the server may have changed under it: a
  // socket reconnect, the tab coming back into view, the mesh poll.
  const [helloBase, setHelloBase] = createSignal<HelloBaseline | null>(null);
  const [staleChange, setStaleChange] = createSignal<HelloChange | null>(null);
  let pendingHost: PendingHost | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(confirmTimer));
  const checkHello = async () => {
    if (!meshOn()) return;
    let hello;
    try {
      hello = await fetchMeshHello();
    } catch {
      return; // no answer is the reconnect's business, not a verdict on the host
    }
    const now: HelloBaseline = { id: hello.id, label: hello.label, protocol: hello.protocol, build: hello.build };
    let base = helloBase();
    if (!base) {
      // The first hello may already come from another host (a failover right after load): the
      // host is the one that served the page; only protocol and build are learnt from the hello.
      base = firstBaseline(servedBy, now);
      setHelloBase(base);
    }
    const step = helloStep(base, now, pendingHost, Date.now());
    const firstSeen = step.pending && step.pending !== pendingHost;
    pendingHost = step.pending;
    // Another host answered once: ask again a little later, and only a second answer from it counts.
    if (firstSeen) {
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => void checkHello(), HOST_CONFIRM_MS + 100);
    }
    const change = step.change;
    if (!change) return;
    // The tab's own code hasn't changed: its protocol and build stay the baseline's. Only the host
    // it talks to moves.
    setHelloBase({ ...base, id: now.id, label: now.label });
    setStaleChange((prev) => ({
      protocol: change.protocol || !!prev?.protocol,
      build: change.build || !!prev?.build,
      host: change.host ?? prev?.host ?? null,
    }));
    if (change.host) onFailover(base.id);
  };
  /**
   * This tab now talks to another host. The open session, if it was the old host's own, keeps
   * pointing there (`?host=<old>`); everything else re-reads, and the old host's sessions come
   * back through its peer list (a session is still driven only by the host holding it).
   */
  /** The last confirmed host change: the old host's state is re-read quickly for a while (watchMove). */
  let moved: { from: string; at: number } | null = null;
  const onFailover = (oldId: string) => {
    // The list on screen is still the old host's own: it stands in as that peer's until it answers.
    const own = (list() ?? []).filter((s) => !hostOf(s.path));
    const r = sessionRouteFromHash(location.hash);
    if (r && !r.host) {
      noteHost(r.path, oldId);
      history.replaceState(history.state, "", sessionHrefOn(oldId, r.path));
    }
    notePeerSessions(oldId, own.map((s) => s.path));
    setPeerLists((m) => seedPeerList(m, oldId, own));
    moved = { from: oldId, at: Date.now() };
    void loadMesh().then(() => {
      refresh();
      void loadPeerSessions();
    });
  };
  createEffect(() => {
    if (meshOn() && !helloBase()) void checkHello();
  });
  // A vanished host leaves the open socket silent: only asking notices the move. Mesh off: never.
  createEffect(() => {
    if (!meshOn()) return;
    const t = setInterval(() => {
      if (document.hidden) return;
      void checkHello();
      if (watchMove(moved, Date.now(), meshPeers())) void loadMesh();
    }, HELLO_POLL_MS);
    onCleanup(() => clearInterval(t));
  });
  setHostCheck(() => void checkHello());
  onCleanup(() => setHostCheck(null));
  createEffect(on(socketReconnects, () => void checkHello(), { defer: true }));
  const onVisible = () => {
    if (!document.hidden) void checkHello();
  };
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisible));

  /** The session-list row for a path: the list's, else one this tab created, else the kept one. */
  const summaryOf = (p: string): SessionSummary | undefined => {
    const kept = openKept(); // only for the session on screen; see where it is set
    return allSessions()?.find((s) => s.path === p) ?? created.get(p) ?? (kept?.path === p ? kept : undefined) ?? linked()[p];
  };

  /** `path` is on a peer whose list hasn't arrived yet. */
  const peerListPending = (path: string): boolean => {
    const h = hostOf(path);
    return !!h && !peerLists().has(h);
  };
  /** Why the peer holding `path` can't be reached, or null: here, or up. */
  const peerDown = (path: string): string | null => {
    const h = hostOf(path);
    if (!h) return null;
    const p = peerInfo(h);
    if (p) return peerUnavailable(p);
    if (meshError()) return `This host couldn't read its peers: ${meshError()}`;
    return meshState() ? `${h} isn't one of this host's peers.` : null;
  };

  /** The session everything session-shaped is about: the open one, or a workspace's focused pane. */
  // In a workspace the focused pane is the workspace's own state, not the route's: moving between
  // panes replaces the URL without a hashchange, so `groupRoute()` names the pane you left.
  const focusedPath = () => route() ?? workspaceFocus() ?? groupRoute()?.path ?? null;
  const summary = createMemo(() => {
    const p = focusedPath();
    return (p ? summaryOf(p) : undefined) ?? null;
  });
  /** The group the route names, once its name is known; the workspace needs the group itself. */
  const openGroup = createMemo(() => {
    const id = groupRoute()?.id;
    return id ? (sessionGroups().find((g) => g.id === id) ?? null) : null;
  });
  /** The group's sessions, in the list's order (newest first); membership is the list's alone. */
  const groupMembers = createMemo(() => {
    const id = groupRoute()?.id;
    return id ? (list() ?? []).filter((s) => s.groupId === id) : [];
  });
  /** Every session mounted right now: the open one, or every pane of the workspace. */
  const openPaths = createMemo<string[]>(() => {
    const p = route();
    if (p) return [p];
    // The Overseer's own chat is a session on screen too: its Timeline and Session detail pane work.
    const o = overseerRoute();
    if (o) return !o.historyId && overseer.data() ? [overseer.data()!.path] : [];
    return groupRoute() ? groupMembers().map((s) => s.path) : [];
  });
  /** The id of the transcript the skip link jumps to: a pane's in a workspace, else the bare one. */
  const transcriptIdOf = (path: string | null) => {
    const pane = path && groupRoute() ? paneIdFor(path) : null;
    return pane ? `transcript-${pane}` : "transcript";
  };
  /**
   * A workspace route for a group that isn't there never renders an empty frame: it says so and
   * goes back to the list. But "this tab hasn't heard of it" is not "it doesn't exist" — a group
   * made in another tab, or on another server, is unknown here until the list is re-read. So an
   * unknown id buys one reload first, and only a second miss is a verdict. Without that, pasting
   * a workspace link from another tab bounces with a sentence that is false.
   *
   * The sidebar guards the same case the same way for a row whose `groupId` it doesn't know.
   */
  const rechecked = new Set<string>();
  createEffect(() => {
    const id = groupRoute()?.id;
    // Read the LIST, not the memo over it: `openGroup()` is null both before and after a reload
    // that doesn't find the group, and a memo whose value doesn't change notifies nobody — so
    // depending on it here meant the verdict never ran and the route sat on an empty frame,
    // which is the one thing the workspace spec says routing must never do.
    const known = sessionGroups().some((g) => g.id === id);
    if (!id || !sessionGroupsLoaded() || known) return;
    if (!rechecked.has(id)) {
      rechecked.add(id);
      void loadSessionGroups();
      return;
    }
    toast("That group is gone.");
    location.hash = "#/";
  });

  /** A session this tab just created opens for chat with its composer focused. */
  const [autofocusPath, setAutofocusPath] = createSignal<string | null>(null);
  /**
   * The skip link's target and name move together: a workspace in Send to All has one action —
   * the group composer — so the link says "Skip to Group Composer" and lands on its input; while
   * the group composer is not on screen (Send to All off, or a workspace with no members) it is
   * the focused pane's transcript and says so, because a link that says "Group Composer" and
   * lands on a transcript, or on a hidden box, is worse than either.
   */
  const hasGroupComposer = () => !!groupRoute() && !!openGroup() && groupMembers().length > 0 && groupSendAll();
  const skipHref = () => (hasGroupComposer() ? "#group-composer" : `#${transcriptIdOf(focusedPath())}`);
  const skipLabel = () => (hasGroupComposer() ? "Skip to Group Composer" : "Skip to Transcript");

  // At folded width, opening a session swaps the column: move focus to its title.
  let titleEl: HTMLHeadingElement | undefined;
  createEffect(on(route, (p) => p && folded() && queueMicrotask(() => titleEl?.focus()), { defer: true }));
  let insightsTitleEl: HTMLHeadingElement | undefined;
  let extTitleEl: HTMLHeadingElement | undefined;
  let meshTitleEl: HTMLHeadingElement | undefined;
  createEffect(on(meshRoute, (open) => open && folded() && queueMicrotask(() => meshTitleEl?.focus()), { defer: true }));
  let sharesTitleEl: HTMLHeadingElement | undefined;
  createEffect(on(sharesRoute, (open) => open && folded() && queueMicrotask(() => sharesTitleEl?.focus()), { defer: true }));
  let shareTitleEl: HTMLHeadingElement | undefined;
  createEffect(on(shareRoute, (open) => open && folded() && queueMicrotask(() => shareTitleEl?.focus()), { defer: true }));
  let orgsTitleEl: HTMLHeadingElement | undefined;
  /** Which organizations page is showing: an org's tabs and its `/start/<person>` are the same page,
      so switching tabs keeps focus on the tab (the memo only changes when the page does). */
  const orgsPage = createMemo(() => {
    const r = orgsRoute();
    if (!r) return null;
    return r.kind === "list" ? "list" : r.kind === "org" ? `org:${r.id}` : `person:${r.id}:${r.personId}`;
  });
  createEffect(on(orgsPage, (page) => page && folded() && queueMicrotask(() => orgsTitleEl?.focus()), { defer: true }));
  let projectsTitleEl: HTMLHeadingElement | undefined;
  /** Which projects page is showing: a project's tabs are one page, so a tab change keeps focus on the tab. */
  const projectsPage = createMemo(() => {
    const r = projectsRoute();
    return r ? (r.kind === "list" ? "list" : `${r.kind}:${r.projectId}`) : null;
  });
  createEffect(on(projectsPage, (page) => page && folded() && queueMicrotask(() => projectsTitleEl?.focus()), { defer: true }));
  createEffect(on(extId, (id) => id && folded() && queueMicrotask(() => extTitleEl?.focus()), { defer: true }));
  // A team deep link focuses its card instead (AgentsView), at every width. A memo, so a change
  // within a page (a team link, the Explanations session filter) doesn't take focus back.
  const insightsPage = createMemo(() => insightsRoute()?.page ?? null);
  /** The foot's two rows mark Usage and Agents; the Explanations page has no row there. */
  const footPage = () => {
    const page = insightsPage();
    return page === "explanations" ? null : page;
  };
  createEffect(on(insightsPage, (page) => page && !focusTeam() && folded() && queueMicrotask(() => insightsTitleEl?.focus()), { defer: true }));

  /** Opens a session we just created: chat right away, composer focused. */
  const adoptCreated = (s: SessionSummary) => {
    created.set(s.path, s);
    setCreatedVersion((v) => v + 1);
    setCreating(false);
    refresh();
    // Route and decision move together: "hashchange" fires later, and until then the decide
    // effect would pair this decision with the old route and replace it, autofocus and all.
    // Route and autofocus move together: "hashchange" fires later, and the view mounts from the
    // route — it must already know this session is one to open for chat, composer focused.
    location.hash = sessionHref(s.path);
    batch(() => {
      setAutofocusPath(s.path);
      onHash();
    });
  };
  setProfileStartAdopt(adoptCreated);

  setAdopter(adoptCreated);
  onCleanup(() => setAdopter(null));

  /**
   * An Archive/Unarchive landed (the chat's own gesture, the pane's). An archived
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
   * A drop on the sidebar's Archive (or its Undo): the row moves now, before the server answers
   * (lib/optimistic-archive). Settling follows `onArchived`'s order — off the dead session first,
   * then the row's local changes in one batch, so no reader sees the row gone while its view is up.
   */
  const onArchiveStart = (path: string, archived: boolean): ArchiveMutation => {
    const row = sidebarSessions()?.find((s) => s.path === path);
    if (!row) return { commit: () => onArchived(path, archived), rollback: () => refresh() };
    const mutation = archiveChanges.begin(row, archived);
    const reread = () => {
      refresh();
      if (hostOf(path)) void loadPeerSessions();
    };
    return {
      commit: (deleted) => {
        if ((archived || deleted) && route() === path) {
          location.hash = "#/";
          batch(onHash);
        }
        batch(() => {
          mutation.commit(deleted);
          if (dropArchived(created, path, archived)) setCreatedVersion((v) => v + 1);
        });
        reread();
      },
      rollback: () => {
        mutation.rollback();
        reread();
      },
    };
  };

  /**
   * A bare "/new" typed in `source`: a new session in the same folder, then `source` goes to
   * the Archive. Resolves to the folder label once the new session exists, null if none was made.
   * Only web-spawned sessions can be archived; one with subagents working stays open, since
   * archiving closes its runtime and they'd die with it.
   */
  const startNewFrom = async (source: string): Promise<string | null> => {
    const s = summary();
    const cwd = newSessionCwd(s, list() ?? []);
    if (!cwd) {
      toast("No folder to start in. Pick one.");
      setCreating(true);
      return null;
    }
    const workersBusy = (s ? sessionWorking(s) > 0 : false) || !!chatWorkers[source]?.list.some((w) => w.working);
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

  /** Any row claiming a run in flight (the sidebar's Busy chip's fallback source). */
  const anyBusy = createMemo(() => (list() ?? []).some((s) => s.busy));
  createEffect(() => {
    if (!anyBusy()) return;
    const t = setInterval(refresh, BUSY_POLL_MS);
    onCleanup(() => clearInterval(t));
  });

  /** The overview's Sessions card opens the list: back to it on a phone (lib/overview-route),
      the pane (expanded from the spine) on a wide window, with the search focused. */
  const openSessionList = () => {
    if (!unfolded()) {
      leaveOverview();
      return;
    }
    if (spine()) setSpine(false);
    queueMicrotask(() => document.getElementById("session-search")?.focus());
  };

  // ---- Subagents pane: open for one session path, closed whenever the route changes ----------
  /** `board`: opened in place from the Agents board, for a session with no view on screen. */
  const [subagents, setSubagents] = createSignal<{ path: string; selected: string | null; board?: boolean } | null>(null);
  /** Each open chat's live workers (WS "workers"), reconciled by id so pane rows keep identity,
      with the runtime's session-lifetime token Σ beside them. By path: a workspace runs several. */
  const [chatWorkers, setChatWorkers] = createStore<Record<string, { list: WorkerInfo[]; usage: UsageTotalView | null } | undefined>>({});
  const noteWorkers = (path: string, workers: WorkerInfo[] | null, usage: UsageTotalView | null) =>
    batch(() => {
      if (!workers) return setChatWorkers(path, undefined);
      if (!chatWorkers[path]) setChatWorkers(path, { list: [], usage: null });
      setChatWorkers(path, "list", reconcile(workers, { key: "id" }));
      setChatWorkers(path, "usage", usage);
    });
  /** Each open chat's RECORDED Claude login id, by path; an unrecorded one is left out, so the
      usage readouts fall back to the login in use for new chats (§app.insights/sidebar-foot). */
  const [chatLogins, setChatLogins] = createStore<Record<string, string | undefined>>({});
  const noteClaudeLogin = (path: string, login: ChatClaudeLogin | null) => setChatLogins(path, login?.recorded ? login.id : undefined);
  /** The Claude login the usage readouts follow: the focused chat's, when it recorded one. */
  const usageLogin = () => {
    const p = focusedPath();
    return p ? (chatLogins[p] ?? null) : null;
  };
  createEffect(on(() => location.hash.replace(/\/[^/]*$/, ""), () => setSubagents(null), { defer: true }));
  /** Each mounted session view's insight store, published for the pane (a sibling of <main>). */
  const [paneInsights, setPaneInsights] = createSignal<Record<string, PaneInsight>>({});
  const noteInsight = (path: string, insight: PaneInsight | null) =>
    setPaneInsights((m) => {
      if (insight) return { ...m, [path]: insight };
      if (!(path in m)) return m;
      const next = { ...m };
      delete next[path];
      return next;
    });
  /** The pane's session: open, and one of the sessions on screen — or, from the Agents board, a
      row of that board while it is showing. */
  const subagentsPath = () => {
    const s = subagents();
    if (!s) return null;
    if (s.board) return insightsPage() === "agents" && (list() ?? []).some((x) => x.path === s.path) ? s.path : null;
    return openPaths().includes(s.path) ? s.path : null;
  };
  /** The pane the board opened: a team link (`#/agents/<team>`) keeps it, leaving the page closes it. */
  createEffect(on(insightsPage, (page) => page !== "agents" && subagents()?.board && setSubagents(null), { defer: true }));
  /** The board's pane has no session view to load its insight: this loads and polls it instead. */
  const boardPanePath = createMemo(() => (subagents()?.board ? subagentsPath() : null));
  createEffect(
    on(boardPanePath, (path) => {
      if (!path) return;
      const { insight, reload } = createPaneInsight(path, () => true);
      noteInsight(path, insight);
      // No file watch here: a newer last-active time in the list is the file having moved.
      const last = createMemo(() => summaryOf(path)?.lastActiveAt);
      createEffect(on(last, reload, { defer: true }));
      // Only its own entry: a session view mounting for the same path publishes one of its own.
      onCleanup(() => paneInsights()[path] === insight && noteInsight(path, null));
    }),
  );
  let subagentsTrigger: HTMLElement | null = null;
  const closeSubagents = () => {
    const was = subagentsPath();
    setSubagents(null);
    const trigger = subagentsTrigger?.isConnected ? subagentsTrigger : document.querySelector<HTMLElement>(".run-status-link");
    subagentsTrigger = null;
    queueMicrotask(() => (trigger ?? transcriptRoot(was))?.focus());
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
  /** The Agents board's Session details button: the pane in place, on its Session tab, for that
      row. Its own row's button closes it; another row's switches it to that session. */
  const openDetailsFor = (path: string) => {
    if (subagentsPath() === path) return closeSubagents();
    subagentsTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActiveTab(path, "session");
    setSubagents({ path, selected: null, board: true });
  };
  /** The Agents board's team chips and team links: that pane in place, on its Agents tab. Never
      closes it: on that session already, it only switches the tab. */
  const openAgentsFor = (path: string) => {
    setActiveTab(path, "agents");
    if (subagentsPath() === path) return;
    subagentsTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSubagents({ path, selected: null, board: true });
  };
  /** The Agents board's Open Subagents: open the session, then its pane on the Agents tab.
      Route first: the pane only opens beside a session that is on screen. */
  const openSubagentsFor = (path: string) => {
    location.hash = sessionHref(path);
    batch(onHash);
    if (!paneOn(path, "agents")) openPane(path, "agents");
  };
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

  /**
   * Everything a session view needs from the app shell, in one object so the single view and a
   * workspace's panes are wired identically. The two live values are getters, so reading them
   * inside a view tracks them.
   */
  const wiring: PaneWiring = {
    get listVersion() {
      return listVersion();
    },
    get now() {
      return now();
    },
    onRefresh: refresh,
    onArchiveChanged: onArchived,
    onInsight: noteInsight,
    onWorkers: noteWorkers,
    onClaudeLogin: noteClaudeLogin,
    onRewindControl: setRewindControl,
    onRewound: noteRewound,
    paneOn,
    openPane,
    toggleSubagents,
    showTimeline,
    inputsOnly,
    subagentsPath,
    onNewSession: startNewFrom,
  };

  return (
    <>
      {/*
        In a workspace the transcripts are the panes': the link points at the focused one, and its
        name and target move together.

        The press is handled rather than followed, because in this app the hash IS the route: letting
        the browser navigate to "#transcript" would replace `#/s/<path>` and drop the reader onto the
        session list — out of the very transcript they asked to skip into. Focusing the region is what
        the link means anyway; the `href` stays so it is still a link, and still announced as one.
      */}
      <a
        class="button skip-link"
        href={skipHref()}
        onClick={(e) => {
          // The composer's INPUT is what takes focus (a footer with an id is not focusable);
          // a workspace whose composer is somehow missing falls back to the pane transcript.
          const el =
            (hasGroupComposer() ? document.getElementById("group-composer-input") : null) ??
            document.getElementById(transcriptIdOf(focusedPath()));
          if (!el) return; // nothing rendered to skip to: leave the browser to it
          e.preventDefault();
          el.focus();
        }}
      >
        {skipLabel()}
      </a>
      <div
        class="app"
        data-spine={collapsed() ? "on" : undefined}
        data-view={groupRoute() ? "workspace" : route() || accessRoute() || insightsRoute() || overseerRoute() || extRoute() || meshRoute() || sharesRoute() || shareRoute() || orgsRoute() || projectsRoute() || overviewRoute() ? "session" : "list"}
        data-ext-maximized={extMaximized() ? "1" : undefined}
      >
        <Sidebar
          unfolded={unfolded()}
          sessions={sidebarSessions()}
          loading={sessions.loading}
          error={listError()}
          selected={route()}
          now={now()}
          usage={usage.data()}
          claudeLogin={usageLogin()}
          agents={agents.data()}
          insightsPage={footPage()}
          sharesOpen={sharesRoute()}
          onRefresh={refresh}
          onArchiveStart={onArchiveStart}
          onNew={() => setCreating(true)}
          onOpenSettings={() => openSettings()}
          overseer={overseer.data()}
          overseerOpen={!!overseerRoute()}
          attention={attention.data()}
        />

        {/* The workspace takes the whole second column, so it IS the main: no session head, and
            its own head instead. */}
        <main
          class={groupRoute() ? "workspace" : "app-main"}
          aria-label={openGroup() ? `Workspace: ${openGroup()!.name}` : undefined}
          /* Send to All: one rule in app.css hides every pane composer under it. */
          data-send-all={groupRoute() && groupSendAll() ? "true" : undefined}
        >
          <Show
            when={!accessRoute() && !insightsRoute() && !overseerRoute()}
            fallback={
              <Switch>
                <Match when={accessRoute()}><AccessPage /></Match>
                <Match when={overseerRoute()}>
                  {(r) => (
                    <OverseerView
                      info={overseer.data()}
                      error={overseer.error()}
                      onInfo={overseer.set}
                      refetch={overseer.refetch}
                      historyId={r().historyId}
                      sessions={list() ?? []}
                      wiring={wiring}
                      titleRef={(el) => (insightsTitleEl = el)}
                    />
                  )}
                </Match>
                <Match when={insightsRoute()?.page === "usage"}>
                  <UsageView usage={usage} now={now()} claudeLogin={usageLogin()} titleRef={(el) => (insightsTitleEl = el)} />
                </Match>
                <Match when={insightsRoute()?.page === "agents"}>
                  <AgentsView
                    agents={agents}
                    sessions={list()}
                    now={now()}
                    focusTeam={focusTeam()}
                    titleRef={(el) => (insightsTitleEl = el)}
                    onRefresh={refresh}
                    onArchiveChanged={onArchived}
                    onOpenSubagents={openSubagentsFor}
                    detailsPath={boardPanePath()}
                    onOpenDetails={openDetailsFor}
                    onOpenAgents={openAgentsFor}
                  />
                </Match>
                {/* Every /explain page as a card (#/explanations[/<sessionId>]). */}
                <Match when={insightsRoute()?.page === "explanations" && insightsRoute()}>
                  {(r) => (
                    <ExplanationsView
                      explanations={explanations}
                      sessions={list()}
                      session={(r() as { session: string | null }).session}
                      now={now()}
                      titleRef={(el) => (insightsTitleEl = el)}
                      onRefresh={refresh}
                    />
                  )}
                </Match>
              </Switch>
            }
          >
            <Switch>
              {/* A workspace: every session of one group on screen at once (#/g/<id>). */}
              <Match when={groupRoute() && openGroup()}>
                {(group) => (
                  <GroupView group={group()} members={groupMembers()} sessions={list() ?? []} focused={groupRoute()!.path} wiring={wiring} />
                )}
              </Match>
              {/* A peer's session whose host can't be reached: said plainly, never a chat that
                  spins on a socket nobody answers. It opens again once the host is back. */}
              <Match when={route() && peerDown(route()!)}>
                {(why) => (
                  <div class="center-fill">
                    <div class="empty">
                      <p class="empty-title">{hostLabel(hostOf(route()!)!)} can't be reached.</p>
                      <p class="empty-body">
                        {why()} This session lives there, so it opens once that host is back. Nothing here changed.
                      </p>
                      <a class="button empty-action" href="#/mesh">
                        See Hosts
                      </a>
                    </div>
                  </div>
                )}
              </Match>
              {/* One session, the whole pane (#/s/<path>), exactly as before. Keyed on its host too: a
                  session a host change hands to a peer reconnects through that peer at once. */}
              <Match when={route() && summary() ? sessionViewKey(hostOf(route()!), route()!) : null} keyed>
                {(key) => {
                  const path = pathOfViewKey(key);
                  // The list can stop carrying this row for an instant; the view keeps the last
                  // summary it had rather than tearing itself down under the user.
                  let last = summaryOf(path)!;
                  const summaryNow = () => (last = summaryOf(path) ?? last);
                  return (
                    <SessionView
                      path={path}
                      summary={summaryNow}
                      autofocus={autofocusPath() === path}
                      titleRef={(el) => (titleEl = el)}
                      lead={
                        <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">
                          <Icon name="chevron-left" />
                        </a>
                      }
                      listVersion={wiring.listVersion}
                      now={wiring.now}
                      onRefresh={wiring.onRefresh}
                      onArchiveChanged={wiring.onArchiveChanged}
                      onInsight={wiring.onInsight}
                      onWorkers={wiring.onWorkers}
                      onClaudeLogin={wiring.onClaudeLogin}
                      onRewindControl={wiring.onRewindControl}
                      onRewound={wiring.onRewound}
                      paneOn={wiring.paneOn}
                      openPane={wiring.openPane}
                      toggleSubagents={wiring.toggleSubagents}
                      showTimeline={wiring.showTimeline}
                      inputsOnly={wiring.inputsOnly}
                      subagentsPath={wiring.subagentsPath}
                      onNewSession={wiring.onNewSession}
                    />
                  );
                }}
              </Match>
              {/* A route naming a session the list doesn't have (deleted, or renamed on disk). */}
              {/* A peer's session waits for that peer's list before it is called missing. */}
              <Match when={route() && list() && !summary() && !peerListPending(route()!)}>
                <div class="center-fill">
                  <div class="empty">
                    <p class="empty-title">Couldn't find this session.</p>
                    <p class="empty-body">It isn't in the list of sessions on disk anymore.</p>
                    <a class="button empty-action" href="#/">
                      Back to Sessions
                    </a>
                  </div>
                </div>
              </Match>
              {/* Projects, placed or not (#/projects[/<project>[/<tab>|/overseer]]). Not keyed: ProjectsView keys each page. */}
              <Match when={projectsRoute()}>
                {(r) => <ProjectsView route={r()} titleRef={(el) => (projectsTitleEl = el)} />}
              </Match>
              {/* Organizations, their rosters and hand-off sessions (#/orgs[/<id>[/<tab>|/people/<person>]]). */}
              {/* Not keyed: a tab change on an org's page (#/orgs/<id>/<tab>) is a new route object,
                  and OrgsView keys each page itself, so the page stays and only the tab moves. */}
              <Match when={orgsRoute()}>
                {(r) => <OrgsView route={r()} titleRef={(el) => (orgsTitleEl = el)} />}
              </Match>
              {/* The peer mesh (#/mesh): hosts, peers.json, sync, first-peer setup. */}
              <Match when={meshRoute()}>
                <MeshView now={now()} titleRef={(el) => (meshTitleEl = el)} />
              </Match>
              {/* Every public link: session shares and org links, here and on up peers (#/shares). */}
              <Match when={sharesRoute()}>
                <SharesPage now={now()} titleRef={(el) => (sharesTitleEl = el)} />
              </Match>
              {/* One session's share page (#/share/<session>): a different session or share remounts it. */}
              <Match when={shareRoute() ? JSON.stringify([shareRoute()!.sessionId, shareRoute()!.host, shareRoute()!.share]) : null} keyed>
                {(_key) => <SharePage route={shareRoute()!} titleRef={(el) => (shareTitleEl = el)} />}
              </Match>
              {/* An installed extension's own UI (#/ext/<id>). */}
              <Match when={extId()} keyed>
                {(id) => (
                  <ExtensionView
                    id={id}
                    sub={extRoute()?.sub ?? null}
                    info={extensions.data()?.find((e) => e.id === id)}
                    loaded={!extensions.pending()}
                    titleRef={(el) => (extTitleEl = el)}
                    onOpenSession={adoptCreated}
                    onRoute={(sub) => {
                      // The extension navigated inside itself: the page URL follows, so a reload or
                      // a copied link comes back to the same place. replaceState: no history entry,
                      // no hashchange, no reload.
                      history.replaceState(history.state, "", extHref(id, sub));
                      setExtRoute({ id, sub });
                    }}
                    onMaximized={setExtMaximized}
                  />
                )}
              </Match>
              <Match when={!route() && !groupRoute() && !meshRoute() && !sharesRoute() && !shareRoute() && !orgsRoute() && !projectsRoute()}>
                {/* A phone keeps the list's head over its overview (§app.shell/overview): the
                    brand back to the list, and New Session. */}
                <Show when={!unfolded()}>
                  <div class="sidebar-head overview-bar">
                    <BrandLink />
                    <span class="sidebar-spacer" />
                    <button type="button" class="button" onClick={() => setCreating(true)}>
                      <Icon name="plus" />
                      New Session
                    </button>
                  </div>
                </Show>
                <div class="overview">
                  <div class="overview-head">
                    {/* A plain title at every width: the Sessions card below is where the count lives. */}
                    <h1 class="overview-title">Overview</h1>
                  </div>
                  {/* Ways to start something. */}
                  <OverviewActions onNewSession={() => setCreating(true)} />
                  <HomeSessionsCard glance={sessionsGlance(list() ?? [], attention.data(), overseer.data()?.proactivity)} now={now()} onOpenList={openSessionList} />
                  <MeshCard />
                  <Show when={installed()}>{(list) => <ExtensionCards extensions={list()} />}</Show>
                  <ExplanationsCard explanations={explanations.data()} now={now()} />
                  {/* Last: every organization at a glance, and the way into #/orgs. */}
                  <OverviewOrgsCard now={now()} />
                </div>
              </Match>
            </Switch>
          </Show>
        </main>

        <Show when={subagentsPath()} keyed>
          {(path) => (
            <Show when={paneInsights()[path]}>
              {(insight) => (
              <SessionPane
                path={path}
                insight={insight()}
                summary={summaryOf(path)}
                onArchiveChanged={onArchived}
                onGroupsChanged={refresh}
                chatWorkers={subagents()?.board ? null : (chatWorkers[path]?.list ?? null)}
                chatUsage={subagents()?.board ? null : (chatWorkers[path]?.usage ?? null)}
                // No chat on screen from the board: the Timeline can't rewind, as when watching.
                rewind={subagents()?.board ? undefined : rewindControls()[path]}
                rewound={rewound()?.path === path ? rewound()! : null}
                inputsOnly={inputsOnly() === path}
                onInputsOnly={(on) => setInputsOnly(on ? path : null)}
                selected={subagents()?.selected ?? null}
                onSelect={(id) => setSubagents((s) => (s ? { ...s, selected: id } : s))}
                onClose={closeSubagents}
                now={now()}
              />
              )}
            </Show>
          )}
        </Show>

        {/* Nothing to drag while collapsed, and unmounting is what drops its resize listener. */}
        <Show when={!spine()}>
          <SidebarResizer />
        </Show>
      </div>

      <Show when={creating()}>
        <Portal>
          <NewSessionDialog
            prefill={newSessionCwd(summary(), list() ?? [], (cwd) => offersCwd(cwd, showHiddenFolders())) ?? ""}
            knownCwds={[...new Set((list() ?? []).filter((s) => !s.overseer && !s.org).map((s) => s.cwd))]}
            onCancel={() => setCreating(false)}
            onCreated={adoptCreated}
          />
        </Portal>
      </Show>
      <Show when={settingsOpenAt()}>
        <Portal>
          <SettingsDialog initialTab={settingsOpenAt() ?? undefined} cwd={summary()?.cwd ?? null} onClose={closeSettings} />
        </Portal>
      </Show>
      {/* Opened from the sidebar's host menu or #/mesh; only while the mesh is on. */}
      <Show when={meshDetailsOpen() && meshOn()}>
        <MeshDetails onClose={closeMeshDetails} />
      </Show>
      {/* Opened from the sidebar foot's monitor button or the spine; it polls only while open. */}
      <Show when={monitorOpen()}>
        <ResourceMonitor onClose={closeMonitor} titleOf={(path) => list()?.find((x) => x.path === path)?.title} />
      </Show>
      <Show when={staleChange()}>
        {(change) => <StaleTabBanner change={change()} onDismiss={() => setStaleChange(null)} />}
      </Show>
      <GlobalRegions />
    </>
  );
}
