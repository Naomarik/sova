import { createEffect, createMemo, createResource, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Portal } from "solid-js/web";
import type { SessionInsight, SessionSummary, TeamInfo } from "../shared/protocol";
import { fetchAgents, fetchSessionInsight, fetchUsage, listSessions, setSessionArchived } from "./lib/api";
import { agentsHref, insightsRouteFromHash, legacyInsightsTarget } from "./lib/insights";
import { createPoll } from "./lib/poll";
import { homeFromSessionPath, shortModel, tildePath } from "./lib/format";
import { copyText, home, setHome, toast } from "./lib/ui-state";
import { sessionWorking } from "./lib/workers";
import { ChatView, type ChatRefusal } from "./components/ChatView";
import { AgentsView } from "./components/AgentsView";
import { ContextGauge, ContextMetaPrefix, contextDescribedBy } from "./components/ContextGauge";
import { ModeMenu, type ModeControl } from "./components/ModeMenu";
import { ModelMenu, type ModelControl } from "./components/ModelMenu";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { OutlineStrip } from "./components/OutlineStrip";
import { sessionHref, Sidebar } from "./components/Sidebar";
import { UsageView } from "./components/UsageView";
import { WatchView } from "./components/WatchView";
import { Banner, Chip, CopyButton, CountChip, GlobalRegions, Icon } from "./components/ui";

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
  a.live?.pid === b.live?.pid &&
  a.live?.status === b.live?.status &&
  a.live?.workers?.working === b.live?.workers?.working &&
  a.live?.workers?.total === b.live?.workers?.total &&
  a.archived === b.archived;

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

/** Insights polling (paused while the tab is hidden). The usage file itself changes ≤ every 3 min. */
const USAGE_POLL_MS = 60_000;
const AGENTS_POLL_MS = 5_000;
/** Session insight (outline, teams) reloads this long after the session's file last changed. */
const SESSION_INSIGHT_DEBOUNCE_MS = 1500;

const folded = () => window.matchMedia("(max-width: 767px)").matches;

/**
 * Archive/Unarchive for a web-spawned session (DESIGN_NOTES §2 "Archiving"). Archiving is refused
 * while it's live in a TUI, since it would stay on top anyway; unarchiving always works.
 */
function ArchiveButton(props: { session: SessionSummary; onChanged(): void }) {
  const [pending, setPending] = createSignal(false);
  const archived = () => props.session.archived === true; // older servers send none
  const blocked = () => !archived() && props.session.live !== null;
  const label = () => (archived() ? "Unarchive Session" : "Archive Session");
  const click = async () => {
    if (pending() || blocked()) return;
    const next = !archived();
    setPending(true);
    try {
      await setSessionArchived(props.session.path, next);
      toast(next ? "Archived. Find it under Archive." : "Moved back to Live & web.");
      props.onChanged();
    } catch (err) {
      toast(`Couldn't ${next ? "archive" : "unarchive"} this session. ${(err as Error).message}`);
    } finally {
      setPending(false);
    }
  };
  return (
    <button
      type="button"
      class="button button-icon button-ghost session-archive"
      aria-label={label()}
      title={blocked() ? "Open in a TUI. It stays on top while live." : label()}
      aria-disabled={blocked() || pending() ? "true" : undefined}
      onClick={click}
    >
      <Icon name="archive" />
    </button>
  );
}

export function App() {
  const [listError, setListError] = createSignal<string | null>(null);
  /** Bumped on every successful list load, so views can tell a fresh list from a stale one. */
  const [listVersion, setListVersion] = createSignal(0);
  // The fetcher never rejects: on failure it keeps the previous list and reports the error,
  // so reading the resource never throws.
  const [sessions, { refetch }] = createResource<SessionSummary[] | undefined>(async (_, { value }) => {
    try {
      const next = reuseUnchanged(await listSessions(), value);
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

  redirectLegacyInsights();
  const [route, setRoute] = createSignal<string | null>(pathFromHash());
  const [insightsRoute, setInsightsRoute] = createSignal(insightsRouteFromHash(location.hash));
  /** Team card to scroll to on `#/agents/<teamId>`. */
  const focusTeam = () => {
    const r = insightsRoute();
    return r?.page === "agents" ? r.team : null;
  };
  const usage = createPoll(fetchUsage, USAGE_POLL_MS);
  const agents = createPoll(fetchAgents, AGENTS_POLL_MS);
  const [decision, setDecision] = createSignal<Decision | null>(null);
  /** Sessions we just created: shown before the list catches up. */
  const created = new Map<string, SessionSummary>();
  const [creating, setCreating] = createSignal(false);
  const [chatModel, setChatModel] = createSignal<string | null>(null);
  /** The open chat session's model picker controls (DESIGN_NOTES §4c); null outside chat. */
  const [modelControl, setModelControl] = createSignal<ModelControl | null>(null);
  const [modeControl, setModeControl] = createSignal<ModeControl | null>(null);
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
    return list()?.find((s) => s.path === p) ?? created.get(p) ?? null;
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

  const folderCount = () => new Set((list() ?? []).map((s) => s.cwd)).size;

  return (
    <>
      <a class="button skip-link" href="#transcript">
        Skip to Transcript
      </a>
      <div class="app" data-view={route() || insightsRoute() ? "session" : "list"}>
        <Sidebar
          sessions={list()}
          loading={sessions.loading}
          error={listError()}
          selected={route()}
          now={now()}
          usage={usage.data()}
          agents={agents.data()}
          insightsPage={insightsRoute()?.page ?? null}
          onRefresh={refresh}
          onNew={() => setCreating(true)}
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
                <div class="center-fill">
                  <Show
                    when={!route() || !list()}
                    fallback={
                      <div class="empty">
                        <p class="empty-title">Couldn't find this session.</p>
                        <p class="empty-body">It isn't in the list of sessions on disk anymore.</p>
                        <a class="button empty-action" href="#/">
                          Back to Sessions
                        </a>
                      </div>
                    }
                  >
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
                  </Show>
                </div>
              }
            >
              {(_key) => {
                const d = decision()!;
                const s = () => summary() ?? created.get(d.path)!;
                const model = () => (d.mode === "chat" ? chatModel() ?? s().model : s().model);
                const author = () => shortModel(model()) ?? "pi";

                // Outline and teams of this session; reloaded (debounced) when its file changes.
                const [insight, setInsight] = createStore<{ data: SessionInsight | null }>({ data: null });
                const loadInsight = async () => {
                  try {
                    // Keyed by id so open topics stay open when a newer outline lands.
                    setInsight("data", reconcile(await fetchSessionInsight(d.path), { key: "id" }));
                  } catch {
                    // Secondary to the transcript: keep the last outline, the next change retries.
                  }
                };
                let insightTimer: ReturnType<typeof setTimeout> | undefined;
                const reloadInsight = () => {
                  clearTimeout(insightTimer);
                  insightTimer = setTimeout(loadInsight, SESSION_INSIGHT_DEBOUNCE_MS);
                };
                onCleanup(() => clearTimeout(insightTimer));
                void loadInsight();
                const working = () => sessionWorking(s());
                /** The busiest live team: where the head chip links. */
                const liveTeam = () =>
                  (insight.data?.teams ?? []).filter((t) => t.live).reduce<TeamInfo | null>((b, t) => (!b || t.working > b.working ? t : b), null);
                const team = () => insight.data?.teams[0] ?? null;
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
                          <span class="text-mono" title={s().cwd}>
                            {tildePath(s().cwd, home())}
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
                      {/* Global mode (§4g): chat sessions only; a watched TUI keeps its own in memory. */}
                      <Show when={d.mode === "chat" && modeControl()}>{(c) => <ModeMenu control={c()} />}</Show>
                      <Show when={d.mode === "chat" && modelControl()}>{(c) => <ModelMenu control={c()} />}</Show>
                      <Show
                        when={working() > 0}
                        fallback={
                          <Show when={!s().live && team()}>
                            {(t) => <CountChip title={t().name}>Team · {t().members.length}</CountChip>}
                          </Show>
                        }
                      >
                        <Show when={liveTeam()} fallback={<CountChip href={agentsHref()} title="Subagents working now">{working()} working</CountChip>}>
                          {(t) => (
                            <CountChip href={agentsHref(t().id)} title={t().name}>
                              Team · {working()} working
                            </CountChip>
                          )}
                        </Show>
                      </Show>
                      <Show when={s().live}>
                        <Chip tone="accent" live title={`Open in pi in a terminal · pid ${s().live!.pid} · ${s().live!.status}`}>
                          Live
                        </Chip>
                      </Show>
                      <Show when={s().origin === "web"}>
                        <ArchiveButton session={s()} onChanged={refresh} />
                      </Show>
                      <CopyButton iconOnly label="Copy Session Path" text={() => d.path} onCopy={(t) => copyText(t, "Copied path.")} />
                    </header>
                    <Show when={insight.data?.outline}>{(o) => <OutlineStrip path={d.path} outline={o()} now={now()} />}</Show>

                    <Switch>
                      <Match when={d.mode === "watch" && d}>
                        {(w) => (
                          <WatchView
                            path={d.path}
                            author={author()}
                            streaming={!!s().live}
                            onAppend={reloadInsight}
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
                        {(c) => (
                          <ChatView
                            path={d.path}
                            cwdLabel={tildePath(s().cwd, home())}
                            author={author()}
                            force={c().force}
                            autofocus={c().autofocus}
                            onModel={(m) => {
                              setChatModel(m);
                              // The sidebar row reads the list: re-read it after a switch.
                              if (m && m !== s().model) refresh();
                            }}
                            onModelControl={setModelControl}
                            onModeControl={setModeControl}
                            onRefused={onRefused}
                            onSettled={() => {
                              refresh();
                              reloadInsight();
                            }}
                          />
                        )}
                      </Match>
                    </Switch>
                  </>
                );
              }}
            </Show>
          </Show>
        </main>
      </div>

      <Show when={creating()}>
        <Portal>
          <NewSessionDialog
            prefill={summary()?.cwd ?? [...(list() ?? [])].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0]?.cwd ?? ""}
            knownCwds={[...new Set((list() ?? []).map((s) => s.cwd))]}
            onCancel={() => setCreating(false)}
            onCreated={(s) => {
              created.set(s.path, s);
              setCreating(false);
              refresh();
              // Our own new session: chat right away, composer focused.
              setDecision({ path: s.path, mode: "chat", force: false, autofocus: true });
              location.hash = sessionHref(s.path);
            }}
          />
        </Portal>
      </Show>
      <GlobalRegions />
    </>
  );
}
