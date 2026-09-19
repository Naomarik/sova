import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { relativeTime, shortModel, tildePath } from "../lib/format";
import { home } from "../lib/ui-state";
import { Banner, Chip, Icon } from "./ui";

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

export const sessionHref = (path: string) => `#/s/${encodeURIComponent(path)}`;

export function Sidebar(props: {
  sessions: SessionSummary[] | undefined;
  loading: boolean;
  error: string | null;
  selected: string | null;
  now: number;
  onRefresh(): void;
  onNew(): void;
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
  const groups = createMemo(() => groupByCwd(hits()));
  const liveCount = () => all().filter((s) => s.live).length;

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

        <For each={groups()}>
          {(group, gi) => (
            <section class="session-group" aria-labelledby={`g-${gi()}`}>
              <h2 class="list-group-label" id={`g-${gi()}`} title={group.cwd}>
                <Icon name="folder" small />
                <span class="session-group-path">
                  <bdi>{tildePath(group.cwd, home())}</bdi>
                </span>
                <span class="text-num">{group.sessions.length}</span>
              </h2>
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
                        <Show when={s.live}>
                          <Chip tone="accent" live title={`Open in a TUI · pid ${s.live!.pid} · ${s.live!.status}`}>
                            Live
                          </Chip>
                        </Show>
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
      </nav>
    </aside>
  );
}
