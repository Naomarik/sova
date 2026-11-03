/**
 * Ending one of the merge queue's own chats (a reviewer once its run has its verdict, a merge thread at Start
 * Fresh): wait for its turn to finish, at most RETIRE_WAIT_MS; still running, stop it; then archive it, trying
 * again when refused (a chat that was mid-turn a moment ago answers 409). Only the last failure is logged; it
 * never throws. A reviewer gives its verdict from inside its own turn, so an archive at that moment was always
 * refused: this is why reviewer chats used to pile up.
 *
 * Harness-neutral: the chat is reached through injected deps (the live ones are Sova's own helpers).
 */
import type { Result } from "./thread";

/** How long a turn may go on before the chat is stopped. */
export const RETIRE_WAIT_MS = 2 * 60_000;
/** How often the turn is checked while waiting. */
export const RETIRE_POLL_MS = 1_000;
/** Archive tries, and the wait between them. */
export const ARCHIVE_TRIES = 3;
export const ARCHIVE_RETRY_MS = 2_000;

export interface RetireDeps {
  /** The chat is running a turn (or its workers are working). */
  busy(path: string): boolean;
  /** Stop its turn. */
  abort(path: string): Promise<void>;
  archive(path: string): Promise<Result>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  log?(line: string): void;
  waitMs?: number;
  pollMs?: number;
  retryMs?: number;
}

export type RetireOutcome = "archived" | "stopped-then-archived" | "not-archived";

/** Wait, else stop, then archive (retried). Resolves how it ended; never throws. */
export async function retireChat(path: string, deps: RetireDeps): Promise<RetireOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((l: string) => console.warn(`[merge-queue] ${l}`));
  const wait = deps.waitMs ?? RETIRE_WAIT_MS;
  const poll = deps.pollMs ?? RETIRE_POLL_MS;
  const busy = () => {
    try {
      return deps.busy(path);
    } catch {
      return false;
    }
  };
  const end = now() + wait;
  while (busy() && now() < end) await sleep(Math.min(poll, Math.max(1, end - now())));
  let stopped = false;
  if (busy()) {
    stopped = true;
    await deps.abort(path).catch(() => undefined);
  }
  let last = "";
  for (let i = 0; i < ARCHIVE_TRIES; i++) {
    if (i > 0) await sleep(deps.retryMs ?? ARCHIVE_RETRY_MS);
    const r = await deps.archive(path).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    if (r.ok) return stopped ? "stopped-then-archived" : "archived";
    last = r.error;
  }
  log(`${path} not archived after ${ARCHIVE_TRIES} tries: ${last}`);
  return "not-archived";
}

/** The live deps: Sova's own busy check, the chat handle's abort and the archive gesture. */
export async function liveRetireDeps(): Promise<RetireDeps> {
  const [{ chatHandle, isSessionBusy }, { archiveSession }, { workingSubagents }] = await Promise.all([import("../chat-handle"), import("../sessions-index"), import("../live")]);
  return {
    busy: (path) => isSessionBusy(path) || workingSubagents(path) > 0,
    async abort(path) {
      await chatHandle(path)?.abort();
    },
    async archive(path) {
      const r = await archiveSession(path, true);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
  };
}
