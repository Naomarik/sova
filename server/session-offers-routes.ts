import { existsSync } from "node:fs";
import type { Context, Hono } from "hono";
import type { ProjectOffersAnswer, SessionOffersAnswer } from "../shared/session-offers";
import { OrgError } from "./org-error";
import { resolveSessionPath } from "./paths";
import { readProject } from "./projects/spaces";
import { canonicalRoot, chooseAllAt, chooseOfferAt, notNowAt, OfferRefusal, projectOffers, readOffersFile, sessionOffersAt, sessionPathOf, showOffer } from "./session-offers";
import { approveRuns } from "./session-offers-trust";

/**
 * Session offers' routes (§chat/offers). A session's cards and its clicks; another chat's show
 * (§chat.offers/from-another-chat); the project page's list and its run-button approval, a trust
 * grant (§chat.offers/approval). Every answer is no-store.
 */

const NO_STORE = { "Cache-Control": "no-store" };

const handle =
  (fn: (c: Context) => Promise<Response>) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof OfferRefusal) return c.json({ error: err.message }, err.status, NO_STORE);
      if (err instanceof OrgError) return c.json({ error: err.message }, err.status, NO_STORE);
      throw err;
    }
  };

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    throw new OfferRefusal("Expected a JSON body.", 400);
  }
}

/** The session a request names by `path`: a .jsonl under the sessions dir that exists. */
function sessionPath(raw: unknown): string {
  const path = resolveSessionPath(typeof raw === "string" ? raw : null);
  if (!path) throw new OfferRefusal("Invalid or missing path (must be a .jsonl under the pi sessions dir)", 400);
  if (!existsSync(path)) throw new OfferRefusal("Session file not found", 404);
  return path;
}

const offerName = (raw: unknown): string => {
  if (typeof raw !== "string" || !raw) throw new OfferRefusal("offer must name an offer", 400);
  return raw;
};

export function registerSessionOfferRoutes(app: Hono<any>): void {
  app.get(
    "/api/session-offers",
    handle(async (c) => c.json((await sessionOffersAt(sessionPath(c.req.query("path")))) satisfies SessionOffersAnswer, 200, NO_STORE)),
  );
  // Another chat shows an offer in this one (§chat.offers/from-another-chat).
  app.post(
    "/api/session-offers/show",
    handle(async (c) => {
      const b = await body(c);
      const path = sessionPath(b.path);
      let from: string | undefined;
      if (b.from !== undefined) {
        if (typeof b.from !== "string" || !b.from) throw new OfferRefusal("from names a session by id or path", 400);
        from = await sessionPathOf(b.from, resolveSessionPath);
        if (!from || !existsSync(from)) throw new OfferRefusal("The session in from doesn't exist.", 404);
      }
      if (b.note !== undefined && typeof b.note !== "string") throw new OfferRefusal("note must be a string", 400);
      const card = await showOffer({ path, offer: offerName(b.offer), by: "another-chat", ...(typeof b.note === "string" ? { note: b.note } : {}), ...(from ? { from } : {}), ...(b.rows !== undefined ? { rows: b.rows } : {}) });
      return c.json({ card }, 200, NO_STORE);
    }),
  );
  // A button's click (§chat.offers/card): on a rows card, one row's (`row`), or the all button over the rows it
  // named (`all`, the row ids its confirm listed).
  app.post(
    "/api/session-offers/choose",
    handle(async (c) => {
      const b = await body(c);
      const path = sessionPath(b.path);
      if (typeof b.card !== "string" || !b.card) throw new OfferRefusal("card names an offer card (of_N)", 400);
      if (b.all !== undefined) {
        if (!Array.isArray(b.all) || !b.all.length || b.all.length > 10 || !b.all.every((r) => typeof r === "string" && /^r_[1-9][0-9]*$/.test(r))) throw new OfferRefusal("all lists the row ids its confirm named (r_N)", 400);
        if (b.button !== undefined || b.row !== undefined) throw new OfferRefusal("all goes without button and row", 400);
        return c.json({ card: await chooseAllAt(path, b.card, b.all as string[]) }, 200, NO_STORE);
      }
      if (b.row !== undefined && (typeof b.row !== "string" || !/^r_[1-9][0-9]*$/.test(b.row))) throw new OfferRefusal("row names a row of the card (r_N)", 400);
      if (b.button === undefined) throw new OfferRefusal("Name the button pressed (button, from 0), or all on a rows card", 400);
      if (typeof b.button !== "number" || !Number.isInteger(b.button) || b.button < 0) throw new OfferRefusal("button is the button's number, from 0", 400);
      return c.json({ card: await chooseOfferAt(path, b.card, b.button, b.row as string | undefined) }, 200, NO_STORE);
    }),
  );
  // Not Now, and its undo.
  for (const [route, on] of [["/api/session-offers/snooze", true], ["/api/session-offers/unsnooze", false]] as const)
    app.post(
      route,
      handle(async (c) => {
        const b = await body(c);
        const path = sessionPath(b.path);
        return c.json({ notNow: await notNowAt(path, offerName(b.offer), on) }, 200, NO_STORE);
      }),
    );
  // The project page's Offers list (§chat.offers/project-list).
  app.get(
    "/api/projects/:pid/offers",
    handle(async (c) => {
      const project = readProject(c.req.param("pid") ?? "");
      return c.json(projectOffers(canonicalRoot(project.root)) satisfies ProjectOffersAnswer, 200, NO_STORE);
    }),
  );
  // Approve the file's run buttons as seen: a trust grant, never a catalogue command (§chat.offers/approval).
  app.post(
    "/api/projects/:pid/offers/approve",
    handle(async (c) => {
      const project = readProject(c.req.param("pid") ?? "");
      const b = await body(c);
      const root = canonicalRoot(project.root);
      try {
        approveRuns(root, readOffersFile(root), b.fingerprint);
      } catch (err) {
        throw new OfferRefusal(err instanceof Error ? err.message : String(err), 409);
      }
      return c.json(projectOffers(root) satisfies ProjectOffersAnswer, 200, NO_STORE);
    }),
  );
}
