/**
 * When the merge thread needs the user (§chat/merge-queue): it never waits in its own chat. Its question (merge.ask)
 * goes to the chat that owns the entry's branch, as one marked merge-queue message (wake.ts), naming the question's
 * id; that chat's agent asks the user and relays their answer with merge.reply. The owner is the entry's recorded
 * chat, a worker resolved up to the chat that runs it (SessionSummary.workerOf). No chat that can take it (none
 * recorded, archived, gone, open in a terminal, a queue chat) or a refused wake: the question is held on the Merge
 * Queue tab (`onTab`) and one notification opens the tab.
 *
 * Harness-neutral: sessions, the wake and the notification are injected (the live ones are Sova's own helpers).
 */
import { MERGE_QUEUE_SENT_PREFIX, type MergeEntry, type MergeThreadAsk } from "../../shared/merge-queue";
import type { SessionSummary } from "../../shared/protocol";
import { newAskId, type MergeThread } from "./thread";

export interface AskDeps {
  /** The session list (each row's id, path, workerOf, archived, live, queueChat). */
  sessions(): Promise<readonly SessionSummary[]>;
  /** One marked merge-queue message to `path` (wake.ts sendQueueWake); throws when the chat can't take it. */
  send(path: string, text: string): Promise<void>;
  /** One notification that opens the project's Merge Queue tab. */
  notify(n: { title: string; body: string; hash: string; tag: string }): Promise<void>;
  /** The project's id and name, for the tab's link and the notification's words. */
  project(root: string): { id: string; name: string } | null;
  log?(line: string): void;
}

/** Workers of workers this deep at most. */
const MAX_HOPS = 8;

/** The chat that can be asked for `entry`'s branch: its recorded chat, up through workers; null when none can be. */
export function askTarget(entry: Pick<MergeEntry, "session"> | undefined, sessions: readonly SessionSummary[]): SessionSummary | null {
  if (!entry?.session) return null;
  let s = sessions.find((x) => x.id === entry.session || x.path === entry.session);
  for (let hops = 0; s?.workerSession; hops++) s = hops < MAX_HOPS && s.workerOf ? sessions.find((x) => x.path === s!.workerOf!.path) : undefined;
  if (!s || s.archived || s.live || s.queueChat || s.overseer || s.baton) return null;
  return s;
}

/** The message the owning chat gets: the question, its id, and how to relay the answer. */
export function askText(ask: Pick<MergeThreadAsk, "id" | "question" | "branch">): string {
  return [
    `${MERGE_QUEUE_SENT_PREFIX} The merge thread needs the user${ask.branch ? ` (about ${ask.branch})` : ""}:`,
    ask.question,
    "",
    `Ask the user this, in plain words, and wait for their answer: never answer it yourself. When they answer, relay their words with the project verbs tool: merge.reply {ask: "${ask.id}", text: "<their answer>"}. The merge thread takes it from there.`,
  ].join("\n");
}

/** merge.ask: send the question to the branch's chat, else hold it on the tab with one notification. */
export async function askUser(keeper: MergeThread, root: string, q: { question: string; entry?: MergeEntry }, deps: AskDeps): Promise<MergeThreadAsk> {
  const id = newAskId();
  const base = { id, question: q.question, ...(q.entry ? { entry: q.entry.id, branch: q.entry.branch } : {}) };
  const target = askTarget(q.entry, await deps.sessions().catch(() => []));
  if (target) {
    try {
      await deps.send(target.path, askText(base));
      return keeper.recordAsk(root, base, { session: target.id, path: target.path });
    } catch (err) {
      deps.log?.(`${root}: the question went to the tab: ${target.id} refused it (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const ask = keeper.recordAsk(root, base, null);
  const p = deps.project(root);
  await deps
    .notify({
      title: `The merge thread needs you${p ? ` · ${p.name}` : ""}`,
      body: q.question.slice(0, 280),
      hash: p ? `#/projects/${encodeURIComponent(p.id)}/merge-queue` : "#/projects",
      tag: `sova:merge-ask:${p?.id ?? root}`,
    })
    .catch((err) => deps.log?.(`${root}: notification not sent: ${err instanceof Error ? err.message : String(err)}`));
  return ask;
}
