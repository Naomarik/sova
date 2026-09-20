import { createEffect, createSignal, For, on, Show, type JSX } from "solid-js";
import type { CompactionInfo, ContextInfo, ModelSpend, SessionInsight, SessionSummary, TokenUsage, TranscriptItem } from "../../shared/protocol";
import { contextSentence, contextStateFor, formatTokens } from "../lib/context";
import { compactModel, relativeTime, thousands, tildePath } from "../lib/format";
import { absoluteTime, anyCost, firstLine, originLabel, spendRows, timelineEntries } from "../lib/spend";
import { setSessionArchived } from "../lib/api";
import { resumeCommand } from "../lib/session-command";
import { copyText, home, toast } from "../lib/ui-state";
import { formatCost, sessionWorking, usageHeadline, usageTitle, usageTotal } from "../lib/workers";
import { Banner, CopyButton, Icon } from "./ui";

/** Long machine facts wrap instead of widening the sheet. */
const wrapMono = { margin: 0, "overflow-wrap": "anywhere" } as const;

/**
 * What a session is and what it has spent (DESIGN_NOTES §4h), read-only: the body of the Session
 * info modal and the session pane's Session tab, one implementation for both. Its parent owns
 * the data and the scroll box; this renders sections as siblings for a flex column with gaps.
 *
 *   path      the session file (shown and copyable)
 *   insight   the session's insight, or null before the first load
 *   error     a failed insight load to report, or null
 *   onRetry   what the error's Retry does; without it the banner offers none
 *   skeleton  the load has been slow: show the skeleton while `insight` is still null
 *   summary   App-level session list row (undefined before the list loads)
 *   context   the transcript's context fill from the server (ContextGauge's source)
 *   items     transcript rows (the model/thinking/mode timeline, and "compacted" for context)
 *   now       the clock relative times are measured against
 *   onArchiveChanged  after Archive/Unarchive succeeds: re-read the session list
 *   idPrefix  prefix of the section heading ids ("si", the modal's, by default), so the modal and
 *             the pane can both be open without duplicate ids
 */
export function SessionDetails(props: {
  path: string;
  insight: SessionInsight | null;
  error: string | null;
  onRetry?: () => void;
  skeleton: boolean;
  summary: SessionSummary | undefined;
  context: ContextInfo | null;
  items: TranscriptItem[];
  now: number;
  onArchiveChanged?: () => void;
  idPrefix?: string;
}) {
  const id = (section: string) => `${props.idPrefix ?? "si"}-${section}-label`;
  const insight = () => props.insight;
  const now = () => props.now;
  const summary = () => props.summary;
  const usage = () => insight()?.usage;
  const rows = () => spendRows(usage());
  const workers = () => insight()?.workers ?? [];
  const working = () => workers().filter((w) => w.working).length;
  const subagentTotal = () => usageTotal(insight());
  const compactions = () => insight()?.compactions ?? [];
  const timeline = () => timelineEntries(props.items);
  /** The gauge's own state, so the sentence here and the one in the head can't disagree. */
  const context = () => contextStateFor(props.context, props.items);
  const live = () => summary()?.live ?? null;
  /** What Archive/Unarchive just did, until the list row catches up (or without a refresh). */
  const [archivedNow, setArchivedNow] = createSignal<boolean | null>(null);
  createEffect(on(() => summary()?.archived, () => setArchivedNow(null), { defer: true }));
  const archived = () => archivedNow() ?? summary()?.archived === true; // older servers send none

  return (
    <>
      <Show when={props.error}>
        {(message) => (
          <Banner
            tone="error"
            title="Couldn't load this session's insight."
            body={`Nothing was changed. ${message()}`}
            action={
              props.onRetry && (
                <button type="button" class="button button-sm" onClick={() => props.onRetry?.()}>
                  Retry
                </button>
              )
            }
          />
        )}
      </Show>

      {/* 1 · Path. The one fact the user came here to copy. */}
      <section class="stack-2" aria-labelledby={id("path")}>
        <h3 class="text-eyebrow" id={id("path")}>
          Path
        </h3>
        <p class="text-mono" style={wrapMono}>
          {props.path}
        </p>
        <div class="cluster">
          <CopyButton label="Copy Session Path" text={() => props.path} onCopy={(t) => copyText(t, "Copied path.")} />
          <CopyButton
            label="Copy Resume Command"
            title="Open this session in a terminal."
            text={() => resumeCommand(props.path)}
            onCopy={(t) => copyText(t, "Copied resume command.")}
          />
        </div>
      </section>

      {/* 2 · Usage. One row per model × origin, plus the two Σs those rows can't carry. */}
      <Show when={usage()}>
        {(u) => (
          <section class="stack-2" aria-labelledby={id("usage")}>
            <h3 class="text-eyebrow" id={id("usage")}>
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
          <section class="stack-2" aria-labelledby={id("context")}>
            <h3 class="text-eyebrow" id={id("context")}>
              Context
            </h3>
            <p class="usage-note">{contextSentence(state())}</p>
          </section>
        )}
      </Show>

      {/* 4 · Identity. What this session is, where it runs, and since when. */}
      <Show when={summary()}>
        {(s) => (
          <section class="stack-2" aria-labelledby={id("identity")}>
            <h3 class="text-eyebrow" id={id("identity")}>
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
              <Fact label="Archived">{archived() ? "Yes" : "No"}</Fact>
              <Show when={live()}>
                {(l) => (
                  <Fact label="Live">
                    <span class="text-mono">pid {l().pid}</span> · {l().status}
                  </Fact>
                )}
              </Show>
            </dl>
            {/* Archiving is ours to define only for sessions pi-web started. */}
            <Show when={s().origin === "web"}>
              <div class="cluster">
                <ArchiveAction
                  session={s()}
                  archived={archived()}
                  working={Math.max(sessionWorking(s()), working())}
                  onDone={(next) => {
                    setArchivedNow(next);
                    props.onArchiveChanged?.();
                  }}
                />
              </div>
            </Show>
          </section>
        )}
      </Show>

      <Show when={props.skeleton && !props.insight}>
        <div class="stack-2" aria-hidden="true">
          <span class="skeleton skeleton-title" />
          <span class="skeleton skeleton-line" />
          <span class="skeleton skeleton-line" />
        </div>
      </Show>

      {/* 5 · Subagents. This session's own workers — never the session's own spend. */}
      <Show when={workers().length > 0 || subagentTotal()}>
        <section class="stack-2" aria-labelledby={id("subagents")}>
          <h3 class="text-eyebrow" id={id("subagents")}>
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
    </>
  );
}

/**
 * Archive/Unarchive for a web-spawned session (DESIGN_NOTES §2 "Archiving"). Archiving closes the
 * session's runtime, so it's refused while the session is live in a TUI (it would stay on top
 * anyway) and while its subagents work (they'd stop with it); unarchiving always works.
 */
function ArchiveAction(props: { session: SessionSummary; archived: boolean; working: number; onDone(archived: boolean): void }) {
  const [pending, setPending] = createSignal(false);
  const blocked = (): string | null => {
    if (props.archived) return null;
    if (props.session.live !== null) return "Open in a TUI. It stays on top while live.";
    const n = props.working;
    if (n > 0) return `${n} ${n === 1 ? "subagent" : "subagents"} working. Archiving closes this session's runtime, so ${n === 1 ? "it stops" : "they stop"}.`;
    return null;
  };
  const click = async () => {
    if (pending() || blocked()) return;
    const next = !props.archived;
    setPending(true);
    try {
      await setSessionArchived(props.session.path, next);
      toast(next ? "Archived. Find it under Archive." : "Moved back to Live & web.");
      props.onDone(next);
    } catch (err) {
      toast(`Couldn't ${next ? "archive" : "unarchive"} this session. ${(err as Error).message}`);
    } finally {
      setPending(false);
    }
  };
  return (
    <button
      type="button"
      class={props.archived ? "button" : "button button-destructive"}
      title={blocked() ?? undefined}
      aria-disabled={blocked() || pending() ? "true" : undefined}
      onClick={click}
    >
      <Icon name="archive" />
      {props.archived ? "Unarchive Session" : "Archive Session"}
    </button>
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
