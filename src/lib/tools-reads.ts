// The setup card's Tools reads (§chat.transcript/setup-card-tools): every read numbered, an answer older
// than the one drawn dropped, a reset (a new session, the card going away) dropping all in flight, and the
// open rows kept while their tool is still listed. Solid state, tested under the browser condition
// (tools-reads.browser.test.ts).
import { createMemo, createSignal } from "solid-js";
import type { SessionTools } from "../../shared/protocol";
import { stillOpen, toolsView } from "./session-tools";

type Answer = { ok: SessionTools } | { error: string };

export function createToolsReads(fetch: (path: string) => Promise<SessionTools>) {
  const [answer, setAnswer] = createSignal<Answer | null>(null);
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const [groupOpen, setGroupOpen] = createSignal(false);
  let epoch = 0;
  let asked = 0;
  let drawn = 0;
  /** Read `path`'s tools; resolves once the answer is drawn or dropped. */
  const read = (path: string): Promise<void> => {
    const mine = epoch;
    const n = ++asked;
    return fetch(path)
      .then((ok): Answer => ({ ok }), (err: Error): Answer => ({ error: err.message }))
      .then((a) => {
        if (mine !== epoch || n < drawn) return;
        drawn = n;
        setOpen((o) => stillOpen(o, toolsView(a)));
        setAnswer(a);
      });
  };
  /** A new session, or the card going away: drop every read in flight, close the group and its rows. */
  const reset = () => {
    epoch++;
    setGroupOpen(false);
    setOpen(new Set<string>());
  };
  const view = createMemo(() => {
    const a = answer();
    return a ? toolsView(a) : null;
  });
  const flip = (key: string, on: boolean) =>
    setOpen((now) => {
      if (now.has(key) === on) return now;
      const next = new Set(now);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  return { read, reset, view, groupOpen, setGroupOpen, isOpen: (key: string) => open().has(key), flip };
}
