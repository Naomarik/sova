// A run's news to the chats it names: each change, gathered for a moment, goes to
// every pane of the chat that shows its card, the chat that conducts it and the chat that started it, as a
// `playbook.run` SovaEvent carrying the card's view. No polling.
import type { SovaEvent } from "../../shared/harness";
import { chatsOfRun, onPlaybookRunChanged, runById } from "./store";
import { runView } from "./view";

const GATHER_MS = 150;

export interface PlaybookRunNews {
  sessionId: string;
  event: Extract<SovaEvent, { type: "playbook.run" }>;
}

const listeners = new Set<(n: PlaybookRunNews) => void>();
export function onPlaybookRunNews(fn: (n: PlaybookRunNews) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const due = new Map<string, NodeJS.Timeout>();
onPlaybookRunChanged((changed) => {
  if (due.has(changed.id)) return;
  const t = setTimeout(() => {
    due.delete(changed.id);
    const r = runById(changed.id);
    if (!r) return;
    void runView(r)
      .then((view) => {
        const run = r.closed ? { ...view, closed: true as const } : view;
        for (const sessionId of chatsOfRun(r))
          for (const fn of listeners) {
            try {
              fn({ sessionId, event: { type: "playbook.run", run } });
            } catch (err) {
              console.error("[playbook-runs] a news listener failed", err);
            }
          }
      })
      .catch((err) => console.warn(`[playbook-runs] ${r.id}: its card wasn't drawn for the news: ${err instanceof Error ? err.message : String(err)}`));
  }, GATHER_MS);
  t.unref?.();
  due.set(changed.id, t);
});
