import type { Context, Hono } from "hono";
import type { AssistantInfo } from "../shared/project-assistant";
import { WORK_KINDS } from "../shared/powers";
import { attentionChanged } from "./attention-memo";
import { OrgError, readOrgOrPlaceholder } from "./orgs";
import { assistantSeesImages, currentAssistantPath, ensureAssistant, refreshAssistant } from "./project-assistant";
import { pricedPick } from "./project-assistant-prices";
import { assistantModelFor, orgRequests, readAssistantStore, setAssistantModels, setRequestStatus } from "./project-assistant-store";
import { assistantProjects } from "./project-assistant-tools";
import { projectOverseerPaths, readPoSettings, sessionIdOfFile } from "./project-overseer-store";

/**
 * The operator's side of the Project Assistant (§app.project-assistant/models, /requests, /chat), main
 * listener only: the Owner card's data, its models, closing a request, and opening the conversation.
 */

const p = (c: Context, name: string): string => c.req.param(name) ?? "";
async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return typeof b === "object" && b !== null && !Array.isArray(b) ? b : {};
  } catch {
    throw new OrgError("Expected a JSON object body");
  }
}
const handle =
  (fn: (c: Context) => Promise<Response> | Response) =>
  async (c: Context): Promise<Response> => {
    try {
      const res = await fn(c);
      if (c.req.method !== "GET" && res.ok) attentionChanged();
      return res;
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
      throw err;
    }
  };

const projectModels = (projectId: string) => {
  try {
    return readPoSettings(projectOverseerPaths(projectId)).powers?.assistantModels ?? null;
  } catch {
    return null;
  }
};

/** The Owner card's Project Assistant part. */
export async function assistantInfo(orgId: string): Promise<AssistantInfo> {
  readOrgOrPlaceholder(orgId);
  const s = readAssistantStore(orgId);
  const models: AssistantInfo["models"] = {};
  for (const k of WORK_KINDS) models[k] = pricedPick(s.models[k] ?? null);
  const projects = assistantProjects(orgId).map((pr) => {
    const o = projectModels(pr.id);
    const coding = assistantModelFor(orgId, "coding", o);
    const gathering = assistantModelFor(orgId, "gathering", o);
    return { projectId: pr.id, name: pr.name, coding: { pick: pricedPick(coding.pick), source: coding.source }, gathering: { pick: pricedPick(gathering.pick), source: gathering.source } };
  });
  const path = await currentAssistantPath(orgId);
  return { models, projects, sessionId: path ? sessionIdOfFile(path) : null, requests: orgRequests(orgId), seesPhotos: await assistantSeesImages(orgId).catch(() => false) };
}

export function registerAssistantRoutes(app: Hono<any>): void {
  app.get(
    "/api/orgs/:id/owner/assistant",
    handle(async (c) => c.json(await assistantInfo(p(c, "id")))),
  );
  app.put(
    "/api/orgs/:id/owner/assistant",
    handle(async (c) => {
      const id = p(c, "id");
      setAssistantModels(id, await body(c));
      refreshAssistant(id);
      return c.json(await assistantInfo(id));
    }),
  );
  app.post(
    "/api/orgs/:id/owner/requests/:rid",
    handle(async (c) => {
      const id = p(c, "id");
      const b = await body(c);
      if (b.status !== "done" && b.status !== "declined") throw new OrgError('status is "done" or "declined".');
      setRequestStatus(id, p(c, "rid"), b.status);
      return c.json(await assistantInfo(id));
    }),
  );
  // Open Assistant Chat: the owner's conversation, made when there is none yet.
  app.post(
    "/api/orgs/:id/owner/assistant/open",
    handle(async (c) => {
      const conv = await ensureAssistant(p(c, "id"));
      return c.json({ sessionId: conv.id, path: conv.path });
    }),
  );
}
