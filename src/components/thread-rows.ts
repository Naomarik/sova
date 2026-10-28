import { createContext, useContext } from "solid-js";
import type { TranscriptItem } from "../../shared/protocol";
import type { Sender } from "../../shared/senders";
import type { ReplyTiming } from "../../shared/usage/perf";

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
