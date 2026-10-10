import { createEffect, For, on, Show } from "solid-js";
import type { WorkerInfo } from "../../shared/protocol";
import type { UsageSessionModelRow, UsageSessionSpend, UsageSpend } from "../../shared/usage/wire";
import { getUsageSession } from "../lib/api";
import { formatTokens } from "../lib/context";
import { compactModel, usageModelNote } from "../lib/format";
import { createPoll, type Poll } from "../lib/poll";
import { originLabel, spendTitle, spendUsd, spentAnything, spoken, usageTabRows } from "../lib/spend";
import { ResendLine } from "./ResendLine";
import { Banner } from "./ui";

/** A session's spend moves with every call; the pane's head chip and Usage tab read it this often. */
const SPEND_POLL_MS = 15_000;

/**
 * One session's spend from the usage ledger (`GET /api/usage/session`), polled while the pane that
 * created it is open, and fetched again at once when the session changes. A worker's sid gives
 * the worker's own and its workers'. Null sid (no id known yet): nothing is asked.
 */
export function createSessionSpend(sid: () => string | null): Poll<UsageSessionSpend> {
  const poll = createPoll(() => {
    const id = sid();
    return id ? getUsageSession(id) : Promise.reject(new Error("No session id yet."));
  }, SPEND_POLL_MS);
  createEffect(on(sid, () => poll.refetch(), { defer: true }));
  return poll;
}

/** A table cell that never wraps. */
const oneLine = { "white-space": "nowrap" } as const;

/**
 * The session pane's Usage tab: what this session has spent, from the usage ledger — every call on
 * every branch, the side calls made for it, and its workers at any depth, at API prices. The
 * headline, one row per model × origin with the main thread's Σ under them, then this session's
 * workers. Read-only; the pane's poll keeps it current.
 */
export function SessionUsageTab(props: { spend: Poll<UsageSessionSpend>; workers: WorkerInfo[] }) {
  const spend = () => props.spend.data();
  const rows = () => usageTabRows(spend());
  const working = () => props.workers.filter((w) => w.working).length;

  return (
    <div class="session-panel-scroll" tabindex="0">
      <Show when={props.spend.error()}>
        {(message) => (
          <Banner
            tone="error"
            title="Couldn't load this session's usage."
            body={message() === "usage-unavailable" ? "The usage counter isn't running yet. Calls keep being recorded, and the figures come back when it starts." : `Nothing was changed. ${message()}`}
          />
        )}
      </Show>
      <Show when={!spend() && props.spend.pending()}>
        <div class="stack-2" aria-hidden="true">
          <span class="skeleton skeleton-title" />
          <span class="skeleton skeleton-line" />
          <span class="skeleton skeleton-line" />
        </div>
      </Show>
      <Show when={spend()}>
        {(s) => (
          <Show
            when={spentAnything(s())}
            fallback={
              <div class="empty subagents-empty">
                <p class="empty-title">Nothing spent in this session yet.</p>
                <Show when={props.workers.length > 0}>
                  <p class="empty-body">
                    <WorkerCount total={props.workers.length} working={working()} />
                  </p>
                </Show>
              </div>
            }
          >
            <section class="stack-2" aria-labelledby="usage-spend-label">
              <h3 class="text-eyebrow" id="usage-spend-label">
                Spend
              </h3>
              <p class="text-mono" style={{ margin: 0 }} title={spendTitle(s().total)}>
                {formatTokens(spoken(s().total))} tokens in and out · {spendUsd(s().total.usd)}
              </p>
              <ResendLine resend={s().resend} spendUsd={s().own.usd} of="the main thread" />
              <Show when={rows().length > 0}>
                <div class="md md-table-wrap usage-table-wrap">
                  <table class="usage-table">
                    <caption class="visually-hidden">Tokens and cost by model and where they were spent</caption>
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
                        <th scope="col" align="right">
                          Cost
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={rows()}>{(row) => <SpendRow row={row} />}</For>
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row" colSpan={2}>
                          Main thread Σ
                        </th>
                        <Cells spend={s().own} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Show>
            </section>
          </Show>
        )}
      </Show>

      {/* This session's own workers, how many and how many work: their spend is in the rows above. */}
      <Show when={props.workers.length > 0 && spend() && spentAnything(spend())}>
        <section class="stack-2" aria-labelledby="usage-subagents-label">
          <h3 class="text-eyebrow" id="usage-subagents-label">
            Subagents
          </h3>
          <p class="usage-note">
            <WorkerCount total={props.workers.length} working={working()} />
          </p>
        </section>
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

/** The four token columns and the cost. Each cell names its column, so a narrow pane can stack the
    row and still say which count is which. */
function Cells(props: { spend: UsageSpend }) {
  const cell = (label: string, n: number) => (
    <td align="right" class="text-mono text-num" data-label={label}>
      {formatTokens(n)}
    </td>
  );
  return (
    <>
      {cell("In", props.spend.tokens.input)}
      {cell("Out", props.spend.tokens.output)}
      {cell("Cache read", props.spend.tokens.cacheRead)}
      {cell("Cache write", props.spend.tokens.cacheWrite)}
      <td align="right" class="text-mono text-num" style={oneLine} data-label="Cost">
        {spendUsd(props.spend.usd)}
      </td>
    </>
  );
}

/** A model × origin row. The id is shortened; the full one, and how it was priced, stay in the `title`. */
function SpendRow(props: { row: UsageSessionModelRow }) {
  const title = () => [priced(), usageModelNote(props.row)].filter(Boolean).join(". ");
  const priced = () => {
    const id = `${props.row.provider}/${props.row.model}`;
    if (props.row.status === "unpriced") return `${id}: unpriced${props.row.why ? `, ${props.row.why}` : ""}`;
    return props.row.priceKey && props.row.priceKey !== id ? `${id}, priced as ${props.row.priceKey}` : id;
  };
  return (
    <tr>
      {/* One line per row ("glm-5.3" broke at its hyphen, "Main thread" at its space): the table
          scrolls sideways instead of rows growing taller, until the pane is narrow enough to stack. */}
      <td class="text-mono usage-table-model" style={oneLine} title={title()}>
        {compactModel(props.row.model) ?? props.row.model}
        {props.row.asked ? " ⚠" : ""}
      </td>
      <td class="usage-table-where" style={oneLine}>
        {originLabel(props.row.origin)}
      </td>
      <Cells spend={props.row} />
    </tr>
  );
}
