// The folded chat's bar in an open Lookbook view on a phone: who wrote the newest message and its
// first words, on one line. Pure: no DOM, no Solid.
import type { TranscriptItem } from "../../shared/protocol";

export interface ChatBarLine {
  who: string;
  text: string;
}

/** A row's message as the bar reads it, or null for rows that aren't a message (tools, Sova's notes, a design's brief, the Creative Director's prompt items). */
function messageOf(row: TranscriptItem, author: string): ChatBarLine | null {
  if (row.kind === "assistant-text") return row.text?.trim() ? { who: author, text: row.text } : null;
  if (row.kind !== "user") return null;
  const lb = row.lookbook;
  if (lb) {
    if ((lb.from === "you" || lb.from === "coordinator") && lb.words?.trim()) return { who: lb.from === "you" ? "You" : "Creative Director", text: lb.words };
    return null;
  }
  return row.text?.trim() ? { who: "You", text: row.text } : null;
}

/** The newest row of a chat's drawn list that is a message, for WorkerTranscript's latest-row callback. */
export function latestMessageRow(rows: readonly TranscriptItem[], author: string): TranscriptItem | undefined {
  for (let i = rows.length - 1; i >= 0; i--) if (messageOf(rows[i]!, author)) return rows[i];
  return undefined;
}

/** Markdown's marks off, every run of space one space: the message as one plain line. */
function oneLine(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The bar's line for a chat's newest message row (null: no message yet, the bar says "Message <name>"). */
export function chatBarLine(row: TranscriptItem | undefined, author: string): ChatBarLine | null {
  const m = row && messageOf(row, author);
  return m ? { who: m.who, text: oneLine(m.text) } : null;
}
