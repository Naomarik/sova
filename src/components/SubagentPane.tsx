import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { TeamInfo, TeamMember, TranscriptItem, WatchServerMessage, WorkerInfo } from "../../shared/protocol";
import { claudeWatchUrl, wsUrl } from "../lib/api";
import { clockTime, compactModel, shortModel } from "../lib/format";
import { memberStatus } from "../lib/insights";
import { createReconnectingSocket } from "../lib/socket";
import { formatTokens } from "../lib/context";
import { capTitle, sortWorkers, sourceKey, sourceName, sourceOf, transcriptUsage, usageHeadline, usageTitle,
  type TranscriptSource, type UsageView, workerLabel, workersNoun, workerTeam, workerUsage } from "../lib/workers";
import { ConnectionBanner } from "./ConnectionBanner";
import type { PaneInsight } from "./SessionPane";
import { HistoryItems, TranscriptSkeleton } from "./Thread";
import { Banner, Chip, Icon } from "./ui";

/** Within this distance of the end, the transcript follows new content. */
const FOLLOW_PX = 80;
/** The server's /ws/watch message for a path that doesn't exist (close 4404). */
const FILE_GONE = "Session file not found";

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

const SETTLED = new Set<WorkerInfo["status"]>(["waiting", "done", "error", "killed"]);
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
  chatWorkers: WorkerInfo[] | null;
  /** App's insight, polled while the pane is open: even while chatting, the teams give workers
      their role names. */
  insight: PaneInsight;
  selected: string | null;
  onSelect(id: string): void;
  view: AgentsView | null;
  onView(view: AgentsView): void;
}) {
  const insight = {
    data: () => props.insight.data ?? undefined,
    error: () => props.insight.error,
    pending: () => props.insight.pending,
  };
  const workers = createMemo(() => sortWorkers(props.chatWorkers ?? insight.data()?.workers ?? []));
  const working = () => workers().filter((w) => w.working).length;
  const label = (w: WorkerInfo) => workerLabel(w, insight.data()?.teams);
  const teamOf = (w: WorkerInfo) => workerTeam(w, insight.data()?.teams);
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
  /** Section heads only once a team actually owns a listed worker. */
  const grouped = () => groups().some((g) => g.team);
  /** A session with a team holds more than subagents, listed or not: the pane says so. */
  const noun = () => workersNoun((insight.data()?.teams.length ?? 0) > 0);
  /** What the open transcript itself reports, which ticks between worker snapshots. Another
      worker's numbers must never linger, so the selection clears it. */
  const [watched, setWatched] = createSignal<UsageView | null>(null);
  const loading = () => !props.chatWorkers && insight.pending();
  /** While the list's source is down nothing pulses. */
  const liveSource = () => !!props.chatWorkers || !insight.error();

  /** The selected worker. Sticky: one that left the list keeps its last known record. */
  const selected = createMemo<WorkerInfo | null>((prev) => {
    const id = props.selected;
    if (!id) return null;
    return workers().find((w) => w.id === id) ?? (prev?.id === id ? prev : null);
  }, null);

  createEffect(on(() => props.selected, () => setWatched(null), { defer: true }));

  // Nothing selected yet: the first row (working ones sort first).
  createEffect(() => {
    const first = workers()[0];
    if (!props.selected && first) props.onSelect(first.id);
  });

  // Settled once, on the first workers: a view that followed the count would swap halves under
  // the reader when a second worker started.
  createEffect(() => {
    if (props.view) return;
    const n = workers().length;
    if (n > 0) props.onView(n === 1 ? "detail" : "list");
  });
  /** With nothing selected the list has nothing to open, and the view half holds the empty and
      error states, so that is the half to show. */
  const view = (): AgentsView => (selected() ? props.view ?? "list" : "detail");

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
        <button type="button" class="subagent-row" aria-current={props.selected === id ? "true" : undefined} onClick={() => open(id)}>
          <span class="subagent-row-name" title={label(w())}>
            {label(w())}
          </span>
          <span class="subagent-row-status">
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
                <ul class="subagents-group-list" aria-labelledby={`subagents-group-${gi()}`}>
                  <For each={idsOf(key)}>{(id) => <li>{row(id)}</li>}</For>
                </ul>
              </li>
            </Show>
          )}
        </For>
      </ul>
      <div class="subagents-view">
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
                  <div class="empty subagents-empty">
                    <p class="empty-title">0 {noun().toLowerCase()} in this session.</p>
                    <p class="empty-body">Workers it starts show up here while they run.</p>
                  </div>
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
                  <h3 class="subagents-view-title" title={label(w())}>
                    {label(w())}
                  </h3>
                  <StatusChip worker={w()} liveSource={liveSource()} />
                  <Show when={teamOf(w())}>
                    {(t) => (
                      <span class="chip chip-count" title={t().objective || undefined}>
                        Team · {t().name}
                      </span>
                    )}
                  </Show>
                  <p class="subagents-view-meta meta-line">
                    <span class="text-mono">{w().id}</span>
                    {/* The provider leads: the route that
                        serves the model — never the part that clips. `claude code` for that
                        backend, a pi ref's prefix or a catalog lookup otherwise. */}
                    <Show when={w().provider}>
                      {(p) => (
                        <>
                          <MetaSep />
                          <span>{p()}</span>
                        </>
                      )}
                    </Show>
                    <Show when={compactModel(w().model)}>
                      {(m) => (
                        <>
                          <MetaSep />
                          <span class="text-mono meta-line-shrink" title={w().model ?? undefined}>
                            {m()}
                          </span>
                        </>
                      )}
                    </Show>
                    <Show when={watched() ?? workerUsage(w())}>
                      {(u) => (
                        <>
                          <MetaSep />
                          <span class="text-mono" title={usageTitle(u())}>
                            {formatTokens(usageHeadline(u()))} tokens
                          </span>
                        </>
                      )}
                    </Show>
                    <Show when={w().effort}>
                      {(e) => (
                        <>
                          <MetaSep />
                          <span>
                            effort <span class="text-mono">{e()}</span>
                          </span>
                        </>
                      )}
                    </Show>
                  </p>
                </div>
              </header>
              <Show
                when={sourceKey(w())}
                keyed
                fallback={
                  <div class="empty subagents-empty">
                    <p class="empty-title">Its transcript isn't available in Sova.</p>
                    <p class="empty-body">
                      <code>{label(w())}</code>{" "}
                      {w().backend === "claude-code"
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
                    name={label(w())}
                    author={shortModel(w().model) ?? label(w())}
                    streaming={w().working}
                    onUsage={setWatched}
                  />
                )}
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

/** A worker's status chip, worded as on the Agents page; only a live-sourced working one pulses. */
function StatusChip(props: { worker: WorkerInfo; liveSource: boolean }) {
  const status = () => memberStatus({ worker: props.worker } as TeamMember, props.liveSource);
  return (
    <Chip tone={status().tone} live={status().live}>
      {status().text}
    </Chip>
  );
}

/** `{provider}` · `{model}` · `{tokens}` · as of `{HH:MM}` (settled) · last task failed (idle
    after a failure). A `.meta-line`: too little room clips the model id, never the provider or the
    count beside it. */
function WorkerMeta(props: { worker: WorkerInfo; liveSource: boolean; class: string }) {
  const provider = () => props.worker.provider;
  const model = () => compactModel(props.worker.model);
  const usage = () => workerUsage(props.worker);
  const failed = () => memberStatus({ worker: props.worker } as TeamMember, props.liveSource).failed;
  /** Without a live source every row reads "as of" its last update. */
  const at = () => asOf(props.worker) ?? (props.liveSource ? undefined : props.worker.lastActivity);
  const iso = (t: number) => new Date(t).toISOString();
  const lead = () => provider() || model() || usage();
  return (
    <Show when={lead() || at() !== undefined || failed()}>
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
        <Show when={at()}>
          {(t) => (
            <>
              <Show when={lead()}>
                <MetaSep />
              </Show>
              <span>{lead() ? "as of" : "As of"}</span>
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

const watchUrl = (s: TranscriptSource): string => (s.kind === "pi" ? wsUrl("/ws/watch", s.path) : claudeWatchUrl(s.sessionId));

/**
 * One worker's session, tailed read-only (like WatchView, without a composer or head). The
 * socket closes when the selection changes or the pane closes.
 */
function WorkerTranscript(props: {
  source: TranscriptSource; name: string; author: string; streaming: boolean;
  /** The transcript's own running token total, for the view head; null when it reports none. */
  onUsage(usage: UsageView | null): void;
}) {
  const [items, setItems] = createSignal<TranscriptItem[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [gone, setGone] = createSignal(false);
  const [lastUpdate, setLastUpdate] = createSignal<string | null>(null);

  const socket = createReconnectingSocket<WatchServerMessage>(watchUrl(props.source), {
    onMessage(msg) {
      switch (msg.type) {
        case "snapshot": // may repeat if the file is rewritten: always replace
          setError(null);
          setGone(false);
          setItems(msg.items);
          setLastUpdate(new Date().toISOString());
          // Cumulative on every message, so a server that reports none leaves the row's own count.
          props.onUsage(transcriptUsage(msg));
          break;
        case "append":
          setItems((prev) => [...(prev ?? []), ...msg.items]);
          setLastUpdate(new Date().toISOString());
          // Only ever upward: an append without a total (older server) leaves what we have.
          const appended = transcriptUsage(msg);
          if (appended) props.onUsage(appended);
          break;
        case "error":
          // A missing file stays missing: stop, rather than cycle through reconnects.
          if (msg.message === FILE_GONE) {
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
          <p class="empty-title">Couldn't find this worker's transcript.</p>
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
      <Show when={away() !== null}>
        <button type="button" class="button jump-latest subagents-jump" onClick={resume}>
          <Icon name="chevron-down" small />
          {newCount() > 0 ? `Jump to Latest · ${newCount()} new` : "Jump to Latest"}
        </button>
      </Show>
    </Show>
  );
}
