import type { DesignChatView, DesignLinkUse, DesignSetup } from "../../shared/design";
import { ApiError, withJsonType } from "./api";
import { onAuthorized, onUnauthorized } from "./auth";
import { hostUrl, routeUrl } from "./mesh";

/** What a design route answers when a run needs a second press before it spends (q2). */
export interface DesignSpendAsk {
  needsConfirm: true;
  designs: number;
  estimateUsd?: number;
}

async function send(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(routeUrl(url, init?.body), withJsonType({ cache: "no-store", ...init }));
  } catch {
    throw new ApiError("The Sova server isn't reachable.", 0);
  }
  if (res.status === 401) onUnauthorized(await res.clone().json().catch(() => undefined));
  else if (res.ok) onAuthorized();
  return res;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await send(url, init);
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok) return body as T;
  const error = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `The design request failed (${res.status}).`;
  throw new ApiError(error, res.status, body);
}

const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** Every design route for one chat, named by its session file. */
export function designApi(path: string, host: string | null) {
  const url = (route: string, extra = "") => hostUrl(host, `/api/design${route}?path=${encodeURIComponent(path)}${extra}`);
  const label = (l: string) => `/${encodeURIComponent(l)}`;
  const run = (id: string) => `/runs/${encodeURIComponent(id)}`;
  return {
    view: () => json<DesignChatView>(url("")),
    setup: (runId: string, setup: DesignSetup) => json<unknown>(url(`${run(runId)}/setup`), { method: "PATCH", body: JSON.stringify(setup) }),
    /** Start Coordinator: asks for no money, that's Start on the brief. */
    start: (runId: string) => json<unknown>(url(`${run(runId)}/start`), post({})),
    /** Start on the brief, on the version you read: a spend ask comes back as a value, any other refusal throws. */
    briefStart: async (runId: string, rev: number, confirmSpend = false): Promise<DesignSpendAsk | null> => {
      try {
        await json<unknown>(url(`${run(runId)}/brief/start`), post({ rev, ...(confirmSpend ? { confirmSpend: true } : {}) }));
        return null;
      } catch (e) {
        const body = e instanceof ApiError ? e.body : undefined;
        if (e instanceof ApiError && e.status === 409 && body && typeof body === "object" && "needsConfirm" in body) return body as DesignSpendAsk;
        throw e;
      }
    },
    briefEdit: (runId: string, edit: { field: "summary" | "prompt" | "look"; text: string; url?: string }) => json<unknown>(url(`${run(runId)}/brief/edit`), post(edit)),
    briefAnswers: (runId: string, answers: { recommended: true } | { picks: { id: string; option?: number; text?: string }[] }) => json<unknown>(url(`${run(runId)}/brief/answers`), post(answers)),
    briefConflict: (runId: string, choice: "keep" | "rewrite") => json<unknown>(url(`${run(runId)}/brief/conflict`), post({ choice })),
    briefLink: (runId: string, link: string, use: DesignLinkUse) => json<unknown>(url(`${run(runId)}/brief/link`), post({ url: link, use })),
    briefNotThisScreen: (runId: string, text?: string) => json<unknown>(url(`${run(runId)}/brief/not-this-screen`), post(text ? { text } : {})),
    message: (l: string, text: string, key: string) => json<{ queued?: boolean }>(url(`${label(l)}/message`), post({ text, key })),
    refine: (l: string, text: string, quick: readonly string[], key: string) => json<{ queued?: boolean }>(url(`${label(l)}/refine`), post({ text, quick, key })),
    retry: (l: string) => json<unknown>(url(`${label(l)}/retry`), post()),
    coordinatorMessage: (text: string, key: string) => json<{ queued?: boolean }>(url("/coordinator/message"), post({ text, key })),
    coordinatorAnswer: (id: string, answer: unknown) => json<unknown>(url("/coordinator/answer"), post({ id, answer })),
    /** What has been written so far of the page in progress; null when there is none. */
    live: async (l: string): Promise<{ version: number; text: string } | null> => {
      try {
        return await json<{ version: number; text: string }>(url(`${label(l)}/live`));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    /** Where a frame may read the page in progress as it is written; null when none is being written, and for another computer's chat, whose card keeps its Writing note. */
    liveUrl: async (l: string): Promise<{ url: string; version: number; expires: number } | null> => {
      const route = url(`${label(l)}/live-url`);
      if (routeUrl(route).startsWith("/peer/")) return null;
      try {
        return await json<{ url: string; version: number; expires: number }>(route);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    /** A finished page's text; the page is never loaded as a document from Sova's origin. */
    page: async (l: string, version: number): Promise<string> => {
      const res = await send(url(`${label(l)}/page`, `&v=${version}`));
      if (!res.ok) throw new ApiError(res.status === 404 ? "This page isn't there." : `This page couldn't be loaded (${res.status}).`, res.status);
      return res.text();
    },
    /** A coordinator screenshot, as an image URL the page may load. */
    shotUrl: (src: string) => routeUrl(src),
  };
}
export type DesignApi = ReturnType<typeof designApi>;
