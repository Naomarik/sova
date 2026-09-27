import type { Hono } from "hono";
import type { BatonInfo } from "../shared/baton";
import { batonById, clearWrapup, sessionPathOf, setWrapup } from "./baton";
import { BATON_TOOLS } from "./baton-loadout";
import { runWrapup, wrapupActive } from "./baton-wrapup";
import { heldChat } from "./chat-manager";
import { batonInfo } from "./org-routes";

/**
 * Retry Wrap-Up (§app.organizations/wrap-up): the operator runs a failed wrap-up again. Only a
 * `failed` one, and only when no wrap-up and no reply is running in the session. The wrap-up never
 * retries on its own (a model that degenerated once may do it again); this is the operator's call.
 */

class RetryError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

const settled = (p: Promise<unknown>) => p.then(
  () => undefined,
  () => undefined,
);
/** Resolve when `ok()` holds, polling every 25 ms, or after `ms`. */
async function until(ok: () => boolean, ms: number): Promise<void> {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 25));
}

/**
 * Clear the failed record and start the wrap-up again. Answers once the row shows the new run
 * (`running`, or already its end), so the strip can show it straight away.
 */
export async function retryWrapup(sessionId: string, tools: readonly string[] = BATON_TOOLS): Promise<BatonInfo> {
  const hit = batonById(sessionId);
  if (!hit) throw new RetryError("Unknown baton session", 404);
  const before = hit.row.wrapup;
  if (before?.state !== "failed") throw new RetryError("Only a wrap-up that stopped can be retried.", 409);
  if (wrapupActive(sessionId)) throw new RetryError("The wrap-up is already running.", 409);
  if (heldChat(sessionPathOf(hit.dir, hit.row))?.session.isStreaming) throw new RetryError("A reply is running in this session. Retry when it finishes.", 409);
  clearWrapup(sessionId);
  let result: Awaited<ReturnType<typeof runWrapup>> | undefined;
  const run = runWrapup(sessionId, tools).then((r) => (result = r));
  run.catch((err) => console.warn(`[baton] wrap-up retry of ${sessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`));
  await Promise.race([settled(run), until(() => !!batonById(sessionId)?.row.wrapup, 2000)]);
  const row = batonById(sessionId)!.row;
  // It didn't start after all (a reply began in between): the failure stands, as it was.
  if (result === null && !row.wrapup) {
    setWrapup(sessionId, before);
    throw new RetryError("A reply is running in this session. Retry when it finishes.", 409);
  }
  return batonInfo(batonById(sessionId)!.row);
}

export function registerWrapupRoutes(app: Hono<any>): void {
  app.post("/api/baton/:sid/wrapup/retry", async (c) => {
    try {
      return c.json(await retryWrapup(c.req.param("sid") ?? ""));
    } catch (err) {
      if (err instanceof RetryError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });
}
