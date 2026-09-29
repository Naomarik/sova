import type { PublicLinksFile } from "../../shared/public-links";

/**
 * "The Public links setting changed" (§mesh.public/setting): PUT /api/public-links calls
 * publicLinksChanged with the file as written; the share listener (rebind) and the ingress
 * (start, stop, close admitted sockets) each subscribe inside their own start function. A
 * listener may be async (a rebind, a restart): a throw or a rejection is logged, never left
 * unhandled, and never stops the other listeners.
 */

type Listener = (file: PublicLinksFile) => void | Promise<void>;

const logFailure = (err: unknown) => console.warn(`[share] public-links listener failed: ${(err as Error)?.message ?? err}`);
const listeners = new Set<Listener>();

/** Returns the unsubscribe. */
export function onPublicLinksChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function publicLinksChanged(file: PublicLinksFile): void {
  for (const cb of listeners) {
    try {
      const done = cb(file);
      if (done instanceof Promise) done.catch(logFailure);
    } catch (err) {
      logFailure(err);
    }
  }
}
