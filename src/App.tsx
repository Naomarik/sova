import { batch, createEffect, createMemo, createResource, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Portal } from "solid-js/web";
import type { SessionSummary, WorkerInfo } from "../shared/protocol";
import { reuseUnchanged } from "./lib/summary-diff";
import { setAgentsFeedSource } from "./lib/agents-feed";
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
  getOverseer,
  getSessionSummaryById,
  getThemes,
  listSessions,
  setSessionArchived,
} from "./lib/api";
import { socketReconnects } from "./lib/socket";
import { firstBaseline, helloStep, HELLO_POLL_MS, meshReadInit, pathOfViewKey, sessionViewKey, watchMove, HOST_CONFIRM_MS, seedPeerList, setHostCheck, type HelloBaseline, type PendingHost, type HelloChange, sessionHrefOn } from "./lib/mesh";
import { hostLabel, hostOf, isMeshHash, joinHostLists, linkedSessionRow, meshRetryDelay, meshState, meshOn, meshPeers, mergePeerLists, noteHost, notePeerSessions, peerInfo, peerUnavailable, sessionRouteFromHash, setMeshState } from "./lib/mesh";
import { isOverseerHash, isOverseerShortcut, OVERSEER_HASH, OVERSEER_POLL_MS, overseerHistoryId } from "./lib/overseer";
import { isMainThread } from "./lib/regions";
import { sessionIdFromHash, setGroupLinkIndex, setSessionIndex } from "./lib/session-links";
import { agentsHref, insightsRouteFromHash, legacyInsightsTarget } from "./lib/insights";
import { transcriptRoot } from "./lib/jump";
import { groupRouteFromHash } from "./lib/group-route";
import { extHref, extRouteFromHash } from "./lib/ext-route";
import { loadSessionGroups, sessionGroups, sessionGroupsLoaded } from "./lib/session-groups";
import { createThenArchive, dropArchived, newSessionCwd } from "./lib/new-session";
import { cwdLabel } from "./lib/remote-session";
import { createPoll } from "./lib/poll";
import { homeFromSessionPath } from "./lib/format";
import { reconcileTheme } from "./lib/theme";
import { rememberedWidth, spine, spineWidth } from "./lib/spine";
import { applySidebarWidth } from "./lib/sidebar-width";
import { closeSettings, openSettings, settingsOpenAt } from "./lib/settings-nav";
import type { RewindControl } from "./lib/inputs";
import { activeTab, home, setActiveTab, setHome, toast } from "./lib/ui-state";
import { sessionWorking, type UsageTotalView } from "./lib/workers";
import { sourceBlocked } from "./lib/fanout";
import { AgentsView } from "./components/AgentsView";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { ExplainGrid } from "./components/ExplainGallery";
import { ExtensionCards, ExtensionView } from "./components/ExtensionView";
import { MeshCard, MeshView, StaleTabBanner } from "./components/MeshView";
import { MeshDetails } from "./components/MeshDetails";
import { closeMeshDetails, meshDetailsOpen } from "./lib/mesh-details";
import { FanoutDialog, type FanoutSource } from "./components/FanoutDialog";
import { GroupView, paneIdFor, workspaceFocus, type PaneWiring } from "./components/GroupView";
import { OverseerView } from "./components/OverseerView";
import { SessionPane, type PaneInsight, type TabId } from "./components/SessionPane";
import { SessionView } from "./components/SessionView";
import { sessionHref, Sidebar } from "./components/Sidebar";
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
/** The explanations store only changes when a /explain subagent finishes; the sidebar row can wait. */
const EXPLAIN_POLL_MS = 60_000;

/** `#/overseer` (null: another route), with the earlier file `#/overseer/h/<id>` names. */
const overseerRouteFromHash = (hash: string) => (isOverseerHash(hash) ? { historyId: overseerHistoryId(hash) } : null);
/** Installed extensions and their health; the server caches each health probe for 10 s. */
const EXTENSIONS_POLL_MS = 15_000;
/** While a peer is configured, its status and its sessions are re-read this often. Never with none. */
const MESH_POLL_MS = 15_000;
const folded = () => window.matchMedia("(max-width: 767px)").matches;

/** Live `matchMedia` (the ExplainGallery pattern): the spine is a desktop affordance, so it only
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
  const [sessions, { refetch }] = createResource<SessionSummary[] | undefined>(async (_, { value }) => {
    try {
      const next = reuseUnchanged(await listSessions(), value);
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
      setListError((err as Error).message);
      return value;
    }
  });
  const list = () => sessions.latest; // keeps the old list on screen while refreshing

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
        setMeshState(s);
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
  const [peerLists, setPeerLists] = createSignal<Map<string, SessionSummary[]>>(new Map());
  /** The first GET /api/mesh/sessions has answered or failed: a peer's session a link names is known by now. */
  const [peersSettled, setPeersSettled] = createSignal(false);
  const loadPeerSessions = async () => {
    if (!meshOn()) return;
    try {
      const answer = await fetchMeshSessions();
      const next = mergePeerLists(peerLists(), answer, meshPeers());
      for (const p of meshPeers()) notePeerSessions(p.id, (next.get(p.id) ?? []).map((s) => s.path));
      setPeerLists(next);
    } catch {
      // Keep the last lists: the peers' own status (GET /api/mesh) says what is down.
    }
    setPeersSettled(true);
  };
  createEffect(() => {
    if (!meshOn()) {
      if (peerLists().size) setPeerLists(new Map());
      return;
    }
    void loadPeerSessions();
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
  const sidebarSessions = createMemo(() => {
    createdVersion();
    const l = allSessions();
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
  const [groupRoute, setGroupRoute] = createSignal(groupRouteFromHash(location.hash));
  // `sova://g/` links in messages resolve against the groups this tab knows (lib/session-links).
  createEffect(() => sessionGroupsLoaded() && setGroupLinkIndex(sessionGroups()));
  const [insightsRoute, setInsightsRoute] = createSignal(insightsRouteFromHash(location.hash));
  const [overseerRoute, setOverseerRoute] = createSignal(overseerRouteFromHash(location.hash));
  const [extRoute, setExtRoute] = createSignal(extRouteFromHash(location.hash));
  const [meshRoute, setMeshRoute] = createSignal(isMeshHash(location.hash));
  /** The extension on screen: the view is keyed by this, so a sub-route change never remounts it
      (which would reload the extension's iframe). */
  const extId = createMemo(() => extRoute()?.id ?? null);
  /** The extension asked to fill the window (ext-contract §3.7); ExtensionView owns it. */
  const [extMaximized, setExtMaximized] = createSignal(false);
  /** Team card to scroll to on `#/agents/<teamKey>` (or a bare team id from an older link). */
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
  const overseer = createPoll(getOverseer, OVERSEER_POLL_MS);
  const extensions = createPoll(fetchExtensions, EXTENSIONS_POLL_MS);
  /** The landing page shows the Extensions section only when something is installed. */
  const installed = createMemo(() => {
    const items = extensions.data();
    return items && items.length > 0 ? items : null;
  });
  /** The landing page renders the grid only when it has rows; the empty state stays in the modal. */
  const explained = createMemo(() => {
    const items = explanations.data();
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
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("hashchange", onHash);
    window.removeEventListener("keydown", onKeyDown);
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
    // The Overseer's own chat is a session on screen too: its Timeline and Session info pane work.
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
   * The fanout dialog, when it is open: `{}` with no source is a fresh-prompt fanout, and a
   * `source` opens it on that session with Fork selected. `presetCwd` is the New Session
   * dialog's handoff: fresh mode starts in the folder that dialog had chosen. It
   * lives here rather than in the workspace because it can be opened from a session too, and it
   * outlives the surface that opened it — the dialog stays up while the request is in flight.
   */
  const [fanout, setFanout] = createSignal<{ source?: FanoutSource; into?: { id: string; name: string }; presetCwd?: string } | null>(null);

  /**
   * The skip link's target and name move together: a workspace with members
   * has one action — the group composer — so the link says "Skip to Group Composer" and lands on
   * its input; before the composer exists (a workspace with no members) it is the focused pane's
   * transcript and says so, because a link that says "Group Composer" and lands on a transcript
   * is worse than either. A link that says "Transcript" in a workspace of N panes would also
   * have to pick one silently; the composer is the one target that needs no picking.
   */
  const hasGroupComposer = () => !!groupRoute() && !!openGroup() && groupMembers().length > 0;
  const skipHref = () => (hasGroupComposer() ? "#group-composer" : `#${transcriptIdOf(focusedPath())}`);
  const skipLabel = () => (hasGroupComposer() ? "Skip to Group Composer" : "Skip to Transcript");

  // At folded width, opening a session swaps the column: move focus to its title.
  let titleEl: HTMLHeadingElement | undefined;
  createEffect(on(route, (p) => p && folded() && queueMicrotask(() => titleEl?.focus()), { defer: true }));
  let insightsTitleEl: HTMLHeadingElement | undefined;
  let extTitleEl: HTMLHeadingElement | undefined;
  let meshTitleEl: HTMLHeadingElement | undefined;
  createEffect(on(meshRoute, (open) => open && folded() && queueMicrotask(() => meshTitleEl?.focus()), { defer: true }));
  createEffect(on(extId, (id) => id && folded() && queueMicrotask(() => extTitleEl?.focus()), { defer: true }));
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
    // Route and autofocus move together: "hashchange" fires later, and the view mounts from the
    // route — it must already know this session is one to open for chat, composer focused.
    location.hash = sessionHref(s.path);
    batch(() => {
      setAutofocusPath(s.path);
      onHash();
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

  /** The sessions the landing page counts: main threads, as the sidebar lists them. */
  const mainList = () => (list() ?? []).filter(isMainThread);
  const folderCount = () => new Set(mainList().map((s) => s.cwd)).size;

  // ---- Subagents pane: open for one session path, closed whenever the route changes ----------
  const [subagents, setSubagents] = createSignal<{ path: string; selected: string | null } | null>(null);
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
  /** The pane's session: open, and one of the sessions on screen. */
  const subagentsPath = () => {
    const p = subagents()?.path;
    return p && openPaths().includes(p) ? p : null;
  };
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
    onRewindControl: setRewindControl,
    onRewound: noteRewound,
    onCreated: adoptCreated,
    paneOn,
    openPane,
    toggleSubagents,
    showTimeline,
    inputsOnly,
    subagentsPath,
    onNewSession: startNewFrom,
    // From a workspace: the members land in THIS group, beside the ones already there.
    // With the group's own seed it is the APPEND case — "I want two more of these": the new
    // members branch from the same fork point the existing ones share, which is the one `groupId`
    // + `source` combination the route defines and the one the UI could never reach before. A
    // hand-made group (no seed) lands beside them with no source, as before; a seed whose parent
    // is no longer in the list falls back to that too — the fork UI would otherwise name a
    // transcript nobody can show.
    onFanOut: (seed?: { parentSessionPath: string; leafId: string }) => {
      const group = openGroup();
      if (!group) {
        setFanout({});
        return;
      }
      const into = { id: group.id, name: group.name };
      const parent = seed ? (list() ?? []).find((s) => s.path === seed.parentSessionPath) : undefined;
      if (!seed || !parent) {
        setFanout({ into });
        return;
      }
      setFanout({
        into,
        source: {
          session: parent,
          leafId: seed.leafId,
          // The source is not on screen here: its fill was never reported, and the summary's own
          // tail value is not the fork point's fill once the source ran on — so unknown, never a
          // guess. No `messages` either: the fork note hides rather than count what it can't see.
          context: null,
          blocked: () => sourceBlocked(parent),
        },
      });
    },
    onFanOutFrom: (source) => setFanout({ source }),
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
        data-view={groupRoute() ? "workspace" : route() || insightsRoute() || overseerRoute() || extRoute() || meshRoute() ? "session" : "list"}
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
          agents={agents.data()}
          insightsPage={insightsRoute()?.page ?? null}
          onRefresh={refresh}
          onArchiveChanged={onArchived}
          onNew={() => setCreating(true)}
          onOpenSettings={() => openSettings()}
          overseer={overseer.data()}
          overseerOpen={!!overseerRoute()}
        />

        {/* The workspace takes the whole second column, so it IS the main: no session head, and
            its own head instead. */}
        <main class={groupRoute() ? "workspace" : "app-main"} aria-label={openGroup() ? `Workspace: ${openGroup()!.name}` : undefined}>
          <Show
            when={!insightsRoute() && !overseerRoute()}
            fallback={
              <Switch>
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
                      onCreated={wiring.onCreated}
                      onArchiveChanged={wiring.onArchiveChanged}
                      onInsight={wiring.onInsight}
                      onWorkers={wiring.onWorkers}
                      onRewindControl={wiring.onRewindControl}
                      onRewound={wiring.onRewound}
                      paneOn={wiring.paneOn}
                      openPane={wiring.openPane}
                      toggleSubagents={wiring.toggleSubagents}
                      showTimeline={wiring.showTimeline}
                      inputsOnly={wiring.inputsOnly}
                      subagentsPath={wiring.subagentsPath}
                      onNewSession={wiring.onNewSession}
                      onFanOut={wiring.onFanOutFrom}
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
              {/* The peer mesh (#/mesh): hosts, peers.json, sync, first-peer setup. */}
              <Match when={meshRoute()}>
                <MeshView now={now()} titleRef={(el) => (meshTitleEl = el)} />
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
              <Match when={!route() && !groupRoute() && !meshRoute()}>
                <div class="welcome">
                  <div class="welcome-head">
                    <div class="empty">
                      <Icon name="chat" class="empty-mark" />
                      <p class="empty-title">
                        <Show when={list()} fallback="Loading sessions.">
                          {mainList().length} sessions across {folderCount()} folders.
                        </Show>
                      </p>
                      <p class="empty-body">Pick one to read it, or start a new one.</p>
                      {/* Two ways to start something: one session, or the same prompt to N models
                          at once (the empty screen is fanout's front door,
                          which is why it is offered here and not in the sidebar). */}
                      <div class="cluster empty-action">
                        <button type="button" class="button" onClick={() => setCreating(true)}>
                          <Icon name="plus" />
                          New Session
                        </button>
                        <button type="button" class="button" onClick={() => setFanout({})}>
                          <span class="icon icon-sm" style={{ "--icon": "url(/icons/branch.svg)" }} aria-hidden="true" />
                          Fan Out…
                        </button>
                      </div>
                    </div>
                  </div>
                  <MeshCard />
                  <Show when={installed()}>{(list) => <ExtensionCards extensions={list()} />}</Show>
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
                chatWorkers={chatWorkers[path]?.list ?? null}
                chatUsage={chatWorkers[path]?.usage ?? null}
                rewind={rewindControls()[path]}
                rewound={rewound()?.path === path ? rewound()! : null}
                inputsOnly={inputsOnly() === path}
                onInputsOnly={(on) => setInputsOnly(on ? path : null)}
                selected={subagents()?.selected ?? null}
                onSelect={(id) => setSubagents({ path, selected: id })}
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
            prefill={newSessionCwd(summary(), list() ?? []) ?? ""}
            knownCwds={[...new Set((list() ?? []).filter((s) => !s.overseer).map((s) => s.cwd))]}
            onCancel={() => setCreating(false)}
            onCreated={adoptCreated}
            onFanOut={(cwd) => {
              // The type field's handoff: close this dialog, open the fanout dialog on a fresh
              // prompt, with the folder it had chosen carried over.
              setCreating(false);
              setFanout({ presetCwd: cwd });
            }}
          />
        </Portal>
      </Show>
      <Show when={fanout()}>
        {(open) => (
          <Portal>
            <FanoutDialog
              source={open().source}
              into={open().into}
              presetCwd={open().presetCwd}
              sessions={list() ?? []}
              onClose={() => setFanout(null)}
              onCreated={refresh}
            />
          </Portal>
        )}
      </Show>
      <Show when={settingsOpenAt()}>
        <Portal>
          <SettingsDialog initialTab={settingsOpenAt() ?? undefined} onClose={closeSettings} />
        </Portal>
      </Show>
      {/* Opened from the sidebar's host menu or #/mesh; only while the mesh is on. */}
      <Show when={meshDetailsOpen() && meshOn()}>
        <MeshDetails onClose={closeMeshDetails} />
      </Show>
      <Show when={staleChange()}>
        {(change) => <StaleTabBanner change={change()} onDismiss={() => setStaleChange(null)} />}
      </Show>
      <GlobalRegions />
    </>
  );
}
