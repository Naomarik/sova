import type { Context, Hono } from "hono";
import type { ProjectList, ProjectRegistered } from "../../shared/projects";
import { BusyError } from "../chat-manager";
import { localRequest } from "../mesh/proxy";
import { OrgError } from "../org-error";
import { OVERSEER_CARD_HEADER, OVERSEER_SENDER_HEADER, overseerCard, overseerSender } from "../overseer-sender";
import { cancelHeld } from "../project-holds";
import { archiveBlockers } from "../project-overseer";
import { nudgeMarks } from "../session-feed";
import { cloneRepo } from "./clone";
import { RegistryError } from "./registry";
import { editProject, listProjects, readProject, registerProjectIn, setProjectArchived, type OperatorBy } from "./spaces";

/**
 * The project layer's routes (§app/projects): list and register projects, read, rename, move, archive and
 * unarchive one, and cancel one of its held acts. A project is found by its id in whichever engine holds it.
 * Registering is the operator's own gesture on this host: never through a peer.
 */

const NO_STORE = { "Cache-Control": "no-store" };

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    if (typeof b === "object" && b !== null && !Array.isArray(b)) return b;
  } catch {}
  throw new OrgError("Expected a JSON object body");
}

const handle =
  (fn: (c: Context) => Promise<Response> | Response) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message }, err.status);
      if (err instanceof RegistryError) return c.json({ error: err.message }, err.status);
      if (err instanceof BusyError) return c.json({ error: err.message }, 409);
      throw err;
    }
  };

/** The operator, or the global Overseer acting for them (its own in-process call), with the confirm card its
    call carried: a card-gated act (archive) checks the card (§app.overseer/org-attribution). */
function operatorBy(c: Context): OperatorBy {
  const overseerId = overseerSender(c.req.header(OVERSEER_SENDER_HEADER));
  if (!overseerId) return { kind: "operator" };
  const card = overseerCard(c.req.header(OVERSEER_CARD_HEADER));
  return { kind: "operator", via: "overseer", overseerId, ...(card ? { card } : {}) };
}

const pidOf = (c: Context): string => c.req.param("pid") ?? "";

export function registerProjectRoutes(app: Hono<any>): void {
  app.get("/api/projects", handle((c) => c.json({ projects: listProjects() } satisfies ProjectList, 200, NO_STORE)));

  // Add Project (a folder, a session's folder) or Clone from GitHub: the operator's, on this host only.
  app.post(
    "/api/projects",
    handle(async (c) => {
      if (!localRequest(c)) return c.json({ error: "Projects are added on their own host." }, 403);
      const b = await body(c);
      let out: ProjectRegistered;
      if (b.clone !== undefined) {
        const cl = b.clone as Record<string, unknown> | null;
        if (!cl || typeof cl !== "object" || typeof cl.repo !== "string" || typeof cl.parent !== "string") throw new OrgError("clone must be { repo, parent, folder? }");
        const repo = cl.repo.trim();
        const { dir } = await cloneRepo({ repo, parent: cl.parent, ...(typeof cl.folder === "string" && cl.folder.trim() ? { folder: cl.folder.trim() } : {}) });
        out = await registerProjectIn("standalone", dir, { name: b.name, origin: "clone", remote: repo });
      } else {
        out = await registerProjectIn("standalone", b.root, { name: b.name, origin: b.origin === "session" ? "session" : "folder" });
      }
      nudgeMarks();
      return c.json(out, 201);
    }),
  );

  app.get("/api/projects/:pid", handle((c) => c.json(readProject(pidOf(c)), 200, NO_STORE)));

  app.patch(
    "/api/projects/:pid",
    handle(async (c) => {
      const b = await body(c);
      return c.json(await editProject(pidOf(c), { name: b.name, root: b.root }, operatorBy(c)), 200, NO_STORE);
    }),
  );

  // Archive (§app.organizations/archive): refused while anything in it is open, naming each.
  app.post(
    "/api/projects/:pid/archive",
    handle(async (c) => {
      const pid = pidOf(c);
      readProject(pid);
      const out = await setProjectArchived(pid, true, operatorBy(c), await archiveBlockers(pid));
      nudgeMarks(); // its sessions leave their region: re-diff the list now
      return c.json(out, 200, NO_STORE);
    }),
  );
  app.post(
    "/api/projects/:pid/unarchive",
    handle(async (c) => {
      const out = await setProjectArchived(pidOf(c), false, operatorBy(c));
      nudgeMarks();
      return c.json(out, 200, NO_STORE);
    }),
  );

  // Needs you's Cancel on a held act of the project, whichever of its engine's statecharts holds it.
  app.post(
    "/api/projects/:pid/held/:holdId/cancel",
    handle(async (c) => {
      const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
      const reason = typeof (b as Record<string, unknown>).reason === "string" ? ((b as Record<string, unknown>).reason as string).trim() : undefined;
      const by = operatorBy(c);
      await cancelHeld(pidOf(c), c.req.param("holdId") ?? "", reason || undefined, { by: "operator", attended: true, ...(by.via ? { via: by.via, overseerId: by.overseerId } : {}) });
      return c.json({ ok: true });
    }),
  );
}
