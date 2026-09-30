import { AsyncLocalStorage } from "node:async_hooks";
import { MINT_ACK_TIMEOUT_MS } from "../../shared/public-links";

/**
 * "This host's public link set changed" (§mesh.public/registry): a link minted or revoked. The
 * link stores (server/baton-links.ts, server/person-links.ts) call shareLinksChanged after the
 * write has landed on disk; the registry push (a routed host) listens and sends its gateway a new
 * snapshot. Expiry needs no event: a snapshot leaves out links past their `exp`, and the gateway
 * drops expired rows itself.
 *
 * Emitting never waits (a store's mint is synchronous). A route that mints runs the mint inside
 * awaitShareLinks, which waits, at most MINT_ACK_TIMEOUT_MS, for the listener answers to the
 * changes emitted inside it (and only those: a concurrent request's, or a stuck listener's, are
 * not its business), and turns them into the link's warning: a listener's own warning, else
 * `unconfirmed` when one is still pending at the deadline (`timedOut`) or failed (`failed`). A
 * listener races its own work against the deadline and answers in time. A listener that throws
 * never fails the mint.
 */

export interface ShareLinksChange {
  /** The link kind that changed: `h` hand-off, `i` owner page, `s` session share, `p` preview. */
  kind: "h" | "i" | "s" | "p";
  /** `mint`: new links; `revoke`: links stopped; `renew`: live links' expiry changed, none new. */
  cause: "mint" | "revoke" | "renew";
  /** A mint's exact new token hashes, when it made several (a session share mints one link per
      recipient): each is confirmed only when it was sent and accepted. Absent: the mint made
      exactly one new hash (the older stores' events). */
  hashes?: string[];
}

/** A listener's answer: nothing, or the warning to show with a just-minted link. */
export type ShareLinksListener = (change: ShareLinksChange) => void | { warning?: string } | Promise<void | { warning?: string }>;

export interface ShareLinksOutcome {
  /** The first warning a listener answered with, or null. */
  warning: string | null;
  /** A listener had not answered within the wait. */
  timedOut: boolean;
  /** A listener threw or rejected. */
  failed: boolean;
}

type Answer = { warning: string | null; failed: boolean };

const listeners = new Set<ShareLinksListener>();
/** The answers owed to the awaitShareLinks call the emit happened inside, if any. */
const scope = new AsyncLocalStorage<Promise<Answer>[]>();

/** Returns the unsubscribe. */
export function onShareLinksChanged(cb: ShareLinksListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Tell every listener; returns at once. */
export function shareLinksChanged(change: ShareLinksChange): void {
  const owed = scope.getStore();
  for (const cb of listeners) {
    const answer: Promise<Answer> = Promise.resolve()
      .then(() => cb(change))
      .then(
        (r) => ({ warning: (r && r.warning) || null, failed: false }),
        (err) => {
          console.warn(`[share] links-changed listener failed: ${(err as Error)?.name ?? "error"}`);
          return { warning: null, failed: true };
        },
      );
    owed?.push(answer);
  }
}

/** Run `mint` (sync or async), then wait up to `waitMs` for the answers to what it emitted. */
export async function awaitShareLinks<T>(mint: () => T | Promise<T>, waitMs = MINT_ACK_TIMEOUT_MS): Promise<{ result: T; outcome: ShareLinksOutcome }> {
  const owed: Promise<Answer>[] = [];
  const result = await scope.run(owed, mint);
  if (!owed.length) return { result, outcome: { warning: null, timedOut: false, failed: false } };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), waitMs);
  });
  try {
    const got = await Promise.race([Promise.all(owed), late]);
    if (got === "late") return { result, outcome: { warning: null, timedOut: true, failed: false } };
    return { result, outcome: { warning: got.find((a) => a.warning)?.warning ?? null, timedOut: false, failed: got.some((a) => a.failed) } };
  } finally {
    clearTimeout(timer);
  }
}
