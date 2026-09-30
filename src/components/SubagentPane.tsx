import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { LinkedAgentInfo } from "../../shared/mesh-links";
import type { ContextInfo, TeamInfo, TeamMember, TranscriptItem, WatchServerMessage, WorkerInfo } from "../../shared/protocol";
import { claudeWatchUrl, fetchHiddenWorkers, wsUrl } from "../lib/api";
import { linkGroupId, linkGroups, linkHostLabel, linkReach, threadHost, type LinkReach } from "../lib/links";
import { chatLinks } from "../lib/links-live";
import { hostOf, meshState, sessionHrefOn } from "../lib/mesh";
import { clockTime, compactModel, shortModel } from "../lib/format";
import { memberBadges, memberStatus, newestEventLine } from "../lib/insights";
import { createReconnectingSocket } from "../lib/socket";
import { formatTokens } from "../lib/context";
import { asOfClock, capTitle, ringContext, sortWorkers, sourceKey, sourceName, sourceOf, transcriptContext, transcriptUsage, usageHeadline,
  usageTitle, usageUnavailable, type TranscriptSource, type UsageView, workerContext, workerEjected, workerLabel, workersNoun, workerTeam,
  workerUsage } from "../lib/workers";
import { ConnectionBanner } from "./ConnectionBanner";
import { ContextReadout } from "./ContextGauge";
import { ContextRing } from "./ContextRing";
import type { PaneInsight } from "./SessionPane";
import { LinkedAgentMeta, LinkedAgentRow, LinkStateChip, LinkThreadView } from "./LinkedAgents";
import { HistoryItems, TranscriptSkeleton } from "./Thread";
import { Banner, Chip, Icon } from "./ui";
import { providerWait, watchProviderWaits } from "../lib/provider-waiting";
import { waitingSentence } from "../../shared/provider-limits";

/** Within this distance of the end, the transcript follows new content. */
const FOLLOW_PX = 80;
/** The server's /ws/watch messages for a transcript that isn't there (close 4404): a pi path
    that doesn't exist, or a Claude session id with no record under ~/.claude/projects. */
const FILE_GONE = new Set(["Session file not found", "Unknown Claude Code session"]);

/** Settled states carry "as of" their end (else last activity); running ones don't. */
/** One list section: a team and the workers of it this session lists, or the teamless ones. */
interface Group {
  key: string;
  team: TeamInfo | null;
  workers: WorkerInfo[];
}

/** The dot between meta facts; a separator is punctuation, not something to read out. */
const MetaSep = () => (
  <span class="meta-line-sep" aria-hidden="true">
    ·
  </span>
);

/** Which half a narrow pane shows: the worker list, or one worker. A wide
    pane shows both side by side and ignores it. */
export type AgentsView = "list" | "detail";

/** Shown to the reader right now: `display: none` (the other half of a narrow pane) is not. */
const shown = (el: Element | null | undefined): el is HTMLElement => !!el && (el as HTMLElement).checkVisibility();

const SETTLED = new Set<WorkerInfo["status"]>(["waiting", "done", "error", "killed", "restored"]);
const asOf = (w: WorkerInfo): number | undefined => (SETTLED.has(w.status) ? w.endedAt ?? w.lastActivity : undefined);

/**
 * The session pane's Agents tab: the open session's workers on the left, the
 * selected worker's read-only transcript (its own session file over `/ws/watch`) on the right.
 * Nothing is ever sent to a worker. `chatWorkers` is the chat runtime's live list; without it
 * (watching, or before the first "workers" message) the list comes from the polled insight.
 * The head, Escape and the opening focus belong to SessionPane. A narrow pane is list/detail:
 * `view` says which half shows (SessionPane holds it, so it outlives a tab switch); null until
 * the first workers arrive, when it settles once — one worker opens on it, more on the list.
 */
export function SubagentPane(props: {
  /** The session these workers belong to: where Resume Worker is sent. */
  path: string;
  chatWorkers: WorkerInfo[] | null;
  /** App's insight, polled while the pane is open: even while chatting, the teams give workers
      their role names. */
  insight: PaneInsight;
  selected: string | null;
  onSelect(id: string): void;
  view: AgentsView | null;
  onView(view: AgentsView): void;
  /** This is the Overseer's pane: it lists every link on its host and is no member of any. */
  overseer?: boolean;
}) {
  const insight = {
    data: () => props.insight.data ?? undefined,
    error: () => props.insight.error,
    pending: () => props.insight.pending,
  };
  const listed = createMemo(() => sortWorkers(props.chatWorkers ?? insight.data()?.workers ?? []));
  /** The workers the live record couldn't list (it carries at most 40), fetched on "Show {n}
      More" and never on a poll: for this session, and the record's count when they came. */
  const [more, setMore] = createSignal<{ path: string; counted: number; workers: WorkerInfo[] } | null>(null);
  const [moreLoading, setMoreLoading] = createSignal(false);
  const [moreError, setMoreError] = createSignal<string | null>(null);
  /** The listed rows, then the fetched ones the record still doesn't list, oldest last. */
  const workers = createMemo(() => {
    const rows = listed();
    const got = more();
    if (!got || got.path !== props.path) return rows;
    const ids = new Set(rows.map((w) => w.id));
    const extra = got.workers.filter((w) => !ids.has(w.id));
    return extra.length > 0 ? [...rows, ...extra] : rows;
  });
  /** How many workers the record counts, when that is more than the list shows; null otherwise.
      After Show More, only a count that grew since (a new worker) offers it again. */
  const counted = createMemo(() => {
    const n = insight.data()?.workerTotal;
    if (n === undefined || n <= workers().length) return null;
    const got = more();
    return got && got.path === props.path && n <= got.counted ? null : n;
  });
  const showMore = async () => {
    const path = props.path;
    const n = insight.data()?.workerTotal ?? 0;
    setMoreLoading(true);
    setMoreError(null);
    try {
      const res = await fetchHiddenWorkers(path);
      if (path !== props.path) return;
      const shown = new Set(workers().map((w) => w.id));
      setMore({ path, counted: n, workers: res.workers });
      // The button goes with the click: focus moves to the first row it added.
      const first = res.workers.find((w) => !shown.has(w.id));
      if (first) queueMicrotask(() => list?.querySelector<HTMLElement>(`.subagent-row[data-worker="${CSS.escape(first.id)}"]`)?.focus());
    } catch (e) {
      if (path === props.path) setMoreError(e instanceof Error ? e.message : String(e));
    } finally {
      setMoreLoading(false);
    }
  };
  /** Linked members on other hosts (§mesh.links/agents-pane): the chat socket's `links` frames
      while this session is an open chat here, else the polled insight. Only the Overseer's pane
      holds local members (`self`): it lists every link this host knows, each with all of them. */
  const links = createMemo<LinkedAgentInfo[]>(() => chatLinks(props.path) ?? insight.data()?.links ?? []);
  /** A local member's row appears only in the Overseer's pane; its summary says so even when it
      made every listed link between other hosts. */
  const overseerLinks = createMemo(() => !!props.overseer || links().some((r) => r.self));
  const linkSections = createMemo(() => linkGroups(links()));
  const linkByKey = createMemo(() => new Map(links().map((r) => [r.key, r])));
  /** The host the page reaches this session on; a member's URLs are mapped from its nodeId. */
  const sessionHost = () => hostOf(props.path);
  const reachOf = (r: LinkedAgentInfo) => linkReach(r, meshState(), sessionHost());
  const hostLabelOf = (r: LinkedAgentInfo) => linkHostLabel(r, meshState());
  /** The rows with the page's own names for their hosts, for naming the thread's senders. */
  const namedLinks = createMemo(() => links().map((r) => ({ ...r, hostLabel: hostLabelOf(r) })));
  /** A local member's row opens that session (the Overseer's pane). */
  const hrefOf = (r: LinkedAgentInfo) => (r.self ? sessionHrefOn(sessionHost(), r.path) : undefined);
  const working = () => workers().filter((w) => w.working).length;
  const label = (w: WorkerInfo) => workerLabel(w, insight.data()?.teams);
  const teamOf = (w: WorkerInfo) => workerTeam(w, insight.data()?.teams);
  /** A team member's badges (duty, then a successor's tie); none for a plain subagent. */
  const badgesOf = (w: WorkerInfo) => {
    const t = teamOf(w);
    const m = t?.members.find((x) => x.workerId === w.id);
    return t && m ? memberBadges(m, t) : [];
  };
  /** The row carries the duty only: the row is narrow, and the head of the open worker says the rest. */
  const dutyOf = (w: WorkerInfo) => {
    const d = badgesOf(w).find((b) => b.label === "Coordinator" || b.label === "Monitor");
    // A member named for its duty ("coordinator", "monitor") already says it.
    return d && d.label.toLowerCase() !== label(w).toLowerCase() ? d : undefined;
  };
  /** The list in sections: one per team that owns a listed worker, then the plain subagents.
      Section order follows the sorted list, so a working team still leads. */
  const groups = createMemo<Group[]>(() => {
    const out: Group[] = [];
    for (const w of workers()) {
      const team = teamOf(w);
      const key = team?.id ?? "";
      const at = out.find((g) => g.key === key);
      if (at) at.workers.push(w);
      else out.push({ key, team, workers: [w] });
    }
    return out;
  });
  /** Section heads once a team owns a listed worker, or once the linked-agents section shows:
      beside a headed section, the plain subagents need their head too. */
  const grouped = () => groups().some((g) => g.team) || links().length > 0;
  /** A session with a team holds more than subagents, listed or not: the pane says so. */
  const noun = () => workersNoun((insight.data()?.teams.length ?? 0) > 0);
  /** What the open transcript itself reports, which ticks between worker snapshots. Another
      worker's numbers must never linger, so the selection clears it. */
  const [watched, setWatched] = createSignal<UsageView | null>(null);
  /** The open transcript's context fill, which ticks with every append; cleared with the selection
      like `watched`. undefined: the transcript hasn't said (or an older server), so the row's stands. */
  const [watchedContext, setWatchedContext] = createSignal<ContextInfo | "compacted" | null | undefined>(undefined);
  /** A worker's fill: the open transcript's own for the selected worker, else its row's. */
  const contextOf = (w: WorkerInfo): ContextInfo | "compacted" | null => {
    const live = w.id === props.selected ? watchedContext() : undefined;
    return live === undefined ? workerContext(w) : live;
  };
  const loading = () => !props.chatWorkers && insight.pending();
  /** While the list's source is down nothing pulses. */
  const liveSource = () => !!props.chatWorkers || !insight.error();
  const liveLinks = () => !!chatLinks(props.path) || !insight.error();

  /** The selected linked member (its `link:` key never collides with a worker id). Sticky like a
      worker: one whose link ended keeps its last known row. */
  const selectedLink = createMemo<LinkedAgentInfo | null>((prev) => {
    const id = props.selected;
    if (!id?.startsWith("link:")) return null;
    return linkByKey().get(id) ?? (prev?.key === id ? prev : null);
  }, null);
  /** The selected worker. Sticky: one that left the list keeps its last known record. */
  const selected = createMemo<WorkerInfo | null>((prev) => {
    const id = props.selected;
    if (!id) return null;
    return workers().find((w) => w.id === id) ?? (prev?.id === id ? prev : null);
  }, null);

  createEffect(
    on(
      () => props.selected,
      () => {
        setWatched(null);
        setWatchedContext(undefined);
      },
      { defer: true },
    ),
  );

  // Nothing selected yet: the first row (working ones sort first), else the first linked member
  // this pane can open (a local one is a link to its session, not a view here).
  createEffect(() => {
    if (props.selected) return;
    const first = workers()[0]?.id ?? links().find((r) => !r.self)?.key;
    if (first) props.onSelect(first);
  });

  // Settled once, on the first workers: a view that followed the count would swap halves under
  // the reader when a second worker started.
  createEffect(() => {
    if (props.view) return;
    const n = workers().length + links().length;
    if (n > 0) props.onView(n === 1 ? "detail" : "list");
  });
  /** With nothing selected the list has nothing to open, and the view half holds the empty and
      error states, so that is the half to show. */
  const view = (): AgentsView => (selected() || selectedLink() ? props.view ?? "list" : "detail");

  let body!: HTMLDivElement;
  /** Focus follows a narrow pane's swap, to the half now shown; a wide pane moves nothing. */
  const focusShown = (selector: string) =>
    queueMicrotask(() => {
      const el = body.querySelector(selector);
      if (shown(el)) el.focus();
    });
  const open = (id: string) => {
    props.onSelect(id);
    props.onView("detail");
    focusShown(".subagents-back");
  };
  const back = () => {
    props.onView("list");
    focusShown('.subagent-row[aria-current="true"]');
  };

  /** The list renders by id and section key, never by object: every worker update builds new
      groups (and the insight new workers), and a <For> over those remounted every row on each
      poll, dropping focus and any tap in flight. Strings keep their rows. */
  const byId = createMemo(() => new Map(workers().map((w) => [w.id, w])));
  const groupOf = (key: string) => groups().find((g) => g.key === key);
  const idsOf = (key: string) => groupOf(key)?.workers.map((w) => w.id) ?? [];

  /** One worker row: name and status, then the meta. No excerpt of its reply — the transcript
      is one tap away and says it whole. Inside a team section the name is its role, and the
      section says whose. The chevron shows only where the row opens a view of its own. */
  const row = (id: string) => (
    <Show when={byId().get(id)}>
      {(w) => (
        <button type="button" class="subagent-row" data-worker={id} aria-current={props.selected === id ? "true" : undefined} onClick={() => open(id)}>
          <span class="subagent-row-name" title={label(w())}>
            <span class="subagent-row-label">{label(w())}</span>
            <Show when={dutyOf(w())}>
              {(d) => (
                <span class="chip chip-count" title={d().title}>
                  {d().label}
                </span>
              )}
            </Show>
          </span>
          <span class="subagent-row-status">
            {/* The sidebar's ring: how full the worker's own context is. Beside the chip, where a
                short name leaves room, so the meta line under it keeps every fact. */}
            <Show when={ringContext(contextOf(w()))}>{(c) => <ContextRing info={c()} />}</Show>
            <Show when={workerEjected(w(), insight.data()?.teams)}>
              <Chip>Ejected</Chip>
            </Show>
            <StatusChip worker={w()} liveSource={liveSource()} />
          </span>
          <WorkerMeta worker={w()} liveSource={liveSource()} class="subagent-row-meta" />
          <Icon name="chevron-right" small class="subagent-row-go" />
        </button>
      )}
    </Show>
  );

  let list: HTMLUListElement | undefined;
  /** Up/Down move between rows; Tab and Enter work as for any button. */
  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...(list?.querySelectorAll<HTMLElement>(".subagent-row") ?? [])];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  return (
    <div class="subagents-body" data-view={view()} ref={body}>
      <ul class="subagents-list" aria-label={noun()} ref={list} onKeyDown={onListKey}>
        <For each={groups().map((g) => g.key)}>
          {(key, gi) => (
            <Show when={grouped()} fallback={<For each={idsOf(key)}>{(id) => <li>{row(id)}</li>}</For>}>
              <li class="subagents-group">
                <h3 class="list-group-label subagents-group-label" id={`subagents-group-${gi()}`}>
                  <Icon name="worker" small />
                  <span>{groupOf(key)?.team ? "Team" : "Subagents"}</span>
                  <Show when={groupOf(key)?.team}>
                    {(t) => (
                      <>
                        <span aria-hidden="true">·</span>
                        <span class="subagents-group-name">{t().name}</span>
                      </>
                    )}
                  </Show>
                  <span class="text-num">{idsOf(key).length}</span>
                </h3>
                <Show when={groupOf(key)?.team?.objective}>
                  {(o) => (
                    <p class="team-objective subagents-group-objective" title={capTitle(o())}>
                      {o()}
                    </p>
                  )}
                </Show>
                {/* The team's newest event only: the full list is on the team's Agents card. */}
                <Show when={groupOf(key)?.team && newestEventLine(groupOf(key)!.team!)}>
                  {(e) => (
                    <p class="text-caption subagents-group-event" title={e().detail ?? e().text}>
                      <span class="text-mono">{e().at}</span> · {e().text}
                    </p>
                  )}
                </Show>
                <ul class="subagents-group-list" aria-labelledby={`subagents-group-${gi()}`}>
                  <For each={idsOf(key)}>{(id) => <li>{row(id)}</li>}</For>
                </ul>
              </li>
            </Show>
          )}
        </For>
        {/* The live record lists at most 40 workers: the rest are one click away, read then. */}
        <Show when={counted()}>
          {(n) => (
            <li class="subagents-more">
              <p class="text-caption">
                {workers().length} of {n()} shown
              </p>
              <button type="button" class="button subagents-more-button" disabled={moreLoading()} title={moreError() ?? undefined} onClick={showMore}>
                {moreLoading() ? "Loading…" : `Show ${n() - workers().length} More`}
              </button>
            </li>
          )}
        </Show>
        {/* After the teams and subagents: members of this session's links on other hosts. The
            Overseer's pane has one section per link on this host, local members included. */}
        <For each={linkSections().map((g) => g.linkId)}>
          {(linkId) => (
            <li class="subagents-group">
              <h3 class="list-group-label subagents-group-label" id={`subagents-link-${linkId}`}>
                <Icon name="network" small />
                <span>Remotely linked agents</span>
                <span class="text-num">{linkSections().find((g) => g.linkId === linkId)?.keys.length ?? 0}</span>
              </h3>
              {/* Several links (the Overseer's pane): each section says which, under its head. */}
              <Show when={linkGroupId(linkId, linkSections().length)}>
                {(id) => (
                  <p class="text-caption subagents-group-event" title={linkId}>
                    Link <span class="text-mono">{id()}</span>
                  </p>
                )}
              </Show>
              <ul class="subagents-group-list" aria-labelledby={`subagents-link-${linkId}`}>
                <For each={linkSections().find((g) => g.linkId === linkId)?.keys ?? []}>
                  {(key) => (
                    <Show when={linkByKey().get(key)}>
                      {(r) => (
                        <li>
                          <LinkedAgentRow
                            row={r()}
                            hostLabel={hostLabelOf(r())}
                            liveSource={liveLinks()}
                            current={props.selected === key}
                            href={hrefOf(r())}
                            onOpen={() => open(key)}
                          />
                        </li>
                      )}
                    </Show>
                  )}
                </For>
              </ul>
            </li>
          )}
        </For>
      </ul>
      <div class="subagents-view">
        <Show when={selectedLink()} fallback={
        <Show
          when={selected()}
          fallback={
            <Show when={!loading()}>
              <Show when={insight.error() && !props.chatWorkers && !insight.data()}>
                <Banner tone="warn" title="Couldn't load this session's subagents." body={`${insight.error()} Your workers keep running. We'll retry on our own.`} />
              </Show>
              <Show
                when={workers().length > 0}
                fallback={
                  <Show
                    when={links().length > 0}
                    fallback={
                      <div class="empty subagents-empty">
                        <p class="empty-title">0 {noun().toLowerCase()} in this session.</p>
                        <p class="empty-body">Workers it starts show up here while they run.</p>
                      </div>
                    }
                  >
                    <div class="empty subagents-empty">
                      <p class="empty-title">
                        {links().length} linked {links().length === 1 ? "agent" : "agents"}, {links().filter((r) => r.state === "working").length} working.
                      </p>
                      <p class="empty-body">Pick one to read your messages with it and its transcript.</p>
                    </div>
                  </Show>
                }
              >
                <div class="empty subagents-empty">
                  <p class="empty-title">
                    {workers().length}{" "}
                    {grouped() ? (workers().length === 1 ? "worker" : "workers") : workers().length === 1 ? "subagent" : "subagents"}, {working()}{" "}
                    working.
                  </p>
                  <p class="empty-body">Pick one to read its transcript.</p>
                </div>
              </Show>
            </Show>
          }
        >
          {(w) => (
            <>
              <header class="subagents-view-head">
                <button
                  type="button"
                  class="button button-icon button-ghost subagents-back"
                  aria-label={`All ${noun().toLowerCase()}`}
                  title={`All ${noun().toLowerCase()}`}
                  onClick={back}
                >
                  <Icon name="chevron-left" />
                </button>
                <div class="subagents-view-id">
                  {/* The id sits beside the name, quieter: it names the worker too, and it
                      leaves the meta line to the facts about its run. */}
                  <div class="subagents-view-name">
                    <h3 class="subagents-view-title" title={label(w())}>
                      {label(w())}
                    </h3>
                    <span class="subagents-view-wid text-mono text-muted">{w().id}</span>
                  </div>
                  {/* The minor modes it was given at its start (spec): a quiet chip right before the
                      status chip, so the meta line keeps to one row. */}
                  <Show when={w().modes?.length ? w().modes : undefined}>
                    {(m) => (
                      <span class="chip chip-count" title="The modes this worker was given when it started.">
                        {m().join(", ")}
                      </span>
                    )}
                  </Show>
                  <StatusChip worker={w()} liveSource={liveSource()} />
                  <Show when={teamOf(w())}>
                    {(t) => (
                      <span class="chip chip-count" title={t().objective || undefined}>
                        Team · {t().name}
                      </span>
                    )}
                  </Show>
                  <For each={badgesOf(w())}>
                    {(b) => (
                      <span class="chip chip-count" title={b.title}>
                        {b.label}
                      </span>
                    )}
                  </For>
                  <p class="subagents-view-meta meta-line">
                    {/* The model leads, bare: the route that serves it (`claude code` for that
                        backend, a pi ref's prefix or a catalog lookup otherwise) and the full id
                        are in its title. It is the only part that clips. */}
                    <Show when={compactModel(w().model)}>
                      {(m) => (
                        <span
                          class="text-mono meta-line-shrink"
                          title={[w().provider, w().model].filter(Boolean).join(" · ") || undefined}
                        >
                          {m()}
                        </span>
                      )}
                    </Show>
                    {/* The effort sits before the count: what the worker is thinking at is a
                        fact about the worker, where the count beside it is a running total
                        that changes under the reader. */}
                    <Show when={w().effort}>
                      {(e) => (
                        <span class="text-mono" title={`effort ${e()}`}>
                          <MetaSep />
                          {e()}
                        </span>
                      )}
                    </Show>
                    <Show
                      when={watched() ?? workerUsage(w())}
                      fallback={
                        <Show when={usageUnavailable(w())}>
                          <span>
                            <MetaSep />
                            usage unavailable
                          </span>
                        </Show>
                      }
                    >
                      {(u) => (
                        <span class="text-mono" title={usageTitle(u())}>
                          <MetaSep />
                          {formatTokens(usageHeadline(u()))} tok
                        </span>
                      )}
                    </Show>
                    {/* How full its own context is, as the chat head says it — pushed to the
                        line's right edge, under the status chip, so it takes no dot. */}
                    <Show when={contextOf(w())}>
                      {(c) => (
                        <span class="subagents-view-context">
                          <ContextReadout state={c()} />
                        </span>
                      )}
                    </Show>
                  </p>
                </div>
              </header>
              <Show when={w().status === "restored"}>
                <RestoredBar worker={w()} />
              </Show>
              <Show
                when={sourceKey(w())}
                keyed
                fallback={
                  <div class="empty subagents-empty">
                    <p class="empty-title">Its transcript isn't available in Sova.</p>
                    <p class="empty-body">
                      <code>{label(w())}</code>{" "}
                      {w().status === "restored"
                        ? "left no transcript we can find."
                        : w().backend === "claude-code"
                          ? "is starting — no Claude session yet."
                          : "runs on a pi that doesn't publish its session file yet."}
                      <Show when={w().preview}>
                        {(p) => (
                          <>
                            {" Latest: "}
                            <span class="text-mono">{p()}</span>
                          </>
                        )}
                      </Show>
                    </p>
                  </div>
                }
              >
                {(key) => (
                  <WorkerTranscript
                    source={sourceOf(key)}
                    host={hostOf(props.path)}
                    name={label(w())}
                    author={shortModel(w().model) ?? label(w())}
                    streaming={w().working}
                    onUsage={setWatched}
                    onContext={(c) => setWatchedContext(transcriptContext(c, w()) ?? null)}
                  />
                )}
              </Show>
            </>
          )}
        </Show>
        }>
          {(r) => (
            <>
              <header class="subagents-view-head">
                <button
                  type="button"
                  class="button button-icon button-ghost subagents-back"
                  aria-label={`All ${noun().toLowerCase()}`}
                  title={`All ${noun().toLowerCase()}`}
                  onClick={back}
                >
                  <Icon name="chevron-left" />
                </button>
                <div class="subagents-view-id">
                  <h3 class="subagents-view-title" title={r().title}>
                    {r().title}
                  </h3>
                  <LinkStateChip row={r()} liveSource={liveLinks()} />
                  <Show when={r().unread > 0}>
                    <span class="chip chip-count">{r().unread} unread</span>
                  </Show>
                  <LinkedAgentMeta row={r()} hostLabel={hostLabelOf(r())} liveSource={liveLinks()} />
                </div>
              </header>
              <LinkThreadView
                row={r()}
                rows={namedLinks()}
                path={props.path}
                reach={threadHost(links().filter((x) => x.linkId === r().linkId), overseerLinks(), meshState(), sessionHost())}
                overseer={overseerLinks()}
              />
              <LinkedTranscript row={r()} reach={reachOf(r())} hostLabel={hostLabelOf(r())} />
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

/** A linked member's own transcript, read-only, from its own host as the page reaches it. A host
    the page's host doesn't know, or one that is down, says so instead; the thread above stays. */
function LinkedTranscript(props: { row: LinkedAgentInfo; reach: LinkReach; hostLabel: string }) {
  const target = createMemo(() => (props.reach.ok ? `${props.reach.host ?? ""}\n${props.row.path}` : null));
  const offline = createMemo(() => props.row.state === "offline");
  return (
    <Show
      when={!offline() && target()}
      keyed
      fallback={
        <div class="empty subagents-empty">
          <Show
            when={offline()}
            fallback={
              <>
                <p class="empty-title">{props.hostLabel} isn't reachable from here.</p>
                <p class="empty-body">This page's host doesn't know that host, so its transcript can't be read here. The messages above are this session's host's copy.</p>
              </>
            }
          >
            <p class="empty-title">Host offline.</p>
            <p class="empty-body">{props.hostLabel} is down, so its transcript can't be read now. The messages above are the last we know.</p>
          </Show>
        </div>
      }
    >
      {(key) => (
        <WorkerTranscript
          source={{ kind: "pi", path: key.slice(key.indexOf("\n") + 1) }}
          host={key.slice(0, key.indexOf("\n")) || null}
          name={props.row.title}
          author={shortModel(props.row.model) ?? props.row.title}
          streaming={props.row.state === "working"}
          what="session"
          onUsage={() => {}}
          onContext={() => {}}
        />
      )}
    </Show>
  );
}

/** What a restart did to this worker: not running, and whether a turn was cut off. */
function RestoredBar(props: { worker: WorkerInfo }) {
  const interrupted = () => props.worker.interruptedAt;
  return (
    <div class="subagents-restored">
      <p class="usage-note">
        Not running since a server restart
        <Show when={interrupted()} fallback=".">
          {(at) => (
            <>
              ; it was mid-task at{" "}
              <span class="text-mono" title={new Date(at()).toISOString()}>
                {asOfClock(at())}
              </span>
              , and that turn never finished.
            </>
          )}
        </Show>
      </p>
    </div>
  );
}

/** A worker's status chip, worded as on the Agents page; only a live-sourced working one pulses.
    A running worker whose model request waits on its provider's limit reads Queued, plain and
    still, the waiting sentence in its title (§app.provider-limits/waiting-shown). */
function StatusChip(props: { worker: WorkerInfo; liveSource: boolean }) {
  const status = () => memberStatus({ worker: props.worker } as TeamMember, props.liveSource);
  watchProviderWaits(() => props.worker.status === "running");
  const wait = () => (props.worker.status === "running" ? providerWait(props.worker.sessionId) : undefined);
  return (
    <Show
      when={wait()}
      fallback={
        <Chip tone={status().tone} live={status().live}>
          {status().text}
        </Chip>
      }
    >
      {(w) => <Chip title={waitingSentence(w())}>Queued</Chip>}
    </Show>
  );
}

/** `{provider}` · `{model}` · `{tokens}` · as of `{HH:MM}` (settled) · last task failed (idle
    after a failure). A `.meta-line`: too little room clips the model id, never the provider or the
    count beside it. */
function WorkerMeta(props: { worker: WorkerInfo; liveSource: boolean; class: string }) {
  const provider = () => props.worker.provider;
  const model = () => compactModel(props.worker.model);
  const usage = () => workerUsage(props.worker);
  const unavailable = () => !usage() && usageUnavailable(props.worker);
  const failed = () => memberStatus({ worker: props.worker } as TeamMember, props.liveSource).failed;
  /** Without a live source every row reads "as of" its last update. */
  const at = () => asOf(props.worker) ?? (props.liveSource ? undefined : props.worker.lastActivity);
  const iso = (t: number) => new Date(t).toISOString();
  const lead = () => provider() || model() || usage();
  return (
    <Show when={lead() || unavailable() || at() !== undefined || failed()}>
      <span class={`${props.class} meta-line`}>
        <Show when={provider()}>
          {(p) => <span>{p()}</span>}
        </Show>
        <Show when={model()}>
          {(m) => (
            <>
              <Show when={provider()}>
                <MetaSep />
              </Show>
              <span class="text-mono meta-line-shrink" title={props.worker.model ?? undefined}>
                {m()}
              </span>
            </>
          )}
        </Show>
        <Show when={usage()}>
          {(u) => (
            <>
              <Show when={provider() || model()}>
                <MetaSep />
              </Show>
              <span class="text-mono" title={usageTitle(u())}>
                {formatTokens(usageHeadline(u()))}
              </span>
            </>
          )}
        </Show>
        <Show when={unavailable()}>
          <Show when={provider() || model()}>
            <MetaSep />
          </Show>
          <span title="Its transcript couldn't be read, and it reported nothing before the restart.">usage unavailable</span>
        </Show>
        <Show when={at()}>
          {(t) => (
            <>
              <Show when={lead() || unavailable()}>
                <MetaSep />
              </Show>
              <span>{lead() || unavailable() ? "as of" : "As of"}</span>
              <span class="text-mono" title={iso(t())}>
                {clockTime(iso(t()))}
              </span>
            </>
          )}
        </Show>
        <Show when={failed()}>
          <Show when={lead() || at() !== undefined}>
            <MetaSep />
          </Show>
          <span>{lead() || at() !== undefined ? "last task failed" : "Last task failed"}</span>
        </Show>
      </span>
    </Show>
  );
}

/** A worker's transcript lives on its parent session's host, so it is read from there. */
const watchUrl = (s: TranscriptSource, host: string | null): string =>
  s.kind === "pi" ? wsUrl("/ws/watch", s.path, false, host) : claudeWatchUrl(s.sessionId, host);

/**
 * One worker's session, tailed read-only (like WatchView, without a composer or head). The
 * socket closes when the selection changes or the pane closes.
 */
function WorkerTranscript(props: {
  source: TranscriptSource; host: string | null; name: string; author: string; streaming: boolean;
  /** What the transcript is, for its not-found copy: a worker's (default) or a linked session's. */
  what?: "worker" | "session";
  /** The transcript's own running token total, for the view head; null when it reports none. */
  onUsage(usage: UsageView | null): void;
  /** Each snapshot/append that carries a context fill (the whole message; the caller reads it). */
  onContext(msg: WatchServerMessage): void;
}) {
  const [items, setItems] = createSignal<TranscriptItem[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [gone, setGone] = createSignal(false);
  const [lastUpdate, setLastUpdate] = createSignal<string | null>(null);

  const socket = createReconnectingSocket<WatchServerMessage>(watchUrl(props.source, props.host), {
    onMessage(msg) {
      switch (msg.type) {
        case "snapshot": // may repeat if the file is rewritten: always replace
          setError(null);
          setGone(false);
          setItems(msg.items);
          setLastUpdate(new Date().toISOString());
          // Cumulative on every message, so a server that reports none leaves the row's own count.
          props.onUsage(transcriptUsage(msg));
          if ("context" in msg) props.onContext(msg);
          break;
        case "append":
          setItems((prev) => [...(prev ?? []), ...msg.items]);
          setLastUpdate(new Date().toISOString());
          // Only ever upward: an append without a total (older server) leaves what we have.
          const appended = transcriptUsage(msg);
          if (appended) props.onUsage(appended);
          if ("context" in msg) props.onContext(msg);
          break;
        case "error":
          // A missing file stays missing: stop, rather than cycle through reconnects.
          if (FILE_GONE.has(msg.message)) {
            setGone(true);
            socket.close();
          } else setError(msg.message);
          break;
      }
    },
  });

  // Follows new content while near the bottom; scrolling up offers Jump to Latest.
  let el!: HTMLElement;
  let follow = true;
  const [away, setAway] = createSignal<number | null>(null); // count when the user scrolled away
  const count = () => items()?.length ?? 0;
  const newCount = () => {
    const a = away();
    return a === null ? 0 : Math.max(0, count() - a);
  };
  const toBottom = () => {
    el.scrollTop = el.scrollHeight;
  };
  const resume = () => {
    follow = true;
    setAway(null);
    toBottom();
  };
  const onScroll = () => {
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
    if (near === follow) return;
    follow = near;
    setAway(near ? null : count());
  };
  const observer = new MutationObserver(() => {
    if (follow) toBottom();
  });
  // A narrow pane hides the view while its list shows; content that arrived meanwhile had no box
  // to scroll, so the end is found again when the view comes back (or the pane is resized).
  const sized = new ResizeObserver(() => {
    if (follow) toBottom();
  });
  onCleanup(() => {
    observer.disconnect();
    sized.disconnect();
  });

  return (
    <Show
      when={!gone() || items()}
      fallback={
        <div class="empty subagents-empty">
          <p class="empty-title">Couldn't find this {props.what ?? "worker"}'s transcript.</p>
          <p class="empty-body">
            <code>{sourceName(props.source)}</code> is gone. Nothing else changed.
          </p>
        </div>
      }
    >
      <section
        class="subagents-transcript pane"
        aria-label={`${props.name} transcript`}
        aria-busy={items() ? undefined : "true"}
        tabindex="0"
        ref={(node) => {
          el = node;
          observer.observe(node, { childList: true, subtree: true, characterData: true });
          sized.observe(node);
          queueMicrotask(toBottom);
        }}
        onScroll={onScroll}
      >
        <div class="subagents-banner stack-2">
          <Show when={gone()}>
            <Banner
              tone="warn"
              title="This transcript's file is gone."
              body={
                <>
                  What's shown is up to <code>{clockTime(lastUpdate() ?? "")}</code>.
                </>
              }
            />
          </Show>
          <ConnectionBanner socket={socket} watch lastUpdate={lastUpdate()} />
          <Show when={error()}>
            <Banner
              tone="error"
              title="Couldn't load this transcript."
              body={
                <>
                  The file at <code>{sourceName(props.source)}</code> wasn't changed. {error()}
                </>
              }
              action={
                <button type="button" class="button button-sm" onClick={() => socket.reconnect()}>
                  Retry
                </button>
              }
            />
          </Show>
        </div>
        <div class="thread">
          <Show when={items()} fallback={<Show when={!error()}><TranscriptSkeleton /></Show>}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <div class="empty subagents-empty">
                    <p class="empty-title">0 entries in {props.name}'s session so far.</p>
                    <p class="empty-body">Entries show up here as it writes them.</p>
                  </div>
                }
              >
                <HistoryItems items={list()} author={props.author} streaming={props.streaming} />
              </Show>
            )}
          </Show>
        </div>
      </section>
      <button type="button" class="button jump-latest subagents-jump" data-shown={away() !== null ? "" : undefined} onClick={resume}>
        <Icon name="chevron-down" small />
        {newCount() > 0 ? `Jump to Latest · ${newCount()} new` : "Jump to Latest"}
      </button>
    </Show>
  );
}
