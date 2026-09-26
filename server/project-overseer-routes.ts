import type { Context, Hono } from "hono";
import type { ItemCodeInput, ItemSendInput } from "../shared/project-overseer";
import type { IdeaUpdate } from "./overseer-ideas";
import { BusyError } from "./chat-manager";
import { OrgError } from "./orgs";
import { addIdea, IdeaConflictError, IdeaError, ideaDetail, ideasInfo, parseIdeaId, updateIdea } from "./overseer-ideas";
import { addTodo, clearDone, removeTodo, reorderTodos, TodoConflictError, TodoError, TodoNotFoundError, todosInfo, updateTodo } from "./overseer-todos";
import { clearProjectOverseer, codeItem, ensureProjectOverseer, lookNow, noteReason, patchProjectOverseer, projectOverseerInfo, sendItem } from "./project-overseer";
import { projectOf, projectOverseerPaths, type ProjectOverseerPaths } from "./project-overseer-store";
import { shareInfo } from "./share/listener";

/**
 * The operator's routes for project overseers (§app/project-overseer; the list is in
 * shared/project-overseer.ts). Main listener only. Ideas and to-dos use the Overseer's own stores
 * and wire shapes, at the project's paths, so the same panels render them.
 */

const NO_STORE = { "Cache-Control": "no-store" };
const linkUrl = (token: string): string => `${shareInfo().publicUrl ?? ""}/h/${token}`;

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    if (typeof b === "object" && b !== null && !Array.isArray(b)) return b;
  } catch {}
  throw new OrgError("Expected a JSON object body");
}

/** The project's paths (404 for an unknown org or project). */
function pathsOf(c: Context): ProjectOverseerPaths {
  const orgId = c.req.param("id") ?? "";
  const pid = c.req.param("pid") ?? "";
  projectOf(orgId, pid);
  return projectOverseerPaths(orgId, pid);
}

const handle =
  (fn: (c: Context) => Promise<Response> | Response) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message }, err.status);
      if (err instanceof BusyError) return c.json({ error: err.message }, 409);
      if (err instanceof IdeaConflictError) return c.json({ error: err.message, current: err.current }, 409);
      if (err instanceof IdeaError) return c.json({ error: err.message }, 400);
      if (err instanceof TodoConflictError) return c.json({ error: err.message, current: err.current }, 409);
      if (err instanceof TodoNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof TodoError) return c.json({ error: err.message }, 400);
      throw err;
    }
  };

export function registerProjectOverseerRoutes(app: Hono<any>): void {
  const base = "/api/orgs/:id/projects/:pid/overseer";
  app.get(base, handle(async (c) => {
    const p = pathsOf(c);
    return c.json(await projectOverseerInfo(p.orgId, p.projectId), 200, NO_STORE);
  }));
  app.post(base, handle(async (c) => {
    const p = pathsOf(c);
    await ensureProjectOverseer(p.orgId, p.projectId);
    return c.json(await projectOverseerInfo(p.orgId, p.projectId), 200, NO_STORE);
  }));
  app.patch(base, handle(async (c) => {
    const p = pathsOf(c);
    return c.json(await patchProjectOverseer(p.orgId, p.projectId, await body(c)), 200, NO_STORE);
  }));
  app.post(`${base}/clear`, handle(async (c) => {
    const p = pathsOf(c);
    return c.json(await clearProjectOverseer(p.orgId, p.projectId), 200, NO_STORE);
  }));
  app.post(`${base}/run`, handle(async (c) => {
    const p = pathsOf(c);
    const r = await lookNow(p.orgId, p.projectId, true);
    if (!r.started) return c.json({ error: `Not started: ${r.why ?? "unknown"}.` }, 409);
    return c.json(await projectOverseerInfo(p.orgId, p.projectId), 200, NO_STORE);
  }));
  app.get(`${base}/actions`, handle(async (c) => {
    const p = pathsOf(c);
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 50));
    const { readFileSync } = await import("node:fs");
    let lines: string[] = [];
    try {
      lines = readFileSync(p.actions, "utf8").split("\n").filter(Boolean);
    } catch {}
    const out: unknown[] = [];
    for (const l of lines.slice(-limit).reverse()) {
      try {
        out.push(JSON.parse(l));
      } catch {}
    }
    return c.json(out, 200, NO_STORE);
  }));

  // ---- ideas ------------------------------------------------------------------------------------
  app.get(`${base}/ideas`, handle((c) => c.json(ideasInfo(pathsOf(c).ideas), 200, NO_STORE)));
  app.post(`${base}/ideas`, handle(async (c) => {
    const p = pathsOf(c);
    const b = await body(c);
    addIdea({ id: b.id, title: b.title, text: b.text, tags: b.tags }, p.ideas);
    // The operator's items reach its next look: a reason to look, the item itself in its prompt.
    noteReason(p.orgId, p.projectId, "The operator added an idea.");
    return c.json(ideasInfo(p.ideas), 201, NO_STORE);
  }));
  app.get(`${base}/idea`, handle((c) => {
    const p = pathsOf(c);
    const id = parseIdeaId(c.req.query("id") ?? "")?.id;
    if (!id) return c.json({ error: "id must be an idea id, e.g. §gap/<name>" }, 400);
    const d = ideaDetail(id, p.ideas);
    return d ? c.json(d, 200, NO_STORE) : c.json({ error: `No idea ${id}` }, 404);
  }));
  app.patch(`${base}/idea`, handle(async (c) => {
    const p = pathsOf(c);
    const id = parseIdeaId(c.req.query("id") ?? "")?.id;
    if (!id) return c.json({ error: "id must be an idea id, e.g. §gap/<name>" }, 400);
    const b = await body(c);
    const patch: IdeaUpdate = {};
    for (const key of ["base", "title", "status", "text"] as const) {
      if (b[key] === undefined) continue;
      if (typeof b[key] !== "string") return c.json({ error: `${key} must be a string` }, 400);
      (patch as Record<string, unknown>)[key] = b[key];
    }
    for (const key of ["tags", "links"] as const) {
      if (b[key] === undefined) continue;
      if (!Array.isArray(b[key])) return c.json({ error: `${key} must be a list` }, 400);
      (patch as Record<string, unknown>)[key] = b[key];
    }
    if (b.newId !== undefined) return c.json({ error: "Renaming a project idea is not supported." }, 400);
    if (!ideaDetail(id, p.ideas)) return c.json({ error: `No idea ${id}` }, 404);
    return c.json(updateIdea(id, patch, p.ideas), 200, NO_STORE);
  }));

  // ---- to-dos ------------------------------------------------------------------------------------
  const todos = (p: ProjectOverseerPaths) => todosInfo(p.todos);
  app.get(`${base}/todos`, handle((c) => c.json(todos(pathsOf(c)), 200, NO_STORE)));
  app.post(`${base}/todos`, handle(async (c) => {
    const p = pathsOf(c);
    const b = await body(c);
    for (const key of ["text", "ideaId", "sessionId"] as const)
      if (b[key] !== undefined && typeof b[key] !== "string") return c.json({ error: `${key} must be a string` }, 400);
    addTodo({ text: b.text, ideaId: b.ideaId, sessionId: b.sessionId }, p.todos, p.ideas);
    noteReason(p.orgId, p.projectId, "The operator queued a to-do item.");
    return c.json(todos(p), 201, NO_STORE);
  }));
  app.patch(`${base}/todo`, handle(async (c) => {
    const p = pathsOf(c);
    const b = await body(c);
    const patch: Parameters<typeof updateTodo>[1] = {};
    for (const key of ["base", "text"] as const) {
      if (b[key] === undefined) continue;
      if (typeof b[key] !== "string") return c.json({ error: `${key} must be a string` }, 400);
      patch[key] = b[key] as string;
    }
    if (b.done !== undefined) {
      if (typeof b.done !== "boolean") return c.json({ error: "done must be true or false" }, 400);
      patch.done = b.done;
    }
    for (const key of ["ideaId", "sessionId"] as const) {
      if (b[key] === undefined) continue;
      if (b[key] !== null && typeof b[key] !== "string") return c.json({ error: `${key} must be a string or null` }, 400);
      patch[key] = b[key] as string | null;
    }
    updateTodo(c.req.query("id") ?? "", patch, p.todos, new Date(), p.ideas);
    return c.json(todos(p), 200, NO_STORE);
  }));
  app.delete(`${base}/todo`, handle((c) => {
    const p = pathsOf(c);
    removeTodo(c.req.query("id") ?? "", p.todos);
    return c.json(todos(p), 200, NO_STORE);
  }));
  app.put(`${base}/todos/order`, handle(async (c) => {
    const p = pathsOf(c);
    const b = await body(c);
    if (!Array.isArray(b.ids)) return c.json({ error: "Expected JSON body { ids: string[] }" }, 400);
    reorderTodos(b.ids, p.todos);
    return c.json(todos(p), 200, NO_STORE);
  }));
  app.delete(`${base}/todos/done`, handle((c) => {
    const p = pathsOf(c);
    clearDone(p.todos);
    return c.json(todos(p), 200, NO_STORE);
  }));

  // ---- items → people and sessions ------------------------------------------------------------------
  app.post(`${base}/items/send`, handle(async (c) => {
    const p = pathsOf(c);
    const b = (await body(c)) as unknown as ItemSendInput;
    const to = b.to;
    if (!(typeof to === "string" && to) && !(Array.isArray(to) && to.length && to.every((x) => typeof x === "string"))) return c.json({ error: "to must be a person id or a list of them" }, 400);
    return c.json(await sendItem(p.orgId, p.projectId, b, linkUrl), 201);
  }));
  app.post(`${base}/items/code`, handle(async (c) => {
    const p = pathsOf(c);
    return c.json(await codeItem(p.orgId, p.projectId, (await body(c)) as unknown as ItemCodeInput), 201);
  }));
}
