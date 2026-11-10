import type { TourFailure, TourJob, TourScript, TourSignInRequirement, TourSize, TourStep, TourTarget } from "../../shared/tour";
import type { TourLookResult } from "./look";
import type { PageCaptureReport } from "./page-capture";

/** What the page's request was, for a contact decided per request. The page's own say-so never reaches this: it's what the browser reported. */
export interface TourContactRequest {
  /** Playwright's resource type: document, image, stylesheet, script, font, xhr, fetch, media, websocket, other… */
  resourceType: string;
  /** The browser is going to a new document in this frame, not loading a part of one. */
  navigation: boolean;
  /** The frame is the page itself. Unknown frames count as the page: the strict reading. */
  mainFrame: boolean;
  /** The origin of the document that asked, when the browser knows it. */
  initiator?: string;
}
/** A page's own request for part of itself: anything but going to a new top-level document. */
export const isSubresourceContact = (r: TourContactRequest | undefined): boolean => !!r && !(r.navigation && r.mainFrame);
/** A request as the child reported it; anything else reads as no request at all, the strict reading. */
export function checkedContactRequest(v: unknown): TourContactRequest | undefined {
  const r = v as Partial<TourContactRequest> | null;
  if (!r || typeof r !== "object" || typeof r.resourceType !== "string" || r.resourceType.length > 24 || typeof r.navigation !== "boolean" || typeof r.mainFrame !== "boolean") return undefined;
  return { resourceType: r.resourceType, navigation: r.navigation, mainFrame: r.mainFrame, ...(typeof r.initiator === "string" && r.initiator.length <= 300 ? { initiator: r.initiator } : {}) };
}
/** The sign-in's fixed outcomes (§app.tours/recording): never page text, never a value. */
export const TOUR_SIGN_IN_WRONG = "The sign-in didn't work with those details, so recording stopped. Check them and record again.";
/** The login worked (the form went away or the page left the sign-in route), but signIn.signedIn never showed: the login is kept. */
export const TOUR_SIGN_IN_LANDED = "Signed in, but the signed-in control (signIn.signedIn) never showed, so recording stopped.";
/** A size that went on from the tour's held session found a view drawing the sign-in form: that session is gone. */
export const TOUR_SIGN_IN_STALE = "The tour's held sign-in no longer works, so recording stopped. Record again to sign in.";
/** A view showed the sign-in's password box in place, but the sign-in route says the recorder is signed in. */
export const TOUR_SIGN_IN_BOX_SIGNED_IN = "This view shows the sign-in's password box while the site says the recorder is signed in, so recording stopped.";
/** A dry run stops when two views in a row found none of their targets (§app.tours/recording). */
export const TOUR_DRY_RUN_BLIND = "Two views in a row found none of their targets, so the dry run stopped there.";
export const TOUR_SIGN_IN_HUMAN = "This site asks to prove you're human, so recording stopped. Tell the user, or use reference text.";
export type TourAttemptProgress = Pick<TourJob, "completed" | "total"> & Partial<Pick<TourJob, "stepId" | "viewId" | "size">>;
/** A browser context's signed-in state (Playwright's storageState shape), only the sign-in origins'. */
export interface TourStorageState {
  cookies: { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None" }[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}
/** `proxied`: the parent ran this child with the chat's sandbox on, so every contact goes through its proxy. */
/** `sova`: only for a verified managed Sova test copy, its own sign-in cookie for exactly that origin, and the name of its recorder marker cookie. Never logged. */
/** `declared`: this tour's own origins (source, listed sites, test-account origin). */
/** `signIn`: the script's form sign-in is usable: its origins, and the tour's stored signed-in session if any. No login rides here. */
/** `look`: a look (§app.tours/look), a dry run that lists each page's controls; `signInRoute`: first list that page signed out. */
/** `browser`: the executable the server chose (macOS only); absent, the child discovers its own. */
/** One step of a walk to a screen: what a tour's actions allow, minus typing, plus a click that navigates (never a form submit). */
export type TourWalkAction = { op: "click"; target: TourTarget } | { op: "reveal"; target: TourTarget } | { op: "wait"; target: TourTarget } | { op: "scroll"; x: number; y: number };
export interface TourAttemptInput { script: TourScript; origin: string; dryRun: boolean; proxied: boolean; browser?: string; declared?: string[]; account?: { origin: string; username: string; password: string }; sova?: { origin: string; name: string; value: string; marker: string }; signIn?: { origins: string[]; storage?: TourStorageState }; look?: { signInRoute?: string }; /** A walk: these steps replace the view's actions, and each size's page is pictured and listed. */ walk?: Partial<Record<TourSize, TourWalkAction[]>>; /** A look at a link: a redirect of a part of the page is asked about rather than failing the attempt, and a part the parent declines is left out. */ reach?: boolean; /** Bring back this page's images and notes, once, on the walk's final screen at desktop width. */ capture?: boolean }
export type TourChildMessage =
  | { type: "contact"; id: number; origin: string; request?: TourContactRequest }
  | { type: "checkpoint"; id: number }
  | { type: "progress"; progress: TourAttemptProgress }
  | { type: "asset"; file: string; base64: string }
  /** One file of a page capture: kept apart from a tour's pictures, whose guards take only its own PNGs and reconcile a full inventory. */
  | { type: "capture-file"; key: string; base64: string }
  /** The page capture's report, after its files. */
  | { type: "capture"; report: PageCaptureReport }
  /** The page asks to sign in: the parent answers from the tour's memory, or parks the job until the user does. */
  | { type: "sign-in-needed"; id: number; origin: string; fields: TourSignInRequirement["fields"]; reason?: string }
  /** A sign-in succeeded: the context's state for the sign-in origins, for this tour's later attempts. */
  | { type: "signed-in"; origin: string; storage: TourStorageState }
  /** `sovaServer`: some answer carried X-Sova-Server: sova (a tour of a Sova). `quietAborts`: writes the pages sent by themselves, stopped without failing. `signedIn`: the capture ran signed in through the form sign-in. */
  | { type: "result"; steps: TourStep[]; contactSheets: string[]; suspicious: string[]; publicOrigins: string[]; sovaServer: boolean; quietAborts?: number; signedIn?: boolean; look?: TourLookResult }
  | { type: "failure"; failure: TourFailure; quietAborts?: number };
export type TourParentMessage =
  | { type: "start"; input: TourAttemptInput }
  /** `skip`: leave this one contact out and carry on; the attempt isn't stopped and nothing is approved. */
  | { type: "answer"; id: number; failure?: TourFailure; skip?: true }
  | { type: "sign-in"; id: number; account?: string; username?: string; password?: string; code?: string };
