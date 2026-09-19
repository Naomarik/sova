import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { AgentsInsight, SessionSummary, UsageInsight } from "../../shared/protocol";
import { relativeTime, shortModel, tildePath } from "../lib/format";
import { activeTeams, agentsHref, type GlancePart, usageGlance, usageHref } from "../lib/insights";
import { isTopSession } from "../lib/regions";
import { home, localRunning } from "../lib/ui-state";
import { sessionWorking } from "../lib/workers";
import { Banner, Chip, CountChip, Icon } from "./ui";

interface Group {
  cwd: string;
  sessions: SessionSummary[];
}

function groupByCwd(sessions: SessionSummary[]): Group[] {
  const byCwd = new Map<string, SessionSummary[]>();
  const sorted = [...sessions].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  for (const s of sorted) {
    const list = byCwd.get(s.cwd);
    if (list) list.push(s);
    else byCwd.set(s.cwd, [s]);
  }
  // Map keeps insertion order, and the first session seen per cwd is its newest.
  return [...byCwd].map(([cwd, list]) => ({ cwd, sessions: list }));
}

const ARCHIVE_KEY = "pi-web:archive-open";

export const sessionHref = (path: string) => `#/s/${encodeURIComponent(path)}`;

/** Sessions grouped by folder, newest first: the markup of DESIGN_NOTES §2 "Anatomy". */
function GroupList(props: { groups: Group[]; selected: string | null; now: number; idPrefix: string }) {
  return (
    <For each={props.groups}>
      {(group, gi) => (
        <section class="session-group" aria-labelledby={`${props.idPrefix}-${gi()}`}>
          <h3 class="list-group-label" id={`${props.idPrefix}-${gi()}`} title={group.cwd}>
            <Icon name="folder" small />
            <span class="session-group-path">
              <bdi>{tildePath(group.cwd, home())}</bdi>
            </span>
            <span class="text-num">{group.sessions.length}</span>
          </h3>
          <ul class="list">
            <For each={group.sessions}>
              {(s) => (
                <li>
                  <a
                    class="list-row list-row-interactive session-row"
                    href={sessionHref(s.path)}
                    aria-current={props.selected === s.path ? "page" : undefined}
                  >
                    <div class="list-main">
                      <p class="list-title" classList={{ "list-title-muted": s.title === "Untitled" }} title={s.title}>
                        {s.title}
                      </p>
                      <p class="list-meta">
                        {relativeTime(s.lastActiveAt, props.now)}
                        <Show when={s.model}>
                          {" · "}
                          <span class="text-mono" title={s.model!}>
                            {shortModel(s.model)}
                          </span>
                        </Show>
                      </p>
                    </div>
                    <Show when={sessionWorking(s)}>
                      {(n) => <CountChip title="Subagents working now">{n()} working</CountChip>}
                    </Show>
                    <Show when={s.live}>
                      <Chip tone="accent" live title={`Open in a TUI · pid ${s.live!.pid} · ${s.live!.status}`}>
                        Live
                      </Chip>
                    </Show>
                    {/* Busy (§2): this tab's own run wins over the last fetched list; Live wins over both. */}
                    <Show when={!s.live && (localRunning()[s.path] ?? s.busy)}>
                      <span class="chip chip-info" title="pi is replying in this session">
                        <i class="chip-dot" />
                        Busy
                        <span class="visually-hidden">, pi is replying in this session</span>
                      </span>
                    </Show>
                  </a>
                </li>
              )}
            </For>
          </ul>
        </section>
      )}
    </For>
  );
}

/** Usage foot row: every provider at a glance ("C 47%  O 95%  OL 80%  Z 0%"), or the page name. */
function UsageGlance(props: { parts: GlancePart[] }) {
  return (
    <Show when={props.parts.length > 0} fallback="Usage">
      <For each={props.parts}>
        {(p) => (
          // Stale wins over high: an old 95% isn't a current warning.
          <span class="usage-glance-item" classList={{ "usage-glance-item-high": p.high && !p.stale, "usage-glance-item-stale": p.stale }}>
            <span class="usage-glance-tag">{p.abbr}</span>
            <span class="text-num">{p.pct}%</span>
          </span>
        )}
      </For>
    </Show>
  );
}

/** Agents foot row: active teams, then working subagents; segments with nothing to say are left out. */
function AgentsGlance(props: { agents: AgentsInsight | undefined }) {
  const parts = () => {
    const teams = activeTeams(props.agents).length;
    const working = props.agents?.totals.working ?? 0;
    const out: { n: number; word: string }[] = [];
    if (teams > 0) out.push({ n: teams, word: teams === 1 ? "team" : "teams" });
    if (working > 0) out.push({ n: working, word: "working" });
    return out;
  };
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

export function Sidebar(props: {
  sessions: SessionSummary[] | undefined;
  loading: boolean;
  error: string | null;
  selected: string | null;
  now: number;
  onRefresh(): void;
  onNew(): void;
  usage: UsageInsight | undefined;
  agents: AgentsInsight | undefined;
  /** The insights page that's open (`#/usage` or `#/agents`), for aria-current on its foot row. */
  insightsPage: "usage" | "agents" | null;
}) {
  const [query, setQuery] = createSignal("");
  const [showSkeleton, setShowSkeleton] = createSignal(false);
  const skeletonTimer = setTimeout(() => setShowSkeleton(true), 300);
  let search!: HTMLInputElement;

  // "/" anywhere outside a text field focuses search.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    search.focus();
  };
  document.addEventListener("keydown", onKey);
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    clearTimeout(skeletonTimer);
  });

  const all = () => props.sessions ?? [];
  const hits = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? all().filter((s) => `${s.title} ${s.cwd} ${s.model ?? ""}`.toLowerCase().includes(q)) : all();
  });
  // Pane rule: live, or web-spawned and not archived, stays on top (src/lib/regions.ts).
  const isTop = isTopSession;
  const topHits = createMemo(() => hits().filter(isTop));
  const archiveHits = createMemo(() => hits().filter((s) => !isTop(s)));
  // Each region groups by cwd on its own, so a folder can appear in both.
  const topGroups = createMemo(() => groupByCwd(topHits()));
  const archiveGroups = createMemo(() => groupByCwd(archiveHits()));
  const archiveTotal = () => all().filter((s) => !isTop(s)).length;

  // Collapsed by default; the user's own choice persists for the tab (DESIGN_NOTES §2 "Regions").
  const [storedOpen, setStoredOpen] = createSignal(sessionStorage.getItem(ARCHIVE_KEY) === "1");
  /** Forced open while searching, when the top is empty, or when the open session is archived. */
  const forcedOpen = () =>
    !!query().trim() || topHits().length === 0 || archiveHits().some((s) => s.path === props.selected);
  const archiveOpen = () => forcedOpen() || storedOpen();
  const onArchiveToggle = (e: Event & { currentTarget: HTMLDetailsElement }) => {
    const open = e.currentTarget.open;
    if (open === archiveOpen()) return; // our own `open` update, not the user's
    setStoredOpen(open);
    sessionStorage.setItem(ARCHIVE_KEY, open ? "1" : "0");
  };
  const liveCount = () => all().filter((s) => s.live).length;
  const glance = createMemo(() => usageGlance(props.usage));
  /** The foot's usage glance in full words, for its tooltip and accessible name. */
  const glanceText = () => (glance().length ? `Usage: ${glance().map((p) => p.full).join(", ")}` : "");

  const clear = () => {
    setQuery("");
    search.focus();
  };

  return (
    <aside class="app-sidebar" aria-label="Sessions">
      <div class="sidebar-head">
        <a class="brand" href="#/">
          <span class="icon" style={{ "--icon": "url(/icons/pi-web-mark.svg)" }} aria-hidden="true" />
          pi-web
        </a>
        <span class="sidebar-spacer" />
        <button
          type="button"
          class="button button-icon button-ghost"
          aria-label="Refresh Sessions"
          title="Refresh Sessions"
          aria-disabled={props.loading ? "true" : undefined}
          onClick={() => !props.loading && props.onRefresh()}
        >
          <Icon name="refresh" />
        </button>
        <button type="button" class="button" onClick={() => props.onNew()}>
          <Icon name="plus" />
          New Session
        </button>
      </div>

      <div class="sidebar-search" role="search">
        <label class="visually-hidden" for="session-search">
          Search sessions
        </label>
        <div class="search">
          <Icon name="search" />
          <input
            ref={search}
            class="input"
            id="session-search"
            type="search"
            placeholder="Title, folder, or model"
            aria-describedby="session-count"
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              if (query()) setQuery("");
              else search.blur();
            }}
          />
          <Show when={query()}>
            <button type="button" class="button button-icon" aria-label="Clear Search" onClick={clear}>
              <Icon name="close" small />
            </button>
          </Show>
        </div>
        <div class="spread">
          <p class="search-count" id="session-count" aria-live="polite">
            <Show when={props.sessions}>
              <Show when={query().trim()} fallback={`${all().length} sessions`}>
                {hits().length} of {all().length} sessions
              </Show>
            </Show>
          </p>
          {/* Always every live session, even while the search filters. */}
          <Show when={liveCount() > 0}>
            <Chip tone="accent" live count title="Sessions open in a TUI">
              {liveCount()} live
            </Chip>
          </Show>
        </div>
      </div>

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
              0 sessions in <code>~/.pi/agent/sessions</code>.
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
            <p class="empty-body">We search titles, folders, and models.</p>
            <button type="button" class="button empty-action" onClick={clear}>
              Clear Search
            </button>
          </div>
        </Show>

        {/* Hidden when a search empties it; kept with a note when there's simply nothing on top. */}
        <Show when={props.sessions && all().length > 0 && (topHits().length > 0 || !query().trim())}>
          <section class="sidebar-region" aria-labelledby="r-top">
            <h2 class="sidebar-region-head" id="r-top">
              Live &amp; web{" "}
              <span class="sidebar-region-count">
                · {query().trim() ? `${topHits().length} of ${all().length - archiveTotal()}` : topHits().length}
              </span>
            </h2>
            <Show
              when={topHits().length > 0}
              fallback={<p class="sidebar-region-note">0 sessions open in a TUI, or started here and not archived. The archive below has the rest.</p>}
            >
              <GroupList groups={topGroups()} selected={props.selected} now={props.now} idPrefix="t" />
            </Show>
          </section>
        </Show>

        <Show when={archiveHits().length > 0}>
          <details class="sidebar-region sidebar-archive" open={archiveOpen()} onToggle={onArchiveToggle}>
            <summary class="sidebar-region-head">
              <Icon name="chevron-right" small class="icon-twist" />
              <span>Archive</span>
              <span class="sidebar-region-count">
                · {query().trim() ? `${archiveHits().length} of ${archiveTotal()}` : archiveHits().length}
              </span>
            </summary>
            <GroupList groups={archiveGroups()} selected={props.selected} now={props.now} idPrefix="a" />
          </details>
        </Show>
      </nav>

      <div class="sidebar-foot">
        <a
          class="list-row list-row-interactive insights-row"
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
        <a class="list-row list-row-interactive insights-row" href={agentsHref()} aria-current={props.insightsPage === "agents" ? "page" : undefined}>
          <Icon name="worker" />
          <span class="insights-row-text">
            <AgentsGlance agents={props.agents} />
          </span>
        </a>
      </div>
    </aside>
  );
}
