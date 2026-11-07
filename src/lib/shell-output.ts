// The window a command's output opens in (§chat.shell-mode/card): a running command's live output, or
// a saved one's whole output, read page by page. Pure: ShellOutputWindow.tsx draws it.

import { thousands } from "./format";

/** The whole output as read so far: its pages joined, where the next one starts, and its full size. */
export interface OutputRead {
  text: string;
  next: number | null;
  total: number;
}

/** A page added to what was read: only the page that starts where the read stopped joins (a stale or
    repeated answer is dropped, so a double press of Load More never doubles the text). */
export function addPage(read: OutputRead | null, page: { text: string; from: number; next: number | null; total: number }): OutputRead {
  if (!read) return page.from === 0 ? { text: page.text, next: page.next, total: page.total } : { text: "", next: 0, total: page.total };
  if (read.next === null || page.from !== read.next) return read;
  return { text: read.text + page.text, next: page.next, total: page.total };
}

/** A size in the window's words: "820 bytes", "48 KB", "3.2 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${thousands(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${thousands(Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : thousands(Math.round(mb))} MB`;
}

/** How much of the whole output the window holds, while there is more: "Showing 1.0 MB of 3.2 MB". */
export function readWords(read: OutputRead, shownBytes: number): string | null {
  return read.next === null ? null : `Showing ${sizeWords(shownBytes)} of ${sizeWords(read.total)}`;
}

/** The whole output's file is gone: its chat was archived. What the card shows stays. */
export const OUTPUT_GONE = "The whole output is gone: it's deleted when its chat is archived. The card still shows the part it kept.";

/** A page that didn't load: what happened, and that trying again is safe. */
export const outputFailed = (why: string) => `Couldn't load the output. ${why.replace(/\.?$/, ".")} Nothing else changed; try again.`;
