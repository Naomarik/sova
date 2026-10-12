import type { ChatRecord } from "./supervisor";

/**
 * Code pickup for chat processes (design §6): a chat on older code asks to reload at a quiet moment
 * (`reload.request`), and this serializes those reloads, one at a time, two-phase. A replacement
 * process is started and must boot (hello `ready`, 30 s) before the old one is asked to close; the old
 * one refuses unless it is quiet, so a reload never cuts off a reply. The first replacement that fails
 * to boot halts the automatic rollout for this server's life (badges stay `older`, the chat keeps its
 * old process); "Reload Now" still tries, being explicit.
 */

/** What rollout needs of the supervisor (ChatSupervisor implements it). */
export interface RolloutSupervisor {
  record(chatId: string): ChatRecord | undefined;
  startReplacement(chatId: string): Promise<ChatRecord>;
  stopUnit(unit: string): Promise<void>;
  expectExit(chatId: string, cause: "reload"): void;
  unexpectExit(chatId: string): void;
  awaitExit(chatId: string): Promise<void>;
  repoint(chatId: string, rep: ChatRecord): void;
}

export interface RolloutDeps<L = unknown> {
  supervisor: RolloutSupervisor;
  /** Connect to `rep` and wait for its `hello{state:"ready"}` (no `open`); the error text when it did not boot. */
  waitReady(rep: ChatRecord, timeoutMs: number): Promise<{ ok: true; link?: L } | { ok: false; error: string }>;
  /** `drain{reason:"reload"}` to the chat's current process: it refuses unless quiet. */
  drain(chatId: string): Promise<{ ok: boolean }>;
  /** Open the chat in `rep` and re-point the server's handle at it; throws when the open fails. */
  open(chatId: string, rep: ChatRecord, link: L | undefined): Promise<void>;
  /** The chat's code state, for its panes and the list (`failed` with the reason). */
  setCode(chatId: string, state: "reloading" | "failed" | "older", detail?: string): void;
  /** The last lines of the replacement's log, for a failed boot's reason. */
  logTail?(unit: string): Promise<string[]>;
  readyTimeoutMs?: number;
  log?: (line: string) => void;
}

export type ReloadOutcome = "reloaded" | "refused" | "failed" | "halted" | "gone";

export class Rollout<L = unknown> {
  private chain: Promise<unknown> = Promise.resolve();
  private queued = new Map<string, Promise<ReloadOutcome>>();
  /** Why automatic reloads stopped for this server's life, once one failed. */
  halted: string | null = null;
  private readonly log: (line: string) => void;
  constructor(private readonly deps: RolloutDeps<L>) {
    this.log = deps.log ?? ((l) => console.log(`[chat-rollout] ${l}`));
  }

  /** A chat's `reload.request`: queued behind any reload in progress; one request per chat at a time. */
  request(chatId: string, opts: { auto: boolean }): Promise<ReloadOutcome> {
    const held = this.queued.get(chatId);
    if (held) return held;
    const run = this.chain.then(() => this.reload(chatId, opts.auto));
    this.queued.set(chatId, run);
    this.chain = run.catch(() => undefined);
    void run.finally(() => this.queued.delete(chatId)).catch(() => undefined);
    return run;
  }

  private async reload(chatId: string, auto: boolean): Promise<ReloadOutcome> {
    const { supervisor: sup } = this.deps;
    if (auto && this.halted) return "halted";
    if (!sup.record(chatId)) return "gone";
    this.deps.setCode(chatId, "reloading");
    let rep: ChatRecord;
    try {
      rep = await sup.startReplacement(chatId);
    } catch (err) {
      return this.fail(chatId, null, (err as Error).message);
    }
    const ready = await this.deps.waitReady(rep, this.deps.readyTimeoutMs ?? 30_000).catch((err) => ({ ok: false as const, error: (err as Error).message }));
    if (!ready.ok) return this.fail(chatId, rep, ready.error);
    sup.expectExit(chatId, "reload");
    const drained = await this.deps.drain(chatId).catch(() => ({ ok: false }));
    if (!drained.ok) {
      // No longer quiet: the replacement goes, and the chat asks again at its next quiet moment.
      sup.unexpectExit(chatId);
      await sup.stopUnit(rep.unit);
      this.deps.setCode(chatId, "older");
      return "refused";
    }
    await sup.awaitExit(chatId);
    sup.repoint(chatId, rep);
    try {
      await this.deps.open(chatId, rep, ready.link);
    } catch (err) {
      // The replacement goes as an expected end; the chat opens afresh (in the server) on its next acquire.
      sup.expectExit(chatId, "reload");
      return this.fail(chatId, rep, `the chat did not open on the new code: ${(err as Error).message}`);
    }
    this.log(`${chatId}: reloaded into ${rep.unit}`);
    return "reloaded";
  }

  private async fail(chatId: string, rep: ChatRecord | null, error: string): Promise<ReloadOutcome> {
    let reason = error;
    if (rep) {
      const tail = await this.deps.logTail?.(rep.unit).catch(() => []);
      if (tail?.length) reason = `${error}: ${tail.at(-1)}`;
      await this.deps.supervisor.stopUnit(rep.unit);
    }
    this.halted ??= `${chatId}: ${reason}`;
    this.log(`${chatId}: could not start on new code (${reason}); automatic reloads stop until the server restarts`);
    this.deps.setCode(chatId, "failed", reason);
    return "failed";
  }
}
