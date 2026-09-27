import { children, createContext, createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, useContext, type JSX } from "solid-js";
import type { TmpAttachment, TranscriptItem } from "../../shared/protocol";
import type { BatonMark } from "../../shared/baton";
import { wrapupRowIds } from "../lib/wrapup-rows";
import type { LiveBlock, LiveEntry, LiveState, LiveUserState } from "../lib/live";
import { agoTime, clockTime, prettyJson, shortModel, stampTime, thousands, tildePath } from "../lib/format";
import { useMinuteNow } from "../lib/minute-clock";
import { isObj, str, timestampOf, toolCallArgs, toolResultView } from "../lib/message";
import { stripPastedPaths } from "../lib/path-attachments";
import { home } from "../lib/ui-state";
import { ensureRendered, entryIdOf, JUMP_EVENT, registerRows, registerTranscript } from "../lib/jump";
import type { ScrollSpot } from "../lib/transcript-cache";
import { carriedStart, chunkStart, FIRST_CHUNK, initialStart, nextChunk, rowEstimate, rowIndexFor } from "../lib/tail-render";
import { usePaneId } from "../lib/pane-scope";
import { isHiddenBlock, liveHiddenCounts, splitHidden, thinkingHiddenLabel, toolsHiddenLabel } from "../lib/hidden-rows";
import { isChangeRow } from "../lib/change-rows";
import { isTurnStart } from "../lib/turn";
import { parseWakeNudge } from "../../shared/wake";
import { ImageStrip } from "./ImageStrip";
import { PathAttachment, PathText } from "./PathAttachment";
import { ReportRow } from "./ReportRow";
import { TeamMessageCard } from "./TeamMessageCard";
import { AlignCard } from "./AlignCard";
import { ExplainCard } from "./ExplainCard";
import { alignOf, latestAlignId } from "../lib/align";
import { explainOf } from "../lib/explain";
import { Markdown } from "./Markdown";
import { ToolCard, type ToolStatus } from "./ToolCard";
import { WakeCard } from "./WakeCard";
import { WorktreeMergeCard } from "./WorktreeMergeCard";
import { Banner, Chip, Icon } from "./ui";
import { BriefRow, ConfirmCard, LinkCard, linkDetails, NavigateGo, OverseerChoiceRow } from "./OverseerCards";
import { confirmAnswer, confirmDetails, detailsOf, isBriefText } from "../lib/overseer";
import { MessageActions, type MessageActionItem } from "./MessageActions";
import { type MessageStrip, stripLabel, stripsByRow } from "../lib/message-actions";

/**
 * What a view hangs under each delivered message. The thread decides
 * WHERE a strip goes — once per entry, never once per rendered block — and the view decides what
 * it holds: a chat offers Copy · Fork · Rewind/Regenerate, a watch offers Copy with the others'
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
  images?: string[];
  attachments?: TmpAttachment[];
}) {
  const author = () => (props.overseer ? "Overseer" : (props.sender ?? AUTHOR[props.origin ?? "client"]));
  return (
    <article class="message message-user" aria-label={props.time ? `${author()}, ${stampTime(props.time)}` : author()}>
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
      <Show when={props.text}>
        <div class="message-body message-text">{props.text}</div>
      </Show>
    </article>
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
      <div class="disclosure-body">{props.text}</div>
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
function Compaction(props: { raw: Record<string, unknown> }) {
  const tokens = () => (typeof props.raw.tokensBefore === "number" ? props.raw.tokensBefore : null);
  const details = () => (isObj(props.raw.details) ? props.raw.details : {});
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
        <div class="compaction-summary">{str(props.raw.summary) ?? ""}</div>
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
  /** Index from which a call without a result may still be running; after the last user row by default. */
  openFrom?: number;
  /** The fork point of a fanout member: one drawn row, right after the entry the
      branch was taken from. Nothing is written to the file for it — the client draws it from the
      group's `seed`, and a member whose branch no longer holds that entry simply has no row. */
  fork?: ForkMarker;
  /** Per-message actions. Absent: no strips at all (a subagent transcript, the hidden-rows
      disclosure) — an action is about the chat you are in, not about every transcript on screen. */
  actions?: MessageActionsProvider;
  /** Build every row at once, even inside a transcript (the hidden-rows disclosure's own list). */
  whole?: boolean;
}) {
  /**
   * The items the thread may render: the settings-change rows are dropped before anything else,
   * so they can't appear even inside the hidden-rows disclosure. Every scan that speaks the
   * rendered rows' coordinates (the last-user/openFrom scan) runs on this same array.
   */
  // A baton wrap-up's turn reads profiles: folded behind its card unless asked for (lib/wrapup-rows).
  const [showWrapup, setShowWrapup] = createSignal(false);
  const wrapupRows = createMemo(() => (showWrapup() ? new Set<string>() : wrapupRowIds(props.items)));
  const renderable = createMemo(() => props.items.filter((it) => !isChangeRow(it) && !wrapupRows().has(it.id)));
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
  const calls = createMemo(() => {
    const ids = new Set<string>();
    for (const it of props.items) if (it.kind === "tool-call" && it.toolCallId) ids.add(it.toolCallId);
    return ids;
  });
  const latestAlign = createMemo(() => latestAlignId(props.items));
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
   * Which rendered row the fork marker follows: the LAST row belonging to the forked entry. An
   * assistant message renders one row per content block, all sharing an entry id, so matching on
   * the row id alone would draw the marker between a reply's own paragraphs — and matching the
   * first block would put it before the rest of the message it says is shared.
   */
  const forkAfter = createMemo(() => {
    const entryId = props.fork?.entryId;
    if (!entryId) return -1;
    let at = -1;
    rows().forEach((item, i) => {
      if (entryIdOf(item.id) === entryId) at = i;
    });
    return at;
  });
  /**
   * The forked entry's OWN timestamp, as the clock — the marker's "· 2:06 PM". It is the time of the
   * last shared moment (the row the marker follows), NOT the wall-clock of the fanout gesture:
   * the gesture time lives nowhere in `seed`, and adding a field for it
   * would put a write-time fact in marker data whose only reader is this decoration. Derived
   * from the row itself, so nothing is added and nothing can drift; omitted outright when the
   * row carries no timestamp (never guessed — the same rule as the marker's position).
   */
  const forkTime = createMemo(() => {
    const at = forkAfter();
    const iso = at >= 0 ? timestampOf(rows()[at]?.raw) : undefined;
    return iso ? clockTime(iso) : null;
  });

  /**
   * Tail-first (lib/tail-render): inside a transcript, the newest rows are built with the list and
   * the older ones prepended above them while the browser is idle, until all are built. The window
   * is held as the id of its first row, so an append or a refetch keeps what is already built.
   * Every index below is the row's index in `rows()`, never in the built slice.
   */
  const scroller = props.whole ? null : useContext(ScrollerContext);
  const rowAt = createMemo(() => {
    const at = new Map<string, number>();
    rows().forEach((r, i) => at.set(r.id, i));
    return at;
  });
  const idAt = (i: number) => (i <= 0 ? null : (rows()[i]?.id ?? null));
  const [firstId, setFirstId] = createSignal<string | null>(scroller ? idAt(initialStart(rows().length)) : null);
  const start = createMemo(() => (scroller ? carriedStart(firstId(), (id) => rowAt().get(id) ?? -1, rows().length) : 0));
  const built = createMemo(() => (start() === 0 ? rows() : rows().slice(start())));
  const indexOf = scroller ? createMemo(() => new Map(rows().map((r, i) => [r, i] as const))) : null;
  if (scroller) {
    const root = scroller.root();
    const ids = createMemo(() => rows().map((r) => (r.kind === "link" ? null : r.id)));
    /** Builds from row `i` down, keeping the view where it is. */
    const buildFrom = (i: number) => scroller.prepend(() => setFirstId(idAt(i)));
    let chunk = FIRST_CHUNK;
    let cancel: (() => void) | null = null;
    const step = () => {
      cancel = null;
      const s = start();
      if (s === 0) return;
      // A jump's smooth scroll is under way: moving the content now would stop it short.
      if (scroller.jumping()) return schedule();
      const next = chunkStart(s, chunk);
      const t0 = performance.now();
      buildFrom(next);
      chunk = nextChunk(chunk, performance.now() - t0);
      if (next > 0) schedule();
    };
    const schedule = () => {
      if (cancel) return;
      cancel = whenIdle(step);
    };
    createEffect(() => start() > 0 && schedule());
    onCleanup(() => cancel?.());
    registerRows(root, {
      has: (entryId) => rowIndexFor(ids(), entryId) >= 0,
      ensure: (entryId) => {
        const i = rowIndexFor(ids(), entryId);
        if (i < 0) return false;
        if (i < start()) buildFrom(i);
        return true;
      },
    });
    onCleanup(() => registerRows(root, null));
  }

  return (
    <>
      <For each={built()}>
        {(item, local) => {
          const index = indexOf ? () => indexOf().get(item) ?? local() : local;
          return (
          // A link message is a partner's, shown only in the Agents tab (§mesh.links/transcript):
          // no row at all here, not even the wrapper. It still counts as a turn start (above).
          item.kind === "link" ? (
            <Show when={forkAfter() === index() && props.fork}>{(fork) => <ForkRow fork={fork()} time={forkTime()} />}</Show>
          ) : (
          // The row's box: the outline strip finds an entry's row by it (Jump to Message), and the
          // estimate is its height until it is first drawn (content-visibility, app.css).
          <div class="entry" data-entry={item.id} style={{ "--entry-est": rowEstimate(item) }}>
            <Switch fallback={<Unknown raw={item.raw} />}>
              <Match when={item.kind === "user" && isBriefText(item.text)}>
                <BriefRow text={item.text ?? ""} time={timestampOf(item.raw)} />
              </Match>
              <Match when={item.kind === "user"}>
                <UserTurn
                  text={item.text ?? ""}
                  time={timestampOf(item.raw)}
                  overseer={overseerSent().has(entryIdOf(item.id))}
                  sender={batonSent().has(entryIdOf(item.id)) ? nameOf(batonSent().get(entryIdOf(item.id))!) : undefined}
                  images={item.images}
                  attachments={item.attachments}
                />
              </Match>
              {/* The sent marker draws nothing itself: it tags the row it names (above). */}
              <Match when={item.overseerMark?.kind === "sent"}>{null}</Match>
              <Match when={item.batonMark?.kind === "sent"}>{null}</Match>
              <Match when={item.batonMark && item.batonMark.kind !== "sent" && item.batonMark}>
                {(mark) => <BatonCard mark={mark() as Exclude<BatonMark, { kind: "sent" }>} name={nameOf} wrapupShown={showWrapup()} onWrapupToggle={() => setShowWrapup(!showWrapup())} />}
              </Match>
              <Match when={item.overseerMark?.kind === "dialog-answer" && item.overseerMark}>
                {(mark) => <OverseerChoiceRow title={mark().title} answer={mark().answer} />}
              </Match>
              <Match when={item.kind === "worktree-merge" && item.worktreeMerge}>
                {(merge) => <WorktreeMergeCard merge={merge()} time={timestampOf(item.raw)} />}
              </Match>
              <Match when={item.kind === "wake" && item.wake}>
                {(wake) => <WakeCard nudge={wake()} text={item.text ?? ""} time={timestampOf(item.raw)} />}
              </Match>
              <Match when={item.kind === "assistant-text"}>
                <AssistantText
                  text={item.text ?? ""}
                  author={shortModel(item.model) ?? props.author}
                  model={item.model}
                  time={timestampOf(item.raw)}
                  showHead={
                    rows()[index() - 1]?.kind !== "assistant-text" || rows()[index() - 1]?.model !== item.model
                  }
                  attachments={item.attachments}
                />
              </Match>
              <Match when={item.kind === "thinking"}>
                <Thinking text={item.text ?? ""} />
              </Match>
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
                {(team) => <TeamMessageCard report={item.report!} team={team()} time={timestampOf(item.raw)} attachments={item.attachments} />}
              </Match>
              <Match when={item.kind === "report" && item.report}>
                {(report) => <ReportRow report={report()} attachments={item.attachments} />}
              </Match>
              <Match when={item.kind === "info" && isObj(item.raw) && item.raw.type === "compaction" && item.raw}>
                {(raw) => <Compaction raw={raw()} />}
              </Match>
              <Match when={item.kind === "info"}>
                <InfoRow>
                  <PathText text={item.text ?? ""} attachments={item.attachments} />
                </InfoRow>
              </Match>
              <Match when={item.kind === "tool-call"}>
                {(() => {
                  const view = () => {
                    const r = item.toolCallId ? results().get(item.toolCallId) : undefined;
                    return r ? toolResultView(r.raw, r.text) : undefined;
                  };
                  const status = (): ToolStatus => {
                    const v = view();
                    if (v) return v.isError ? "error" : "done";
                    return props.streaming && index() >= openFrom() ? "running" : "none";
                  };
                  const resultDetails = () => {
                    const r = item.toolCallId ? results().get(item.toolCallId) : undefined;
                    return r ? detailsOf(r.raw) : undefined;
                  };
                  const confirm = () =>
                    item.text === "sova_confirm" && status() !== "error"
                      ? (confirmDetails(resultDetails()) ?? confirmDetails(toolCallArgs(item.raw, item.toolCallId)))
                      : null;
                  /** A made or ended link reads as a card naming its members (§app.overseer/links-tools);
                      running or failed, the plain tool card. */
                  const linked = () =>
                    (item.text === "sova_link" || item.text === "sova_unlink") && status() === "done" ? linkDetails(resultDetails()) : null;
                  return (
                    <Show
                      when={confirm()}
                      fallback={
                    <Show
                      when={linked()}
                      fallback={
                    <ToolCard
                      name={item.text ?? "tool"}
                      args={toolCallArgs(item.raw, item.toolCallId)}
                      status={status()}
                      output={view()?.output}
                      images={item.toolCallId ? results().get(item.toolCallId)?.images : undefined}
                      attachments={item.toolCallId ? results().get(item.toolCallId)?.attachments : undefined}
                      action={item.text === "sova_navigate" && status() === "done" ? <NavigateGo details={resultDetails()} /> : undefined}
                    />
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
                  );
                })()}
              </Match>
              <Match when={item.kind === "tool-result"}>
                {/* Paired results render inside their call's card; orphans get their own. */}
                <Show when={!item.toolCallId || !calls().has(item.toolCallId)}>
                  {(() => {
                    const view = toolResultView(item.raw, item.text);
                    return (
                      <ToolCard
                        name="result"
                        args={undefined}
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
            <Show when={strips().get(index())}>
              {(strip) => (
                <MessageActions
                  label={stripLabel(strip().role)}
                  align={strip().role === "user" ? "end" : "start"}
                  items={props.actions!.items(strip())}
                  note={props.actions!.note?.(strip().entryId) ?? null}
                />
              )}
            </Show>
            {/* After the entry, not inside its blocks: above this row is shared with the source,
                below it is this member's own. */}
            <Show when={forkAfter() === index() && props.fork}>{(fork) => <ForkRow fork={fork()} time={forkTime()} />}</Show>
          </div>
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
          const confirm = () => (b().name === "sova_confirm" && status() !== "error" ? confirmDetails(tool()?.details) ?? confirmDetails(b().args) : null);
          const linked = () => ((b().name === "sova_link" || b().name === "sova_unlink") && status() === "done" ? linkDetails(tool()?.details) : null);
          return (
            <Show
              when={confirm()}
              fallback={
                <Show
                  when={linked()}
                  fallback={
                    <ToolCard
                      name={b().name}
                      args={b().args ?? tool()?.args}
                      argsText={b().argsText}
                      status={status()}
                      output={tool()?.output}
                      images={tool()?.images}
                      action={b().name === "sova_navigate" && status() === "done" ? <NavigateGo details={tool()?.details} /> : undefined}
                    />
                  }
                >
                  {(d) => <LinkCard details={d()} ended={b().name === "sova_unlink"} />}
                </Show>
              }
            >
              {(details) => <ConfirmCard details={details()} answered={false} choice={null} pending={props.live.running} />}
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
  /** What a message of ours that hasn't been delivered offers — one Remove, from the chat. A row
      the server has already taken (`delivered`) is never asked: nothing can be recalled then, and
      a disabled Remove under every message you ever sent is an affordance that lies. */
  queueActions?: (row: { id?: string; state: LiveUserState; text: string }) => MessageActionItem[];
}) {
  const hide = () => ({ tools: !!props.hideTools, thinking: !!props.hideThinking });
  const shows = (b: LiveBlock | undefined) => !!b && !isHiddenBlock(b, hide());
  /** The nearest block before `i` that renders, so a hidden call doesn't repeat the author head. */
  const shownBefore = (blocks: LiveBlock[], i: number) => {
    for (let j = i - 1; j >= 0; j--) if (!isHiddenBlock(blocks[j], hide())) return blocks[j];
    return undefined;
  };
  const hiddenBlocks = () => props.live.entries.flatMap((e) => (e.kind === "assistant" ? e.blocks.filter((b) => isHiddenBlock(b, hide())) : []));
  /** A hidden thinking block still streams (live dot) until its own message is done. */
  const blockDone = (b: LiveBlock) => props.live.entries.some((e) => e.kind === "assistant" && e.done && e.blocks.includes(b));
  const hidden = createMemo(() => (props.hideTools || props.hideThinking ? liveHiddenCounts(props.live, hide()) : null));
  return (
    <>
      <For each={props.live.entries}>
        {(entry: LiveEntry) => (
          <Switch>
            <Match when={entry.kind === "user" && entry}>
              {(e) => (
                <Show
                  when={parseWakeNudge(e().text)}
                  fallback={
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
                  }
                >
                  {(wake) => <WakeCard nudge={wake()} text={e().text} />}
                </Show>
              )}
            </Match>
            <Match when={entry.kind === "assistant" && entry}>
              {(e) => (
                <>
                  <For each={e().blocks}>
                    {(block, i) => (
                      <Show when={shows(block)}>
                        <LiveBlockView
                          block={block}
                          live={props.live}
                          author={shortModel(e().model) ?? props.author}
                          model={e().model}
                          streaming={!e().done}
                          showHead={shownBefore(e().blocks, i())?.type !== "text"}
                        />
                      </Show>
                    )}
                  </For>
                  <Show when={e().stoppedAt}>
                    <InfoRow>
                      Stopped by you at <code>{stampTime(e().stoppedAt!)}</code>.
                    </InfoRow>
                  </Show>
                  <Show when={e().error}>
                    <TurnError message={e().error!} />
                  </Show>
                </>
              )}
            </Match>
          </Switch>
        )}
      </For>
      <Show when={hidden()?.calls || hidden()?.thinking ? hidden() : null}>
        {(h) => (
          <HiddenRows calls={h().calls} failed={h().failed} running={h().running} thinking={h().thinking}>
            {() => (
              <For each={hiddenBlocks()}>
                {(b) => <LiveBlockView block={b} live={props.live} author={props.author} streaming={!blockDone(b)} showHead={false} />}
              </For>
            )}
          </HiddenRows>
        )}
      </Show>
    </>
  );
}

/** What a transcript offers the rows inside it (tail-first rendering, lib/tail-render). */
interface ScrollerApi {
  /** The transcript element: jumps find its rows through it (lib/jump `registerRows`). */
  root(): HTMLElement;
  /** Runs `build`, which adds rows above the ones on screen, and keeps the view where it was:
      at the bottom while following, else the same distance from the end. */
  prepend(build: () => void): void;
  /** A jump's smooth scroll is under way. */
  jumping(): boolean;
}
const ScrollerContext = createContext<ScrollerApi | null>(null);

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
/** How long a jump's smooth scroll may take before a scroll near the bottom means following again. */
const JUMP_SETTLE_MS = 1000;

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
    el.scrollTop = el.scrollHeight;
    lastGap = 0;
  };
  const resumeFollowing = () => {
    follow = true;
    setAway(null);
    toBottom();
  };
  /** Until then a jump's own smooth scroll is under way: its first frames are still near the
      bottom, and must not read as the user coming back to follow it. */
  let jumpingUntil = 0;
  const onScroll = () => {
    lastGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = lastGap < FOLLOW_PX;
    if (near && performance.now() < jumpingUntil) return;
    if (near === follow) return;
    follow = near;
    setAway(near ? null : props.count);
  };

  /**
   * A disclosure the user just opened or closed (a tool card, thinking, a report): what it adds or
   * removes is theirs to look at, so the view stays where it is and following is re-read from the
   * new position instead of pulling the bottom back into view. Marked at the summary's click, which
   * comes before the open state changes (the `toggle` event is queued and may come after the frame
   * that lays the growth out), and again at `toggle`, where a lazy body is built; held for two
   * frames after the later of the two.
   */
  let toggled = false;
  let toggleFrame = 0;
  const markToggle = () => {
    toggled = true;
    cancelAnimationFrame(toggleFrame);
    toggleFrame = requestAnimationFrame(() => (toggleFrame = requestAnimationFrame(() => (toggled = false))));
  };
  const onClick = (e: MouseEvent) => {
    if ((e.target as Element | null)?.closest?.("summary")) markToggle();
  };
  onCleanup(() => cancelAnimationFrame(toggleFrame));
  /** Content was added or changed: back to the bottom while following. */
  const settle = () => {
    if (!follow) return;
    if (toggled) return onScroll();
    toBottom();
  };
  const observer = new MutationObserver(settle);
  onCleanup(() => observer.disconnect());
  // Rows change height with no mutation too: an image decoding, a row first drawn at its real
  // height instead of its estimate (content-visibility, app.css). Only a view that sat at the end
  // is put back there: rows drawn above a view scrolling up (a smooth scroll's first frames are
  // still "following") must not pull it back down.
  const resized = typeof ResizeObserver === "function" ? new ResizeObserver(() => lastGap <= 2 && settle()) : null;
  onCleanup(() => resized?.disconnect());
  // The view itself changing height (the composer's status row appearing, a keyboard) never moves
  // a scroll under way, so while following it always goes back to the end. A scroll event can read
  // the new, shorter view before this runs, so it can't wait for `lastGap`.
  const viewResized = typeof ResizeObserver === "function" ? new ResizeObserver(() => follow && !toggled && toBottom()) : null;
  onCleanup(() => viewResized?.disconnect());
  const api: ScrollerApi = {
    root: () => el,
    prepend(build) {
      const fromEnd = el.scrollHeight - el.scrollTop;
      build();
      // The rows just added are above the view: not new content to follow. The view keeps its
      // distance from the end, which at the bottom is the bottom. The browser's own scroll
      // anchoring usually has done this already; then nothing is written, and a scroll under way
      // (a jump, Align to Fork) carries on.
      observer.takeRecords();
      const want = el.scrollHeight - fromEnd;
      if (Math.abs(el.scrollTop - want) >= 1) el.scrollTop = want;
    },
    jumping: () => performance.now() < jumpingUntil,
  };
  createEffect(on(() => props.resume, resumeFollowing, { defer: true }));

  /**
   * Where the view is: following, or the first row whose drawn part reaches into the view and how
   * far its top is below the view's top. Rows that draw nothing (`display: none`) are skipped.
   */
  const spot = (): ScrollSpot | null => {
    if (!el?.isConnected) return null;
    if (follow) return { follow: true };
    const top = el.getBoundingClientRect().top;
    for (const entry of el.querySelectorAll<HTMLElement>(".thread > .entry")) {
      const row = entry.firstElementChild;
      if (!row || entry.getClientRects().length === 0) continue;
      const box = row.getBoundingClientRect();
      if (box.bottom > top) return { follow: false, rowId: entry.dataset.entry ?? "", offset: box.top - top };
    }
    return null;
  };
  let spotTimer: ReturnType<typeof setTimeout> | undefined;
  const reportSpot = () => {
    const s = spot();
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
      const row = ensureRendered(r.rowId, el);
      if (!row) return false;
      el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - r.offset;
      lastGap = el.scrollHeight - el.scrollTop - el.clientHeight;
      return true;
    };
    if (!place()) return false;
    follow = false;
    setAway(props.count);
    // The rows around it are drawn at their real heights in the next frame: place it again then.
    requestAnimationFrame(() => requestAnimationFrame(place));
    return true;
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
          observer.observe(node, { childList: true, subtree: true, characterData: true });
          // A jump (lib/jump) takes the view away from the bottom: stop following, as a scroll up would.
          node.addEventListener("click", onClick, true);
          node.addEventListener("toggle", markToggle, true);
          viewResized?.observe(node);
          node.addEventListener(JUMP_EVENT, () => {
            jumpingUntil = performance.now() + JUMP_SETTLE_MS;
            if (!follow) return;
            follow = false;
            setAway(props.count);
          });
          if (props.path) {
            const path = props.path;
            registerTranscript(path, node);
            onCleanup(() => registerTranscript(path, null));
          }
          queueMicrotask(() => restoreSpot() || toBottom());
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
        </div>
      </section>
      {/* Always mounted, shown by attribute: inserting it relaid out the whole transcript at the
          first scroll up (base.css `.jump-latest`). */}
      <button type="button" class="button jump-latest" data-shown={away() !== null ? "" : undefined} onClick={resumeFollowing}>
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

/** Where a fanout member was branched from. */
export interface ForkMarker {
  /** `seed.leafId`: the entry the fork was taken at. It exists with this id in the source AND in
      every member, because branching copies entries without re-minting their ids. */
  entryId: string;
  /** The source session's title, and its path while the file is still there. */
  title: string;
  path: string | null;
}

/**
 * The marker row: above it is shared with the source, below it is this member's own. A rendered
 * row, never an entry — nothing is written into the session file for it, because the fact it
 * states already lives in the group registry, and a written marker would need the write guards.
 * `time` is the forked entry's own clock (`2:06 PM`) (see `forkTime`), or null to omit the clock half —
 * an entry with no timestamp is not a thing to guess at.
 */
function ForkRow(props: { fork: ForkMarker; time: string | null }) {
  return (
    <p class="info-row fork-marker" role="note">
      <span class="icon icon-sm" style={{ "--icon": "url(/icons/branch.svg)" }} aria-hidden="true" />
      <span class="info-row-text">
        Forked from{" "}
        <Show
          when={props.fork.path}
          fallback={<span title="This session is no longer on disk.">{props.fork.title}</span>}
        >
          {(path) => <a href={`#/s/${encodeURIComponent(path())}`}>{props.fork.title}</a>}
        </Show>{" "}
        here{props.time ? ` · ${props.time}` : ""}
      </span>
    </p>
  );
}
