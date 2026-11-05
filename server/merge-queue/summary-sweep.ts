import type { MergeReady } from "../../shared/merge-queue";
import { AUTO_RETRY_AFTER_MS, type BranchSummaries } from "./branch-summaries";

/**
 * The branch summaries' sweep: every branch on a served project's "Ready to land, not approved" list gets its bullets
 * once its chat is idle (no chat, or an archived one, counts as idle), in the background, never from a page read. Its
 * first pass is the backfill of what is already on the list. A pass runs FIRST_MS after start, when a project's target
 * moves, when a branch's chat is read idle (`poke`), and every FULL_EVERY_MS otherwise; each asks BranchSummaries
 * (which writes one at a time) and spends the one automatic retry of a summary the model service didn't answer.
 */

export const FIRST_MS = 30_000;
/** How often the sweep looks whether anything moved (one rev-parse per served project). */
export const TICK_MS = 60_000;
/** A pass with nothing moved, at most this far apart: the retry's cool-down and anything no trigger sees. */
export const FULL_EVERY_MS = 5 * 60_000;

export interface SummarySweepDeps {
  /** The served projects' roots now. */
  roots: () => Iterable<string>;
  /** The project's Ready to land, not approved rows, read from git (never a view, never a model call). */
  readyOf: (root: string) => Promise<MergeReady[]>;
  /** The project's target head now. */
  targetHead: (root: string) => Promise<string | null>;
  /** Whether a chat is idle (an unknown chat is). */
  chatIdle: (session: string) => Promise<boolean>;
  summaries: Pick<BranchSummaries, "ensure" | "autoRetry">;
  now?: () => number;
  retryAfterMs?: number;
  log?: (line: string) => void;
}

export class SummarySweep {
  private readonly heads = new Map<string, string | null>();
  private readonly lastPass = new Map<string, number>();
  private readonly poked = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private passing: Promise<void> | null = null;
  private stopped = false;
  constructor(private readonly deps: SummarySweepDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Start the timer: the first pass (the backfill) after `firstMs`, then a look every `tickMs`. */
  start(firstMs = FIRST_MS, tickMs = TICK_MS): void {
    const loop = (ms: number) => {
      if (this.stopped) return;
      this.timer = setTimeout(() => void this.tick().finally(() => loop(tickMs)), ms);
      this.timer.unref?.();
    };
    loop(firstMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A branch's chat was read idle, or something else the list rests on moved: the root's next look passes. */
  poke(root: string): void {
    this.poked.add(root);
  }

  /** One look: a pass for each root whose target moved, that was poked, never passed, or passed FULL_EVERY_MS ago.
   *  One look at a time. */
  tick(): Promise<void> {
    if (this.passing) return this.passing;
    this.passing = this.look().finally(() => (this.passing = null));
    return this.passing;
  }

  private async look(): Promise<void> {
    for (const root of [...this.deps.roots()]) {
      if (this.stopped) return;
      try {
        const head = await this.deps.targetHead(root);
        const moved = !this.heads.has(root) || this.heads.get(root) !== head;
        const due = this.now() - (this.lastPass.get(root) ?? -Infinity) >= FULL_EVERY_MS;
        if (!moved && !due && !this.poked.has(root)) continue;
        this.poked.delete(root);
        this.heads.set(root, head);
        this.lastPass.set(root, this.now());
        await this.pass(root);
      } catch (err) {
        this.deps.log?.(`[summary-sweep] ${root}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Ask for each idle row's bullets; a known failure gets its one automatic retry once cooled down. Returns how many
   *  writes it queued. */
  async pass(root: string): Promise<number> {
    let n = 0;
    for (const row of await this.deps.readyOf(root)) {
      const idle = !row.session || !!row.sessionArchived || (await this.deps.chatIdle(row.session).catch(() => false));
      if (!idle) continue;
      const r = this.deps.summaries.ensure(root, row.branch, row.commit);
      if (r.result === "started") n++;
      else if (r.result === "known" && this.deps.summaries.autoRetry(root, row.branch, row.commit, this.deps.retryAfterMs ?? AUTO_RETRY_AFTER_MS).result === "started") n++;
    }
    return n;
  }
}
