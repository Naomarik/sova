import { join } from "node:path";
import { dropWakeRecords, cancelWakesBefore } from "../pi-config/extensions/subagents/wake-store.ts";
import { acquireChatHandle, chatHandle, chatsReady } from "./chat-handle";
import { reopenWorkerChat, wakeOwnerOf, workerChatsOf } from "./chat-host";
import { getSessionSummary } from "./sessions-index";
import { LEAD_MS, TICK_MS, wakeDir, WakeKeeper, wakesOn, type WakeWorker } from "./wake-keeper";

const RESUME_WAIT_MS = 20_000;
const num = (v: string | undefined, fallback: number) => (Number(v) > 0 ? Number(v) : fallback);

/**
 * The route back of a worker with no process (§chat.wake-nudges/kinds), its parent already started:
 * one its record still holds is reopened, and the parent, which took it back at its start, watches
 * it; one whose record ended (a crash) is resumed by the parent, once the parent has listed it.
 * Either way the worker's own process then fires its nudge.
 */
async function resumeWorker(sessionId: string, w: WakeWorker): Promise<void> {
  if (!w.ended) return reopenWorkerChat(sessionId);
  const parent = await acquireChatHandle(w.parentPath);
  const deadline = Date.now() + RESUME_WAIT_MS;
  while (!(await parent.workerInfo(w.workerId)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  const out = await parent.resumeWorker(w.workerId);
  if (!out.ok) throw new Error(out.error);
}

/** Start the real keeper. `SOVA_WAKE_TICK_MS`, `SOVA_WAKE_LEAD_MS`, `SOVA_WAKE_CONFIRM_MS` and `SOVA_WAKE_GAPS_MS` (comma-separated) shorten it for a test server. */
export function startWakeKeeper(env: NodeJS.ProcessEnv = process.env): WakeKeeper | null {
  if (!wakesOn()) return null;
  const dir = wakeDir();
  const keeper = new WakeKeeper({
    dir,
    triesFile: join(dir, "keeper", "tries.json"),
    now: Date.now,
    summary: async (path) => {
      const s = await getSessionSummary(path).catch(() => null);
      return s ? { archived: !!s.archived, live: !!s.live } : null;
    },
    running: (path) => !!chatHandle(path),
    worker: wakeOwnerOf,
    open: async (path) => {
      await acquireChatHandle(path);
    },
    resumeWorker,
    log: (line) => console.log(`[wake-keeper] ${line}`),
    tickMs: num(env.SOVA_WAKE_TICK_MS, TICK_MS),
    leadMs: num(env.SOVA_WAKE_LEAD_MS, LEAD_MS),
    ...(num(env.SOVA_WAKE_CONFIRM_MS, 0) ? { confirmMs: num(env.SOVA_WAKE_CONFIRM_MS, 0) } : {}),
    ...(env.SOVA_WAKE_GAPS_MS ? { gapsMs: env.SOVA_WAKE_GAPS_MS.split(",").map(Number) } : {}),
  });
  // Chats a previous server left running are its to take back first; a catch-up then goes at once.
  void chatsReady().then(() => keeper.tick(), () => {});
  keeper.start();
  return keeper;
}

/** Chat `sessionId` was archived or deleted: everything it and its workers scheduled is cancelled for good. */
export function cancelChatWakes(sessionId: string, now = Date.now(), dir = wakeDir(), workers: (id: string) => string[] = workerChatsOf): void {
  try {
    for (const id of [sessionId, ...workers(sessionId)]) {
      cancelWakesBefore(dir, id, now);
      dropWakeRecords(dir, id);
    }
  } catch (err) {
    console.warn(`[wake-keeper] cancel of ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
