import type { Context, Hono } from "hono";
import type { AssistantInfo, PricedPick } from "../shared/project-assistant";
import { WORK_KINDS } from "../shared/powers";
import { attentionChanged } from "./attention-memo";
import { OrgError, readIndex, readOrgOrPlaceholder } from "./orgs";
import { assistantSeesImages, currentAssistantPath, ensureAssistant, refreshAssistant } from "./project-assistant";
import { assistantReplyState } from "./project-assistant-ready";
import { assistantDefault, assistantPicksAdopted, markAssistantPicksAdopted, readBatonSettings, writeAssistantDefault, writeBatonSettings } from "./baton-settings";
import type { BatonSettings } from "../shared/baton";
import { pricedPick } from "./project-assistant-prices";
import { adoptDefaultPicks, effectiveAssistantModel, orgRequests, samePick, setAssistantModels, setRequestStatus } from "./project-assistant-store";
import { assistantProjects } from "./project-assistant-tools";
import { HasChatError, startRequestChat, withChats } from "./owner-request-chat";
import { projectOverseerPaths, readPoSettings, sessionIdOfFile } from "./project-overseer-store";

/**
 * The operator's side of the Project Assistant (§app.project-assistant/models, /requests, /chat,
 * /request-chat), main listener only: the Owner card's data, its models, closing a request, a
 * request's Start Chat, and opening the conversation.
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

/** The Owner card's Project Assistant part: each kind resolved (its own pick, else the default) with its source. */
export async function assistantInfo(orgId: string): Promise<AssistantInfo> {
  readOrgOrPlaceholder(orgId);
  const fallback = assistantDefault();
  const models: AssistantInfo["models"] = {};
  for (const k of WORK_KINDS) {
    const r = effectiveAssistantModel(orgId, k, null, fallback);
    models[k] = r ? { ...pricedPick(r.pick)!, source: r.source } : null;
  }
  const projects = assistantProjects(orgId).map((pr) => {
    const o = projectModels(pr.id);
    const coding = effectiveAssistantModel(orgId, "coding", o, fallback);
    const gathering = effectiveAssistantModel(orgId, "gathering", o, fallback);
    return {
      projectId: pr.id,
      name: pr.name,
      coding: { pick: pricedPick(coding?.pick ?? null), source: coding?.source ?? null },
      gathering: { pick: pricedPick(gathering?.pick ?? null), source: gathering?.source ?? null },
    };
  });
  const path = await currentAssistantPath(orgId);
  const reply = await assistantReplyState(orgId).catch(() => null);
  return {
    models,
    default: pricedPick(fallback),
    ready: reply?.ready === true,
    replyProblem: reply?.problem ?? null,
    projects,
    sessionId: path ? sessionIdOfFile(path) : null,
    requests: await withChats(orgRequests(orgId)),
    seesPhotos: await assistantSeesImages(orgId).catch(() => false),
  };
}

/** GET /api/baton/settings: the host's settings, the Project Assistant's default with its price. */
export function batonSettingsView(): BatonSettings {
  const s = readBatonSettings();
  return { ...s, assistant: pricedPick(s.assistant ?? null) };
}

/** PUT /api/baton/settings (Settings → Organizations' Save Changes): never the assistant's default (its own route). */
export function saveBatonSettings(body: unknown): BatonSettings {
  const result = writeBatonSettings(body);
  if ("error" in result) throw new OrgError(result.error, 400);
  return { ...result, assistant: pricedPick(result.assistant ?? null) };
}

/**
 * PUT /api/settings/project-assistant {assistant} (Settings → Organizations' Save Changes, when the
 * default changed): its own route so a mesh peer needs `admin` for it, as for an org's own pick
 * (server/mesh/access.ts: `settings` writes). Saving the host's FIRST default adopts, once, every
 * org's pick that equals it exactly (§app.project-assistant/models); later saves never clear a pick.
 * A change refreshes every owner page's assistant view (orgs that follow it move with it).
 */
export function saveAssistantDefault(body: unknown): { assistant: PricedPick | null } {
  const before = assistantDefault();
  const result = writeAssistantDefault(body);
  if ("error" in result) throw new OrgError(result.error, 400);
  const next = result.assistant;
  if (next && !assistantPicksAdopted()) {
    if (!before) adoptDefaultPicks(next);
    markAssistantPicksAdopted();
  }
  if (!(before && next ? samePick(before, next) : before === next))
    for (const o of readIndex().orgs) {
      try {
        refreshAssistant(o.id);
      } catch {
        /* a view refresh is best-effort */
      }
    }
  return { assistant: pricedPick(next) };
}

export function registerAssistantRoutes(app: Hono<any>): void {
  app.put(
    "/api/settings/project-assistant",
    handle(async (c) => c.json(saveAssistantDefault(await body(c)))),
  );
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
  // Start Chat (§app.project-assistant/request-chat): a project chat with the request as a note; 409 with the chat it has.
  app.post("/api/orgs/:id/owner/requests/:rid/chat", async (c) => {
    try {
      const out = await startRequestChat(p(c, "id"), p(c, "rid"));
      attentionChanged();
      return c.json(out);
    } catch (err) {
      if (err instanceof HasChatError) return c.json({ error: err.message, code: err.code, sessionId: err.chat.sessionId, path: err.chat.path }, 409);
      if (err instanceof OrgError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
      throw err;
    }
  });
  // Open Assistant Chat: the owner's conversation, made when there is none yet.
  app.post(
    "/api/orgs/:id/owner/assistant/open",
    handle(async (c) => {
      const conv = await ensureAssistant(p(c, "id"));
      return c.json({ sessionId: conv.id, path: conv.path });
    }),
  );
}
