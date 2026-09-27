import { createMemo, createSignal, createEffect, For, Show } from "solid-js";
import type { ExplanationInfo, SessionSummary } from "../../shared/protocol";
import { ApiError, getSessionSummaryById } from "../lib/api";
import {
  EXPLAIN_ORDERS,
  EXPLAIN_RANGES,
  explanationSessionOptions,
  explanationsGlance,
  explanationsMeta,
  filterExplanations,
  resolveExplainSession,
  sessionsToLookUp,
  type ExplainOrder,
  type ExplainRange,
  type SessionLookup,
} from "../lib/explanations";
import { relativeTime, stampTime } from "../lib/format";
import { explanationsHref } from "../lib/insights";
import type { Poll } from "../lib/poll";
import { ExplainGrid } from "./ExplainTiles";
import { InsightsPage, ListSkeleton } from "./InsightsPage";
import { CountChip, Icon } from "./ui";
import "../agents-board.css";
import "../explain.css";
import "../extensions.css";

/**
 * #/explanations (§app.insights/explanations-page): every /explain page as a card, filtered by
 * session (the route's), date and order. Each card's session comes from the list the sidebar
 * loads; one this list doesn't carry is asked of this host once, so a gone session can say so.
 */
export function ExplanationsView(props: {
  explanations: Poll<ExplanationInfo[]>;
  /** The session list; undefined until it has loaded. */
  sessions: SessionSummary[] | undefined;
  /** The route's session filter (`#/explanations/<id>`), or null for every session. */
  session: string | null;
  now: number;
  titleRef(el: HTMLHeadingElement): void;
  /** Re-reads the session list, beside the explanations. */
  onRefresh(): void;
}) {
  const [range, setRange] = createSignal<ExplainRange>("all");
  const [order, setOrder] = createSignal<ExplainOrder>("newest");
  const [lookups, setLookups] = createSignal<Record<string, SessionLookup>>({});
  const all = () => props.explanations.data() ?? [];

  // Ask for each unlisted parent session once. A 404 is the only "gone"; anything else leaves the
  // card linking by id, which the #/sid/ route resolves (or explains) on click.
  createEffect(() => {
    const ask = sessionsToLookUp(all(), props.sessions, lookups());
    if (!ask.length) return;
    setLookups((m) => ({ ...m, ...Object.fromEntries(ask.map((id) => [id, "pending" as const])) }));
    for (const id of ask) {
      void getSessionSummaryById(id).then(
        (s) => setLookups((m) => ({ ...m, [id]: s })),
        (err) => setLookups((m) => ({ ...m, [id]: err instanceof ApiError && err.status === 404 ? "gone" : "failed" })),
      );
    }
  });

  const sessionOf = (id: string) => resolveExplainSession(id, props.sessions, lookups());
  const nameOf = (id: string) => {
    const s = sessionOf(id);
    return s.kind === "gone" ? `Session no longer on disk (${id.slice(0, 8)})` : s.title;
  };
  const options = createMemo(() => explanationSessionOptions(all(), nameOf, props.session));
  const shown = createMemo(() => filterExplanations(all(), { session: props.session, range: range(), order: order() }, props.now));
  const loaded = () => props.explanations.data() !== undefined;

  return (
    <InsightsPage
      title="Explanations"
      meta={loaded() ? explanationsMeta(shown().length, order()) : undefined}
      refreshLabel="Refresh Explanations"
      onRefresh={() => {
        props.explanations.refetch();
        props.onRefresh();
      }}
      error={props.explanations.error()}
      errorTitle="Couldn't load explanations."
      busy={!loaded() && props.explanations.pending()}
      titleRef={props.titleRef}
    >
      <Show when={loaded()} fallback={<ListSkeleton groups={1} rows={3} />}>
        <Show
          when={all().length > 0}
          fallback={
            <div class="card">
              <div class="empty">
                <p class="empty-title">0 explanations yet.</p>
                <p class="empty-body">
                  Run <code>/explain</code> in a session and its page shows up here.
                </p>
              </div>
            </div>
          }
        >
          <div class="explain-bar">
            <label class="field explain-bar-session">
              <span class="field-label">Session</span>
              <span class="select-wrap">
                <select
                  class="select"
                  value={props.session ?? ""}
                  onChange={(e) => {
                    // The route is the filter: replace, so the select adds no history entry.
                    const href = explanationsHref(e.currentTarget.value || null);
                    if (location.hash !== href) location.replace(href);
                  }}
                >
                  <option value="">All sessions</option>
                  <For each={options()}>
                    {(o) => (
                      <option value={o.id} selected={o.id === props.session}>
                        {o.label}
                      </option>
                    )}
                  </For>
                </select>
                <span class="select-caret" aria-hidden="true">
                  <Icon name="chevron-down" small />
                </span>
              </span>
            </label>
            <div class="board-filters explain-bar-dates" role="group" aria-label="Date">
              <For each={EXPLAIN_RANGES}>
                {(r) => (
                  <button type="button" class="board-filter" aria-pressed={range() === r.id ? "true" : "false"} onClick={() => setRange(r.id)}>
                    <Show when={range() === r.id}>
                      <Icon name="check" small />
                    </Show>
                    {r.label}
                  </button>
                )}
              </For>
            </div>
            <label class="field explain-bar-sort">
              <span class="field-label">Sort</span>
              <span class="select-wrap">
                <select class="select" value={order()} onChange={(e) => setOrder(e.currentTarget.value as ExplainOrder)}>
                  <For each={EXPLAIN_ORDERS}>{(o) => <option value={o.id}>{o.label}</option>}</For>
                </select>
                <span class="select-caret" aria-hidden="true">
                  <Icon name="chevron-down" small />
                </span>
              </span>
            </label>
          </div>
          <Show
            when={shown().length > 0}
            fallback={
              <div class="card">
                <div class="empty">
                  <p class="empty-title">
                    {all().length} {all().length === 1 ? "explanation" : "explanations"} in all. None match these filters.
                  </p>
                  <p class="empty-body">Choose All sessions or All to see more.</p>
                </div>
              </div>
            }
          >
            <ExplainGrid explanations={shown()} now={props.now} session={(item) => sessionOf(item.parentSessionId)} class="explain-page-grid" />
          </Show>
        </Show>
      </Show>
    </InsightsPage>
  );
}

/**
 * The overview's Explanations section (§chat.transcript/landing-page): one card in the Mesh card's
 * shape, always shown, leading to #/explanations — the way in on a phone (list → Overview → here).
 */
export function ExplanationsCard(props: { explanations: ExplanationInfo[] | undefined; now: number }) {
  const glance = () => explanationsGlance(props.explanations ?? []);
  return (
    <section class="explain-section" aria-labelledby="explain-section-title">
      <h2 class="explain-section-head" id="explain-section-title">
        Explanations
      </h2>
      <ul class="ext-grid ext-grid-full">
        <li>
          <a class="card ext-card" href={explanationsHref()}>
            <div class="ext-card-head">
              <span class="icon ext-card-icon" style={{ "--icon": "url(/icons/file.svg)" }} aria-hidden="true" />
              <h3 class="ext-card-title">Explanations</h3>
              <Show when={props.explanations}>
                <CountChip>
                  <span class="text-num">{glance().count}</span>
                </CountChip>
              </Show>
            </div>
            <p class="ext-card-body">
              <Show when={props.explanations} fallback="Reading explanations…">
                <Show
                  when={glance().latest}
                  fallback={
                    <>
                      No explanations yet. Run <code>/explain</code> in a session to write one.
                    </>
                  }
                >
                  {(l) => (
                    <>
                      Latest · {l().topic} ·{" "}
                      <span title={stampTime(l().createdAt, props.now)}>{relativeTime(l().createdAt, props.now)}</span>
                    </>
                  )}
                </Show>
              </Show>
            </p>
          </a>
        </li>
      </ul>
    </section>
  );
}
