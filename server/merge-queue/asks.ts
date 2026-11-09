/**
 * When the merge thread needs the user (§chat/merge-queue): it never waits in its own chat. Its question (merge.ask)
 * waits as a decision on the card of the entry's branch in the chat that owns it (al_3 v7, queue.ts askDecision): the
 * user answers in that chat's message box, and their own message, sent with the held note, is the answer the thread
 * gets (decisionAnswered). No chat ever relays it. The owner is the entry's recorded chat, a worker resolved up to the
 * chat that runs it (SessionSummary.workerOf). No chat that can show it (none recorded, archived, gone, open in a
 * terminal, a queue chat) or a decision that couldn't be raised: the question is held on the Merge Queue tab
 * (`onTab`), answered in the merge thread, and one notification opens the tab.
 *
 * Harness-neutral: sessions, the wake and the notification are injected (the live ones are Sova's own helpers).
 */
import type { MergeEntry, MergeThreadAsk } from "../../shared/merge-queue";
import type { SessionSummary } from "../../shared/protocol";
import { newAskId, type MergeThread } from "./thread";

export interface AskDeps {
  /** The session list (each row's id, path, workerOf, archived, live, queueChat). */
  sessions(): Promise<readonly SessionSummary[]>;
  /** The question as a decision on the entry's card in that chat (queue.ts askDecision): its held note goes with the
   *  user's answer, which reaches the thread (al_3 v7). False, or absent: the question is held on the tab. */
  decide?(ask: { id: string; question: string; choices: string[] }, chat: { session: string; path: string }): Promise<boolean>;
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

/** merge.ask: a decision on the branch's card in its chat, else held on the tab with one notification. */
export async function askUser(keeper: MergeThread, root: string, q: { question: string; entry?: MergeEntry; choices?: string[] }, deps: AskDeps): Promise<MergeThreadAsk> {
  const id = newAskId();
  const base = { id, question: q.question, ...(q.entry ? { entry: q.entry.id, branch: q.entry.branch } : {}) };
  const target = askTarget(q.entry, await deps.sessions().catch(() => []));
  if (target) {
    const chat = { session: target.id, path: target.path };
    if (q.entry && deps.decide) {
      const decided = await deps.decide({ id, question: q.question, choices: q.choices ?? [] }, chat).catch((err) => {
        deps.log?.(`${root}: the question wasn't raised as a decision (${err instanceof Error ? err.message : String(err)})`);
        return false;
      });
      if (decided) return keeper.recordAsk(root, base, chat);
      deps.log?.(`${root}: the question went to the tab: it couldn't wait on ${q.entry.branch}'s card in ${target.id}`);
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
