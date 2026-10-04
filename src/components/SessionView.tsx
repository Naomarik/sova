import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js";
import { shareHref } from "../lib/share-slice";
import type { ChatClaudeLogin, SessionSummary, WorkerInfo } from "../../shared/protocol";
import { agentsFeed } from "../lib/agents-feed";
import { teamPulse } from "../lib/insights";
import { relativeTime, shortModel } from "../lib/format";
import { createPaneInsight } from "../lib/pane-insight";
import { explanationsFeed } from "../lib/explanations-feed";
import { knownExplanations, knownOutline, knownWorkers } from "../lib/known-before-mount";
import { PaneScopeProvider, type PaneScope } from "../lib/pane-scope";
import { cwdLabel } from "../lib/remote-session";
import type { RewindControl } from "../lib/inputs";
import { activeTab, home, toast } from "../lib/ui-state";
import { regenerateOutcome, regeneratingTitle, setRegeneratingTitle } from "../lib/auto-title";
import { regenerateSessionTitle } from "../lib/api";
import { sessionWorking, formatCost, type UsageTotalView, workingSplit } from "../lib/workers";
import { ChatView, type ChatRefusal, type OverseerChat } from "./ChatView";
import { ContextGauge, contextDescribedBy } from "./ContextGauge";
import { ProfileChip } from "./ProfileChip";
import type { ChatProfileInfo } from "../../shared/protocol";
import { InsightStrip } from "./InsightStrip";
import { createProjectOverseerControl, ProjectOverseerHead } from "./ProjectOverseerHead";
import { RemoteChip, RemoteHeadChip } from "./RemoteStatus";
import type { PaneInsight, TabId } from "./SessionPane";
import { WatchView } from "./WatchView";
import { Banner, Chip, Icon } from "./ui";
import { hostLabel, hostOf } from "../lib/mesh";
import { HostScopeProvider } from "../lib/host-scope";

/**
 * An open session's Regenerate title (§app.session-list/auto-titles), in the single-session head
 * beside the title and path it changes — never on a list row or a workspace pane. It asks the
 * session's host for a new title, which may replace any title (the press is the request). The
 * new title arriving is the answer; a title that stays gets a toast saying why.
 */
function RegenerateTitleButton(props: { path: string; onDone(): void }) {
  const busy = () => regeneratingTitle(props.path);
  const label = () => (busy() ? "Regenerating title…" : "Regenerate title");
  const press = async () => {
    const path = props.path;
    if (regeneratingTitle(path)) return;
    setRegeneratingTitle(path, true);
    try {
      const r = regenerateOutcome(await regenerateSessionTitle(path).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
      if ("error" in r) toast(r.error);
    } finally {
      setRegeneratingTitle(path, false);
      props.onDone();
    }
  };
  return (
    <button
      type="button"
      class="button button-icon button-ghost session-title-regenerate"
      aria-label={label()}
      title={label()}
      aria-busy={busy() ? "true" : undefined}
      disabled={busy()}
      onClick={() => void press()}
    >
      <Icon name="refresh" small />
    </button>
  );
}

/** Why a session is open read-only: a TUI has it, an unknown writer may, or it is a project
    overseer's earlier conversation. */
export type WatchWhy = "tui" | "recent" | "earlier";

/** How the open session is shown. Decided once when it's opened, then changed only by events. */
export type Decision =
  | { path: string; mode: "chat"; force: boolean; autofocus?: boolean }
  | { path: string; mode: "watch"; why: WatchWhy; listVersion: number };

/** While a session is watched, poll the list so live status (and TUI exit) shows up on its own. */
const WATCH_POLL_MS = 10_000;

/**
 * One session on screen: its head, its outline strip, and either the chat or the read-only watch
 * view — everything that used to live inline in App under the view key. App mounts exactly one of
 * these for `#/s/<path>`; a workspace (`#/g/<id>`) mounts one per pane, so everything that was
 * "the open session's" state is this component's: the read/write decision, the model the chat
 * switched to, and the session's insight (outline, teams, workers).
 *
 * `paneId` is what tells the two apart. Without it this is THE view: bare DOM ids, bare
 * announcements, the back link in the head. With it, every id inside carries the pane's id and
 * every sentence it announces is prefixed with the pane's model.
 */
export function SessionView(props: {
  path: string;
  /** The session-list row for this path; App keeps it non-null while this is mounted. */
  summary: () => SessionSummary;
  /** Bumped on every list load: what tells the watch view that a TUI has let go. */
  listVersion: number;
  now: number;
  /** A session this tab just created: open it for chat with the composer focused. */
  autofocus?: boolean;
  /** Set when this view is one pane of a workspace. */
  paneId?: string;
  /** The user's word for this member inside its group (`GroupMember.label`), when it has one:
      the pane head shows it in place of the title, and it is what the pane is called to AT. */
  label?: () => string | null;
  /** The pane's whole name, pre-assembled by the workspace: label, title or a
      repeat suffix (`claude-opus-5 #2`) — whatever tells this member apart — already joined with
      the model. Given, it overrides the label/title assembly, because the workspace is the only
      place that can see which members repeat: three `opus` members may share a title, and this
      view's own assembly would name all three identically. One rule (paneNames), one string,
      every surface — head, aria-label, live prefix. */
  name?: () => string;
  /** Leading control in the head (the single view's Back link, a pane's nothing). */
  lead?: JSX.Element;
  /** Trailing controls in the head: a pane's own menu. */
  actions?: JSX.Element;
  /** The head's title element, for the folded-width focus move. */
  titleRef?: (el: HTMLHeadingElement) => void;
  onRefresh(): void;
  onArchiveChanged(path: string, archived: boolean): void;
  /** This session's insight store, published for the session pane; null as it goes away. */
  onInsight(path: string, insight: PaneInsight | null): void;
  /** This chat's live subagents and its Σ; null list as the chat goes away. */
  onWorkers(path: string, workers: WorkerInfo[] | null, usage: UsageTotalView | null): void;
  /** This chat's Claude login (ChatView's "claude_login"), keyed by path like onWorkers; null as
      the chat reconnects or goes away. */
  onClaudeLogin?(path: string, login: ChatClaudeLogin | null): void;
  /** This chat's turn-error state, keyed by path like onWorkers: the latest
   *  turn-error message, or null when there is none. State, not events — the workspace's roll-up
   *  pairs a word with colour without panning every pane, and without it a failed member reads
   *  exactly like a quiet one. */
  onTurnError?(path: string, message: string | null): void;
  onRewindControl(path: string, control: RewindControl | null): void;
  onRewound(info: { path: string; entryId: string }): void;
  /** Whether the session pane is open for this session on `tab`. */
  paneOn(path: string, tab: TabId): boolean;
  openPane(path: string, tab: TabId): void;
  toggleSubagents(path: string): void;
  showTimeline(path: string, inputsOnly?: boolean): void;
  /** The path whose pane has the Timeline's "Inputs Only" filter on, else null. */
  inputsOnly(): string | null;
  /** The session the pane is open for, else null. */
  subagentsPath(): string | null;
  /** A bare "/new" in the composer: start a new session in this folder. */
  onNewSession(path: string): Promise<string | null>;
  /** A head of the caller's own in place of the session head (the Overseer's page). */
  head?: () => JSX.Element;
  /** The Overseer's chat extras (ChatView `overseer`). */
  overseer?: OverseerChat;
}) {
  const path = props.path;
  const s = () => props.summary();

  /**
   * A project overseer's conversation, shown alone (a workspace pane keeps its pane head): its own
   * head and status strip (§app.project-overseer/page). A cleared one opens read-only under the
   * earlier-conversation head. Decided once, at mount, like the read/write decision below.
   */
  const po = !props.paneId && !props.head ? s().projectOverseer : undefined;
  const poEarlier = !!po && !!(s().project?.finished ?? s().org?.finished);
  const poControl = po ? createProjectOverseerControl({ projectId: po.projectId, path, summary: s, onRefresh: () => props.onRefresh() }) : null;

  /** The model the chat switched to, this view's own: a workspace's panes each run their own. */
  const [chatModel, setChatModel] = createSignal<string | null>(null);
  /** The chat socket's profile message, for the head chip (§chat.profiles/after-first-message). */
  const [profileInfo, setProfileInfo] = createSignal<ChatProfileInfo | null>(null);

  /**
   * Default for a freshly opened session: TUI-owned → read-only; else try chat without force.
   * The server is the authority on unknown writers: it refuses with code "recent" (before hello,
   * so nothing can be sent) and we fall back to read-only with Chat Anyway.
   */
  const initial = (): Decision =>
    poEarlier
      ? { path, mode: "watch", why: "earlier", listVersion: props.listVersion }
      : s().live
      ? { path, mode: "watch", why: "tui", listVersion: props.listVersion }
      : { path, mode: "chat", force: false, autofocus: props.autofocus };
  // Decided once, when this view mounts for this session: it is keyed on the path, so a new
  // session gets a new view and a new decision.
  const [decision, setDecision] = createSignal<Decision>(initial());

  /** "just now" / "2m ago": when the file last changed, live (the list refreshes, the clock ticks). */
  const changedWhen = () => relativeTime(s().lastActiveAt, props.now);
  const openChat = (force: boolean) => setDecision({ path, mode: "chat", force, autofocus: true });
  const onRefused = (kind: ChatRefusal) => {
    props.onRefresh();
    setDecision({ path, mode: "watch", why: kind === "busy" ? "tui" : "recent", listVersion: props.listVersion });
  };

  // Remount the view (and its socket) when the mode or force flag changes.
  const viewKey = createMemo(() => {
    const d = decision();
    return d.mode === "chat" ? `chat:${d.force}` : `watch:${d.why}`;
  });

  createEffect(() => {
    if (decision().mode !== "watch") return;
    const t = setInterval(props.onRefresh, WATCH_POLL_MS);
    onCleanup(() => clearInterval(t));
  });

  const model = () => (decision().mode === "chat" ? (chatModel() ?? s().model) : s().model);
  const author = () => shortModel(model()) ?? "pi";
  /** This pane's scope: its id for every DOM id below, its model for what it announces. */
  const scope: PaneScope = { id: props.paneId ?? null, label: () => (props.paneId ? paneName() : null) };

  // Outline, teams and workers of this session; reloaded (debounced) when its file changes, and
  // polled while the session pane is open for it — the one poller of this endpoint. The pane
  // reads this same store.
  const { insight, load: loadInsight, reload: reloadInsight } = createPaneInsight(path, () => props.subagentsPath() === path);
  props.onInsight(path, insight);
  onCleanup(() => props.onInsight(path, null));
  // A team event (pause, resume, handover) or a working count can change with no turn of this
  // session's own and no pane open: follow the #/agents poll, so what this view says of its
  // teams and workers is never staler than that page. A memo, so only a changed value reloads (the feed's objects are rebuilt).
  // loadInsight, not reloadInsight: nothing here says the transcript moved (no `changed` bump).
  const pulse = createMemo(() => teamPulse(agentsFeed(), path));
  createEffect(on(pulse, () => void loadInsight(), { defer: true }));

  const working = () => sessionWorking(s());
  /** What's working, by kind: team members and plain subagents are different things. */
  const split = () => workingSplit(working(), insight.data?.workers, insight.data?.teams);

  /**
   * The name this pane is known by, in the head and to AT. In a workspace it is the pre-assembled
   * `name()` (repeat-suffix aware, see the prop); standalone it is "{label or title} · {model}".
   */
  const paneName = () => {
    if (props.name) return props.name();
    const name = props.label?.() || s().title;
    const m = shortModel(model());
    return m ? `${name} · ${m}` : name;
  };

  /**
   * The pane name's `title`: the full string, then the cwd, then the member's session-lifetime
   * spend when the server reports one. "Which answer won" includes cost, and the spend already
   * lives in the member's Usage tab — this puts it one hover away from the comparison
   * itself instead of a tab deep in each pane. The cwd is the raw path (no tilde folding): a
   * tooltip is where the long form earns its place.
   *
   * The cost is `SessionInsight.usage.total` — the SAME field the Usage tab's spend
   * table tallies, not a second computation that could drift — and `total` rather than `main`
   * on purpose: a member that spawned workers to answer spent them as part of its answer, and a
   * comparison that hid subagent cost would tilt "which answer won" toward exactly the members
   * that delegated the most. (`usageTotal` here is the WORKERS' Σ — a member with no worker has
   * none, and the title would show no spend at all; that was the first cut of this line.)
   */
  const paneTitle = () => {
    const cost = formatCost(insight.data?.usage?.total?.cost);
    return [paneName(), cwdLabel(s(), null), ...(cost ? [`${cost} this session`] : [])].filter(Boolean).join(" · ");
  };

  /** The single-session view's head, unchanged: the whole width of the main column. */
  const FullHead = () => (
    <header class="session-head">
      {props.lead}
      <div class="session-head-main">
        <h1 class="session-head-title" tabindex="-1" ref={props.titleRef} title={s().title} aria-describedby={contextDescribedBy(path, scope)}>
          {s().title}
        </h1>
        <p class="session-head-meta">
          {/* A peer's session names its host first: the folder and everything else are that host's. */}
          <Show when={hostOf(path)}>
            {(h) => (
              <>
                <span class="session-head-host" title={`This session lives on ${hostLabel(h())}`}>
                  on {hostLabel(h())}
                </span>
                <span aria-hidden="true">·</span>
              </>
            )}
          </Show>
          <span class="text-mono" title={cwdLabel(s(), null)}>
            {cwdLabel(s(), home())}
          </span>
          {/* Chat sessions show the model as the picker trigger instead. */}
          <Show when={model() && decision().mode !== "chat"}>
            <span aria-hidden="true">·</span>
            <span class="text-mono" title={model()!}>
              {shortModel(model())}
            </span>
          </Show>
        </p>
      </div>
      <RegenerateTitleButton path={path} onDone={props.onRefresh} />
      <ContextGauge path={path} />
      <ProfileChip summary={s()} info={profileInfo()} />
      {/* The remote identity is always present; the connection chip reports liveness separately. */}
      <RemoteChip path={path} summary={s()} />
      <RemoteHeadChip path={path} onOpen={() => props.openPane(path, "session")} />
      <Show when={s().live}>
        <Chip tone="accent" title={`Open in pi in a terminal · pid ${s().live!.pid} · ${s().live!.status}`}>
          TUI
        </Chip>
      </Show>
      {/* The share page, where a slice of this session is picked and shared. */}
      <a class="button button-icon button-ghost session-share-open" href={shareHref(s().id, { host: hostOf(path) })} aria-label="Share session" title="Share session">
        <Icon name="share" />
      </a>
      <button
        type="button"
        class="button button-icon button-ghost session-details-open"
        aria-label="Session details"
        title="Session details"
        aria-controls="session-pane"
        aria-expanded={props.paneOn(path, "session")}
        onClick={() => props.openPane(path, "session")}
      >
        <Icon name="info" />
      </button>
    </header>
  );

  return (
    <PaneScopeProvider value={scope}>
      {/* A peer's session: its composer's models, policy and mode defaults are that host's. */}
      <HostScopeProvider value={() => hostOf(path)}>
      <Show
        when={props.paneId}
        fallback={
          props.head ? (
            props.head()
          ) : poControl ? (
            <ProjectOverseerHead
              control={poControl}
              path={path}
              summary={s}
              now={props.now}
              earlier={poEarlier}
              titleRef={props.titleRef}
              detailsOpen={props.paneOn(path, "session")}
              onDetails={() => props.openPane(path, "session")}
            />
          ) : (
            <FullHead />
          )
        }
      >
        {/* One pane of a workspace: a 40px head under the
            workspace's own, carrying only what tells this member apart — its name, its context
            fill, its state chip, and its tools. The pane's accessible name IS this name. */}
        <header class="workspace-pane-head">
          <span class="workspace-pane-name" id={`pane-${props.paneId}-name`} title={paneTitle()}>
            {paneName()}
          </span>
          <ContextGauge path={path} />
          <ProfileChip summary={s()} info={profileInfo()} />
          {/* Mid-turn, said at workspace level: split mode has N panes and
              no single place that says who is still working — the tab strip's dot covers tabs
              mode only. The pulse is the sanctioned one: work in flight. */}
          <Show when={s().busy || working() > 0}>
            <Chip live title="This member is mid-turn. Its own composer can steer; the group composer waits.">
              Working
            </Chip>
          </Show>
          <RemoteChip path={path} summary={s()} />
          <Show when={s().archived}>
            <Chip title="Archived. Unarchive it to send.">Archived</Chip>
          </Show>
          <Show when={s().live}>
            <Chip tone="accent" title={`Open in pi in a terminal · pid ${s().live!.pid} · ${s().live!.status}`}>
              TUI
            </Chip>
          </Show>
          <div class="workspace-pane-tools">
            <button
              type="button"
              class="button button-icon button-ghost session-details-open"
              aria-label={`Session details · ${paneName()}`}
              title="Session details"
              aria-controls="session-pane"
              aria-expanded={props.paneOn(path, "session")}
              onClick={() => props.openPane(path, "session")}
            >
              <Icon name="info" />
            </button>
            {props.actions}
          </div>
        </header>
      </Show>
      <InsightStrip
        path={path}
        sessionId={s().id}
        outline={insight.data?.outline ?? null}
        known={insight.data ? null : knownOutline(s())}
        explanations={insight.data ? insight.data.explanations : knownExplanations(explanationsFeed(), s().id)}
        now={props.now}
        onOpenTimeline={() => props.showTimeline(path)}
      />

      <Show when={viewKey()} keyed>
        {(_key) => {
          const d = decision();
          return (
            <Switch>
              <Match when={d.mode === "watch" && d}>
                {(w) => (
                  <WatchView
                    path={path}
                    sessionId={s().id}
                    author={author()}
                    streaming={!!s().live}
                    onAppend={reloadInsight}
                    workersWorking={working()}
                    workersTotal={insight.data ? (insight.data.workers?.length ?? 0) : knownWorkers(s())}
                    workersSplit={split()}
                    onShowWorkers={() => props.toggleSubagents(path)}
                    workersOpen={props.paneOn(path, "agents")}
                    stateBanner={
                      <Switch>
                        <Match when={w().why === "recent"}>
                          <Banner
                            tone="warn"
                            title="Another pi process may be writing this session."
                            // The age is read live from the list row against App's clock: a number captured at
                            // connect time froze while the 120s it counts toward ran out.
                            body={`${changedWhen() ? `It changed ${changedWhen()}` : "It changed"} from a process we can't identify, and no TUI claims it, so we only read it. Chatting here would put 2 writers on one file.`}
                            action={
                              <button type="button" class="button button-sm" onClick={() => openChat(true)}>
                                Chat Anyway
                              </button>
                            }
                          />
                        </Match>
                        <Match when={!s().live && props.listVersion > w().listVersion}>
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
                      w().why === "earlier"
                        ? { icon: "clock", text: "An earlier conversation. Read only." }
                        : w().why === "recent"
                        ? { icon: "attention", text: "Read only while another process may be writing this file." }
                        : { icon: "attention", text: "Read only while this session is open in the TUI." }
                    }
                  />
                )}
              </Match>
              <Match when={d.mode === "chat" && d}>
                {(c) => {
                  onCleanup(() => {
                    props.onWorkers(path, null, null);
                    props.onClaudeLogin?.(path, null);
                  });
                  return (
                    <ChatView
                      path={path}
                      summary={() => s()}
                      cwdLabel={cwdLabel(s(), home())}
                      author={author()}
                      force={c().force}
                      autofocus={c().autofocus}
                      onModel={(m) => {
                        setChatModel(m);
                        // The sidebar row reads the list: re-read it after a switch.
                        if (m && m !== s().model) props.onRefresh();
                      }}
                      onRewindControl={(control) => props.onRewindControl(path, control)}
                      onRewound={props.onRewound}
                      inputsOpen={props.paneOn(path, "timeline") && props.inputsOnly() === path}
                      paneTab={props.subagentsPath() === path ? activeTab(path) : null}
                      onShowTimeline={(only) => props.showTimeline(path, only)}
                      onRefused={onRefused}
                      onStarted={props.onRefresh}
                      onArchiveChanged={props.onArchiveChanged}
                      onSettled={() => {
                        props.onRefresh();
                        reloadInsight();
                      }}
                      onWorkers={(w, usage) => props.onWorkers(path, w, usage)}
                      onClaudeLogin={props.onClaudeLogin ? (login) => props.onClaudeLogin!(path, login) : undefined}
                      onProfile={setProfileInfo}
                      onTurnError={props.onTurnError ? (m) => props.onTurnError!(path, m) : undefined}
                      onShowWorkers={() => props.toggleSubagents(path)}
                      workersOpen={props.paneOn(path, "agents")}
                      onNewSession={() => props.onNewSession(path)}
                      overseer={props.overseer}
                      projectOverseer={poControl && !poEarlier ? { onClear: poControl.clear, onReloaded: poControl.onReloaded } : undefined}
                      teams={insight.data?.teams}
                    />
                  );
                }}
              </Match>
            </Switch>
          );
        }}
      </Show>
      </HostScopeProvider>
    </PaneScopeProvider>
  );
}
