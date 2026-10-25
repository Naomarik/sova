import { normalizeTourJob, normalizeTourManifest, normalizeTourPresentation, normalizeTourProgress, tourUrl, type TourJob, type TourPresentation } from "../../shared/tour";
import { ApiError, withJsonType } from "./api";
import { onAuthorized, onUnauthorized } from "./auth";
import { hostUrl, routeUrl } from "./mesh";
import type { TourPosition, TourSignInBody } from "./tour-state";
import type { TourBinding, TourHandoffDestination, TourShareLink, TourSharePreview } from "../components/TourShare";

/** Uses the same browser gate and peer routing as the main API without exposing owner paths to viewers. */
async function request(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try { res = await fetch(routeUrl(url, init?.body), withJsonType({ cache: "no-store", ...init })); }
  catch { throw new ApiError("The Sova server isn't reachable.", 0); }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    if (res.status === 401) onUnauthorized(body);
    const error = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `Tour request failed (${res.status}).`;
    throw new ApiError(error, res.status, body);
  }
  onAuthorized(); return body;
}
const checked = (raw: unknown): TourPresentation => {
  const value = normalizeTourManifest(raw) ?? normalizeTourPresentation(raw);
  if (!value) throw new Error("This checked tour couldn't be read. Ask the agent to check its edition.");
  return value;
};
const job = (raw: unknown): TourJob => { const value = normalizeTourJob(raw); if (!value) throw new Error("Recording status couldn't be read."); return value; };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const loadScopedTour = async (base: string): Promise<TourPresentation> => checked(await request(base));
export const scopedTourAssetUrl = (base: string, file: string): string => routeUrl(`${base}/assets/${encodeURIComponent(file)}`);

/** A site a tour uses, and whether this installation holds its approval or a test account now. */
export interface TourSite { origin: string; approved: boolean; account: boolean }
const sites = (raw: unknown): TourSite[] => {
  if (!Array.isArray(raw) || !raw.every(s => object(s) && typeof s.origin === "string" && typeof s.approved === "boolean" && typeof s.account === "boolean")) throw new Error("This tour's sites couldn't be read.");
  return raw.map(s => ({ origin: s.origin, approved: s.approved, account: s.account }));
};

export function ownerTourApi(sessionId: string, tourId: string, host: string | null) {
  const root = hostUrl(host, `/api/tours/${encodeURIComponent(sessionId)}/${encodeURIComponent(tourId)}`);
  const jobs = hostUrl(host, `/api/tours/${encodeURIComponent(sessionId)}/jobs`);
  const base = (edition: string) => hostUrl(host, tourUrl(sessionId, tourId, edition));
  return {
    manifest: async (edition: string) => checked(await request(base(edition))),
    assetUrl: (edition: string, file: string) => hostUrl(host, tourUrl(sessionId, tourId, edition, file)),
    /** `signedIn` is the returned edition's lock; absent means the server said it isn't signed in. */
    latest: async (): Promise<{ editionId?: string; job?: TourJob; sites: TourSite[]; signedIn: boolean }> => {
      const raw = await request(root);
      if (!object(raw)) throw new Error("Tour status couldn't be read.");
      return { ...(typeof raw.editionId === "string" ? { editionId: raw.editionId } : {}), ...(raw.job ? { job: job(raw.job) } : {}), sites: raw.sites === undefined ? [] : sites(raw.sites), signedIn: raw.signedIn === true };
    },
    revokeSite: async (origin: string) => sites(await request(`${root}/approvals`, { method: "DELETE", body: JSON.stringify({ origin }) })),
    removeAccount: async (origin: string) => sites(await request(`${root}/accounts`, { method: "DELETE", body: JSON.stringify({ origin }) })),
    job: async (id: string) => job(await request(`${jobs}/${encodeURIComponent(id)}`)),
    cancel: (id: string) => request(`${jobs}/${encodeURIComponent(id)}/cancel`, post()),
    approve: (id: string, origin: string) => request(`${jobs}/${encodeURIComponent(id)}/approve`, post({ origin })),
    account: (id: string, account: { origin: string; username: string; password: string; testAccount: true }) => request(`${jobs}/${encodeURIComponent(id)}/account`, post(account)),
    /** The reply is the job; the body is never kept here after the request is sent. */
    signIn: async (id: string, body: TourSignInBody) => job(await request(`${jobs}/${encodeURIComponent(id)}/sign-in`, post(body))),
    approveAll: async (id: string, origins: string[]) => job(await request(`${jobs}/${encodeURIComponent(id)}/approve-all`, post({ origins }))),
    recordAgain: async () => job(await request(`${root}/re-record`, post())),
    destinations: async (edition: string) => {
      const raw = await request(`${base(edition)}/destinations`);
      return object(raw) ? raw as Record<string, Record<string, Partial<Record<"desktop" | "phone", string>>>> : {};
    },
    progress: async (edition: string): Promise<TourPosition | null> => {
      const raw = await request(`${base(edition)}/progress`);
      if (raw === null) return null;
      const value = normalizeTourProgress(raw);
      if (!value || value.tourId !== tourId || value.editionId !== edition) throw new Error("Your saved place couldn't be read.");
      return value;
    },
    saveProgress: (edition: string, position: TourPosition) => request(`${base(edition)}/progress`, { method: "PUT", body: JSON.stringify(position) }),
    bindingDestinations: async (edition: string): Promise<TourHandoffDestination[]> => {
      const raw = await request(`${base(edition)}/binding-destinations`);
      if (!Array.isArray(raw) || !raw.every(d => object(d) && [d.sessionId, d.orgId, d.orgName, d.publicTitle].every(v => typeof v === "string") && (d.holder === null || typeof d.holder === "string"))) throw new Error("Hand-off destinations couldn't be loaded.");
      return raw as TourHandoffDestination[];
    },
    bindingPreview: async (edition: string, destinationSessionId: string): Promise<TourSharePreview> => {
      const raw = await request(`${base(edition)}/binding-preview`, post({ destinationSessionId }));
      if (!object(raw) || typeof raw.previewId !== "string" || typeof raw.expiresAt !== "string") throw new Error("The hand-off preview couldn't be read.");
      return { previewId: raw.previewId, expiresAt: raw.expiresAt, manifest: checked(raw.manifest) };
    },
    bind: (edition: string, previewId: string, destinationSessionId: string) => request(`${base(edition)}/bindings`, post({ previewId, destinationSessionId })),
    bindings: async (edition: string): Promise<TourBinding[]> => {
      const raw = await request(`${base(edition)}/bindings`);
      if (!Array.isArray(raw) || !raw.every(d => object(d) && [d.handle, d.destinationSessionId, d.orgId, d.orgName, d.publicTitle].every(v => typeof v === "string") && (d.holder === null || typeof d.holder === "string"))) throw new Error("Tour attachments couldn't be loaded.");
      return raw as TourBinding[];
    },
    detach: (edition: string, handle: string, destinationSessionId: string) => request(`${base(edition)}/bindings/${encodeURIComponent(handle)}?destinationSessionId=${encodeURIComponent(destinationSessionId)}`, { method: "DELETE" }),
    sharePreview: async (edition: string): Promise<TourSharePreview> => {
      const raw = await request(`${base(edition)}/share-preview`, post());
      if (!object(raw) || typeof raw.previewId !== "string" || typeof raw.expiresAt !== "string") throw new Error("The sharing preview couldn't be read.");
      return { previewId: raw.previewId, expiresAt: raw.expiresAt, manifest: checked(raw.manifest) };
    },
    share: async (edition: string, previewId: string, expiresAt: string): Promise<TourShareLink> => {
      const raw = await request(`${base(edition)}/shares`, post({ previewId, expiresAt }));
      if (!object(raw) || ![raw.id, raw.url, raw.expiresAt, raw.editionId].every(v => typeof v === "string")) throw new Error("The share link couldn't be read.");
      return { id: raw.id as string, url: raw.url as string, expiresAt: raw.expiresAt as string, editionId: raw.editionId as string };
    },
  };
}

/** A tour attached to a hand-off conversation, as the operator's own view of that conversation lists it. */
export interface ConversationTour { handle: string; title: string; summary: string; steps: number }
/** Keyed by the hand-off conversation, not the source chat: works after the source is gone. Operator only. */
export function conversationTourApi(orgId: string, sessionId: string) {
  const base = `/api/orgs/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(sessionId)}/tours`;
  return {
    list: async (): Promise<ConversationTour[]> => {
      const raw = await request(base);
      if (!Array.isArray(raw) || !raw.every(t => object(t) && [t.handle, t.title, t.summary].every(v => typeof v === "string") && typeof t.steps === "number")) throw new Error("This conversation's tours couldn't be loaded.");
      return raw as ConversationTour[];
    },
    detach: (handle: string) => request(`${base}/${encodeURIComponent(handle)}`, { method: "DELETE" }),
  };
}
