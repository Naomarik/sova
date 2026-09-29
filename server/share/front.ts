import type { FrontGuide, ShareGatewaySetting, VerifyResult } from "../../shared/public-links";

/**
 * The gateway's front (§mesh.public/front): the steps for the chosen front, generated from the
 * setting and never run by Sova, and Verify (`<publicUrl>/h/<random token>` must answer the
 * gateway's own 404 signature; https only, no redirect followed).
 *
 * Not built yet: no steps, and Verify never passes.
 */

export function frontGuide(setting: ShareGatewaySetting): FrontGuide {
  return { front: setting.front, steps: [] };
}

export async function verifyPublicUrl(url: string): Promise<VerifyResult> {
  void url;
  return { ok: false, error: "not implemented" };
}
