import { createContext, useContext } from "solid-js";
import type { SovaConfirmDetails, TranscriptItem } from "../../shared/protocol";
import type { CardDetails, OverseerCard } from "../../shared/overseer-card";
import type { Sender } from "../../shared/senders";
import type { ReplyTiming } from "../../shared/usage/perf";
import type { ToolSource } from "../lib/tool-content";

/**
 * What a transcript's whole list knows that one row's view may ask (§chat.transcript-cards/toolkit):
 * HistoryItems gives it to the views of Sova's own kinds (components/BuiltinKinds.tsx), so a view
 * draws from its row and these facts alone and never reaches into Thread.tsx. Accessors, read where
 * the view draws, so a view updates as the list does (a call's result arriving, a later row).
 */
export interface ThreadRows {
  /** The reply's author when a row names no model. */
  author(): string;
  /** Whether a user row is on the branch (the profile row waits for one). */
  hasUserRow(): boolean;
  /** Whether a call with this id is on the list (its result draws inside the call's card). */
  hasCall(callId: string): boolean;
  /** Whose transcript this is, for a tool card's content its row doesn't carry (lib/tool-content). */
  toolSource(): ToolSource | null;
  /** A call's result row, by the call's id. */
  result(callId: string): TranscriptItem | undefined;
  /** Whether a call without a result at row `index` may still be running (the stream is on and the row is in the open turn). */
  running(index: number): boolean;
  /** An earlier tour call's one line, what it reported then (§app.tours/one-card); undefined for the call that draws the card. */
  tourEarlier(item: TranscriptItem): string | undefined;
  /** A deck card call's card: the newest row draws it whole with the card's newest snapshot, an earlier one a line. */
  cardRow(item: TranscriptItem): { details: CardDetails; card: OverseerCard; newest: boolean } | undefined;
  /** The row of the newest alignment report: only it draws the old alignment card. */
  latestAlign(): string | undefined;
  /** Whether an alignment row is its document's newest revision (drawn whole; earlier ones one line). */
  alignNewest(item: TranscriptItem): boolean;
  /** A legacy confirm's answer, from the user rows after it. */
  confirmAnswer(item: TranscriptItem, details: SovaConfirmDetails): { answered: boolean; choice: string | null };
  /** The shown row at index `i` (a reply's head shows when the row above is another's). */
  row(i: number): TranscriptItem | undefined;
  /** A measured reply's figures, by its row id: its first text row's head shows them. */
  timing(id: string): ReplyTiming | undefined;
  /** Who sent a user row, when its marker says (shared/senders.ts). */
  senderOf(id: string): Sender | undefined;
  /** A baton person's name by ref ("operator" is You). */
  nameOf(ref: string): string;
  /** Whether a baton wrap-up's turn is shown (folded behind its card until asked for). */
  wrapupShown(): boolean;
  toggleWrapup(): void;
}

export const ThreadRowsContext = createContext<ThreadRows>();

/** The transcript around a row; views of Sova's own kinds are drawn only inside one. */
export function useThreadRows(): ThreadRows {
  const rows = useContext(ThreadRowsContext);
  if (!rows) throw new Error("a transcript row's view is drawn outside its transcript");
  return rows;
}
