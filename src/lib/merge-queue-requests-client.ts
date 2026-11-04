// The calls behind how a branch lands and its requests (team contract §5): save 'How it lands' to the project file
// or this computer, clear this computer's override, publish a reviewed request (q10), and Update Local Main (q11).
// Each bumps mergeChanged so the tab, the rows and the cards read the queue again.
import type { LandHow } from "./merge-queue-requests";
import { noteMergeChanged } from "./merge-queue-client";

/** A refusal or a result, never a throw for a refusal the route answers with. */
export type Answer<T = Record<string, unknown>> = { ok: true; body: T } | { ok: false; message: string; code?: string };

async function call<T>(url: string, method: string, body?: unknown): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch {
    return { ok: false, message: "The Sova server isn't reachable." };
  }
  let parsed: unknown = undefined;
  try {
    parsed = await res.json();
  } catch {
    // an empty or non-JSON answer
  }
  noteMergeChanged();
  if (!res.ok) {
    const p = (parsed ?? {}) as { error?: string | { message?: string; code?: string }; message?: string; code?: string };
    const e = typeof p.error === "object" ? p.error : undefined;
    const message = e?.message ?? (typeof p.error === "string" ? p.error : undefined) ?? p.message ?? `${res.status} ${res.statusText}`;
    return { ok: false, message, ...(e?.code ?? p.code ? { code: (e?.code ?? p.code)! } : {}) };
  }
  return { ok: true, body: (parsed ?? {}) as T };
}

const P = (project: string) => `/api/merge-queue/projects/${encodeURIComponent(project)}`;

/** The project-file save answers as the settings save does: saved with its commit, or waiting for the current branch
    or for the release holding the queue (`release`, as shown). */
export type LandHowSaved = { state?: "saved" | "waiting"; commit?: string; pushed?: boolean; release?: string };

export const saveLandHow = (project: string, how: LandHow, where: "project" | "computer") => call<LandHowSaved>(`${P(project)}/land-how`, "PUT", { how, where, confirm: true });
export const clearLandHowOverride = (project: string) => call(`${P(project)}/land-how/override`, "DELETE");
export const updateLocalMain = (project: string) => call<{ kind?: "updated" | "current"; head?: string }>(`${P(project)}/update-local-main`, "POST", {});
export const publishRequest = (entry: string, text: { title: string; body: string; draft: boolean }) =>
  call(`/api/merge-queue/entries/${encodeURIComponent(entry)}/publish`, "POST", text);
