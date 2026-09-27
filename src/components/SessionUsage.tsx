import { For, Show } from "solid-js";
import type { ModelSpend, TokenUsage, WorkerInfo } from "../../shared/protocol";
import { formatTokens } from "../lib/context";
import { compactModel } from "../lib/format";
import { anyCost, originLabel, spendRows, spentAnything } from "../lib/spend";
import { asOfClock, formatCost, idList, lifetimeIncludes, usageHeadline, usageTitle, usageTotal } from "../lib/workers";
import type { PaneInsight } from "./SessionPane";
import { Banner } from "./ui";

/** The distinct "as of" times of the snapshot-cost rows, oldest first, as `21:08` or `21:08 and
    22:25`; null when no row carries one. */
function snapshotTimes(rows: readonly ModelSpend[]): string | null {
  const times = [...new Set(rows.flatMap((r) => (r.asOf !== undefined && (r.cost ?? 0) > 0 ? [r.asOf] : [])))].sort((a, b) => a - b);
  return times.length ? idList([...new Set(times.map(asOfClock))]) : null;
}

/** A table cell that never wraps. */
const oneLine = { "white-space": "nowrap" } as const;

/**
 * The session pane's Usage tab: what this session has spent, off the pane's shared insight. The
 * headline, one row per model × origin with the main thread's Σ under them, the notes those rows
 * can't carry, then this session's workers. Read-only; the insight poll keeps it current.
 */
export function SessionUsageTab(props: { insight: PaneInsight; chatWorkers: WorkerInfo[] | null }) {
  const insight = () => props.insight.data;
  const usage = () => insight()?.usage;
  const rows = () => spendRows(usage());
  const cost = () => anyCost(rows());
  /** The chat socket's list while it runs, else the insight's — the head's working count reads the same. */
  const workers = () => props.chatWorkers ?? insight()?.workers ?? [];
  const working = () => workers().filter((w) => w.working).length;
  /** Every worker this session ever started; it rides on `usage` and, with nothing else spent, alone. */
  const lifetime = () => usage()?.workersTotal ?? insight()?.usageTotal;
  const spent = () => spentAnything(usage()) || usageTotal(insight()) !== null;

  return (
    <div class="session-panel-scroll" tabindex="0">
      <Show when={!insight() && props.insight.error}>
        {(message) => <Banner tone="error" title="Couldn't load this session's insight." body={`Nothing was changed. ${message()}`} />}
      </Show>
      <Show when={!insight() && props.insight.pending}>
        <div class="stack-2" aria-hidden="true">
          <span class="skeleton skeleton-title" />
          <span class="skeleton skeleton-line" />
          <span class="skeleton skeleton-line" />
        </div>
      </Show>
      <Show when={insight()}>
        <Show
          when={spent()}
          fallback={
            <div class="empty subagents-empty">
              <p class="empty-title">Nothing spent in this session yet.</p>
              <Show when={workers().length > 0}>
                <p class="empty-body">
                  <WorkerCount total={workers().length} working={working()} />
                </p>
              </Show>
            </div>
          }
        >
          <Show when={usage()}>
            {(u) => (
              <section class="stack-2" aria-labelledby="usage-spend-label">
                <h3 class="text-eyebrow" id="usage-spend-label">
                  Spend
                </h3>
                <p class="text-mono" style={{ margin: 0 }} title={usageTitle(u().total)}>
                  {formatTokens(usageHeadline(u().total))} tokens in and out
                  <Show when={formatCost(u().total.cost)}>{(c) => <> · {c()}</>}</Show>
                </p>
                <Show when={rows().length > 0}>
                  <div class="md md-table-wrap usage-table-wrap">
                    <table class="usage-table">
                      <caption class="visually-hidden">Tokens by model and where they were spent</caption>
                      <thead>
                        <tr>
                          <th scope="col">Model</th>
                          <th scope="col">Where</th>
                          <th scope="col" align="right">
                            In
                          </th>
                          <th scope="col" align="right">
                            Out
                          </th>
                          <th scope="col" align="right">
                            Cache read
                          </th>
                          <th scope="col" align="right">
                            Cache write
                          </th>
                          <Show when={cost()}>
                            <th scope="col" align="right">
                              Cost
                            </th>
                          </Show>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={rows()}>{(row) => <SpendRow row={row} cost={cost()} />}</For>
                      </tbody>
                      <tfoot>
                        <tr>
                          <th scope="row" colSpan={2}>
                            Main thread Σ
                          </th>
                          <Cells usage={u().main} cost={cost()} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </Show>
                <p class="usage-note">Main thread counts the active branch only.</p>
                <Show when={snapshotTimes(rows())}>
                  {(times) => (
                    <p class="usage-note">
                      * Cost as of <span class="text-mono">{times()}</span>, the last report before the restart.
                    </p>
                  )}
                </Show>
                {/* A worker the restart left with no readable transcript and no report: its spend is
                    unknown, so it is named here rather than counted as 0 anywhere. */}
                <Show when={u().unavailable?.length ? u().unavailable : null}>
                  {(ids) => (
                    <p class="usage-note">
                      Usage unavailable for <span class="text-mono">{idList(ids())}</span>: we couldn't read{" "}
                      {ids().length === 1 ? "its transcript" : "their transcripts"}, so the totals above leave{" "}
                      {ids().length === 1 ? "it" : "them"} out.
                    </p>
                  )}
                </Show>
              </section>
            )}
          </Show>

          {/* This session's own workers: how many, and what they spent over the session's life. */}
          <Show when={workers().length > 0 || lifetime()}>
            <section class="stack-2" aria-labelledby="usage-subagents-label">
              <h3 class="text-eyebrow" id="usage-subagents-label">
                Subagents
              </h3>
              <Show when={workers().length > 0}>
                <p class="usage-note">
                  <WorkerCount total={workers().length} working={working()} />
                </p>
              </Show>
              <Show when={lifetime()}>
                {(total) => (
                  <p class="usage-note text-muted" title={usageTitle(total(), total().workers)}>
                    Subagent lifetime: {formatTokens(usageHeadline(total()))} tokens
                    <Show when={formatCost(total().cost)}>
                      {(c) => (
                        <>
                          {" · "}
                          {c()}
                          <Show when={total().asOf}>
                            {(at) => (
                              <>
                                {" as of "}
                                <span class="text-mono" title={new Date(at()).toISOString()}>
                                  {asOfClock(at())}
                                </span>
                              </>
                            )}
                          </Show>
                        </>
                      )}
                    </Show>{" "}
                    across {total().workers} {total().workers === 1 ? "worker" : "workers"}
                    {lifetimeIncludes(total(), insight()?.workers ?? [])}.
                  </p>
                )}
              </Show>
            </section>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

/** "12 subagents · 2 working". */
function WorkerCount(props: { total: number; working: number }) {
  return (
    <>
      {props.total} {props.total === 1 ? "subagent" : "subagents"} · {props.working} working
    </>
  );
}

/** The four token columns and, when any row reports one, the cost. Each cell names its column, so
    a narrow pane can stack the row and still say which count is which. */
function Cells(props: { usage: TokenUsage & { asOf?: number }; cost: boolean }) {
  const cell = (label: string, n: number) => (
    <td align="right" class="text-mono text-num" data-label={label}>
      {formatTokens(n)}
    </td>
  );
  return (
    <>
      {cell("In", props.usage.input)}
      {cell("Out", props.usage.output)}
      {cell("Cache read", props.usage.cacheRead)}
      {cell("Cache write", props.usage.cacheWrite)}
      <Show when={props.cost}>
        {/* A snapshot cost carries a muted mark; its time is in the note under the table, so the
            row stays one line and the column keeps its width. */}
        <td align="right" class="text-mono text-num" style={oneLine} data-label="Cost">
          <Show
            when={formatCost(props.usage.cost)}
            fallback={
              <>
                <span class="text-muted" aria-hidden="true">
                  —
                </span>
                <span class="visually-hidden">Not reported</span>
              </>
            }
          >
            {(c) => (
              <>
                {c()}
                {/* Part of it is a restored worker's last report (Claude transcripts carry no cost). */}
                <Show when={props.usage.asOf}>
                  {(at) => (
                    <span class="text-muted" title={`As of ${asOfClock(at())}`}>
                      *
                    </span>
                  )}
                </Show>
              </>
            )}
          </Show>
        </td>
      </Show>
    </>
  );
}

/** A model × origin row. The id is shortened; the full one stays in the `title`. */
function SpendRow(props: { row: ModelSpend; cost: boolean }) {
  return (
    <tr>
      {/* One line per row ("glm-5.3" broke at its hyphen, "Main thread" at its space): the table
          scrolls sideways instead of rows growing taller, until the pane is narrow enough to stack. */}
      <td class="text-mono usage-table-model" style={oneLine} title={props.row.model}>
        {compactModel(props.row.model) ?? props.row.model}
      </td>
      <td class="usage-table-where" style={oneLine}>
        {originLabel(props.row.origin)}
      </td>
      <Cells usage={props.row} cost={props.cost} />
    </tr>
  );
}
