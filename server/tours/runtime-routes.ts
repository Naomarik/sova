import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isTourId, isTourOrigin } from "../../shared/tour";
import type { TourAccountInput } from "./accounts";
import { tourCallerBySession } from "./context";
import { ensureTourToolRuntime, type TourRuntime } from "./runtime";
import type { TourToolCaller } from "./tools";

type Runtime = Pick<TourRuntime, "status" | "cancel" | "approve" | "approveAll" | "saveAccount" | "signIn" | "reRecord" | "latest" | "revokeSite" | "removeAccount">;
/** What the card sends: a form login or a one-time code, never both, never stored by this route. */
export type TourSignInInput = { origin: string; account?: string; username: string; password: string } | { origin: string; code: string };
// No C0 controls; a value that can't be typed into a field is refused, never trimmed silently.
const typable = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
/** Exactly one complete shape, or null. Never reports which value was wrong. */
export function tourSignInInput(v: unknown): TourSignInInput | null {
  if (!object(v) || !isTourOrigin(v.origin)) return null;
  const keys = Object.keys(v).sort().join(",");
  // A three-box sign-in adds an account (a site's pre-filled code box); whether the job asks for one is the runtime's check.
  if (keys === "origin,password,username" || keys === "account,origin,password,username") {
    const username = typeof v.username === "string" ? v.username.trim() : "";
    const account = "account" in v ? (typeof v.account === "string" ? v.account.trim() : "") : undefined;
    if (account !== undefined && !typable(account, 512)) return null;
    return typable(username, 512) && typable(v.password, 4096) ? { origin: v.origin, ...(account !== undefined ? { account } : {}), username, password: v.password } : null;
  }
  if (keys === "code,origin") return typable(v.code, 64) ? { origin: v.origin, code: v.code } : null;
  return null;
}
export interface TourJobRouteOptions {
  runtime?: () => Runtime;
  caller?: (sessionId: string) => Promise<TourToolCaller>;
  owned?: (sessionId: string) => Promise<boolean>;
  /** Synchronous: the chat is still its owner and not deleted (tourOwnerCurrent). Checked after the last await. */
  current?: (sessionId: string) => boolean;
}
const json = bodyLimit({ maxSize: 16 * 1024 });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const NO_BODY = Symbol("no body");
const MALFORMED = Symbol("malformed");
/** Read a body without throwing, so a deleted chat answers 404 before any shape check. */
async function readBody(c: Context): Promise<unknown> {
  const raw = await c.req.text().catch(() => null);
  if (raw === null) return MALFORMED;
  if (!raw.trim()) return NO_BODY;
  try { return JSON.parse(raw) as unknown; } catch { return MALFORMED; }
}
/** Operator listener only; never mounted on share. Every action independently verifies its chat. */
export function mountTourJobRoutes(app: Hono, options: TourJobRouteOptions = {}): void {
  const runtime = options.runtime ?? ensureTourToolRuntime;
  const owned = options.owned ?? (async sid => (await import("../tour-routes")).tourSessionOwned(sid));
  const caller = options.caller ?? tourCallerBySession;
  const currentCheck = async (): Promise<(sid: string) => boolean> => options.current ?? (await import("./ownership")).tourOwnerCurrent;
  // A chat deleted while admission awaited is indistinguishable from a missing one: the last check
  // is synchronous, after every await, and precedes any body validation or runtime call.
  const authorized = async (c: Context): Promise<TourToolCaller | null> => {
    const sid = c.req.param("sessionId");
    if (!sid) return null;
    const current = await currentCheck();
    if (!await owned(sid)) return null;
    const context = await caller(sid);
    return context.sessionId === sid && current(sid) ? context : null;
  };
  const missing = (c: Context) => c.json({ error: "Recording not found.", code: "not-found" }, 404);
  const failed = (c: Context) => c.json({ error: "That recording action could not finish. Check its chat and recording report, then retry.", code: "recording-refused" }, 409);
  const badRequest = (c: Context, error: string) => c.json({ error, code: "bad-request" }, 400);
  /** A runtime refusal: 409 while the chat still owns the recording, else the same 404 as a missing chat. */
  const refused = async (c: Context) => {
    const sid = c.req.param("sessionId");
    try { if (sid && (await currentCheck())(sid)) return failed(c); } catch { /* unknown owner: missing */ }
    return missing(c);
  };
  const JOB = "/api/tours/:sessionId/jobs/:jobId";
  app.get(JOB, async c => {
    c.header("Cache-Control", "no-store");
    try { const ctx = await authorized(c); if (!ctx || !isTourId(c.req.param("jobId"))) return missing(c); return c.json((await runtime().status(ctx, c.req.param("jobId"))).job); }
    catch { return missing(c); }
  });
  app.post(`${JOB}/cancel`, json, async c => {
    try { await readBody(c); const ctx = await authorized(c); if (!ctx || !isTourId(c.req.param("jobId"))) return missing(c); return c.json((await runtime().cancel(ctx, c.req.param("jobId"))).job); }
    catch { return refused(c); }
  });
  app.post(`${JOB}/approve`, json, async c => {
    try {
      const input = await readBody(c);
      const ctx = await authorized(c); if (!ctx || !isTourId(c.req.param("jobId"))) return missing(c);
      if (!object(input) || !exact(input, ["origin"]) || !isTourOrigin(input.origin)) return badRequest(c, "Approve one exact requested origin.");
      return c.json(await runtime().approve(ctx, c.req.param("jobId"), input.origin));
    } catch { return refused(c); }
  });
  // Form sign-in or one-time code for a job waiting in needs-sign-in. The reply is the job and nothing
  // else; every refusal is fixed copy, so no field, value or runtime message can reach the response.
  app.post(`${JOB}/sign-in`, json, async c => {
    try {
      const raw = await readBody(c);
      const ctx = await authorized(c); if (!ctx || !isTourId(c.req.param("jobId"))) return missing(c);
      const input = tourSignInInput(raw);
      if (!input) return badRequest(c, "Send the sign-in details the card asks for: a username and password (and an account, when asked), or a one-time code.");
      return c.json(await runtime().signIn(ctx, c.req.param("jobId"), input));
    } catch { return refused(c); }
  });
  // Approve All: exactly the origins the card showed; the runtime refuses unless they equal the job's list.
  app.post(`${JOB}/approve-all`, json, async c => {
    try {
      const input = await readBody(c);
      const ctx = await authorized(c); if (!ctx || !isTourId(c.req.param("jobId"))) return missing(c);
      if (!object(input) || !exact(input, ["origins"]) || !Array.isArray(input.origins) || !input.origins.length || input.origins.length > 16 || !input.origins.every(isTourOrigin) || new Set(input.origins).size !== input.origins.length) return badRequest(c, "Approve the exact list of requested origins.");
      return c.json(await runtime().approveAll(ctx, c.req.param("jobId"), input.origins as string[]));
    } catch { return refused(c); }
  });
  app.post(`${JOB}/account`, json, async c => {
    try {
      const input = await readBody(c);
      const ctx = await authorized(c); if (!ctx || !isTourId(c.req.param("jobId"))) return missing(c);
      if (!object(input) || !exact(input, ["origin", "username", "password", "testAccount"]) || !isTourOrigin(input.origin) || typeof input.username !== "string" || typeof input.password !== "string" || input.testAccount !== true) return badRequest(c, "Use a test account for the exact requested origin.");
      return c.json(await runtime().saveAccount(ctx, c.req.param("jobId"), input as unknown as TourAccountInput));
    } catch { return refused(c); }
  });
  app.post("/api/tours/:sessionId/:tourId/re-record", json, async c => {
    try {
      // There are deliberately no source, session, cwd, sandbox or script fields in this request.
      const input = await readBody(c);
      const ctx = await authorized(c); if (!ctx || !isTourId(c.req.param("tourId"))) return missing(c);
      if (input !== NO_BODY && (!object(input) || Object.keys(input).length)) return badRequest(c, "Re-record takes no authoring or caller parameters.");
      return c.json(await runtime().reRecord(ctx, c.req.param("tourId")));
    } catch { return refused(c); }
  });
  // Revoke Site and Remove Account: installation-wide, for an exact origin this chat's tour uses. A
  // deleted chat or another chat's request is the same 404, before the stores are read or changed.
  for (const [path, act] of [["approvals", "revokeSite"], ["accounts", "removeAccount"]] as const) {
    app.delete(`/api/tours/:sessionId/:tourId/${path}`, json, async c => {
      try {
        const input = await readBody(c);
        const ctx = await authorized(c); if (!ctx || !isTourId(c.req.param("tourId"))) return missing(c);
        if (!object(input) || !exact(input, ["origin"]) || !isTourOrigin(input.origin)) return badRequest(c, "Name one exact site this tour uses.");
        return c.json(runtime()[act](ctx, c.req.param("tourId"), input.origin));
      } catch { return refused(c); }
    });
  }
  app.get("/api/tours/:sessionId/:tourId", async c => {
    c.header("Cache-Control", "no-store");
    try { const ctx = await authorized(c); if (!ctx || !isTourId(c.req.param("tourId"))) return missing(c); return c.json(runtime().latest(ctx.sessionId, c.req.param("tourId"))); }
    catch { return missing(c); }
  });
}
