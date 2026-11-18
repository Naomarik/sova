import type { Context } from "hono";
import { SHARING_OFF_ERROR, SHARING_OFF_MESSAGE } from "../../shared/public-links";
import { readPublicLinksSetting } from "../public-links";

/**
 * Off turns sharing off (§mesh.public/sharing-off): while the setting reads `sharingOff` (an Off
 * picked from the list), every store that makes a public link refuses before it writes anything,
 * so a route, an Overseer tool, an outreach send and the services `share` verb all refuse alike,
 * whoever calls them. The refusal is SharingOffError, which the app answers as 403
 * `{ error, code: "sharing-off" }` (server/app.ts onError) and a tool reports as its message.
 */

export class SharingOffError extends Error {
  readonly code = SHARING_OFF_ERROR;
  readonly status = 403;
  constructor() {
    super(SHARING_OFF_MESSAGE);
    this.name = "SharingOffError";
  }
}

/** Whether sharing is off on this computer now. */
export function sharingOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return readPublicLinksSetting(env).sharingOff;
}

/** Throws SharingOffError while sharing is off; the first line of every public-link mint. */
export function assertSharingOn(env: NodeJS.ProcessEnv = process.env): void {
  if (sharingOff(env)) throw new SharingOffError();
}

export const isSharingOffError = (err: unknown): err is SharingOffError =>
  err instanceof SharingOffError || (!!err && typeof err === "object" && (err as { code?: unknown }).code === SHARING_OFF_ERROR && (err as { name?: unknown }).name === "SharingOffError");

/** The app's answer to a refused mint (server/app.ts onError): 403 `{ error, code: "sharing-off" }`; null for any other error. */
export function sharingOffResponse(err: unknown, c: Context): Response | null {
  return isSharingOffError(err) ? c.json({ error: err.message, code: SHARING_OFF_ERROR }, 403) : null;
}
