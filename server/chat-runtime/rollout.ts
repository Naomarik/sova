import { awaitFrame, connectLink, type ConnectLinkOptions, type Link } from "./link";
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
  /** Stop the chat's current process as an expected end, and forget it. */
  stop(chatId: string, cause: "reload"): Promise<void>;
  /** Wait (bounded) until no process holds the session's writer lock; whether it is free. */
  waitUnlocked(sessionPath: string): Promise<boolean>;
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
  /** The chat could not open in its replacement, and its old process is gone: the router lets go of
      its handle and starts it again on the code it ran before, showing why. Never a death. */
  onReloadOpenFailed?(chatId: string, sessionPath: string, reason: string): void;
  /** The code a replacement starts on (the current generation's id), for the halt record and its log. */
  codeId?: () => string;
  /** Runs once the queue is empty after a reload that moved a chat: unused code generations are collected. */
  collect?: () => Promise<unknown>;
  readyTimeoutMs?: number;
  log?: (line: string) => void;
}

export type ReloadOutcome = "reloaded" | "refused" | "failed" | "halted" | "gone";

export class Rollout<L = unknown> {
  private chain: Promise<unknown> = Promise.resolve();
  private queued = new Map<string, Promise<ReloadOutcome>>();
  /** Chats whose queued reload a Reload now asked for (or joined): run as one, whatever the first ask was. */
  private readonly manual = new Set<string>();
  /** A chat moved onto new code since the last collection. */
  private moved = false;
  /** Why automatic reloads stopped for this server's life, once one failed. */
  halted: string | null = null;
  private readonly log: (line: string) => void;
  constructor(private readonly deps: RolloutDeps<L>) {
    this.log = deps.log ?? ((l) => console.log(`[chat-rollout] ${l}`));
  }

  /** A chat's `reload.request`: queued behind any reload in progress; one request per chat at a time. */
  request(chatId: string, opts: { auto: boolean }): Promise<ReloadOutcome> {
    const held = this.queued.get(chatId);
    if (held) {
      // A Reload now joining a queued automatic one makes it a Reload now (a halt never skips it).
      if (!opts.auto) this.manual.add(chatId);
      this.log(`${chatId}: asked again while its reload is under way: that one answers`);
      return held;
    }
    if (!opts.auto) this.manual.add(chatId);
    const run = this.chain.then(() => {
      const auto = !this.manual.delete(chatId);
      return this.reload(chatId, auto);
    });
    this.queued.set(chatId, run);
    this.chain = run.catch(() => undefined);
    const settled = (outcome: ReloadOutcome | null) => {
      // A refused run let go of its place already, and a new ask may hold it now.
      if (this.queued.get(chatId) === run) {
        this.queued.delete(chatId);
        // A Reload now that joined this run was answered by it: never carried into the chat's next request.
        this.manual.delete(chatId);
      }
      if (outcome === "reloaded") this.moved = true;
      if (this.queued.size || !this.moved || !this.deps.collect) return;
      this.moved = false;
      void this.deps.collect().catch((err) => this.log(`collecting unused code failed: ${(err as Error).message}`));
    };
    void run.then(settled, () => settled(null));
    return run;
  }

  private async reload(chatId: string, auto: boolean): Promise<ReloadOutcome> {
    const { supervisor: sup } = this.deps;
    if (auto && this.halted) {
      this.log(`${chatId}: no automatic reload: automatic reloads stopped this server life`);
      return "halted";
    }
    if (!sup.record(chatId)) {
      this.log(`${chatId}: no reload: no process of it is recorded`);
      return "gone";
    }
    this.deps.setCode(chatId, "reloading");
    this.log(`${chatId}: reloading${this.deps.codeId ? ` onto ${this.deps.codeId()}` : ""}`);
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
      this.log(`${chatId}: not quiet any more (a reply started); the replacement goes, and the chat asks again`);
      sup.unexpectExit(chatId);
      await sup.stopUnit(rep.unit);
      // Its place goes before "older" is said: the chat may ask again at once (a Reload now that stood),
      // and that ask is a reload of its own, never this refused one.
      this.queued.delete(chatId);
      this.manual.delete(chatId);
      this.deps.setCode(chatId, "older");
      return "refused";
    }
    await sup.awaitExit(chatId);
    // The replacement takes the writer lock at open: the old process must have let go of it.
    await sup.waitUnlocked(rep.sessionPath);
    sup.repoint(chatId, rep);
    try {
      await this.deps.open(chatId, rep, ready.link);
    } catch (err) {
      // The old process is gone: the replacement goes too, as an expected end (no death, no resume),
      // its record and own pid only once its unit is stopped, and the chat starts again on its old code,
      // once the replacement's writer lock is free.
      const reason = `the chat did not open on the new code: ${(err as Error).message}`;
      await sup.stop(chatId, "reload");
      if (!(await sup.waitUnlocked(rep.sessionPath))) this.log(`${chatId}: the replacement's writer lock is still held`);
      this.deps.onReloadOpenFailed?.(chatId, rep.sessionPath, reason);
      // The chat starts again on the code it ran before (the router shows why): "failed" here is the rollout's halt record only.
      return this.fail(chatId, null, reason, false);
    }
    this.log(`${chatId}: reloaded into ${rep.unit}`);
    return "reloaded";
  }

  private async fail(chatId: string, rep: ChatRecord | null, error: string, shown = true): Promise<ReloadOutcome> {
    let reason = error;
    if (rep) {
      const tail = await this.deps.logTail?.(rep.unit).catch(() => []);
      if (tail?.length) reason = `${error}: ${tail.at(-1)}`;
      await this.deps.supervisor.stopUnit(rep.unit);
    }
    const code = rep?.build ?? this.deps.codeId?.();
    this.halted ??= `${chatId}: ${code ? `(${code}) ` : ""}${reason}`;
    this.log(`${chatId}: could not start on new code${code ? ` (${code})` : ""}: ${reason}; automatic reloads stop until the server restarts`);
    if (shown) this.deps.setCode(chatId, "failed", reason);
    return "failed";
  }
}

/**
 * The `waitReady` rollout needs, over the link: dial the replacement as this server's controller (no
 * replay: it opened nothing yet) and wait for its hello saying `ready`. The runtime sends hello again
 * at each change of its state, and a process that dies booting ends the link. The link is kept for
 * the open; on failure it is closed.
 */
export function linkWaitReady(
  opts: Pick<ConnectLinkOptions, "epoch" | "build" | "settings"> & Partial<ConnectLinkOptions>,
  dial: typeof connectLink = connectLink,
  next: typeof awaitFrame = awaitFrame,
): RolloutDeps<Link>["waitReady"] {
  return async (rep, timeoutMs) => {
    const until = Date.now() + timeoutMs;
    let link: Link | undefined;
    try {
      const c = await dial(rep.sock, { ...opts, since: null, retryForMs: timeoutMs });
      link = c.link;
      if (c.hello.state !== "ready") await next(link, "hello", Math.max(1, until - Date.now()), (h) => h.state === "ready");
      return { ok: true, link };
    } catch (err) {
      link?.close();
      return { ok: false, error: (err as Error).message };
    }
  };
}
