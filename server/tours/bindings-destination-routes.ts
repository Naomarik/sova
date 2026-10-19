import type { Context, Hono } from "hono";
import type { HEntry } from "../../shared/harness";
import { isTourHandle } from "../../shared/tour";
import { batonById, sessionPathOf } from "../baton";
import { readView, refreshShare } from "../share/hub";
import { visibleTour } from "./bindings";
import { bindingWriter, inDestination, type BindingWriter } from "./bindings-routes";
import { invalidatePreviews } from "./shares";

const missing = (c: Context) => c.json({ error: "Not found" }, 404);
const sessionOwned = async (session: string): Promise<boolean> => (await import("../tour-routes")).tourSessionOwned(session);
type Hit = NonNullable<ReturnType<typeof batonById>>;

async function attachedIn(hit: Hit) {
  const out: { branch?: HEntry[] } = {};
  const view = await readView(hit.row, hit.dir, undefined, undefined, out);
  return { view, branch: out.branch ?? [] };
}

/**
 * The operator's own view of a hand-off conversation: its attached tours, and Detach keyed by the
 * conversation itself. A tour that outlived its deleted source chat, or arrived with a restored
 * organization, can still be detached. Operator listener only (DELETE under /api/orgs is `admin`
 * for a peer). Neither route reads a snapshot, so an unreadable or missing one can still be detached.
 */
export function mountTourDestinationRoutes(app: Hono, owned: (session: string) => Promise<boolean> = sessionOwned, writer: BindingWriter = bindingWriter): void {
  const base = "/api/orgs/:id/conversations/:session/tours";
  const conversation = async (c: Context): Promise<Hit | null> => {
    const hit = batonById(c.req.param("session") ?? "");
    return hit && hit.row.orgId === c.req.param("id") && (await owned(hit.row.sessionId)) ? hit : null;
  };
  app.get(base, async c => {
    c.header("Cache-Control", "no-store");
    const hit = await conversation(c);
    if (!hit) return missing(c);
    const { view, branch } = await attachedIn(hit);
    const seen = new Set<string>();
    // A tour the model showed again appears twice in the view; the list names each attachment once.
    return c.json(view.items.flatMap(item => {
      if (item.kind !== "tour" || seen.has(item.handle) || !visibleTour(view, branch, item.handle)) return [];
      seen.add(item.handle);
      return [{ handle: item.handle, title: item.title, summary: item.summary, steps: item.steps }];
    }));
  });
  app.delete(`${base}/:handle`, async c => {
    const handle = c.req.param("handle") ?? "";
    if (!isTourHandle(handle)) return missing(c);
    const hit = await conversation(c);
    if (!hit) return missing(c);
    // The same per-destination serialization as attach and the source-keyed detach.
    return inDestination(hit.row.sessionId, async () => {
      const latest = batonById(hit.row.sessionId);
      if (!latest || latest.row.orgId !== hit.row.orgId || latest.dir !== hit.dir) return missing(c);
      const { view, branch } = await attachedIn(latest);
      if (!visibleTour(view, branch, handle)) return missing(c);
      // Any outstanding destination review predating this revocation must be reviewed afresh.
      invalidatePreviews(`baton:${latest.row.sessionId}`);
      await writer.detach(sessionPathOf(latest.dir, latest.row), handle);
      refreshShare(latest.row.sessionId);
      return c.json({ ok: true });
    });
  });
}
