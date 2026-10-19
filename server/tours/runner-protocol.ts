import type { TourFailure, TourJob, TourScript, TourSignInRequirement, TourStep } from "../../shared/tour";
import type { TourLookResult } from "./look";
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
export interface TourAttemptInput { script: TourScript; origin: string; dryRun: boolean; proxied: boolean; declared?: string[]; account?: { origin: string; username: string; password: string }; sova?: { origin: string; name: string; value: string; marker: string }; signIn?: { origins: string[]; storage?: TourStorageState }; look?: { signInRoute?: string } }
export type TourChildMessage =
  | { type: "contact"; id: number; origin: string }
  | { type: "checkpoint"; id: number }
  | { type: "progress"; progress: TourAttemptProgress }
  | { type: "asset"; file: string; base64: string }
  /** The page asks to sign in: the parent answers from the tour's memory, or parks the job until the user does. */
  | { type: "sign-in-needed"; id: number; origin: string; fields: TourSignInRequirement["fields"]; reason?: string }
  /** A sign-in succeeded: the context's state for the sign-in origins, for this tour's later attempts. */
  | { type: "signed-in"; origin: string; storage: TourStorageState }
  /** `sovaServer`: some answer carried X-Sova-Server: sova (a tour of a Sova). `quietAborts`: writes the pages sent by themselves, stopped without failing. `signedIn`: the capture ran signed in through the form sign-in. */
  | { type: "result"; steps: TourStep[]; contactSheets: string[]; suspicious: string[]; publicOrigins: string[]; sovaServer: boolean; quietAborts?: number; signedIn?: boolean; look?: TourLookResult }
  | { type: "failure"; failure: TourFailure; quietAborts?: number };
export type TourParentMessage =
  | { type: "start"; input: TourAttemptInput }
  | { type: "answer"; id: number; failure?: TourFailure }
  | { type: "sign-in"; id: number; account?: string; username?: string; password?: string; code?: string };
