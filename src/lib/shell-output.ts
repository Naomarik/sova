// The window a command's output opens in (§chat.shell-mode/card): a running command's live output, or
// a saved one's whole output, read page by page. No DOM: ShellOutputWindow.tsx draws it.

import { createSignal } from "solid-js";
import type { ShellOutputPage } from "../../shared/protocol";
import { thousands } from "./format";

/** The whole output as read so far: its pages joined, where the next one starts, and its full size. */
export interface OutputRead {
  text: string;
  next: number | null;
  total: number;
}

/** A page added to what was read: only the page that starts where the read stopped joins (a stale or
    repeated answer is dropped, so a double press of Load More never doubles the text). */
export function addPage(read: OutputRead | null, page: ShellOutputPage): OutputRead {
  if (!read) return page.from === 0 ? { text: page.output, next: page.next, total: page.bytes } : { text: "", next: 0, total: page.bytes };
  if (read.next === null || page.from !== read.next) return read;
  return { text: read.text + page.output, next: page.next, total: page.bytes };
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

/** One page as the server gives it (shared/protocol ShellOutputPage, src/lib/api fetchShellOutput). */
export type OutputPage = ShellOutputPage;

/**
 * A saved command's whole output, read a page at a time for its window: the first page at once, each
 * Load More the next from where the read stopped. A press while a page is out does nothing; a failed
 * page keeps what was read and Try Again asks for the same page. `gone` tells a deleted file (a 404:
 * its chat was archived) from any other failure. Solid signals; no DOM.
 */
export function createOutputReader(o: { fetch(from: number): Promise<OutputPage>; gone(err: unknown): boolean }) {
  const [read, setRead] = createSignal<OutputRead | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  let closed = false;
  const load = async () => {
    if (closed || loading()) return;
    const r = read();
    if (r && r.next === null) return;
    setLoading(true);
    setError(null);
    try {
      const page = await o.fetch(r?.next ?? 0);
      if (!closed) setRead((now) => addPage(now, page));
    } catch (e) {
      if (!closed) setError(o.gone(e) ? OUTPUT_GONE : outputFailed(e instanceof Error ? e.message : String(e)));
    } finally {
      if (!closed) setLoading(false);
    }
  };
  return {
    read,
    error,
    loading,
    load,
    /** The window closed: an answer still out changes nothing. */
    close() {
      closed = true;
    },
  };
}
