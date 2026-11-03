// How the Merge Queue tab names a chat it recorded by id (its branch's chat, a run's reviewer): pure, so the rule
// runs under tsx --test. A worker is never named by its first message (its instructions): it is shown as
// `Worker {name} of “{its chat's title}”`, linking to that chat; "A worker's chat" when its chat isn't known.
import type { SessionSummary } from "../../shared/protocol";

/** A chat the page's session list knows: where its link opens and what it says. */
export interface ChatRef {
  path: string;
  title?: string;
  archived?: boolean;
}

/** Workers of workers this deep at most. */
const MAX_HOPS = 8;

/** The label of a worker's row, from its own summary and its top chat's (null: not known). */
export function workerLabel(worker: Pick<SessionSummary, "workerOf">, top: Pick<SessionSummary, "title"> | null): string {
  if (!top) return "A worker's chat";
  const name = worker.workerOf?.name?.trim();
  return `Worker ${name ? `${name} ` : ""}of “${top.title || "Untitled"}”`;
}

/** The ref for the chat recorded as `id` (an older record names its path) among `sessions`, or undefined. */
export function chatRefOf(id: string, sessions: readonly SessionSummary[] | undefined): ChatRef | undefined {
  const all = sessions ?? [];
  const s = all.find((x) => x.id === id || x.path === id);
  if (!s) return undefined;
  if (!s.workerSession) return { path: s.path, title: s.title, archived: s.archived };
  let top: SessionSummary | undefined = s;
  for (let hops = 0; top?.workerSession; hops++) top = hops < MAX_HOPS && top.workerOf ? all.find((x) => x.path === top!.workerOf!.path || x.id === top!.workerOf!.id) : undefined;
  return top ? { path: top.path, title: workerLabel(s, top), archived: top.archived } : { path: s.path, title: workerLabel(s, null), archived: s.archived };
}
