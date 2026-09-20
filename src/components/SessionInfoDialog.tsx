import { createEffect, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { CompactionInfo, ContextInfo, ModelSpend, SessionInsight, SessionSummary, TokenUsage, TranscriptItem } from "../../shared/protocol";
import { fetchSessionInsight } from "../lib/api";
import { contextSentence, contextStateFor, formatTokens } from "../lib/context";
import { compactModel, relativeTime, thousands, tildePath } from "../lib/format";
import { absoluteTime, anyCost, firstLine, originLabel, spendRows, timelineEntries } from "../lib/spend";
import { copyText, home } from "../lib/ui-state";
import { formatCost, usageHeadline, usageTitle, usageTotal } from "../lib/workers";
import { Banner, CopyButton, Icon, trapFocus } from "./ui";

/** Relative times in here are minutes-old at most; a slow tick keeps them honest. */
const TICK_MS = 30_000;
/** Same rule as everywhere else: a skeleton only after the fetch has actually been slow. */
const SKELETON_MS = 300;

/** Long machine facts wrap instead of widening the sheet. */
const wrapMono = { margin: 0, "overflow-wrap": "anywhere" } as const;

/**
 * Per-session info modal (DESIGN_NOTES §4h): opened from the composer flyout's "Session info"
 * item. Read-only — it reports what this session has spent and what it's made of, and changes
 * nothing.
 *
 *   path     this chat's session file (key for insights/context)
 *   summary  App-level session list row, live (undefined before the list loads)
 *   context  this chat's context fill (ContextGauge's source)
 *   items    this chat's transcript rows (for the model/thinking/mode timeline)
 *   onClose  close and return focus to the flyout trigger
 */
export function SessionInfoDialog(props: {
  path: string;
  onClose(): void;
  summary?: () => SessionSummary | undefined;
  context?: () => ContextInfo | null;
  items?: () => TranscriptItem[];
}) {
  const [insight, setInsight] = createSignal<SessionInsight | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [fetchedAt, setFetchedAt] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [slow, setSlow] = createSignal(false);

  // The dialog is mounted while it's open, so mounting IS opening: reopening refetches, and a
  // path that changes under an open dialog (never today) would too.
  let run = 0;
  const load = async () => {
    const mine = ++run;
    setLoading(true);
    const slowTimer = setTimeout(() => mine === run && setSlow(true), SKELETON_MS);
    try {
      const next = await fetchSessionInsight(props.path);
      if (mine !== run) return;
      setInsight(next);
      setError(null);
      setFetchedAt(Date.now());
    } catch (err) {
      if (mine !== run) return;
      setError((err as Error).message);
    } finally {
      clearTimeout(slowTimer);
      if (mine === run) {
        setLoading(false);
        setSlow(false);
      }
    }
  };
  createEffect(on(() => props.path, () => void load()));

  const tick = setInterval(() => setNow(Date.now()), TICK_MS);
  onCleanup(() => {
    run++; // an answer that lands after the close writes to nothing
    clearInterval(tick);
  });

  const summary = () => props.summary?.();
  const usage = () => insight()?.usage;
  const rows = () => spendRows(usage());
  const workers = () => insight()?.workers ?? [];
  const working = () => workers().filter((w) => w.working).length;
  const subagentTotal = () => usageTotal(insight());
  const compactions = () => insight()?.compactions ?? [];
  const timeline = () => timelineEntries(props.items?.() ?? []);
  /** The gauge's own state, so the sentence here and the one in the head can't disagree. */
  const context = () => contextStateFor(props.context?.() ?? null, props.items?.() ?? []);
  const live = () => summary()?.live ?? null;

  const close = () => props.onClose();

  return (
    <Portal>
      <div class="scrim" onClick={close} />
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-info-title"
        tabindex="-1"
        ref={(el) => {
          trapFocus(el);
          queueMicrotask(() => el.focus());
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="session-info-title">
            Session info
          </h2>
        </div>

        <div class="modal-body">
          <Show when={error()}>
            {(message) => (
              <Banner
                tone="error"
                title="Couldn't load this session's insight."
                body={`Nothing was changed. ${message()}`}
                action={
                  <button type="button" class="button button-sm" onClick={() => void load()}>
                    Retry
                  </button>
                }
              />
            )}
          </Show>

          {/* 1 · Path. The one fact the user came here to copy. */}
          <section class="stack-2" aria-labelledby="si-path-label">
            <h3 class="text-eyebrow" id="si-path-label">
              Path
            </h3>
            <p class="text-mono" style={wrapMono}>
              {props.path}
            </p>
            <div class="cluster">
              <CopyButton label="Copy Session Path" text={() => props.path} onCopy={(t) => copyText(t, "Copied path.")} />
            </div>
          </section>

          {/* 2 · Usage. One row per model × origin, plus the two Σs those rows can't carry. */}
          <Show when={usage()}>
            {(u) => (
              <section class="stack-2" aria-labelledby="si-usage-label">
                <h3 class="text-eyebrow" id="si-usage-label">
                  Usage
                </h3>
                <p class="text-mono" style={{ margin: 0 }} title={usageTitle(u().total)}>
                  {formatTokens(usageHeadline(u().total))} tokens in and out
                  <Show when={formatCost(u().total.cost)}>{(cost) => <> · {cost()}</>}</Show>
                </p>
                <Show when={rows().length > 0}>
                  <div class="md md-table-wrap">
                    <table>
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
                          <Show when={anyCost(rows())}>
                            <th scope="col" align="right">
                              Cost
                            </th>
                          </Show>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={rows()}>{(row) => <SpendRow row={row} cost={anyCost(rows())} />}</For>
                      </tbody>
                      <tfoot>
                        <tr>
                          <th scope="row" colSpan={2}>
                            Main thread Σ
                          </th>
                          <Cells usage={u().main} cost={anyCost(rows())} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </Show>
                <p class="usage-note">Main thread counts the active branch only.</p>
                <Show when={u().workersTotal}>
                  {(total) => (
                    <p class="usage-note text-muted" title={usageTitle(total(), total().workers)}>
                      Subagent lifetime: {formatTokens(usageHeadline(total()))} tokens
                      <Show when={formatCost(total().cost)}>{(cost) => <> · {cost()}</>}</Show> across {total().workers}{" "}
                      {total().workers === 1 ? "worker" : "workers"} (includes evicted).
                    </p>
                  )}
                </Show>
              </section>
            )}
          </Show>

          {/* 3 · Context. The gauge's own sentence, so the two never drift. */}
          <Show when={context()}>
            {(state) => (
              <section class="stack-2" aria-labelledby="si-context-label">
                <h3 class="text-eyebrow" id="si-context-label">
                  Context
                </h3>
                <p class="usage-note">{contextSentence(state())}</p>
              </section>
            )}
          </Show>

          {/* 4 · Identity. What this session is, where it runs, and since when. */}
          <Show when={summary()}>
            {(s) => (
              <section class="stack-2" aria-labelledby="si-identity-label">
                <h3 class="text-eyebrow" id="si-identity-label">
                  Identity
                </h3>
                <dl class="stack-2" style={{ margin: 0 }}>
                  <Fact label="Session id">
                    <span class="text-mono" style={wrapMono}>
                      {s().id}
                    </span>
                  </Fact>
                  <Fact label="Folder">
                    <span class="text-mono" style={wrapMono} title={s().cwd}>
                      {tildePath(s().cwd, home())}
                    </span>
                  </Fact>
                  <Fact label="Created">
                    <span title={absoluteTime(s().createdAt, now())}>{relativeTime(s().createdAt, now())}</span>
                  </Fact>
                  <Fact label="Last active">
                    <span title={absoluteTime(s().lastActiveAt, now())}>{relativeTime(s().lastActiveAt, now())}</span>
                  </Fact>
                  <Fact label="Origin">{s().origin === "web" ? "Started here" : "Started in a terminal"}</Fact>
                  <Fact label="Archived">{s().archived ? "Yes" : "No"}</Fact>
                  <Show when={live()}>
                    {(l) => (
                      <Fact label="Live">
                        <span class="text-mono">pid {l().pid}</span> · {l().status}
                      </Fact>
                    )}
                  </Show>
                </dl>
              </section>
            )}
          </Show>

          <Show when={loading() && slow() && !insight()}>
            <div class="stack-2" aria-hidden="true">
              <span class="skeleton skeleton-title" />
              <span class="skeleton skeleton-line" />
              <span class="skeleton skeleton-line" />
            </div>
          </Show>

          {/* 5 · Subagents. This session's own workers — never the session's own spend. */}
          <Show when={workers().length > 0 || subagentTotal()}>
            <section class="stack-2" aria-labelledby="si-subagents-label">
              <h3 class="text-eyebrow" id="si-subagents-label">
                Subagents
              </h3>
              <p class="usage-note">
                {workers().length} {workers().length === 1 ? "subagent" : "subagents"} in this session · {working()} working
              </p>
              <Show when={subagentTotal()}>
                {(total) => (
                  <p class="usage-note text-muted" title={usageTitle(total(), total().workers)}>
                    {formatTokens(usageHeadline(total()))} tokens across {total().workers} {total().workers === 1 ? "worker" : "workers"}
                  </p>
                )}
              </Show>
            </section>
          </Show>

          {/* 6 · Compactions. Where the transcript was summarized, on demand. */}
          <Show when={compactions().length > 0}>
            <details class="disclosure">
              <summary class="disclosure-summary">
                <Icon name="chevron-right" small class="icon-twist" />
                <span class="disclosure-label">
                  {compactions().length} {compactions().length === 1 ? "compaction" : "compactions"}
                </span>
              </summary>
              <div class="disclosure-body">
                <ul class="list">
                  <For each={compactions()}>{(c) => <CompactionRow compaction={c} now={now()} />}</For>
                </ul>
              </div>
            </details>
          </Show>

          {/* 7 · Timeline. Model, thinking and mode changes, in the order they happened. */}
          <Show when={timeline().length > 0}>
            <details class="disclosure">
              <summary class="disclosure-summary">
                <Icon name="chevron-right" small class="icon-twist" />
                <span class="disclosure-label">Timeline</span>
                <span class="disclosure-preview">
                  · {timeline().length} {timeline().length === 1 ? "change" : "changes"}
                </span>
              </summary>
              <div class="disclosure-body">
                <ul class="list">
                  <For each={timeline()}>
                    {(entry) => (
                      <li class="list-row">
                        <div class="list-main">
                          <p class="list-title" style={wrapMono}>
                            {entry.text}
                          </p>
                          <Show when={entry.at}>
                            {(at) => (
                              <p class="list-meta" title={absoluteTime(at(), now())}>
                                {relativeTime(at(), now())}
                              </p>
                            )}
                          </Show>
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </details>
          </Show>
        </div>

        <div class="modal-foot">
          <Show when={fetchedAt() > 0}>
            <span class="text-caption text-muted">Refreshed {relativeTime(new Date(fetchedAt()).toISOString(), now())}</span>
          </Show>
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={() => void load()} aria-disabled={loading() ? "true" : undefined}>
            Refresh
          </button>
          <button type="button" class="button" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </Portal>
  );
}

/** One label/value pair in the Identity list. `<dd>` carries its own reset: base.css has none. */
function Fact(props: { label: string; children: JSX.Element }) {
  return (
    <div class="spread">
      <dt class="text-caption text-muted">{props.label}</dt>
      <dd class="text-caption" style={{ margin: 0, "text-align": "right", "min-width": 0 }}>
        {props.children}
      </dd>
    </div>
  );
}

/** The four token columns and, when any row reports one, the cost. */
function Cells(props: { usage: TokenUsage; cost: boolean }) {
  const cell = (n: number) => (
    <td align="right" class="text-mono text-num">
      {formatTokens(n)}
    </td>
  );
  return (
    <>
      {cell(props.usage.input)}
      {cell(props.usage.output)}
      {cell(props.usage.cacheRead)}
      {cell(props.usage.cacheWrite)}
      <Show when={props.cost}>
        <td align="right" class="text-mono text-num">
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
            {(cost) => cost()}
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
      <td class="text-mono" title={props.row.model}>
        {compactModel(props.row.model) ?? props.row.model}
      </td>
      <td>{originLabel(props.row.origin)}</td>
      <Cells usage={props.row} cost={props.cost} />
    </tr>
  );
}

/** One compaction: when it happened, what it summarized away, and the first line of the summary. */
function CompactionRow(props: { compaction: CompactionInfo; now: number }) {
  const preview = () => firstLine(props.compaction.summary);
  const tokens = () => props.compaction.tokensBefore;
  return (
    <li class="list-row">
      <div class="list-main">
        <p class="list-meta" title={absoluteTime(props.compaction.timestamp, props.now)}>
          {relativeTime(props.compaction.timestamp, props.now)}
          <Show when={tokens() !== null} fallback=" · earlier messages summarized">
            {" · "}
            <span class="text-mono">{thousands(tokens()!)}</span> tokens summarized
          </Show>
        </p>
        <Show when={preview()}>
          <p class="list-title" style={wrapMono}>
            {preview()}
          </p>
        </Show>
      </div>
    </li>
  );
}
