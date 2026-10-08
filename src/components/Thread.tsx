import { children, createContext, createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, useContext, type JSX } from "solid-js";
import type { RowFacts } from "../../shared/harness-wire";
import type { HandoffRunInfo, TmpAttachment, TranscriptItem } from "../../shared/protocol";
import { rowFacts } from "../../shared/wire-v1";
import type { BatonMark } from "../../shared/baton";
import { wrapupRowIds } from "../lib/wrapup-rows";
import { blockStreams, type LiveBlock, type LiveEntry, type LiveState, type LiveUserState } from "../lib/live";
import { agoTime, modelLabel, modelMismatch, prettyJson, stampTime, thousands, tildePath } from "../lib/format";
import { useMinuteNow } from "../lib/minute-clock";
import { isObj, resultDetails as detailsOf, str, toolCallArgs, toolResultView } from "../lib/message";
import { toolContent, type ToolSource } from "../lib/tool-content";
import { stripPastedPaths } from "../lib/path-attachments";
import { home } from "../lib/ui-state";
import { ensureRendered, entryIdOf, JUMP_EVENT, loadRow, registerRows, registerTranscript, transcriptRoot } from "../lib/jump";
import type { RowTarget } from "../lib/older-rows";
import type { ScrollSpot } from "../lib/transcript-cache";
import { carriedStart, chunkStart, fillStops, FIRST_CHUNK, type ImagesAt, initialStart, jumpStart, lineCols, nextChunk, rowEstimate, rowIndexFor, windowId } from "../lib/tail-render";
import { usePaneId } from "../lib/pane-scope";
import { isHiddenBlock, liveHiddenCounts, splitHidden, thinkingHiddenLabel, toolsHiddenLabel, CARD_TOOLS } from "../lib/hidden-rows";
import { chainRuns, type ChainRun } from "../lib/chain-rows";
import { compressWork } from "../lib/work-compression";
import { isChangeRow, isLoginNoteRow } from "../lib/change-rows";
import { stripSessionHeader } from "../../shared/profiles";
import { profileIconName } from "../lib/profiles";
import { profileToolCard, ProfileToolCardView } from "./ProfileCards";
import { isTurnStart } from "../lib/turn";
import { parseWakeNudge } from "../../shared/wake";
import { parseTopicBatch } from "../../shared/topic-message";
import { ImageStrip } from "./ImageStrip";
import { PathAttachment, PathText } from "./PathAttachment";
import { ReportRow } from "./ReportRow";
import { TeamMessageCard } from "./TeamMessageCard";
import { AlignCard } from "./AlignCard";
import { AlignRow } from "./AlignDocCard";
import { ExplainCard } from "./ExplainCard";
import { alignOf, alignRowFromDetails, latestAlignId, newestAlignRows } from "../lib/align";
import { explainOf } from "../lib/explain";
import { Markdown } from "./Markdown";
import { ToolCard, type ToolStatus } from "./ToolCard";
import { WakeCard } from "./WakeCard";
import { TopicCard } from "./TopicCard";
import { WorktreeMergeCard } from "./WorktreeMergeCard";
import { ShowChangesCard } from "./ChangesViewer";
import { SubagentLimitRow } from "./SubagentLimitRow";
import { rowProvider } from "../lib/subagent-limit";
import { normalizeShowChangesDetails, SHOW_CHANGES_TOOL } from "../../pi-config/extensions/show-changes/details";
import { Banner, Chip, Icon } from "./ui";
import { BriefRow, CardRevision, ConfirmCard, DeckCard, LinkCard, linkDetails, NavigateGo, OverseerChoiceRow, useOverseerThread } from "./OverseerCards";
import { cardFold, confirmAnswer, confirmDetails, isBriefText } from "../lib/overseer";
import { CARD_TOOL, LEGACY_CONFIRM_TOOL, normalizeCardDetails } from "../../shared/overseer-card";
import { MessageActions, type MessageActionItem } from "./MessageActions";
import { type MessageStrip, sameStrip, stripLabel, stripsByRow } from "../lib/message-actions";

/** Whose transcript the rows inside are (lib/tool-content): a tool card asks it for the content its
    row doesn't carry. Absent: the rows carry all they draw. */
export const ToolSourceContext = createContext<ToolSource | null>(null);

/**
 * What a view hangs under each delivered message. The thread decides
 * WHERE a strip goes — once per entry, never once per rendered block — and the view decides what
 * it holds: a chat offers Copy · Rewind/Regenerate, a watch offers Copy with the others'
 * reasons, and a transcript rendered with no provider (a subagent's) shows no strip at all.
 */
export interface MessageActionsProvider {
  items(strip: MessageStrip): MessageActionItem[];
  /** The last refusal for that entry, kept on its row after the announcement. */
  note?(entryId: string): string | null;
}

/** "1:43 PM · 5m ago": the clock in mono, then its age, kept current by the one minute clock
    every head shares. The age drops once it would only repeat the date (past 7 days). */
function Stamp(props: { iso?: string }) {
  const now = useMinuteNow();
  return (
    <Show when={props.iso}>
      {(iso) => (
        <span class="message-stamp" title={iso()}>
          <span class="message-time">{stampTime(iso(), now())}</span>
          <Show when={agoTime(iso(), now())}>{(ago) => <span class="message-ago"> · {ago()}</span>}</Show>
        </span>
      )}
    </Show>
  );
}

/** The head label for a message that hasn't been delivered yet. "Sending…" is only true while
    nothing has acknowledged it; once the server says it holds the message, the truth is "Queued"
    — it may sit there for minutes, until the agent next polls its queue. */
const PENDING_LABEL: Partial<Record<LiveUserState, string>> = { sending: "Sending…", queued: "Queued" };

/** A message Sova queued for itself (a group send from another surface, a remote status probe)
    is still a message to this session, but it is not one you typed here — and a row that says
    "You" over a message you never wrote is the kind of small lie that makes the rest suspect. */
const AUTHOR = { client: "You", server: "Sent by Sova" } as const;

function UserTurn(props: {
  text: string;
  time?: string;
  state?: LiveUserState;
  origin?: "client" | "server";
  /** The Overseer sent this message (its `sova-overseer-sent` marker names this row). */
  overseer?: boolean;
  /** A baton participant's name (its `sova-baton-sent` marker names this row, §app.baton/attribution). */
  sender?: string;
  /** Another session sent this message (its `sova-session-sent` marker, §chat.profiles/delivery). */
  fromSession?: { sessionId: string; title: string; hop?: number };
  images?: string[];
  attachments?: TmpAttachment[];
}) {
  const author = () =>
    props.fromSession ? "From a session" : props.overseer ? "Overseer" : (props.sender ?? AUTHOR[props.origin ?? "client"]);
  // The model reads the header line; the row shows it as the sender header instead.
  const text = () => (props.fromSession ? stripSessionHeader(props.text) : props.text);
  return (
    <>
    <Show when={props.fromSession}>
      {(from) => (
        <p class="session-sender">
          <Icon name="network" small />
          <span>
            From <a href={`#/sid/${encodeURIComponent(from().sessionId)}`}>{from().title || "another session"}</a>
          </span>
          <Show when={from().hop !== undefined}>
            <span class="text-muted">· hop {from().hop}</span>
          </Show>
        </p>
      )}
    </Show>
    <article
      class="message message-user"
      classList={{ "message-from-session": !!props.fromSession }}
      aria-label={props.time ? `${author()}, ${stampTime(props.time)}` : author()}
    >
      <div class="message-head">
        <Show when={props.overseer} fallback={<span class="message-author">{author()}</span>}>
          <span class="message-author overseer-author" title="Sent by the Overseer">
            <Icon name="eye" small />
            Overseer
          </span>
        </Show>
        <Stamp iso={props.time} />
        <Show when={props.state && PENDING_LABEL[props.state]}>
          {(label) => <span class="message-pending">{label()}</span>}
        </Show>
      </div>
      <ImageStrip images={props.images} where="in your message" />
      <For each={props.attachments}>{(a) => <PathAttachment attachment={a} where="in your message" />}</For>
      <Show when={text()}>
        <div class="message-body message-text">{text()}</div>
      </Show>
    </article>
    </>
  );
}

function AssistantText(props: {
  text: string;
  author: string;
  /** Full "provider/model" behind `author` (its short form), for hover. */
  model?: string;
  time?: string;
  streaming?: boolean;
  showHead: boolean;
  attachments?: TmpAttachment[];
}) {
  return (
    <article
      class="message"
      classList={{ "message-streaming": !!props.streaming }}
      aria-label={props.time ? `${props.author}, ${stampTime(props.time)}` : props.author}
    >
      <Show when={props.showHead || props.streaming}>
        <div class="message-head">
          <span class="message-author text-mono" title={props.model}>{props.author}</span>
          <Show when={props.streaming}>
            <span class="live-dot" />
          </Show>
          <Stamp iso={props.time} />
        </div>
      </Show>
      <Markdown text={props.text} streaming={props.streaming} attachments={props.attachments} />
    </article>
  );
}

/**
 * Tools the thread draws as a card rather than as a tool card: they carry the message (a question
 * with buttons, a link, a profile's session), not the working, so a chain never swallows one
 * `show_changes` joins them only when its details check out, which
 * the caller decides.
 */
const CARD_RENDER_NAMES: ReadonlySet<string> = new Set([...CARD_TOOLS, "session_send", "sova_create_session"]);

/**
 * Runs the reader has folded, by the run's own key. Module scope, not component state: the streaming
 * run (`LiveEntries`) and the settled rows (`HistoryItems`) are two components drawing the same
 * transcript, and a fold is about the run, not about which one of them drew it.
 */
const [foldedRuns, setFoldedRuns] = createSignal<ReadonlySet<string>>(new Set());
const foldedRun = (run: { key: string } | undefined) => !!run && foldedRuns().has(run.key);
/** A step of a folded run: it draws nothing at all, so the run is its one line. */
const foldedStep = (run: { key: string; first: boolean } | undefined) => !!run && !run.first && foldedRun(run);
/** One fold control per run, including a run containing only one step. */
const foldable = (run: ChainRun | undefined) => !!run && run.first;
const toggleRunFold = (key: string) =>
  setFoldedRuns((prev) => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });

/**
 * The run's own control in a separate gutter. Folded, the whole summary is the target;
 * the step's native twist remains independent.
 */
function ChainFold(props: { run: ChainRun & { key: string; failed: number; running?: number } }) {
  const folded = () => foldedRun(props.run);
  const name = () => `${folded() ? "Expand" : "Collapse"} ${props.run.steps} work ${props.run.steps === 1 ? "step" : "steps"}`;
  return (
    <button type="button" class="button button-ghost chain-fold" aria-expanded={!folded()} aria-label={name()} title={name()} onClick={() => toggleRunFold(props.run.key)}>
      <Icon name={folded() ? "chevron-right" : "chevron-down"} small />
      <span class="chain-fold-label">
        Work · {props.run.steps} {props.run.steps === 1 ? "step" : "steps"}
        <Show when={props.run.failed > 0}> · {props.run.failed} failed</Show>
        <Show when={(props.run.running ?? 0) > 0}> · {props.run.running} running</Show>
      </span>
      <span class="chain-fold-action">{folded() ? "Expand" : "Collapse"}</span>
    </button>
  );
}

function Thinking(props: { text: string; streaming?: boolean }) {
  const preview = () => {
    const first = props.text.trim().split("\n")[0] ?? "";
    return first.length > 80 ? `${first.slice(0, 80)}…` : first;
  };
  return (
    <details class="disclosure">
      <summary class="disclosure-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="disclosure-label">Thinking</span>
        <Show when={props.streaming}>
          <span class="live-dot" />
        </Show>
        <Show when={preview()}>
          <span class="disclosure-preview">· {preview()}</span>
        </Show>
      </summary>
      <div class="disclosure-body thinking-body">{props.text}</div>
    </details>
  );
}

/** A baton entry in the operator's transcript (§app.baton/attribution): a hand-off, an offer and its
    lease, a decision, a proposed person, the wrap-up, done. Typed as the full mark so kinds the
    protocol field gains later render here once. */
function BatonCard(props: { mark: Exclude<BatonMark, { kind: "sent" }>; name(ref: string): string; wrapupShown: boolean; onWrapupToggle(): void }) {
  const m = props.mark;
  const names = (refs: string[]) => refs.map(props.name).join(", ");
  return (
    <Switch>
      <Match when={m.kind === "handoff" && m}>
        {(h) => (
          <aside class="baton-card" aria-label={`Hand-off ${h().n}`}>
            <span class="baton-card-head">
              Hand-off {h().n}: {props.name(h().from)} → {props.name(h().to)}
            </span>
            <div class="baton-card-body">{h().question}</div>
            <Show when={h().briefing}>
              <div class="baton-card-brief">Briefing: {h().briefing}</div>
            </Show>
          </aside>
        )}
      </Match>
      <Match when={m.kind === "offer" && m}>
        {(o) => (
          <aside class="baton-card" aria-label={`Offer, hand-off ${o().n}`}>
            <span class="baton-card-head">
              Hand-off {o().n}: {props.name(o().from)} → offered to {names(o().to)}
            </span>
            <div class="baton-card-body">{o().question}</div>
            <Show when={o().briefing}>
              <div class="baton-card-brief">Briefing: {o().briefing}</div>
            </Show>
          </aside>
        )}
      </Match>
      <Match when={m.kind === "lease" && m}>
        {(l) => (
          <p class="baton-card-line">
            {l().event === "claimed" ? `${props.name(l().by)} took the offer.` : `${props.name(l().by)} went quiet, so the offer is open to every invitee again.`}
          </p>
        )}
      </Match>
      <Match when={m.kind === "decision" && m}>
        {(d) => (
          <aside class="baton-card" aria-label="Decision">
            <span class="baton-card-head">
              Decision · {d().area} · {props.name(d().by)}
            </span>
            <div class="baton-card-body">{d().statement}</div>
            <div class="baton-card-quote">“{d().quote}”</div>
          </aside>
        )}
      </Match>
      <Match when={m.kind === "proposal" && m}>
        {(r) => (
          <aside class="baton-card" aria-label={`Proposed: ${r().name}`}>
            <span class="baton-card-head">
              Proposed for the roster · {r().name}
              {r().role ? ` (${r().role})` : ""} · by {props.name(r().by)}
            </span>
            <div class="baton-card-body">{r().why}</div>
          </aside>
        )}
      </Match>
      <Match when={m.kind === "wrapup" && m}>
        {(w) => {
          const end = () => (w().phase === "end" ? (w() as Extract<BatonMark, { kind: "wrapup"; phase: "end" }>) : null);
          return (
            <Show
              when={end()}
              fallback={
                <p class="baton-card-line">
                  Wrap-up turn: it reads this session for profile updates and quotes profiles, so it's folded here.{" "}
                  <button type="button" class="button button-sm button-ghost" aria-expanded={props.wrapupShown} onClick={() => props.onWrapupToggle()}>
                    {props.wrapupShown ? "Fold Wrap-up Turn" : "Show Wrap-up Turn"}
                  </button>
                </p>
              }
            >
              {(e) => (
                <aside class="baton-card" aria-label="Wrap-up">
                  <span class="baton-card-head">Wrap-up</span>
                  <div class="baton-card-body">
                    {e().error
                      ? `Stopped: ${e().error} No profile changed after that.`
                      : `${e().applied.length} profile ${e().applied.length === 1 ? "field" : "fields"} updated${e().refused.length ? `, ${e().refused.length} refused` : ""}.`}
                  </div>
                  <For each={e().applied}>{(a) => <div class="baton-card-brief">{props.name(a.personId)} · {a.field}</div>}</For>
                  <For each={e().refused}>
                    {(r) => (
                      <div class="baton-card-brief">
                        Refused: {props.name(r.personId)} · {r.field} — {r.reason}
                      </div>
                    )}
                  </For>
                </aside>
              )}
            </Show>
          );
        }}
      </Match>
      <Match when={m.kind === "done" && m}>
        {(d) => (
          <aside class="baton-card" aria-label="Done">
            <span class="baton-card-head">Done</span>
            <div class="baton-card-body">{d().summary}</div>
          </aside>
        )}
      </Match>
    </Switch>
  );
}

export function InfoRow(props: { children: JSX.Element }) {
  return (
    <div class="info-row" role="note">
      <span class="info-row-text">
        <Icon name="info" small />
        <span>{props.children}</span>
      </span>
    </div>
  );
}

/** A /compact-handoff run (§chat.slash-commands/compact-handoff-row): an info row whose icon is
    the live dot while the fork writes; the result entry (same id) replaces it in place. */
function HandoffRunRow(props: { run: HandoffRunInfo; text: string }) {
  return (
    <div class="info-row" role="note">
      <span class="info-row-text">
        <Show when={props.run.status === "running"} fallback={<Icon name="info" small />}>
          {/* The explain card's 16px slot, so the dot sits where the icon would. */}
          <span class="explain-card-live" aria-hidden="true">
            <span class="live-dot" />
          </span>
        </Show>
        <Show when={props.run.status === "failed"}>
          <Chip tone="error">Failed</Chip>
        </Show>
        <Show when={props.run.status === "interrupted"}>
          <Chip tone="warn">Interrupted</Chip>
        </Show>
        <span>{props.text}</span>
      </span>
    </div>
  );
}

function Unknown(props: { raw: unknown }) {
  const type = () => (isObj(props.raw) ? str(props.raw.type) : undefined) ?? "unknown";
  return (
    <div class="stack-2">
      <InfoRow>
        Unrecognized entry <code>{type()}</code>
      </InfoRow>
      <details class="disclosure">
        <summary class="disclosure-summary">
          <Icon name="chevron-right" small class="icon-twist" />
          <span class="disclosure-label">Raw entry</span>
        </summary>
        <pre>{prettyJson(props.raw)}</pre>
      </details>
    </div>
  );
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A compaction entry: where it happened in the thread, with its summary on demand. */
function Compaction(props: { compaction: NonNullable<RowFacts["compaction"]> }) {
  const tokens = () => props.compaction.tokensBefore ?? null;
  const details = () => (isObj(props.compaction.details) ? props.compaction.details : {});
  const read = () => strings(details().readFiles);
  const changed = () => strings(details().modifiedFiles);
  return (
    <details class="disclosure compaction">
      <summary class="disclosure-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="disclosure-label">Compacted</span>
        <span class="disclosure-preview">
          <Show when={tokens() !== null} fallback="· earlier messages summarized">
            · <span class="text-mono">{thousands(tokens()!)}</span> tokens summarized
          </Show>
        </span>
      </summary>
      <div class="disclosure-body">
        <div class="compaction-summary">{props.compaction.summary ?? ""}</div>
        <Show when={read().length > 0}>
          <p class="toolcard-section-label">Files read</p>
          <ul class="compaction-files">
            <For each={read()}>{(f) => <li>{tildePath(f, home())}</li>}</For>
          </ul>
        </Show>
        <Show when={changed().length > 0}>
          <p class="toolcard-section-label">Files changed</p>
          <ul class="compaction-files">
            <For each={changed()}>{(f) => <li>{tildePath(f, home())}</li>}</For>
          </ul>
        </Show>
      </div>
    </details>
  );
}

/** "The turn stopped with an error." Kept in the thread, in flow, so it stays in the record. */
export function TurnError(props: { message: string }) {
  return (
    <Banner
      tone="error"
      title="The turn stopped with an error."
      body={`${props.message.replace(/\.$/, "")}. Your messages are kept. Send again to retry.`}
    />
  );
}

/** A transcript row that ends a turn on an error (the `${entryId}:stop` info row): the error's own
    words sit in its text, its producer's model on the row. The server words it "Error…" for a
    stop reason of "error" and "Aborted…" otherwise. */
export function isErroredTurnStop(it: TranscriptItem): boolean {
  return it.kind === "info" && it.id.endsWith(":stop") && (it.text ?? "").startsWith("Error");
}

/**
 * Stands in for the rows "Hide tool calls" and "Hide thinking" remove: each count, with any
 * failures right after the tool count, and the blocks themselves on demand — so hiding is never a
 * dead end and never hides a failure.
 */
function HiddenRows(props: { calls: number; failed: number; running?: number; thinking: number; children: () => JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <details class="disclosure" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary class="disclosure-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <Show when={props.calls > 0}>
          <span class="disclosure-label">{toolsHiddenLabel(props.calls)}</span>
          <Show when={props.failed > 0}>
            <Chip tone="error">{props.failed} failed</Chip>
          </Show>
          <Show when={props.running}>
            <Chip tone="accent" live>
              {props.running} running
            </Chip>
          </Show>
        </Show>
        <Show when={props.thinking > 0}>
          <span class="disclosure-label">
            {props.calls > 0 ? "· " : ""}
            {thinkingHiddenLabel(props.thinking)}
          </span>
        </Show>
      </summary>
      {/* Mounted only while open: a long session's blocks cost nothing while they're hidden. */}
      <Show when={open()}>
        <div class="disclosure-body stack-2" style={{ "white-space": "normal" }}>
          {props.children()}
        </div>
      </Show>
    </details>
  );
}

/**
 * Renders normalized transcript items. Tool results fold into their call's card. `streaming`
 * says whether a tool without a result may still be running (vs. never got one). `hideTools` and `hideThinking`
 * drops every call with its result and puts one summary row after the rest.
 */
export function HistoryItems(props: {
  items: TranscriptItem[];
  author: string;
  /** A baton session's person names by ref ("operator" included): the sender tags and cards. */
  names?: Record<string, string>;
  streaming: boolean;
  hideTools?: boolean;
  hideThinking?: boolean;
  /** The chat's own path when this transcript is a held chat (ChatView): an errored turn's `:stop`
      row carries the limit row then. Never on a watched or subagent transcript. */
  limitPath?: string;
  /** Index from which a call without a result may still be running; after the last user row by default. */
  openFrom?: number;
  /** Per-message actions. Absent: no strips at all (a subagent transcript, the hidden-rows
      disclosure) — an action is about the chat you are in, not about every transcript on screen. */
  actions?: MessageActionsProvider;
  /** Build every row at once, even inside a transcript (the hidden-rows disclosure's own list). */
  whole?: boolean;
  /** Rows above the list that the view doesn't hold yet (lib/older-rows): fetched as the reader
      nears the top, or down to a jump's target. */
  older?: OlderRowsApi;
  /** Alignments this streaming run already changed: their settled cards read as revision rows
      until the refetch brings the new revision (§chat.alignment/card). */
  liveAlignIds?: ReadonlySet<string>;
  /** Cards this streaming run already changed: their settled rows read as one line until the
      refetch brings the new snapshot (§app.overseer/confirm). */
  liveCardIds?: ReadonlySet<string>;
}) {
  /**
   * The items the thread may render: the settings-change rows are dropped before anything else,
   * so they can't appear even inside the hidden-rows disclosure. Every scan that speaks the
   * rendered rows' coordinates (the last-user/openFrom scan) runs on this same array.
   */
  // A baton wrap-up's turn reads profiles: folded behind its card unless asked for (lib/wrapup-rows).
  const [showWrapup, setShowWrapup] = createSignal(false);
  const wrapupRows = createMemo(() => (showWrapup() ? new Set<string>() : wrapupRowIds(props.items)));
  /** Calls whose result is an alignment row: the row is the card, so the call has no row at all. */
  const alignCalls = createMemo(() => new Set(props.items.flatMap((it) => (it.kind === "align" && it.toolCallId ? [it.toolCallId] : []))));
  const renderable = createMemo(() =>
    props.items.filter((it) => !isChangeRow(it) && !wrapupRows().has(it.id) && !(it.kind === "tool-call" && it.toolCallId && alignCalls().has(it.toolCallId))),
  );
  const split = createMemo(() =>
    props.hideTools || props.hideThinking ? splitHidden(renderable(), { tools: !!props.hideTools, thinking: !!props.hideThinking }) : null,
  );
  /** The rows rendered: all of them, or everything but tool rows while they're hidden. */
  const rows = () => split()?.shown ?? renderable();
  const results = createMemo(() => {
    const byCall = new Map<string, TranscriptItem>();
    for (const it of props.items) if (it.kind === "tool-result" && it.toolCallId) byCall.set(it.toolCallId, it);
    return byCall;
  });
  /** A show_changes call's checked details, once it succeeded (§chat.changes/show-changes-card). */
  const showChangesOf = (callId: string | undefined) => {
    const r = callId ? results().get(callId) : undefined;
    return r && !toolResultView(r).isError ? normalizeShowChangesDetails(detailsOf(r)) : undefined;
  };
  const calls = createMemo(() => {
    const ids = new Set<string>();
    for (const it of props.items) if (it.kind === "tool-call" && it.toolCallId) ids.add(it.toolCallId);
    return ids;
  });
  /** The images a row draws, for its height estimate: a user row's own (a brief row draws none), a
      tool call's result's, an orphan result's own; a paired result draws nothing. */
  const shownImages = (item: TranscriptItem): [string[] | undefined, ImagesAt] =>
    item.kind === "user" ? [isBriefText(item.text) ? undefined : item.images, "user"]
    : item.kind === "tool-call" ? [item.toolCallId ? results().get(item.toolCallId)?.images : undefined, "tool"]
    : item.kind === "tool-result" ? [item.toolCallId && calls().has(item.toolCallId) ? undefined : item.images, "tool"]
    : [undefined, "user"];
  const latestAlign = createMemo(() => latestAlignId(props.items));
  /** The newest revision of each alignment renders as the card; the rest as one line each. */
  const newestAligns = createMemo(() => newestAlignRows(props.items));
  /** The thread's cards, folded from their results: the row that last touched a card itself renders
      it in full, with the card's newest snapshot; an earlier row is one line. */
  const cards = createMemo(() => cardFold(props.items));
  const cardRow = (item: TranscriptItem) => {
    const d = cards().rows.get(item.id);
    if (!d?.card) return undefined;
    const id = d.card.id;
    const newest = cards().newest.get(id) === item.id && !props.liveCardIds?.has(id);
    return { details: d, card: newest ? (cards().cards.get(id) ?? d.card) : d.card, newest };
  };
  const alignNewest = (item: TranscriptItem) => newestAligns().has(item.id) && !(item.align?.doc && props.liveAlignIds?.has(item.align.doc.id));

  /** Whether a call draws a card rather than a tool card, by the render's own rule. */
  const asCard = (it: TranscriptItem): boolean => {
    if (it.kind !== "tool-call") return false;
    if (it.text === SHOW_CHANGES_TOOL) return !!showChangesOf(it.toolCallId);
    return cardRow(it) !== undefined || CARD_RENDER_NAMES.has(it.text ?? "");
  };

  /**
   * Consecutive visible working rows draw one timeline, a line per step instead of a card.
   * A paired result draws inside its call's row: it is neither a step nor a break.
   */
  const chains = createMemo(() => {
    const list = rows();
    const callIds = new Set(list.flatMap((it) => (it.kind === "tool-call" && it.toolCallId ? [it.toolCallId] : [])));
    const working = list.map(
      (it) =>
        it.kind === "thinking" ||
        (it.kind === "tool-call" && !asCard(it)) ||
        (it.kind === "tool-result" && !(it.toolCallId && callIds.has(it.toolCallId))),
    );
    const skip = list.map((it) => it.kind === "tool-result" && !!it.toolCallId && callIds.has(it.toolCallId));
    const runs = chainRuns(working, skip, compressWork());
    // What the folded line reports on, counted FIRST and for the run as a whole: the row that draws
    // that line is the run's first one, and it would otherwise be told the count before its own run
    // had been walked. One error per failed step, never twice for a call and its stored result.
    const failedOf = (it: TranscriptItem): boolean => {
      if (it.kind === "tool-call") {
        const r = it.toolCallId ? results().get(it.toolCallId) : undefined;
        return !!r && toolResultView(r).isError;
      }
      if (it.kind === "tool-result") return !(it.toolCallId && callIds.has(it.toolCallId)) && toolResultView(it).isError;
      return false;
    };
    // A run is folded by ONE key that outlives its rows: the first row's id, which the list keeps
    // across appends and refetches.
    const meta = new Map<number, { key: string; failed: number }>();
    list.forEach((it, i) => {
      const run = runs[i];
      if (!run) return;
      let m = meta.get(run.at);
      if (!m) {
        m = { key: list[run.at]!.id, failed: 0 };
        meta.set(run.at, m);
      }
      if (failedOf(it)) m.failed += 1;
    });
    return new Map(
      list.flatMap((it, i) => {
        const run = runs[i];
        return run ? [[it.id, { ...run, ...meta.get(run.at)! }] as const] : [];
      }),
    );
  });

  /** User rows a baton participant sent: target id → their ref, in any order (§app.baton/attribution). */
  const batonSent = createMemo(() => {
    const by = new Map<string, string>();
    for (const it of props.items) if (it.batonMark?.kind === "sent") by.set(it.batonMark.targetId, it.batonMark.by);
    return by;
  });
  const nameOf = (ref: string) => props.names?.[ref] ?? (ref === "operator" ? "You" : "Someone");
  /** User rows the Overseer sent: its markers name them by id, in any order. */
  const overseerSent = createMemo(() => {
    const ids = new Set<string>();
    for (const it of props.items) if (it.overseerMark?.kind === "sent") ids.add(it.overseerMark.targetId);
    return ids;
  });
  /** User rows another session sent (§chat.profiles/delivery): target id → sender, in any order. */
  const sessionSent = createMemo(() => {
    const by = new Map<string, { sessionId: string; title: string; hop: number }>();
    for (const it of props.items) if (it.sessionMark?.kind === "sent") by.set(it.sessionMark.targetId, { ...it.sessionMark.from, hop: it.sessionMark.hop });
    return by;
  });
  /** The profile row shows once a message is on the branch (§chat.profiles/after-first-message). */
  const hasUserRow = createMemo(() => props.items.some((it) => it.kind === "user"));
  /**
   * Where the action strips go, by rendered-row index. One per ENTRY: a reply rendered as three
   * blocks is one message, and three strips under it would be three Regenerates for one turn.
   * Computed from the rows actually shown, so hiding tools or thinking moves a strip rather than
   * duplicating or dropping one.
   */
  const strips = createMemo(() => (props.actions ? stripsByRow(rows()) : new Map<number, MessageStrip>()));
  // Only calls after the last user message (or wake nudge or link message — isTurnStart) can still be in flight.
  const lastUserIndex = createMemo(() => {
    for (let i = renderable().length - 1; i >= 0; i--) if (isTurnStart(renderable()[i]!)) return i;
    return -1;
  });
  const openFrom = () => props.openFrom ?? lastUserIndex() + 1;
  /**
   * Tail-first (lib/tail-render): inside a transcript, the newest rows are built with the list and
   * the older ones prepended above them while the browser is idle, up to MAX_BUILT_ROWS, then as
   * the view nears their top or a jump needs them. The window
   * is held as the id of its first row, so an append or a refetch keeps what is already built.
   * Every index below is the row's index in `rows()`, never in the built slice.
   */
  const scroller = props.whole ? null : useContext(ScrollerContext);
  const toolSource = useContext(ToolSourceContext);
  const rowAt = createMemo(() => {
    const at = new Map<string, number>();
    rows().forEach((r, i) => at.set(r.id, i));
    return at;
  });
  const idAt = (i: number) => windowId(rows(), i);
  const [firstId, setFirstId] = createSignal<string | null>(scroller ? idAt(initialStart(rows().length)) : null);
  const start = createMemo<number>((prev) => (scroller ? carriedStart(firstId(), (id) => rowAt().get(id) ?? -1, rows().length, prev) : 0), 0);
  // The window is held by a row that is on the list: once its row is gone (or there was none, an
  // empty list), it is held again by the row it starts at now, so rows that arrive above later
  // (lib/older-rows) go to the fill instead of being built at once.
  if (scroller)
    createEffect(() => {
      const id = firstId();
      if (rows().length > 0 && (id === null || !rowAt().has(id))) setFirstId(idAt(start()));
    });
  const built = createMemo(() => (start() === 0 ? rows() : rows().slice(start())));
  const indexOf = scroller ? createMemo(() => new Map(rows().map((r, i) => [r, i] as const))) : null;
  if (scroller) {
    const root = scroller.root();
    const ids = createMemo(() => rows().map((r) => (r.kind === "link" ? null : r.id)));
    /** Builds from row `i` down, keeping the view where it is (`hold`: to the pixel while they draw). */
    const buildFrom = (i: number, hold = false) => scroller.prepend(() => setFirstId(idAt(i)), hold);
    let chunk = FIRST_CHUNK;
    let cancel: (() => void) | null = null;
    /** One chunk above the built rows, timed for the next one's size. */
    const buildChunk = () => {
      const next = chunkStart(start(), chunk);
      const t0 = performance.now();
      buildFrom(next, true);
      chunk = nextChunk(chunk, performance.now() - t0);
      return next;
    };
    // The idle fill: up to MAX_BUILT_ROWS (lib/tail-render `fillStops`); past that, the view nearing
    // the top builds the next chunk (below).
    const step = () => {
      cancel = null;
      if (fillStops(rows().length, start())) return;
      const next = buildChunk();
      if (!fillStops(rows().length, next)) schedule();
    };
    const schedule = () => {
      if (cancel) return;
      cancel = whenIdle(step);
    };
    createEffect(() => !fillStops(rows().length, start()) && schedule());
    onCleanup(() => cancel?.());
    // Once the view is within NEAR_TOP_VIEWS viewports of the top of the built rows: rows held but
    // not built (the fill stopped at its cap) are built a chunk at a time, with the view held still;
    // once every row held is built, the next older rows are fetched, and they land above the
    // window, where the fill builds them as any row not built yet.
    const older = props.older;
    const check = () => {
      const left = older?.left() ?? 0;
      if ((start() === 0 && (left === null || left <= 0)) || root.scrollTop >= NEAR_TOP_VIEWS * root.clientHeight) return;
      if (start() > 0) buildChunk();
      else older?.more();
    };
    root.addEventListener("scroll", check, { passive: true });
    onCleanup(() => root.removeEventListener("scroll", check));
    // After a change to what's held or built, when the frame has settled (a short list sits at the
    // top): a frame later, since the follow-scroll for the same change runs in that frame's
    // animation callbacks after this one is queued, and a check before it reads a view not yet at
    // the end (an open would fetch a chunk nobody asked for).
    createEffect(on([start, () => older?.left(), () => rows().length], () => requestAnimationFrame(() => requestAnimationFrame(check))));
    registerRows(root, {
      has: (entryId) => rowIndexFor(ids(), entryId) >= 0,
      ensure: (entryId) => {
        const i = rowIndexFor(ids(), entryId);
        if (i < 0) return false;
        const from = jumpStart(i, start());
        if (from < start()) buildFrom(from);
        return true;
      },
      older: () => {
        const left = props.older?.left();
        return left === null || (left ?? 0) > 0;
      },
      load: (target) => props.older?.load(target) ?? Promise.resolve("missing" as const),
    });
    onCleanup(() => registerRows(root, null));
  }

  return (
    <>
      {/* Held while there are older rows to fetch, so its indicator appearing never moves the view;
          the indicator (no text; its name is for screen readers) shows only while a fetch is slow,
          a scroll-up chunk or a jump's range, and sticks to the top of the view so a jump from the
          end sees it too. It goes with the fill's last build, not before: that build keeps the view
          where it is (ScrollerApi.prepend), its going included. */}
      <Show when={scroller && props.older && ((props.older.left() ?? 0) > 0 || start() > 0)}>
        <div class="older-edge" role="status">
          <Show when={props.older!.slow()}>
            <span class="older-edge-bar skeleton" role="img" aria-label="Loading older messages" />
          </Show>
        </div>
      </Show>
      <For each={built()}>
        {(item, local) => {
          const index = indexOf ? () => indexOf().get(item) ?? local() : local;
          /** The timeline run this row belongs to, when it is the working. */
          const chain = () => chains().get(item.id);
          // The strip every list change rebuilds, kept while it offers the same thing: rows
          // arriving above (a tail-first hello's history), an append or a turn-end reload would
          // otherwise rebuild the buttons of every message on the page.
          const strip = createMemo(() => strips().get(index()), undefined, { equals: sameStrip });
          return (
          // A link message is a partner's, shown only in the Agents tab (§mesh.links/transcript):
          // no row at all here, not even the wrapper. It still counts as a turn start (above).
          item.kind === "link" ? null : (
          /* A step of a folded run draws nothing at all — as a `<Show>`, because a plain early return
             is read once and would leave the folded run's steps in the page. */
          <Show when={!foldedStep(chain())}>
          {/* The row's box: the outline strip finds an entry's row by it (Jump to Message), and the
              estimate is its height until it is first drawn (content-visibility, app.css). */}
          <div
            class="entry"
            classList={{ "chain-row": !!chain() }}
            data-chain={chain() ? String(chain()!.at) : undefined}
            data-chain-first={chain()?.first ? "" : undefined}
            data-chain-last={chain()?.last ? "" : undefined}
            data-chain-folded={foldedRun(chain()) ? "" : undefined}
            data-entry={item.id}
            style={{ "--entry-est": rowEstimate(item, ...shownImages(item), !!chain(), foldedRun(chain()), !!chain()?.first) }}
          >
            <Show when={foldable(chain()) ? chain() : null}>{(run) => <ChainFold run={run()} />}</Show>
            <Switch fallback={<Unknown raw={item.entry} />}>
              <Match when={item.kind === "user" && isBriefText(item.text)}>
                <BriefRow text={item.text ?? ""} time={item.at} />
              </Match>
              <Match when={item.kind === "user"}>
                <UserTurn
                  text={item.text ?? ""}
                  time={item.at}
                  overseer={overseerSent().has(entryIdOf(item.id))}
                  sender={batonSent().has(entryIdOf(item.id)) ? nameOf(batonSent().get(entryIdOf(item.id))!) : undefined}
                  fromSession={sessionSent().get(entryIdOf(item.id))}
                  images={item.images}
                  attachments={item.attachments}
                />
              </Match>
              {/* The sent marker draws nothing itself: it tags the row it names (above). */}
              <Match when={item.overseerMark?.kind === "sent"}>{null}</Match>
              <Match when={item.batonMark?.kind === "sent"}>{null}</Match>
              <Match when={item.sessionMark?.kind === "sent"}>{null}</Match>
              <Match when={item.profileMark}>
                {(mark) => (
                  <Show when={hasUserRow() && mark().profile}>
                    {(p) => (
                      <p class="profile-row" title="The profile this session runs with. It was fixed when the first message was sent.">
                        <Icon name={profileIconName(p().icon)} small />
                        {item.text}
                      </p>
                    )}
                  </Show>
                )}
              </Match>
              <Match when={item.batonMark && item.batonMark.kind !== "sent" && item.batonMark}>
                {(mark) => <BatonCard mark={mark() as Exclude<BatonMark, { kind: "sent" }>} name={nameOf} wrapupShown={showWrapup()} onWrapupToggle={() => setShowWrapup(!showWrapup())} />}
              </Match>
              <Match when={item.overseerMark?.kind === "dialog-answer" && item.overseerMark}>
                {(mark) => <OverseerChoiceRow title={mark().title} answer={mark().answer} />}
              </Match>
              <Match when={item.kind === "worktree-merge" && item.worktreeMerge}>
                {(merge) => <WorktreeMergeCard merge={merge()} time={item.at} />}
              </Match>
              <Match when={item.kind === "wake" && item.wake}>
                {(wake) => <WakeCard nudge={wake()} text={item.text ?? ""} time={item.at} />}
              </Match>
              <Match when={item.kind === "topic" && item.topic}>
                {(batch) => <TopicCard batch={batch()} time={item.at} />}
              </Match>
              {/* Legacy: the retired spec card's row, still sent by older mesh peers. */}
              <Match when={item.kind === "spec-turn"}>{null}</Match>
              <Match when={item.kind === "assistant-text"}>
                <AssistantText
                  text={item.text ?? ""}
                  author={modelLabel(item.model, item.answered) ?? props.author}
                  model={[item.model, modelMismatch(item.model, item.answered)].filter(Boolean).join(" · ") || undefined}
                  time={item.at}
                  showHead={
                    rows()[index() - 1]?.kind !== "assistant-text" || rows()[index() - 1]?.model !== item.model
                  }
                  attachments={item.attachments}
                />
              </Match>
              <Match when={item.kind === "thinking"}>
                <Thinking text={item.text ?? ""} />
              </Match>
              <Match when={item.kind === "align" && item.align}>{(row) => <AlignRow row={row()} newest={alignNewest(item)} />}</Match>
              <Match when={item.kind === "report" && item.report && alignOf(item.report)}>
                {(align) => (
                  <Show when={item.id === latestAlign()} fallback={<span class="align-superseded" hidden />}>
                    <AlignCard report={item.report!} align={align()} attachments={item.attachments} />
                  </Show>
                )}
              </Match>
              <Match when={item.kind === "report" && item.report && explainOf(item.report)}>
                {(explain) => <ExplainCard explain={explain()} />}
              </Match>
              <Match when={item.kind === "report" && item.report?.team}>
                {(team) => <TeamMessageCard report={item.report!} team={team()} time={item.at} attachments={item.attachments} />}
              </Match>
              <Match when={item.kind === "report" && item.report}>
                {(report) => <ReportRow report={report()} attachments={item.attachments} />}
              </Match>
              <Match when={item.kind === "info" && item.handoffRun}>
                {(run) => <HandoffRunRow run={run()} text={item.text ?? ""} />}
              </Match>
              <Match when={item.kind === "info" && rowFacts(item)?.compaction}>
                {(compaction) => <Compaction compaction={compaction()} />}
              </Match>
              {/* A Claude login note waits for the first message, like the profile row. */}
              <Match when={isLoginNoteRow(item) && !hasUserRow()}>{null}</Match>
              <Match when={item.kind === "info"}>
                <>
                  <InfoRow>
                    <PathText text={item.text ?? ""} attachments={item.attachments} />
                  </InfoRow>
                  {/* A turn that ended on an error keeps its "Error: …" row (the transcript's
                      `${entryId}:stop`); the limit row rides beside it with that turn's own
                      provider (the row's `model` — never the session's current one). */}
                  <Show when={props.limitPath && isErroredTurnStop(item) ? { path: props.limitPath, item } : null}>
                    {(x) => <SubagentLimitRow path={x().path} message={x().item.text?.replace(/^Error: /, "") ?? ""} provider={rowProvider(x().item.model)} />}
                  </Show>
                </>
              </Match>
              {/* A show_changes result whose details check out reads as a card that opens the
                  changes viewer (§chat.changes/show-changes-card); anything else, a tool card. */}
              <Match when={item.kind === "tool-call" && item.text === SHOW_CHANGES_TOOL && showChangesOf(item.toolCallId)}>
                {(details) => <ShowChangesCard details={details()} />}
              </Match>
              <Match when={item.kind === "tool-call"}>
                {(() => {
                  const view = () => {
                    const r = item.toolCallId ? results().get(item.toolCallId) : undefined;
                    return r ? toolResultView(r) : undefined;
                  };
                  const status = (): ToolStatus => {
                    const v = view();
                    if (v) return v.isError ? "error" : "done";
                    return props.streaming && index() >= openFrom() ? "running" : "none";
                  };
                  const resultDetails = () => {
                    const r = item.toolCallId ? results().get(item.toolCallId) : undefined;
                    return r ? detailsOf(r) : undefined;
                  };
                  // A legacy card (from before card ids): read-only, answered by the rule it had then.
                  const confirm = () =>
                    item.text === LEGACY_CONFIRM_TOOL && status() !== "error"
                      ? (confirmDetails(resultDetails()) ?? confirmDetails(toolCallArgs(item)))
                      : null;
                  const card = () => (item.text === CARD_TOOL && status() === "done" ? cardRow(item) : undefined);
                  /** A made or ended link reads as a card naming its members (§app.overseer/links-tools);
                      running or failed, the plain tool card. */
                  const linked = () =>
                    (item.text === "sova_link" || item.text === "sova_unlink") && status() === "done" ? linkDetails(resultDetails()) : null;
                  /** session_send and a profile's sova_create_session read as cards (§chat.profiles/delivery). */
                  /** The arguments and output its rows don't carry, asked for by the call's row id. */
                  const lazy = createMemo(() => {
                    const r = item.toolCallId ? results().get(item.toolCallId) : undefined;
                    if (!toolSource || !(item.tool?.lazy || r?.tool?.lazy)) return undefined;
                    return toolContent.handle(toolSource, item.id, { resultId: r?.id, callId: item.toolCallId, size: (item.tool?.bytes ?? 0) + (r?.tool?.bytes ?? 0) });
                  });
                  const profileCard = () => profileToolCard(item.text, status(), toolCallArgs(item), resultDetails(), view()?.output);
                  return (
                    <Show
                      when={!card()}
                      fallback={
                        <Show when={card()!.newest} fallback={<CardRevision card={card()!.card} line={card()!.details.line} />}>
                          <DeckCard card={card()!.card} line={card()!.details.line} />
                        </Show>
                      }
                    >
                    <Show
                      when={confirm()}
                      fallback={
                    <Show
                      when={linked()}
                      fallback={
                    <Show
                      when={profileCard()}
                      fallback={
                    <ToolCard
                      name={item.text ?? "tool"}
                      args={toolCallArgs(item)}
                      summary={item.tool?.summary}
                      stats={(item.text === "edit" || item.text === "write") && item.toolCallId ? results().get(item.toolCallId)?.tool?.stats : undefined}
                      calls={item.toolCallId ? results().get(item.toolCallId)?.tool?.calls : undefined}
                      lazy={lazy()}
                      details={resultDetails()}
                      status={status()}
                      output={view()?.output}
                      images={item.toolCallId ? results().get(item.toolCallId)?.images : undefined}
                      attachments={item.toolCallId ? results().get(item.toolCallId)?.attachments : undefined}
                      action={item.text === "sova_navigate" && status() === "done" ? <NavigateGo details={resultDetails()} /> : undefined}
                    />
                      }
                    >
                      {(card) => <ProfileToolCardView card={card()} />}
                    </Show>
                      }
                    >
                      {(d) => <LinkCard details={d()} ended={item.text === "sova_unlink"} />}
                    </Show>
                      }
                    >
                      {(details) => {
                        const answer = () => confirmAnswer(props.items, props.items.indexOf(item), details());
                        return <ConfirmCard details={details()} answered={answer().answered} choice={answer().choice} />;
                      }}
                    </Show>
                    </Show>
                  );
                })()}
              </Match>
              <Match when={item.kind === "tool-result"}>
                {/* Paired results render inside their call's card; orphans get their own. */}
                <Show when={!item.toolCallId || !calls().has(item.toolCallId)}>
                  {(() => {
                    const view = toolResultView(item);
                    const lazy = toolSource && item.tool?.lazy ? toolContent.handle(toolSource, item.id, { resultId: item.id, size: item.tool.bytes }) : undefined;
                    return (
                      <ToolCard
                        name="result"
                        args={undefined}
                        lazy={lazy}
                        status={view.isError ? "error" : "done"}
                        output={view.output}
                        images={item.images}
                        attachments={item.attachments}
                      />
                    );
                  })()}
                </Show>
              </Match>
            </Switch>
            {/* Under the bubble, once per entry (see `strips`). */}
            <Show when={strip()}>
              {(strip) => (
                <MessageActions
                  label={stripLabel(strip().role)}
                  align={strip().role === "user" ? "end" : "start"}
                  items={props.actions!.items(strip())}
                  note={props.actions!.note?.(strip().entryId) ?? null}
                />
              )}
            </Show>
          </div>
          </Show>
          )
          );
        }}
      </For>
      <Show when={split()?.hidden.length ? split() : null}>
        {(s) => (
          <HiddenRows calls={s().calls} failed={s().failed} thinking={s().thinking}>
            {() => <HistoryItems items={s().hidden} author={props.author} names={props.names} streaming={props.streaming} openFrom={s().openFrom} whole />}
          </HiddenRows>
        )}
      </Show>
    </>
  );
}

function LiveBlockView(props: { block: LiveBlock; live: LiveState; author: string; model?: string; streaming: boolean; showHead: boolean }) {
  const overseerThread = useOverseerThread();
  return (
    <Switch>
      <Match when={props.block.type === "text" && props.block}>
        {(b) => (
          <Show when={b().text}>
            <AssistantText text={b().text} author={props.author} model={props.model} streaming={props.streaming} showHead={props.showHead} />
          </Show>
        )}
      </Match>
      <Match when={props.block.type === "thinking" && props.block}>
        {(b) => <Thinking text={b().text} streaming={props.streaming} />}
      </Match>
      <Match when={props.block.type === "toolCall" && props.block}>
        {(b) => {
          const tool = () => props.live.tools[b().id];
          const status = (): ToolStatus => {
            const t = tool();
            if (t) return t.status;
            return props.live.running ? "running" : "none";
          };
          /** A card this run raised or changed: the card itself, as soon as the result lands. */
          const card = () => (b().name === CARD_TOOL && status() === "done" ? normalizeCardDetails(tool()?.details) : undefined);
          /** The card at the fold's newest snapshot; null when a later call (this run's too) changed
              it since this one, so this call is a revision line and never takes a click. */
          const deck = () => {
            const own = card()?.card;
            if (!own) return undefined;
            const newest = overseerThread?.card?.(own.id) ?? own;
            return newest.rev > own.rev ? null : newest;
          };
          const linked = () => ((b().name === "sova_link" || b().name === "sova_unlink") && status() === "done" ? linkDetails(tool()?.details) : null);
          // A finished call keeps what it streamed for the settled row that replaces this one, so a
          // card open now stays drawn while the fetch asks the session file (lib/tool-content).
          const toolSource = useContext(ToolSourceContext);
          createEffect(() => {
            const t = tool();
            if (!toolSource || !t || (t.status !== "done" && t.status !== "error")) return;
            const args = b().args ?? t.args;
            toolContent.seed(toolSource, b().id, {
              ...(args !== undefined ? { args } : {}),
              result: { output: t.output, isError: t.status === "error", ...(t.details !== undefined ? { details: t.details } : {}) },
            });
          });
          /** An align result that changed an alignment: its card, as soon as the result lands. */
          const aligned = () => (b().name === "align" && status() === "done" ? alignRowFromDetails(tool()?.details) : undefined);
          return (
            <Show when={!aligned()} fallback={<div class="entry-live-align" data-align-live={aligned()?.doc?.id}><AlignRow row={aligned()!} newest /></div>}>
            <Show
              when={!card()?.card}
              fallback={
                <Show when={deck()} fallback={<CardRevision card={card()!.card!} line={card()!.line} />}>
                  {(c) => <DeckCard card={c()} line={card()!.line} />}
                </Show>
              }
            >
                <Show
                  when={linked()}
                  fallback={
                    <ToolCard
                      name={b().name}
                      args={b().args ?? tool()?.args}
                      argsText={b().argsText}
                      details={tool()?.details}
                      status={status()}
                      output={tool()?.output}
                      images={tool()?.images}
                      action={b().name === "sova_navigate" && status() === "done" ? <NavigateGo details={tool()?.details} /> : undefined}
                    />
                  }
                >
                  {(d) => <LinkCard details={d()} ended={b().name === "sova_unlink"} />}
                </Show>
            </Show>
            </Show>
          );
        }}
      </Match>
    </Switch>
  );
}

/** The in-progress run assembled from streaming events. `hideTools` and `hideThinking` drop those
    blocks and put one summary row after the turn, counted from live status. */
export function LiveEntries(props: {
  live: LiveState;
  author: string;
  /** A baton session's names by ref: a live row's sender, once its marker arrived. */
  names?: Record<string, string>;
  hideTools?: boolean;
  hideThinking?: boolean;
  /** The chat's own path when this thread is a held chat (ChatView): the limit row's switch is a
      chat pick, so nothing else (a watched or a subagent transcript) ever gets one. */
  limitPath?: string;
  /** What a message of ours that hasn't been delivered offers — one Remove, from the chat. A row
      the server has already taken (`delivered`) is never asked: nothing can be recalled then, and
      a disabled Remove under every message you ever sent is an affordance that lies. */
  queueActions?: (row: { id?: string; state: LiveUserState; text: string }) => MessageActionItem[];
}) {
  const hide = () => ({ tools: !!props.hideTools, thinking: !!props.hideThinking });
  const shows = (b: LiveBlock | undefined) => !!b && !isHiddenBlock(b, hide()) && (!compressWork() || b.type !== "text" || !!b.text);
  /** The nearest block before `i` that renders, so a hidden call doesn't repeat the author head. */
  const shownBefore = (blocks: LiveBlock[], i: number) => {
    for (let j = i - 1; j >= 0; j--) if (!isHiddenBlock(blocks[j], hide())) return blocks[j];
    return undefined;
  };
  const hiddenBlocks = () => props.live.entries.flatMap((e) => (e.kind === "assistant" ? e.blocks.filter((b) => isHiddenBlock(b, hide())) : []));
  /** A hidden block streams (live dot) as it would shown: thinking until a later block starts. */
  const hiddenStreams = (b: LiveBlock) => {
    for (const e of props.live.entries) if (e.kind === "assistant" && e.blocks.includes(b)) return blockStreams(e, e.blocks.indexOf(b));
    return true;
  };
  const hidden = createMemo(() => (props.hideTools || props.hideThinking ? liveHiddenCounts(props.live, hide()) : null));
  /**
   * The chain each streaming block belongs to, by the settled transcript's own rule.
   * A hidden block is neither a step nor a break.
   */
  const liveChains = createMemo(() => {
    // Entry boundaries draw nothing. Nulls stand for visible user/error/stop rows instead.
    const blocks: (LiveBlock | null)[] = [];
    for (const e of props.live.entries) {
      if (e.kind !== "assistant") blocks.push(null);
      else {
        blocks.push(...e.blocks);
        if (e.stoppedAt || e.error) blocks.push(null);
      }
    }
    const working = blocks.map((b) => {
      if (b?.type === "thinking") return true;
      if (b?.type !== "toolCall") return false;
      if (b.name === SHOW_CHANGES_TOOL) {
        const tool = props.live.tools[b.id];
        return !(tool?.status === "done" && normalizeShowChangesDetails(tool.details));
      }
      return !CARD_RENDER_NAMES.has(b.name);
    });
    const skip = blocks.map((b) => b !== null && !shows(b));
    // A streaming run folds under its own key: it has no entry id yet, and its block list only
    // grows at the end, so where it starts is what identifies it. Settling gives it a real id,
    // which is why a run folded while it streamed comes back open.
    // The failures are counted before any block is handed a run, as the settled path counts them.
    const runsList = chainRuns(working, skip, compressWork());
    const failed = new Map<number, number>();
    const running = new Map<number, number>();
    blocks.forEach((b, i) => {
      const run = runsList[i];
      if (!run || b === null) return;
      if (!failed.has(run.at)) failed.set(run.at, 0);
      if (b.type === "toolCall" && props.live.tools[b.id]?.status === "error") failed.set(run.at, failed.get(run.at)! + 1);
      if (b.type === "toolCall" && props.live.tools[b.id]?.status === "running") running.set(run.at, (running.get(run.at) ?? 0) + 1);
    });
    const runs = new Map<LiveBlock, (ChainRun & { key: string; failed: number; running: number }) | null>();
    runsList.forEach((run, i) => {
      const b = blocks[i];
      if (!b) return;
      runs.set(b, run ? { ...run, key: `live:${run.at}`, failed: failed.get(run.at) ?? 0, running: running.get(run.at) ?? 0 } : null);
    });
    return runs;
  });
  const liveChainOf = (block: LiveBlock) => liveChains().get(block) ?? undefined;
  return (
    <>
      <For each={props.live.entries}>
        {(entry: LiveEntry) => (
          /* What the last row read (ThreadScroller `spot`) needs of a live message: the entry it was
             written as, once its end has named it, or that it is a prompt no start has taken yet. */
          <div
            class="live-entry"
            data-entry-read={entry.entryId}
            data-queued={entry.kind === "user" && !entry.started && !entry.entryId ? "" : undefined}
          >
          <Switch>
            <Match when={entry.kind === "user" && entry}>
              {(e) => (
                <Show
                  when={parseWakeNudge(e().text)}
                  fallback={
                    <Show when={parseTopicBatch(e().text)} fallback={
                    <Show when={!isBriefText(e().text)} fallback={<BriefRow text={e().text} />}>
                    {
                    /* A queued row has no `.entry` around it, so it brings the hover/tap region
                       its Remove needs to be revealed by (base.css; `display: contents`, so the
                       wrapper changes nothing about how the row lays out). */
                    <div class="message-actions-host">
                      <UserTurn
                        text={e().attachments ? stripPastedPaths(e().text) : e().text}
                        state={e().state}
                        origin={e().origin}
                        overseer={e().overseer}
                        fromSession={e().fromSession}
                        sender={e().by ? (props.names?.[e().by!] ?? (e().by === "operator" ? "You" : "Someone")) : undefined}
                        images={e().images}
                        attachments={e().attachments}
                      />
                      <Show when={props.queueActions && e().state !== "delivered" ? props.queueActions(e()) : null}>
                        {(items) => <Show when={items().length > 0}><MessageActions label="Actions for your queued message" align="end" items={items()} /></Show>}
                      </Show>
                    </div>
                    }
                    </Show>
                    }>
                      {(batch) => <TopicCard batch={batch()} />}
                    </Show>
                  }
                >
                  {(wake) => <WakeCard nudge={wake()} text={e().text} />}
                </Show>
              )}
            </Match>
            <Match when={entry.kind === "assistant" && entry}>
              {(e) => (
                <>
                  {/* Streaming blocks group like settled rows, across assistant entries too. */}
                  <For each={e().blocks}>
                    {(block, i) => {
                      const chain = () => liveChainOf(block);
                      const view = () => (
                        <LiveBlockView
                          block={block}
                          live={props.live}
                          author={modelLabel(e().model) ?? props.author}
                          model={e().model}
                          streaming={blockStreams(e(), i())}
                          showHead={shownBefore(e().blocks, i())?.type !== "text"}
                        />
                      );
                      return (
                      <Show when={shows(block) && !foldedStep(chain())}>
                        <Show when={compressWork()} fallback={view()}>
                        <div
                          classList={{ "chain-live": !!chain() }}
                          data-chain={chain() ? String(chain()!.at) : undefined}
                          data-chain-first={chain()?.first ? "" : undefined}
                          data-chain-last={chain()?.last ? "" : undefined}
                          data-chain-folded={foldedRun(chain()) ? "" : undefined}
                        >
                          <Show when={foldable(chain()) ? chain() : null}>{(run) => <ChainFold run={run()} />}</Show>
                          <Show when={!foldedRun(chain())}>{view()}</Show>
                        </div>
                        </Show>
                      </Show>
                      );
                    }}
                  </For>
                  <Show when={e().stoppedAt}>
                    <InfoRow>
                      Stopped by you at <code>{stampTime(e().stoppedAt!)}</code>.
                    </InfoRow>
                  </Show>
                  <Show when={e().error}>
                    {(err) => (
                      <>
                        <TurnError message={err()} />
                        {/* The failure's own row carries its own provider (its producing model) —
                            never a worker's, never the chat model of right now. */}
                        <Show when={props.limitPath}>{(p) => <SubagentLimitRow path={p()} message={err()} provider={rowProvider(e().model)} />}</Show>
                      </>
                    )}
                  </Show>
                </>
              )}
            </Match>
          </Switch>
          </div>
        )}
      </For>
      <Show when={hidden()?.calls || hidden()?.thinking ? hidden() : null}>
        {(h) => (
          <HiddenRows calls={h().calls} failed={h().failed} running={h().running} thinking={h().thinking}>
            {() => (
              <For each={hiddenBlocks()}>
                {(b) => <LiveBlockView block={b} live={props.live} author={props.author} streaming={hiddenStreams(b)} showHead={false} />}
              </For>
            )}
          </HiddenRows>
        )}
      </Show>
    </>
  );
}

/** A view's rows above its list (lib/older-rows), as its thread reads them. */
export interface OlderRowsApi {
  /** How many; null until the view's hello or snapshot says. */
  left(): number | null;
  /** The next chunk above, unless one is on its way. */
  more(): void;
  /** The rows down to a jump's target, in one request. */
  load(target: RowTarget): Promise<"here" | "missing" | "stale">;
  /** A scroll-up fetch is taking long enough to say so. */
  slow(): boolean;
}

/** Within this many viewports of the top of the rows held, the next older chunk is fetched. */
const NEAR_TOP_VIEWS = 2;

/** What a transcript offers the rows inside it (tail-first rendering, lib/tail-render). */
interface ScrollerApi {
  /** The transcript element: jumps find its rows through it (lib/jump `registerRows`). */
  root(): HTMLElement;
  /** Runs `build`, which adds rows above the ones on screen, and keeps the view where it was:
      at the bottom while following, else the same distance from the end. With `hold`, the row at
      the top of the view also stays put while the rows just built are first drawn; while a jump's
      row is held (ThreadScroller `land`), that row stays put instead, with or without it. */
  prepend(build: () => void, hold?: boolean): void;
}
const ScrollerContext = createContext<ScrollerApi | null>(null);
/** The characters a message line held in the last transcript measured (`--entry-cols-measured`). */
let lastCols = 0;

/** Runs `fn` once the browser is idle (at the latest after a short wait); returns a cancel. */
function whenIdle(fn: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(fn, { timeout: 100 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 16);
  return () => clearTimeout(id);
}

/** Within this distance of the end, the transcript follows new content. */
const FOLLOW_PX = 80;
/** A jump's row is held until it has needed no correction for this many frames in a row... */
const JUMP_QUIET_FRAMES = 20;
/** ...and for this long at most, unless rows are built above it meanwhile. */
const JUMP_HOLD_MS = 2000;
/** How long the row at the top of the view is held after rows were built above it (ThreadScroller
    `holdView`): they are drawn within a few frames. */
const HOLD_MS = 600;
/** How long after the reader's last input, or the last scroll that was theirs, a scroll is still
    theirs: a wheel's or a key's smooth scroll and a fling go on in scroll events a frame apart. */
const INPUT_MS = 300;
/** Sent on a transcript right before its streamed rows give way to the saved rows of the same turn. */
const SWAP_EVENT = "sova-swap";

/**
 * Call inside the update that swaps a turn's streamed rows for its saved rows, before it lands (the
 * page still holds the streamed rows): a view not following keeps its place through the swap
 * (§chat.transcript/turn-end-keeps-reader).
 */
export function holdReaderAcrossSwap(path: string): void {
  transcriptRoot(path)?.dispatchEvent(new Event(SWAP_EVENT));
}

/**
 * The transcript scroll region. Follows new content while the user is near the bottom; scrolling
 * up pauses following and offers "Jump to Latest · N new". Changing `resume` forces following
 * (e.g. after the user sends). `banner` sticks to the top of the region.
 */
export function ThreadScroller(props: {
  children: JSX.Element;
  banner?: JSX.Element;
  /** Number of rendered entries, for the "N new" count. */
  count: number;
  resume?: number;
  busy?: boolean;
  /** The session shown here: what a jump from the outline, Skills or Timeline looks up. */
  path?: string;
  /** Where to open, for rows kept from the last visit (lib/transcript-cache); the end otherwise. */
  restore?: ScrollSpot | null;
  /** Told where the transcript was when it goes away, and whenever a scroll comes to rest. */
  onSpot?(spot: ScrollSpot): void;
  /** This visit's rows have come (its hello or snapshot): until then, rows kept from the last visit. */
  current?: boolean;
  /** The thread shows a new session's empty state: there is no latest to jump to. */
  empty?: boolean;
}) {
  const paneId = usePaneId();
  let el!: HTMLElement;
  let follow = true;
  const [away, setAway] = createSignal<number | null>(null); // count when the user scrolled away
  // Resolve once: reading a JSX prop twice would build its DOM twice.
  const banner = children(() => props.banner);

  /** How far the view was from the end when last read: 0 right after a scroll to the bottom. */
  let lastGap = 0;
  const toBottom = () => {
    endJumpHold();
    el.scrollTop = el.scrollHeight;
    scrolledTop = el.scrollTop;
    lastGap = 0;
    seeEnd();
  };
  /** The scroll height a view not following is measured against for coming back to the end: the
      rows as they stood. It rises at once and drops only once the lower height has stood HOLD_MS,
      so rows first drawn shorter than they are (a turn's saved rows at their estimate, for a frame)
      never bring the end to the reader. */
  let endAt = 0;
  /** When a height lower than `endAt` was first seen, since when it has stood. */
  let lowSince: number | null = null;
  const seeEnd = () => {
    const h = el.scrollHeight;
    const now = performance.now();
    if (h < endAt && (lowSince === null || now - lowSince <= HOLD_MS)) {
      lowSince ??= now;
      return;
    }
    endAt = h;
    lowSince = null;
  };
  const resumeFollowing = () => {
    follow = true;
    setAway(null);
    toBottom();
  };
  // A new session's empty state reads from its top (the title, then the profile cards), never its
  // end, and follows nothing; the first row to land puts the view back to following the end.
  createEffect(
    on(
      () => !!props.empty,
      (empty, was) => {
        if (empty)
          queueMicrotask(() => {
            if (!el || !props.empty) return;
            follow = false;
            el.scrollTop = 0;
            scrolledTop = 0;
            lastGap = el.scrollHeight - el.clientHeight;
          });
        else if (was) resumeFollowing();
      },
    ),
  );
  /**
   * The row at the top of the view, held for a moment after rows were built above it. Rows built
   * near the view are first drawn a few frames later, at their real height instead of their
   * estimate, and the browser's scroll anchoring doesn't always make up for rows it only just got
   * (Chrome 154, rows built a viewport above the view): the view then moved by the difference.
   * Corrected when the thread's size changes, after layout and before paint; the user's own
   * scroll, or a jump, ends it. A jump's row is held the same way (`land`, its `jump` state).
   */
  let held: { row: HTMLElement; offset: number; until: number; at: number; swap?: true; jump?: { quiet: number; moved: boolean } } | null = null;
  const offsetOf = (row: HTMLElement) => row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  const holdView = () => {
    const s = spot();
    const row = s && !s.follow ? el.querySelector<HTMLElement>(`.thread > .entry[data-entry="${CSS.escape(s.rowId)}"]`) : null;
    held = row ? { row, offset: offsetOf(row), until: performance.now() + HOLD_MS, at: el.scrollTop } : null;
  };
  /**
   * A turn's streamed rows are about to give way to its saved rows (SWAP_EVENT). The row the view
   * is anchored on may be one of those leaving, and the saved rows are first drawn at an estimate,
   * which can clamp the view: a view not following holds the last row that stays, the one at its
   * top or the last one above it. The rows replaced below that one come back at about the height
   * they had. Every scroll meanwhile may be the browser's (a clamp, its anchoring), so only the
   * reader's input after the swap ends this hold (`onInput`).
   */
  const holdAcrossSwap = () => {
    if (follow) return;
    const top = el.getBoundingClientRect().top;
    const rows = el.querySelectorAll<HTMLElement>(".thread > .entry");
    for (let i = rows.length - 1; i >= 0; i--) {
      const box = rows[i]!.getBoundingClientRect();
      if (box.height === 0 || box.top > top) continue;
      held = { row: rows[i]!, offset: box.top - top, until: performance.now() + HOLD_MS, at: el.scrollTop, swap: true };
      // Corrected in the frame the swap lands too, should the thread's size come out the same.
      requestAnimationFrame(keepHeld);
      return;
    }
  };
  const keepHeld = () => {
    if (!held) return;
    if (performance.now() > held.until || !held.row.isConnected) {
      held = null;
      return;
    }
    const delta = offsetOf(held.row) - held.offset;
    if (Math.abs(delta) >= 1) {
      el.scrollTop += delta;
      if (held.jump) held.jump.moved = true;
    }
    held.at = el.scrollTop;
  };
  /**
   * A jump (lib/jump JUMP_EVENT) lands at once, with no smooth scroll: following stops, as a scroll
   * up would, and the row's center goes to the view's center (a row taller than the view fills it;
   * one the view can't center, at the top or the end of the rows, goes as near as it can). The
   * rows around it are then first drawn at their real heights, not their estimates, above it too,
   * so it is held where it landed: corrected when the thread's size changes (after layout, before
   * paint) and once a frame, until it has needed no correction for JUMP_QUIET_FRAMES frames with no
   * image above it on screen still loading (`loadingAbove`), or JUMP_HOLD_MS have passed, or it
   * leaves the page. Rows built above it meanwhile keep it held (`prepend`). The reader's own input
   * ends it (`onInput`), and so does a scroll of theirs no input announced (`onScroll`), or anything
   * else placing the view (`endJumpHold`: the end, a kept spot, the last row read; a swap's hold or
   * another jump replaces it).
   */
  const land = (target: HTMLElement) => {
    if (follow) {
      follow = false;
      setAway(props.count);
    }
    const view = el.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    el.scrollTop += (box.top + box.bottom) / 2 - (view.top + view.bottom) / 2;
    lastGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const row = target.closest<HTMLElement>(".thread > .entry") ?? target;
    const hold = { row, offset: offsetOf(row), until: performance.now() + JUMP_HOLD_MS, at: el.scrollTop, jump: { quiet: 0, moved: false } };
    held = hold;
    const frame = () => {
      if (held !== hold) return;
      keepHeld();
      if (held !== hold) return;
      hold.jump.quiet = hold.jump.moved || loadingAbove(row) ? 0 : hold.jump.quiet + 1;
      hold.jump.moved = false;
      if (hold.jump.quiet >= JUMP_QUIET_FRAMES) held = null;
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
  /** An image still loading in the rows on screen above `row`: it may make them taller when it
      does, so nothing having moved yet doesn't mean nothing will. Rows off screen are never looked
      inside (measuring inside a skipped row lays it out). */
  const loadingAbove = (row: Element) => {
    const top = el.getBoundingClientRect().top;
    for (let r = row.previousElementSibling; r && r.getBoundingClientRect().bottom > top; r = r.previousElementSibling)
      for (const img of r.querySelectorAll("img")) if (!img.complete) return true;
    return false;
  };
  /** Something else places the view: a jump's row is no longer held there. */
  const endJumpHold = () => {
    if (held?.jump) held = null;
  };
  /** The view's width at the last scroll event. */
  let scrolledWidth = 0;
  /** Where the view was at the last scroll event, or the last scroll to the end. */
  let scrolledTop = 0;
  const onScroll = () => {
    const up = el.scrollTop < scrolledTop;
    scrolledTop = el.scrollTop;
    // A scroll right after the reader's input, or right after one of theirs, is theirs too.
    const reader = readerInput();
    if (reader) readerAt = performance.now();
    // A scroll that moved the held row is the user's (the browser's anchoring keeps it in place);
    // not across a swap (`holdAcrossSwap`): their input ends that. A jump's row (`land`) moves while
    // the rows around it are first drawn, so only a scroll that moved it by just as much as the view
    // moved (the view scrolled, the rows stayed) ends that one.
    if (held && el.scrollTop !== held.at) {
      const moved = offsetOf(held.row) - held.offset;
      const theirs = held.jump ? Math.abs(moved + el.scrollTop - held.at) < 1 : !held.swap && Math.abs(moved) >= 1;
      if (theirs) held = null;
      else held.at = el.scrollTop;
    }
    lastGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    seeEnd();
    // The view narrowing or widening reflows the rows, and scroll anchoring's correction can come
    // before `viewResized` and `measured` put a following view back at the end: not scrolling away.
    const width = el.clientWidth;
    let reflowed = false;
    if (width !== scrolledWidth) {
      const first = scrolledWidth === 0;
      scrolledWidth = width;
      if (!first && follow) return;
      reflowed = !first;
    }
    const near = lastGap < FOLLOW_PX;
    // A jump never brings following back, even one landing at the end right after a press in the
    // transcript (a card reference), which would otherwise read as the reader's scroll.
    if (near && held?.jump) return;
    // Only the view moving up stops following. Content landing below a following view (a queued
    // message drawn again after a switch back) lands in a task before the frame that settles it,
    // and the browser's scroll anchoring can move the view down meanwhile: that event finds the
    // end far below, and is not the reader leaving it. Back to the end instead. A disclosure the
    // reader just opened is theirs to look at, so following is re-read from where the view is.
    if (follow && !near && !up && !toggled) return settleSoon();
    if (near === follow) return;
    // Following comes back only by the reader's hand (§chat.transcript/turn-end-keeps-reader): their
    // own scroll reaching the end of the rows as they stood (`endAt`), a disclosure they
    // toggled, or the view resized. The browser taking a view that isn't following to the end
    // (clamped as rows below got shorter or left, or its anchoring adding rows inserted above an
    // anchor that then left) is not the reader coming back, even mid-scroll: the view stays where
    // it landed, with Jump to Latest.
    const reached = endAt - el.scrollTop - el.clientHeight < FOLLOW_PX;
    if (near && !(reader && reached) && !toggled && !reflowed) return;
    follow = near;
    setAway(near ? null : props.count);
  };

  /**
   * A disclosure the user just opened or closed (a tool card, thinking, a report): what it adds or
   * removes is theirs to look at, so the view stays where it is and following is re-read from the
   * new position instead of pulling the bottom back into view. Marked at the summary's click, which
   * comes before the open state changes (the `toggle` event is queued and may come after the frame
   * that lays the growth out), and again at `toggle`, where a lazy body is built; held for two
   * frames after the later of the two. Only a click starts it (a key on a summary clicks it too),
   * and only the clicked disclosure's `toggle` marks it again: one drawn open (an alignment's
   * approach) fires `toggle` as its row is built, and that is new content, not the user's.
   */
  let toggled = false;
  let toggleFrame = 0;
  const markToggle = () => {
    toggled = true;
    cancelAnimationFrame(toggleFrame);
    toggleFrame = requestAnimationFrame(() => (toggleFrame = requestAnimationFrame(() => (toggled = false))));
  };
  /** The disclosure whose summary was clicked last: its `toggle`, whenever it comes, is the reader's. */
  let clicked: Element | null = null;
  const onClick = (e: MouseEvent) => {
    const summary = (e.target as Element | null)?.closest?.("summary");
    if (!summary) return;
    clicked = summary.parentElement;
    markToggle();
  };
  const onToggle = (e: Event) => {
    if (e.target !== clicked) return;
    clicked = null;
    markToggle();
  };
  onCleanup(() => cancelAnimationFrame(toggleFrame));
  /**
   * The last row read, for a view left at the end (`props.restore`), until this visit's rows have
   * come: rows that land after it were added while the reader was away, so the view stops on it
   * with "N new" instead of following past them. Dropped once the reader scrolls or touches the
   * transcript, which then goes where they take it.
   */
  let readTo = props.restore?.follow && props.restore.lastRow ? props.restore : null;
  /** The reader has scrolled or touched the transcript since it opened. */
  let touched = false;
  const onTouch = () => {
    readTo = null;
    touched = true;
  };
  /** When the reader last gave the transcript input that can scroll it, or last scrolled it
      (`onScroll` chains a smooth scroll's or a fling's events), and whether a press on it (a
      scrollbar drag) is still held: a scroll then is theirs. */
  let readerAt = -Infinity;
  let pressing = false;
  const readerInput = () => pressing || performance.now() - readerAt < INPUT_MS;
  const onInput = (e: Event) => {
    readerAt = performance.now();
    // The reader takes the view from here, from where they were: the swap's first frame may not
    // have been drawn (or corrected) yet, and their input is meant for the view they saw.
    if (held?.swap) {
      keepHeld();
      held = null;
    }
    // A jump's row is corrected before each paint, so the view they saw is where it is; a
    // correction now would undo the scroll their input may already have started.
    endJumpHold();
    if (e.type === "pointerdown") pressing = true;
    // A wheel down at the end (of the rows as they stood) scrolls nothing, so no scroll event says
    // the reader is back there.
    if (e.type !== "wheel" || (e as WheelEvent).deltaY <= 0 || follow) return;
    seeEnd();
    if (endAt - el.scrollTop - el.clientHeight < FOLLOW_PX) {
      follow = true;
      setAway(null);
    }
  };
  const onRelease = () => {
    if (!pressing) return;
    pressing = false;
    readerAt = performance.now();
  };
  window.addEventListener("pointerup", onRelease, true);
  window.addEventListener("pointercancel", onRelease, true);
  onCleanup(() => {
    window.removeEventListener("pointerup", onRelease, true);
    window.removeEventListener("pointercancel", onRelease, true);
  });
  const rowOf = (id: string) => el.querySelector<HTMLElement>(`.thread > .entry[data-entry="${CSS.escape(id)}"]`);
  const drawn = (row: Element) => row.getBoundingClientRect().height > 0;
  /** The last row read, by its row id or by the entry id a live row knew (an assistant message's
      rows are `<entry id>:<block>`): its last drawn row. */
  const lastRowOf = (id: string): HTMLElement | null => {
    const exact = rowOf(id);
    if (exact) return exact;
    const entry = entryIdOf(id);
    const rows = [...el.querySelectorAll<HTMLElement>(`.thread > .entry:is([data-entry="${CSS.escape(entry)}"], [data-entry^="${CSS.escape(entry)}:"])`)];
    return rows.filter(drawn).at(-1) ?? rows.at(-1) ?? null;
  };
  const textOf = (row: Element) => (row.querySelector(".message-user .message-text")?.textContent ?? "").replace(/\s+/g, " ").trim();
  /**
   * The row the reader had read to (`readTo`): its last row read, then the live messages drawn
   * below it, now rows of the transcript. First the ones with no entry yet when the reader left
   * (a reply still streaming), the entries right after it; then each queued message, the next
   * prompt when its text is the same (it was delivered while away; one still queued is a live row
   * again, below every row).
   */
  const readRow = (spot: NonNullable<typeof readTo>): HTMLElement | null => {
    let row = spot.lastRow ? lastRowOf(spot.lastRow) : null;
    if (!row) return null;
    const groups: HTMLElement[][] = [];
    for (let next = row.nextElementSibling; next; next = next.nextElementSibling) {
      if (!(next instanceof HTMLElement) || !next.matches(".entry") || !drawn(next)) continue;
      const last = groups.at(-1);
      if (last && entryIdOf(last[0]!.dataset.entry ?? "") === entryIdOf(next.dataset.entry ?? "")) last.push(next);
      else groups.push([next]);
    }
    let i = 0;
    for (let n = spot.unnamed ?? 0; n > 0 && i < groups.length; n--) row = groups[i++]!.at(-1)!;
    for (const text of spot.queued ?? []) {
      const group = groups[i];
      if (group && textOf(group[0]!) === text.replace(/\s+/g, " ").trim()) row = groups[i++]!.at(-1)!;
    }
    return row;
  };
  /** The rows drawn below `row`: what "N new" counts after the last row read. */
  const rowsAfter = (row: Element) => {
    let n = 0;
    for (let next = row.nextElementSibling; next; next = next.nextElementSibling) if (next.matches(".entry") && next.getBoundingClientRect().height > 0) n++;
    return n;
  };
  /** The row the view stopped on, until this visit's rows have come. Rows kept from the last visit
      count whole, this visit's from its hello's first row (`props.count`), so "N new" is counted
      again then. Meanwhile it is still the last row read: a view replaced before then (a chat
      that turns out to be written elsewhere opens as a watch) stops on it again. */
  let heldRow: string | null = null;
  /** The last row read's bottom at the bottom of the view, unless the reader has moved it since. */
  const placeAtRead = (row: HTMLElement) => {
    if (touched || !row.isConnected) return;
    endJumpHold();
    el.scrollTop += row.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
    lastGap = el.scrollHeight - el.scrollTop - el.clientHeight;
  };
  /** With rows below the last row read: its bottom at the bottom of the view, not following. Not
      when they're short enough that the view would still be within FOLLOW_PX of the end. */
  const holdAtRead = (): boolean => {
    if (!readTo) return false;
    const row = readRow(readTo);
    if (!row) return false;
    const added = rowsAfter(row);
    if (!added) return false;
    const id = row.dataset.entry ?? "";
    readTo = null;
    const top = el.scrollTop + row.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
    if (el.scrollHeight - top - el.clientHeight < FOLLOW_PX) return false;
    endJumpHold();
    el.scrollTop = top;
    lastGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    follow = false;
    heldRow = id;
    setAway(Math.max(0, props.count - added));
    // The rows around it are drawn at their real heights in the next frame: place it again then.
    requestAnimationFrame(() => requestAnimationFrame(() => placeAtRead(row)));
    return true;
  };
  createEffect(
    on(
      () => props.current,
      (current) => {
        if (!current || !(readTo || heldRow)) return;
        requestAnimationFrame(() => {
          holdAtRead();
          readTo = null;
          const row = heldRow && !follow ? rowOf(heldRow) : null;
          if (row) {
            setAway(Math.max(0, props.count - rowsAfter(row)));
            placeAtRead(row);
          }
          heldRow = null;
        });
      },
    ),
  );

  /** Content was added or changed: back to the bottom while following. */
  const settle = () => {
    // Before following: a scroll event between the rows landing and this frame may have read the
    // view they grew as the reader's own.
    if (holdAtRead()) return;
    if (!follow) return;
    if (toggled) return onScroll();
    toBottom();
  };
  // A mutation's settle waits for the frame (still before its paint), so the write to `scrollTop`
  // no longer forces a layout of the whole thread inside the task that changed it, once per change.
  let settleFrame = 0;
  const settleSoon = () => {
    if (settleFrame) return;
    settleFrame = requestAnimationFrame(() => {
      settleFrame = 0;
      settle();
    });
  };
  const observer = new MutationObserver(settleSoon);
  onCleanup(() => {
    observer.disconnect();
    cancelAnimationFrame(settleFrame);
  });
  // Rows change height with no mutation too: an image decoding, a row first drawn at its real
  // height instead of its estimate (content-visibility, app.css). Only a view that sat at the end
  // is put back there: rows drawn above a view scrolling up (a smooth scroll's first frames are
  // still "following") must not pull it back down.
  const resized = typeof ResizeObserver === "function" ? new ResizeObserver(() => (keepHeld(), seeEnd(), lastGap <= 2 && settle())) : null;
  onCleanup(() => resized?.disconnect());
  // The view itself changing height (the composer's status row appearing, a keyboard) never moves
  // a scroll under way, so while following it always goes back to the end. A scroll event can read
  // the new, shorter view before this runs, so it can't wait for `lastGap`.
  const viewResized = typeof ResizeObserver === "function" ? new ResizeObserver(() => follow && !toggled && toBottom()) : null;
  onCleanup(() => viewResized?.disconnect());
  // The characters a message line holds, for the rows' estimates (lib/tail-render `lineCols`), from
  // a probe as wide as a message: set only when it changes, since every row reads it. A new
  // transcript starts from the last one's, so a switch at the same width lays its rows out once.
  // The rows not yet drawn change height with it, after `viewResized` has put a following view
  // back at the end, so it goes back there again; scroll anchoring keeps any other view in place.
  let cols = lastCols;
  const measured =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(([entry]) => {
          const width = entry?.contentRect.width ?? 0;
          if (width <= 0 || lineCols(width) === cols) return;
          cols = lastCols = lineCols(width);
          el.style.setProperty("--entry-cols-measured", String(cols));
          if (follow && !toggled) toBottom();
        })
      : null;
  onCleanup(() => measured?.disconnect());
  const api: ScrollerApi = {
    root: () => el,
    prepend(build, hold) {
      const fromEnd = el.scrollHeight - el.scrollTop;
      build();
      // The rows just added are above the view: not new content to follow. The view keeps its
      // distance from the end, which at the bottom is the bottom. The browser's own scroll
      // anchoring usually has done this already; then nothing is written, and a scroll under way
      // (a jump) carries on.
      observer.takeRecords();
      const want = el.scrollHeight - fromEnd;
      if (Math.abs(el.scrollTop - want) >= 1) el.scrollTop = want;
      if (held?.jump) {
        // A jump's row is held (`land`): it stays where it is, through these rows' first drawing too.
        keepHeld();
        if (held?.jump) {
          held.until = Math.max(held.until, performance.now() + HOLD_MS);
          held.jump.quiet = 0;
        }
      } else if (hold && !follow) holdView();
    },
  };
  createEffect(on(() => props.resume, resumeFollowing, { defer: true }));

  /**
   * Where the view is: following, or the first row reaching into the view and how far its top is
   * below the view's top. Measured on the rows' own boxes, never inside them: a row off screen is
   * skipped (content-visibility), and measuring inside one lays it out.
   */
  const spot = (): ScrollSpot | null => {
    if (!el?.isConnected) return null;
    if (follow) {
      // The last row drawn, a live one included (LiveEntries): one whose entry is known by that
      // entry's id; the live messages below it with none yet are counted, the queued ones by text.
      const rows = el.querySelectorAll<HTMLElement>(".thread > :is(.entry, .live-entry)");
      let unnamed = 0;
      const queued: string[] = [];
      let lastRow: string | undefined;
      for (let i = rows.length - 1; i >= 0 && lastRow === undefined; i--) {
        const row = rows[i]!;
        if (row.matches(".entry")) {
          if (drawn(row)) lastRow = row.dataset.entry;
          continue;
        }
        // Laid out as its contents: drawn when anything in it is.
        if (![...row.querySelectorAll("*")].some(drawn)) continue;
        if (row.dataset.entryRead) lastRow = row.dataset.entryRead;
        else if (row.dataset.queued !== undefined) queued.unshift(textOf(row));
        else unnamed++;
      }
      if (lastRow === undefined) return { follow: true };
      return { follow: true, lastRow, ...(unnamed ? { unnamed } : {}), ...(queued.length ? { queued } : {}) };
    }
    const top = el.getBoundingClientRect().top;
    for (const entry of el.querySelectorAll<HTMLElement>(".thread > .entry")) {
      const box = entry.getBoundingClientRect();
      if (box.height === 0) continue; // draws nothing
      if (box.bottom > top) return { follow: false, rowId: entry.dataset.entry ?? "", offset: box.top - top };
    }
    return null;
  };
  let spotTimer: ReturnType<typeof setTimeout> | undefined;
  const reportSpot = () => {
    const s = heldRow && !touched ? { follow: true as const, lastRow: heldRow } : spot();
    if (s) props.onSpot?.(s);
  };
  onCleanup(() => {
    clearTimeout(spotTimer);
    reportSpot();
  });
  /** Opens where `props.restore` says: on its row, at its offset, not following. False when that
      row isn't in this transcript anymore (the caller goes to the end instead). */
  const restoreSpot = (): boolean => {
    const r = props.restore;
    if (!r || r.follow || !r.rowId) return false;
    const place = () => {
      const entry = ensureRendered(r.rowId, el)?.closest(".entry");
      if (!entry) return false;
      endJumpHold();
      el.scrollTop += entry.getBoundingClientRect().top - el.getBoundingClientRect().top - r.offset;
      lastGap = el.scrollHeight - el.scrollTop - el.clientHeight;
      return true;
    };
    const settleThere = () => {
      follow = false;
      setAway(props.count);
      // The rows around it are drawn at their real heights in the next frame: place it again then.
      requestAnimationFrame(() => requestAnimationFrame(place));
    };
    if (place()) {
      settleThere();
      return true;
    }
    // A row the list doesn't hold (kept rows dropped by the hello): fetched down to it
    // (lib/older-rows), and placed then, unless the view has been moved from the end meanwhile.
    const load = loadRow(el, { entry: r.rowId });
    if (load)
      void load.then((x) => {
        if (x !== "here" || !follow || lastGap > 2) return;
        queueMicrotask(() => place() && settleThere());
      });
    return false;
  };

  const newCount = () => {
    const a = away();
    return a === null ? 0 : Math.max(0, props.count - a);
  };

  return (
    <div class="transcript-wrap">
      <section
        class="transcript pane"
        id={paneId("transcript")}
        aria-label="Transcript"
        aria-busy={props.busy ? "true" : undefined}
        tabindex="0"
        ref={(node) => {
          el = node;
          if (cols) node.style.setProperty("--entry-cols-measured", String(cols));
          observer.observe(node, { childList: true, subtree: true, characterData: true });
          node.addEventListener("click", onClick, true);
          node.addEventListener("toggle", onToggle, true);
          viewResized?.observe(node);
          node.addEventListener(SWAP_EVENT, holdAcrossSwap);
          // A jump (lib/jump) lands here: cancelled, to tell it so.
          node.addEventListener(JUMP_EVENT, (e) => {
            const row = (e as CustomEvent<unknown>).detail;
            if (!(row instanceof HTMLElement) || !node.contains(row)) return;
            e.preventDefault();
            land(row);
          });
          if (props.path) {
            const path = props.path;
            registerTranscript(path, node);
            onCleanup(() => registerTranscript(path, null));
          }
          for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) node.addEventListener(type, onTouch, { passive: true });
          for (const type of ["wheel", "touchstart", "touchmove", "touchend", "pointerdown", "keydown"]) node.addEventListener(type, onInput, { passive: true });
          // Kept rows refetched in the background (lib/recent-preload) may already hold rows added
          // after the last row read.
          queueMicrotask(() => restoreSpot() || (toBottom(), holdAtRead()));
        }}
        onScroll={() => {
          onScroll();
          clearTimeout(spotTimer);
          spotTimer = setTimeout(reportSpot, 150);
        }}
      >
        <Show when={banner()}>
          <div class="transcript-banner">{banner()}</div>
        </Show>
        <div class="transcript-inner">
          <div class="thread" ref={(thread) => resized?.observe(thread)}>
            <ScrollerContext.Provider value={api}>{props.children}</ScrollerContext.Provider>
          </div>
          <div class="entry-measure" aria-hidden="true" ref={(probe) => measured?.observe(probe)} />
        </div>
      </section>
      {/* Always mounted, shown by attribute: inserting it relaid out the whole transcript at the
          first scroll up (base.css `.jump-latest`). */}
      <button type="button" class="button jump-latest" data-shown={away() !== null && !props.empty ? "" : undefined} onClick={resumeFollowing}>
        <Icon name="chevron-down" small />
        {newCount() > 0 ? `Jump to Latest · ${newCount()} new` : "Jump to Latest"}
      </button>
    </div>
  );
}

/** Placeholder shaped like what lands; nothing shows for the first 300ms. */
export function TranscriptSkeleton() {
  const [show, setShow] = createSignal(false);
  const t = setTimeout(() => setShow(true), 300);
  onCleanup(() => clearTimeout(t));
  return (
    <Show when={show()}>
      <div class="skeleton skeleton-bubble" />
      <div class="stack-2">
        <div class="skeleton skeleton-title" />
        <div class="skeleton skeleton-line skeleton-w92" />
        <div class="skeleton skeleton-line skeleton-w78" />
        <div class="skeleton skeleton-line skeleton-w60" />
      </div>
      <div class="skeleton skeleton-row skeleton-w60" />
    </Show>
  );
}

