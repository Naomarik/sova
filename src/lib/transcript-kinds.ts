/**
 * THE list of transcript row kinds (§chat.transcript-cards/toolkit: "One list of card types"). Every
 * row the transcript draws is looked up here, in this order, and the first kind whose `match` gives
 * a value draws it, exactly as the old per-kind `<Match>` chain in Thread.tsx did (first match
 * wins). A kind is an id, what it matches, the height it reserves before it draws, where it draws
 * (`host`), where it stands (`placement`), and its view.
 *
 * A kind with a `view` is drawn by the toolkit (components/TranscriptKind.tsx), inside its own
 * error box with Reload. A kind without one is still drawn by its own branch in Thread.tsx, keyed by
 * this list's id: the built-ins move onto the toolkit one step at a time, smallest first, the
 * alignment card last (§chat.transcript-cards/built-ins). Thread.tsx never matches a row itself
 * (transcript-kinds-rule.test.ts).
 *
 * Like src/vis/registry.ts this file stays free of Solid, the DOM and CSS (views are named or
 * imported lazily), so its order and matching are tested in plain unit tests.
 */

import type { Component } from "solid-js";
import type { TranscriptItem } from "../../shared/protocol";
import { rowFacts } from "../../shared/wire-v1";
import { isBriefText } from "../../shared/senders";
import { OFFER_TOOL } from "../../shared/session-offers";
import { CARD_TOOL, type CardInfo } from "../../shared/transcript-cards";
import { checkCardData, dataCardHeight } from "../../shared/view-cards";
import { SHOW_CHANGES_TOOL } from "../../pi-config/extensions/show-changes/details";
import { alignKey, alignOf } from "./align";
import { newestByKey } from "./transcript-placement";
import { explainOf } from "./explain";
import { isLoginNoteRow } from "./change-rows";
import { infoEstimate } from "./tail-render";

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
  /** A `card` call's card, once it succeeded (§chat.transcript-cards/card-tool). */
  card(callId: string | undefined): CardInfo | undefined;
}

/** What a toolkit view gets: its row, the value its kind's match gave, and what the transcript knows of it. */
export interface KindViewProps<V = unknown> {
  item: TranscriptItem;
  value: V;
  /** The chat's own path when this transcript is a held chat (HistoryItems' `limitPath`). */
  limitPath?: string;
}

/** The views drawn in the page (components/TranscriptKind.tsx `PAGE_VIEWS`), by name. */
export type PageView = "wake" | "topic" | "compaction" | "info";

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
  /** Drawn by the toolkit. Absent: drawn by its own branch in Thread.tsx, until it migrates. */
  view?: KindView;
  /** A row the transcript keeps for its facts but never draws (a sent marker): no view, no branch. */
  drawsNothing?: true;
}

const kind = <V>(k: TranscriptKind<V>): TranscriptKind => k as unknown as TranscriptKind;
const isCall = (item: TranscriptItem) => item.kind === "tool-call";

// In the order Thread.tsx's chain had: the first kind that matches draws the row.
export const TRANSCRIPT_KINDS: readonly TranscriptKind[] = [
  kind({ id: "brief", match: (it) => it.kind === "user" && isBriefText(it.text), host: "page", placement: "anchored" }),
  kind({ id: "user", match: (it) => it.kind === "user", host: "page", placement: "anchored" }),
  // The sent markers draw nothing themselves: each tags the row it names.
  kind({ id: "overseer-sent", match: (it) => it.overseerMark?.kind === "sent", host: "page", placement: "anchored", drawsNothing: true }),
  kind({ id: "baton-sent", match: (it) => it.batonMark?.kind === "sent", host: "page", placement: "anchored", drawsNothing: true }),
  kind({ id: "session-sent", match: (it) => it.sessionMark?.kind === "sent", host: "page", placement: "anchored", drawsNothing: true }),
  kind({ id: "profile-mark", match: (it) => it.profileMark, host: "page", placement: "anchored" }),
  kind({ id: "baton", match: (it) => it.batonMark && it.batonMark.kind !== "sent" && it.batonMark, host: "page", placement: "anchored" }),
  kind({ id: "overseer-answer", match: (it) => it.overseerMark?.kind === "dialog-answer" && it.overseerMark, host: "page", placement: "anchored" }),
  kind({ id: "worktree-merge", match: (it) => it.kind === "worktree-merge" && it.worktreeMerge, host: "page", placement: "anchored" }),
  kind({ id: "wake", match: (it) => it.kind === "wake" && it.wake, estimate: () => "46px", host: "page", placement: "anchored", view: { page: "wake" } }),
  kind({ id: "topic", match: (it) => it.kind === "topic" && it.topic, estimate: () => "70px", host: "page", placement: "anchored", view: { page: "topic" } }),
  // Legacy: the retired spec card's row, still sent by older mesh peers.
  kind({ id: "spec-turn", match: (it) => it.kind === "spec-turn", host: "page", placement: "anchored", drawsNothing: true }),
  kind({ id: "assistant-text", match: (it) => it.kind === "assistant-text", host: "page", placement: "anchored" }),
  kind({ id: "thinking", match: (it) => it.kind === "thinking", host: "page", placement: "anchored" }),
  // An open alignment follows the chat by revision: each `align` call is a new row, its newest
  // revision draws the whole card and earlier ones one line (lib/align.ts `newestAlignRows`).
  kind({ id: "align", match: (it) => it.kind === "align" && it.align, host: "page", placement: "follow", key: (it) => alignKey(it) }),
  kind({ id: "align-report", match: (it) => it.kind === "report" && it.report && alignOf(it.report), host: "page", placement: "anchored" }),
  kind({ id: "explain", match: (it) => it.kind === "report" && it.report && explainOf(it.report), host: "page", placement: "anchored" }),
  kind({ id: "team-report", match: (it) => it.kind === "report" && it.report?.team, host: "page", placement: "anchored" }),
  kind({ id: "report", match: (it) => it.kind === "report" && it.report, host: "page", placement: "anchored" }),
  // An owner request a Start Chat put at the top (§app.project-assistant/request-chat).
  kind({ id: "owner-request", match: (it) => it.kind === "info" && it.ownerRequest, host: "page", placement: "anchored" }),
  kind({ id: "handoff-run", match: (it) => it.kind === "info" && it.handoffRun, host: "page", placement: "anchored" }),
  kind({ id: "compaction", match: (it) => it.kind === "info" && rowFacts(it)?.compaction, estimate: () => "36px", host: "page", placement: "anchored", view: { page: "compaction" } }),
  // A Claude login note waits for the first message, like the profile row.
  kind({ id: "login-note-waiting", match: (it, ctx) => isLoginNoteRow(it) && !ctx.hasUserRow(), host: "page", placement: "anchored", drawsNothing: true }),
  kind({ id: "info", match: (it) => it.kind === "info", estimate: (it) => infoEstimate(it.text ?? ""), host: "page", placement: "anchored", view: { page: "info" } }),
  kind({ id: "tour", match: (it, ctx) => isCall(it) && ctx.tourCard(it), host: "page", placement: "anchored" }),
  // A show_changes result whose details check out reads as a card that opens the changes viewer
  // (§chat.changes/show-changes-card); anything else, a tool card.
  kind({ id: "show-changes", match: (it, ctx) => isCall(it) && it.text === SHOW_CHANGES_TOOL && ctx.showChanges(it.toolCallId), host: "page", placement: "anchored" }),
  kind({ id: "offer", match: (it, ctx) => isCall(it) && it.text === OFFER_TOOL && ctx.offer(it.toolCallId), host: "page", placement: "anchored" }),
  // A project's transcript card (§chat/transcript-cards), one of Sova's data cards: the agent's at its
  // `card` call, one raised from outside at the row the page placed it as. Its type says where it
  // stands: a follow type's revisions share its key, the newest drawn whole; an anchored card has no key.
  kind({
    id: "card",
    match: (it, ctx) => (isCall(it) && it.text === CARD_TOOL && ctx.card(it.toolCallId)) || (it.kind === "card" && it.card),
    estimate: (_it, card: CardInfo) => `${cardEstimate(card)}px`,
    host: "data",
    placement: "follow",
    key: (_it, card: CardInfo) => (card.placement === "follow" && card.key ? `${card.type}\u0000${card.key}` : undefined),
    view: { load: () => import("../components/TranscriptCard") as unknown as Promise<{ default: Component<KindViewProps> }> },
  }),
  kind({ id: "settings", match: (it, ctx) => isCall(it) && it.text === SETTINGS_TOOL && ctx.settings(it.toolCallId), host: "page", placement: "anchored" }),
  kind({ id: "tool", match: (it) => isCall(it), host: "page", placement: "anchored" }),
  kind({ id: "tool-result", match: (it) => it.kind === "tool-result", host: "page", placement: "anchored" }),
];

/** A card's reserved height: its data card's estimate, or a line for data that doesn't fit (its error box). */
function cardEstimate(card: CardInfo): number {
  const c = checkCardData(card.draws, card.data);
  return (c.ok ? dataCardHeight(card.draws, c.data) : 56) + (card.by.kind === "agent" ? 0 : 24) + (card.answer ? 28 : 0);
}

const BY_ID = new Map(TRANSCRIPT_KINDS.map((k) => [k.id, k]));
if (BY_ID.size !== TRANSCRIPT_KINDS.length) throw new Error("transcript-kinds: two kinds share an id");

export const kindById = (id: string): TranscriptKind | undefined => BY_ID.get(id);

/** A row's kind and the value its match gave. */
export interface KindHit {
  kind: TranscriptKind;
  value: unknown;
}

/** The first kind that matches `item`, in the list's order, or undefined (the row draws as Unknown). */
export function kindOf(item: TranscriptItem, ctx: KindContext, kinds: readonly TranscriptKind[] = TRANSCRIPT_KINDS): KindHit | undefined {
  for (const k of kinds) {
    const value = k.match(item, ctx);
    if (value) return { kind: k, value };
  }
  return undefined;
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
