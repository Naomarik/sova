/**
 * THE list of transcript row kinds (§chat.transcript-cards/toolkit: "One list of card types"). Every
 * row the transcript draws is looked up here, in this order, and the first kind whose `match` gives
 * a value draws it, exactly as the old per-kind `<Match>` chain in Thread.tsx did (first match
 * wins). A kind is an id, what it matches, the height it reserves before it draws, where it draws
 * (`host`), where it stands (`placement`), and its view.
 *
 * Every kind has a `view`, drawn by the toolkit (components/TranscriptKind.tsx) inside its own
 * error box with Reload, or draws nothing (`drawsNothing`). Sova's own kinds are page views
 * (components/BuiltinKinds.tsx), moved onto the toolkit one at a time, smallest first, the
 * alignment card last (§chat.transcript-cards/built-ins). Thread.tsx never matches a row itself
 * and draws no kind of its own (transcript-kinds-rule.test.ts).
 *
 * A turn still streaming is drawn from the same list: a kind that draws before its row settles has a
 * `live` form, matched against the run's own pieces (`LiveInput`: a message going in, a streamed
 * block, a call with its result, the reply's stop or error) by `liveKindOf`, in the same order, and
 * drawn by the same host (components/LiveKinds.tsx holds the live views). The settled row that
 * replaces it at the turn's end is the same kind's `view`.
 *
 * Which rows join a run of the working (§chat.transcript/work-chain, "Work · n steps") is the kinds'
 * own say too, by one rule for both (`outsideWork`): a call whose kind declares `outsideWork` is the
 * message, not the working, and breaks the run, settled or streaming, so no row moves out of a run at
 * the handover.
 *
 * Like src/vis/registry.ts this file stays free of Solid, the DOM and CSS (views are named or
 * imported lazily), so its order and matching are tested in plain unit tests.
 */

import type { Component } from "solid-js";
import type { TranscriptItem } from "../../shared/protocol";
import { rowFacts } from "../../shared/wire-v1";
import { isBriefText } from "../../shared/senders";
import { normalizeOfferDetails, OFFER_TOOL } from "../../shared/session-offers";
import { CARD_TOOL, normalizeCardDetails as normalizeRaisedCard, type CardInfo } from "../../shared/transcript-cards";
import { checkCardData, dataCardHeight } from "../../shared/view-cards";
import { normalizeShowChangesDetails, SHOW_CHANGES_TOOL } from "../../pi-config/extensions/show-changes/details";
import { normalizeTourCardDetails, TOUR_TOOLS } from "../../shared/tour";
import { isSettingsToolDetails } from "../../shared/project-settings";
import { parseWakeNudge } from "../../shared/wake";
import { parseTopicBatch } from "../../shared/topic-message";
import type { ReplyTiming } from "../../shared/usage/perf";
import type { LiveBlock, LiveEntry, LiveTool } from "./live";
import { alignKey, alignOf, alignRowFromDetails } from "./align";
import { newestByKey } from "./transcript-placement";
import { explainOf } from "./explain";
import { isLoginNoteRow } from "./change-rows";
import { infoEstimate } from "./tail-render";
import { CARD_TOOLS } from "./hidden-rows";

/** Where a kind draws: in the page (Sova's own), as one of Sova's data cards, or in a sealed frame. */
export type KindHost = "page" | "data" | "frame";

/**
 * Where a kind's rows stand (§chat.transcript-cards/placement). Every row stands where it was raised;
 * nothing ever moves to the end. Anchored: each row is its own card. Follow: a card raised again is a
 * new revision at its own point in the chat, by `key`; only the newest revision draws the whole card.
 */
export type Placement = "anchored" | "follow";

/** The project overseer's settings tool: a propose draws its Settings change card. */
export const SETTINGS_TOOL = "sova_settings";

/**
 * What a row's match may ask of the transcript around it: facts only the whole list knows (a
 * call's result, whether a user row exists). Thread.tsx gives it; tests give plain functions.
 */
export interface KindContext {
  hasUserRow(): boolean;
  /** A tour call's card, once its rows say so (lib/tour-rows). */
  tourCard(item: TranscriptItem): unknown;
  /** A show_changes call's checked details, once it succeeded. */
  showChanges(callId: string | undefined): unknown;
  /** An offer call's card, once it succeeded. */
  offer(callId: string | undefined): unknown;
  /** A settings call's details, once it succeeded. */
  settings(callId: string | undefined): unknown;
  /** Whether a call with this id is on the list (its result then draws inside the call's card). */
  hasCall?(callId: string): boolean;
  /** A `card` call's card, once it succeeded (§chat.transcript-cards/card-tool). */
  card(callId: string | undefined): CardInfo | undefined;
}

/** What a toolkit view gets: its row, the value its kind's match gave, and what the transcript knows of it. */
export interface KindViewProps<V = unknown> {
  item: TranscriptItem;
  value: V;
  /** The chat's own path when this transcript is a held chat (HistoryItems' `limitPath`). */
  limitPath?: string;
  /** The row's place in the rows the transcript shows (a later row may ask it of the list). */
  index?: () => number;
}

/** A message going into the running turn: yours, queued or taken, or one the server started (a wake, a topic batch). */
export type LiveUserEntry = Extract<LiveEntry, { kind: "user" }>;
export type LiveCallBlock = Extract<LiveBlock, { type: "toolCall" }>;

/** Where a streamed block stands in its reply, worked out by the run around it (the same for every kind). */
export interface LiveBlockFacts {
  /** The reply's author: its model's label, or the transcript's author. */
  author(): string;
  model(): string | undefined;
  /** The block is still being written (its live dot). */
  streaming(): boolean;
  /** A reply text block shows its head: the block drawn above it is no text. */
  showHead(): boolean;
  /** A finished reply's measurement, on its first text block. */
  timing(): ReplyTiming | undefined;
  /** The measured head's time. */
  time(): string | undefined;
}

/**
 * A piece of the running turn, as `liveKindOf` matches it: the live counterpart of a settled row. Each
 * is drawn by the kind whose `live` form matches it first, in the list's order.
 */
export type LiveInput =
  | { kind: "user"; entry: LiveUserEntry }
  | { kind: "text" | "thinking"; block: Extract<LiveBlock, { type: "text" | "thinking" }>; facts: LiveBlockFacts }
  | { kind: "call"; block: LiveCallBlock; facts: LiveBlockFacts }
  /** The reply ended as stopped by you. */
  | { kind: "stopped"; at: string }
  /** The reply ended on an error; `model` produced it. */
  | { kind: "error"; message: string; model?: string };

/** What a live form's match may ask of the run: facts only the whole run knows. */
export interface LiveKindContext {
  /** A call's tool state: running, and its result once it ends. */
  tool(callId: string): LiveTool | undefined;
  /** The run's newest finished call for a tour: only it draws the tour's card (§app.tours/one-card). */
  tourCall(tourId: string): string | undefined;
}

/** The live views (components/LiveKinds.tsx `LIVE_VIEWS`), by name. */
export type LiveView = "wake" | "topic" | "brief" | "user" | "assistant-text" | "thinking" | "align" | "info" | "tour" | "show-changes" | "offer" | "card" | "settings" | "tool";

/** What a live view gets: the piece of the run it draws, and the value its kind's live match gave. */
export interface LiveKindViewProps<V = unknown> {
  input: LiveInput;
  value: V;
}

/** A kind's form while its turn streams: what it matches of the run, and the view that draws it then. */
export interface LiveForm {
  match(input: LiveInput, ctx: LiveKindContext): unknown;
  view: LiveView;
}

/** The views drawn in the page (components/TranscriptKind.tsx `PAGE_VIEWS`), by name. */
export type PageView = "wake" | "topic" | "compaction" | "info" | "worktree-merge" | "settings" | "offer" | "show-changes" | "tour" | "owner-request" | "handoff-run" | "overseer-answer" | "profile-mark" | "brief" | "explain" | "team-report" | "report" | "baton" | "user" | "assistant-text" | "thinking" | "tool-result" | "tool" | "align-report" | "align";

/**
 * A kind's view: one of Sova's page views by name (drawn at once, as before, in the page's own
 * chunk), or a module loaded the first time a row of the kind draws.
 */
export type KindView = { page: PageView } | { load: () => Promise<{ default: Component<KindViewProps> }> };

export interface TranscriptKind<V = unknown> {
  /** Sova's own kinds have plain names; a project's `project.<name>`, an extension's `<id>.<name>` (later phases). */
  id: string;
  /** The value the row draws from, or a falsy value when the row isn't this kind. Pure, cheap. */
  match(item: TranscriptItem, ctx: KindContext): V | null | undefined | false;
  /**
   * The row's height until it is first drawn, as the CSS length `rowEstimate` wraps (the images'
   * part is added there). Absent: rowEstimate's own rule for the row's kind.
   */
  estimate?(item: TranscriptItem, value: V): string;
  host: KindHost;
  placement: Placement;
  /** A `follow` kind's card, shared by its revisions: the newest row per key draws it whole. */
  key?(item: TranscriptItem, value: V): string | undefined;
  /** Drawn by the toolkit. Absent only on a kind that draws nothing. */
  view?: KindView;
  /** A row the transcript keeps for its facts but never draws (a sent marker): no view, no branch. */
  drawsNothing?: true;
  /** How the kind draws while its turn still streams, before its row settles; absent, it draws only settled. */
  live?: LiveForm;
  /**
   * A call this kind draws stands outside the Work run (§chat.transcript/work-chain): it is the
   * message, not the working, so it breaks the run. `true`: every call the kind matches; a function:
   * decided by the call's tool name (the tool kind's own cards: a deck card, a link). Absent: a call
   * of the kind is a step. Read by `outsideWork`, for settled and live rows alike.
   */
  outsideWork?: true | ((toolName: string) => boolean);
}

const kind = <V>(k: TranscriptKind<V>): TranscriptKind => k as unknown as TranscriptKind;
const isCall = (item: TranscriptItem) => item.kind === "tool-call";
/** A live call named `name` that finished: its result's details. */
const doneCall = (input: LiveInput, ctx: LiveKindContext, name: (n: string) => boolean): unknown => {
  if (input.kind !== "call" || !name(input.block.name)) return undefined;
  const t = ctx.tool(input.block.id);
  return t?.status === "done" ? t.details : undefined;
};
const named = (n: string) => (name: string) => name === n;
/**
 * Calls the tool kind draws that stay outside the Work run by name, whatever their result: the deck
 * card, a link, a session sent to, every tour call (its request, progress and failure rows too,
 * §app.tours/recording) and a raised card's call from its first streamed argument. An offer is out
 * only once its card is (the offer kind), as is a show_changes call with valid details.
 */
const OUTSIDE_WORK_NAMES: ReadonlySet<string> = new Set([...CARD_TOOLS, ...TOUR_TOOLS, "session_send", "sova_create_session"].filter((n) => n !== OFFER_TOOL));

// In the order Thread.tsx's chains had: the first kind that matches draws the row (settled or live).
// The settled kinds are told apart by their row kind first, so wake and topic standing before the
// user row changes no settled row; a live message is a wake, a topic batch, a brief or yours, in that order.
export const TRANSCRIPT_KINDS: readonly TranscriptKind[] = [
  kind({
    id: "wake",
    match: (it) => it.kind === "wake" && it.wake,
    estimate: () => "46px",
    host: "page",
    placement: "anchored",
    view: { page: "wake" },
    live: { match: (input) => input.kind === "user" && parseWakeNudge(input.entry.text), view: "wake" },
  }),
  kind({
    id: "topic",
    match: (it) => it.kind === "topic" && it.topic,
    estimate: () => "70px",
    host: "page",
    placement: "anchored",
    view: { page: "topic" },
    live: { match: (input) => input.kind === "user" && parseTopicBatch(input.entry.text), view: "topic" },
  }),
  kind({
    id: "brief",
    match: (it) => it.kind === "user" && isBriefText(it.text),
    host: "page",
    placement: "anchored",
    view: { page: "brief" },
    live: { match: (input) => input.kind === "user" && isBriefText(input.entry.text) && input.entry, view: "brief" },
  }),
  kind({ id: "user", match: (it) => it.kind === "user", host: "page", placement: "anchored", view: { page: "user" }, live: { match: (input) => input.kind === "user" && input.entry, view: "user" } }),
  // The sent markers draw nothing themselves: each tags the row it names.
  kind({ id: "overseer-sent", match: (it) => it.overseerMark?.kind === "sent", host: "page", placement: "anchored", drawsNothing: true }),
  kind({ id: "baton-sent", match: (it) => it.batonMark?.kind === "sent", host: "page", placement: "anchored", drawsNothing: true }),
  kind({ id: "session-sent", match: (it) => it.sessionMark?.kind === "sent", host: "page", placement: "anchored", drawsNothing: true }),
  kind({ id: "profile-mark", match: (it) => it.profileMark, host: "page", placement: "anchored", view: { page: "profile-mark" } }),
  kind({ id: "baton", match: (it) => it.batonMark && it.batonMark.kind !== "sent" && it.batonMark, host: "page", placement: "anchored", view: { page: "baton" } }),
  kind({ id: "overseer-answer", match: (it) => it.overseerMark?.kind === "dialog-answer" && it.overseerMark, host: "page", placement: "anchored", view: { page: "overseer-answer" } }),
  kind({ id: "worktree-merge", match: (it) => it.kind === "worktree-merge" && it.worktreeMerge, host: "page", placement: "anchored", view: { page: "worktree-merge" } }),
  // Legacy: the retired spec card's row, still sent by older mesh peers.
  kind({ id: "spec-turn", match: (it) => it.kind === "spec-turn", host: "page", placement: "anchored", drawsNothing: true }),
  kind({
    id: "assistant-text",
    match: (it) => it.kind === "assistant-text",
    host: "page",
    placement: "anchored",
    view: { page: "assistant-text" },
    live: { match: (input) => input.kind === "text" && input.block, view: "assistant-text" },
  }),
  kind({ id: "thinking", match: (it) => it.kind === "thinking", host: "page", placement: "anchored", view: { page: "thinking" }, live: { match: (input) => input.kind === "thinking" && input.block, view: "thinking" } }),
  // An open alignment follows the chat by revision: each `align` call is a new row, its newest
  // revision draws the whole card and earlier ones one line (lib/align.ts `newestAlignRows`). While
  // the turn streams, a call that changed an alignment draws its card whole, as the newest.
  kind({
    id: "align",
    outsideWork: true,
    match: (it) => it.kind === "align" && it.align,
    host: "page",
    placement: "follow",
    key: (it) => alignKey(it),
    view: { page: "align" },
    live: { match: (input, ctx) => alignRowFromDetails(doneCall(input, ctx, named("align"))), view: "align" },
  }),
  kind({ id: "align-report", match: (it) => it.kind === "report" && it.report && alignOf(it.report), host: "page", placement: "anchored", view: { page: "align-report" } }),
  kind({ id: "explain", match: (it) => it.kind === "report" && it.report && explainOf(it.report), host: "page", placement: "anchored", view: { page: "explain" } }),
  kind({ id: "team-report", match: (it) => it.kind === "report" && it.report?.team, host: "page", placement: "anchored", view: { page: "team-report" } }),
  kind({ id: "report", match: (it) => it.kind === "report" && it.report, host: "page", placement: "anchored", view: { page: "report" } }),
  // An owner request a Start Chat put at the top (§app.project-assistant/request-chat).
  kind({ id: "owner-request", match: (it) => it.kind === "info" && it.ownerRequest, host: "page", placement: "anchored", view: { page: "owner-request" } }),
  kind({ id: "handoff-run", match: (it) => it.kind === "info" && it.handoffRun, host: "page", placement: "anchored", view: { page: "handoff-run" } }),
  kind({ id: "compaction", match: (it) => it.kind === "info" && rowFacts(it)?.compaction, estimate: () => "36px", host: "page", placement: "anchored", view: { page: "compaction" } }),
  // A Claude login note waits for the first message, like the profile row.
  kind({ id: "login-note-waiting", match: (it, ctx) => isLoginNoteRow(it) && !ctx.hasUserRow(), host: "page", placement: "anchored", drawsNothing: true }),
  // An info row; while the turn streams, its reply's stop and error rows (a held chat's error with its limit row).
  kind({
    id: "info",
    match: (it) => it.kind === "info",
    estimate: (it) => infoEstimate(it.text ?? ""),
    host: "page",
    placement: "anchored",
    view: { page: "info" },
    live: { match: (input) => (input.kind === "stopped" || input.kind === "error") && input, view: "info" },
  }),
  kind({
    id: "tour",
    outsideWork: true,
    match: (it, ctx) => isCall(it) && ctx.tourCard(it),
    host: "page",
    placement: "anchored",
    view: { page: "tour" },
    // Only the run's newest call for its tour draws the card; an earlier one is a tool card with its line.
    live: {
      match: (input, ctx) => {
        const d = normalizeTourCardDetails(doneCall(input, ctx, (n) => TOUR_TOOLS.has(n)));
        return d && input.kind === "call" && ctx.tourCall(d.tourId) === input.block.id && d;
      },
      view: "tour",
    },
  }),
  // A show_changes result whose details check out reads as a card that opens the changes viewer
  // (§chat.changes/show-changes-card); anything else, a tool card.
  kind({
    id: "show-changes",
    outsideWork: true,
    match: (it, ctx) => isCall(it) && it.text === SHOW_CHANGES_TOOL && ctx.showChanges(it.toolCallId),
    host: "page",
    placement: "anchored",
    view: { page: "show-changes" },
    live: { match: (input, ctx) => normalizeShowChangesDetails(doneCall(input, ctx, named(SHOW_CHANGES_TOOL))), view: "show-changes" },
  }),
  kind({
    id: "offer",
    outsideWork: true,
    match: (it, ctx) => isCall(it) && it.text === OFFER_TOOL && ctx.offer(it.toolCallId),
    host: "page",
    placement: "anchored",
    view: { page: "offer" },
    live: { match: (input, ctx) => normalizeOfferDetails(doneCall(input, ctx, named(OFFER_TOOL))), view: "offer" },
  }),
  // A project's transcript card (§chat/transcript-cards), one of Sova's data cards: the agent's at its
  // `card` call, one raised from outside at the row the page placed it as. Its type says where it
  // stands: a follow type's revisions share its key, the newest drawn whole; an anchored card has no key.
  kind({
    id: "card",
    outsideWork: true,
    match: (it, ctx) => (isCall(it) && it.text === CARD_TOOL && ctx.card(it.toolCallId)) || (it.kind === "card" && it.card),
    estimate: (_it, card: CardInfo) => `${cardEstimate(card)}px`,
    host: "data",
    placement: "follow",
    key: (_it, card: CardInfo) => (card.placement === "follow" && card.key ? `${card.type}\u0000${card.key}` : undefined),
    view: { load: () => import("../components/TranscriptCard") as unknown as Promise<{ default: Component<KindViewProps> }> },
    // The running turn's card is drawn as soon as its call returns (§chat.transcript-cards/card-tool).
    live: { match: (input, ctx) => normalizeRaisedCard(doneCall(input, ctx, named(CARD_TOOL))), view: "card" },
  }),
  kind({
    id: "settings",
    outsideWork: true,
    match: (it, ctx) => isCall(it) && it.text === SETTINGS_TOOL && ctx.settings(it.toolCallId),
    host: "page",
    placement: "anchored",
    view: { page: "settings" },
    live: {
      match: (input, ctx) => {
        const d = doneCall(input, ctx, named(SETTINGS_TOOL));
        return isSettingsToolDetails(d) && (d.card || d.appliedNow.length) ? d : undefined;
      },
      view: "settings",
    },
  }),
  // Any other call: its tool card, or the card its result reads as (a deck card, a link), streamed arguments and all.
  kind({
    id: "tool",
    match: (it) => isCall(it),
    host: "page",
    placement: "anchored",
    view: { page: "tool" },
    live: { match: (input) => input.kind === "call" && input.block, view: "tool" },
    outsideWork: (name) => OUTSIDE_WORK_NAMES.has(name),
  }),
  // A paired result draws inside its call's card: its own row draws nothing.
  kind({ id: "tool-result-paired", match: (it, ctx) => it.kind === "tool-result" && !!it.toolCallId && !!ctx.hasCall?.(it.toolCallId), host: "page", placement: "anchored", drawsNothing: true }),
  kind({ id: "tool-result", match: (it) => it.kind === "tool-result", host: "page", placement: "anchored", view: { page: "tool-result" } }),
];

/** A card's reserved height: its data card's estimate, or a line for data that doesn't fit (its error box). */
function cardEstimate(card: CardInfo): number {
  if (card.draws === "view") return (card.view?.height ?? 160) + (card.by.kind === "agent" ? 0 : 24) + (card.answer ? 28 : 0);
  const c = checkCardData(card.draws, card.data);
  return (c.ok ? dataCardHeight(card.draws, c.data) : 56) + (card.by.kind === "agent" ? 0 : 24) + (card.answer ? 28 : 0);
}

const BY_ID = new Map(TRANSCRIPT_KINDS.map((k) => [k.id, k]));
if (BY_ID.size !== TRANSCRIPT_KINDS.length) throw new Error("transcript-kinds: two kinds share an id");

export const kindById = (id: string): TranscriptKind | undefined => BY_ID.get(id);

/** A row's kind and the value its match gave; `live`: matched by the kind's live form, drawn by its live view. */
export interface KindHit {
  kind: TranscriptKind;
  value: unknown;
  live?: true;
}

/** The first kind that matches `item`, in the list's order, or undefined (the row draws as Unknown). */
export function kindOf(item: TranscriptItem, ctx: KindContext, kinds: readonly TranscriptKind[] = TRANSCRIPT_KINDS): KindHit | undefined {
  for (const k of kinds) {
    const value = k.match(item, ctx);
    if (value) return { kind: k, value };
  }
  return undefined;
}

/** The first kind whose live form matches a piece of the running turn, in the list's order, or undefined (it draws nothing). */
export function liveKindOf(input: LiveInput, ctx: LiveKindContext, kinds: readonly TranscriptKind[] = TRANSCRIPT_KINDS): KindHit | undefined {
  for (const k of kinds) {
    const value = k.live?.match(input, ctx);
    if (value) return { kind: k, value, live: true };
  }
  return undefined;
}

/** A streamed block as the piece of the run its live row draws: a call, or a text or thinking block. */
export const liveBlockInput = (block: LiveBlock, facts: LiveBlockFacts): LiveInput => (block.type === "toolCall" ? { kind: "call", block, facts } : { kind: block.type, block, facts });

/** A reply's end, as the pieces its live rows draw after its blocks: stopped by you, then its error. */
export function liveEndsOf(entry: Extract<LiveEntry, { kind: "assistant" }>): LiveInput[] {
  const out: LiveInput[] = [];
  if (entry.stoppedAt) out.push({ kind: "stopped", at: entry.stoppedAt });
  if (entry.error) out.push({ kind: "error", message: entry.error, ...(entry.model ? { model: entry.model } : {}) });
  return out;
}

/**
 * Whether a tool call stands outside the Work run, by its kind's `outsideWork`: the one rule the
 * settled rows (a `kindOf` hit) and the running turn (a `liveKindOf` hit) both cut their runs by.
 */
export function outsideWork(hit: KindHit | undefined, toolName: string): boolean {
  const o = hit?.kind.outsideWork;
  return o === true || (typeof o === "function" && o(toolName));
}

/** Two hits draw the same: the same kind, from the same value. */
export const sameHit = (a: KindHit | undefined, b: KindHit | undefined): boolean => a === b || (!!a && !!b && a.kind === b.kind && a.value === b.value);

/** The kinds the toolkit draws (each has a view), by id: the rule test holds Thread.tsx to having no branch for them. */
export const toolkitKinds = (kinds: readonly TranscriptKind[] = TRANSCRIPT_KINDS): string[] => kinds.filter((k) => k.view).map((k) => k.id);

/** The rows that draw a following card whole: the newest revision of each card, by kind and key. Anchored rows are never in it. */
export function newestRevisions(items: readonly TranscriptItem[], ctx: KindContext, kinds: readonly TranscriptKind[] = TRANSCRIPT_KINDS): Set<string> {
  return newestByKey(
    items,
    (it) => {
      const hit = kindOf(it, ctx, kinds);
      if (hit?.kind.placement !== "follow" || !hit.kind.key) return undefined;
      const key = hit.kind.key(it, hit.value);
      return key === undefined ? undefined : `${hit.kind.id}\u0000${key}`;
    },
    (it) => it.id,
  );
}
