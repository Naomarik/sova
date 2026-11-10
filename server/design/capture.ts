// The capture step: one browser visit to the screen the coordinator found, no model. It brings the page's images into
// the chat's catalogue under short names that never change, and reads the page's colors and font names as notes.
// A signed-in page may hold someone's private pictures, so capturing one waits for your say-so, once, on the card.
import { randomUUID } from "node:crypto";
import type { DesignCapture } from "../../shared/design-assets";
import { DESIGN_ASSET_LIMITS } from "../../shared/design-assets";
import { browseRequestProblem, designBrowse, type BrowseParent, type DesignBrowseDeps, type DesignBrowseOutcome, type DesignBrowseRequest } from "./browse";
import { changeAssets, keepAsset, signedInConsented } from "./assets";
import { describeAssets } from "./describe";

type Describe = typeof describeAssets;
let describe: Describe = describeAssets;
/** Tests: no describing team behind a capture. */
export const setDescribeForTest = (fn: Describe | null): void => void (describe = fn ?? describeAssets);

export const CAPTURE_LIMITS = Object.freeze({ attemptMs: 180_000, captures: 40 });

export type DesignCaptureOutcome =
  | { kind: "captured"; capture: DesignCapture; added: string[] }
  /** A signed-in page: the card asks once, saying what will be saved and which model reads it. */
  | { kind: "needs-signed-in-consent"; origin: string }
  | Exclude<DesignBrowseOutcome, { kind: "pictures" }>;

/** Keep what the attempt brought back; an image the chat can't keep is listed with its reason. Returns the capture's record. */
export function keepCapture(sessionId: string, url: string, at: string, captured: NonNullable<Extract<DesignBrowseOutcome, { kind: "pictures" }>["capture"]>, signedIn: boolean, runId?: string): { capture: DesignCapture; added: string[] } {
  const skipped = [...captured.skipped];
  const names: string[] = [];
  const added: string[] = [];
  let bytes = 0;
  for (const item of captured.items) {
    const kept = keepAsset(sessionId, { source: "page", original: item.original, full: item.full, small: item.small, describe: item.describe, width: item.width, height: item.height, context: item.context });
    if ("refused" in kept) {
      skipped.push({ what: item.context.sourceUrl ?? "An image on the page", reason: kept.refused });
      continue;
    }
    if (names.includes(kept.asset.name)) continue;
    names.push(kept.asset.name);
    bytes += item.original.length;
    if (kept.isNew) added.push(kept.asset.name);
  }
  const capture: DesignCapture = {
    id: randomUUID(),
    ...(runId ? { runId } : {}),
    url,
    ...(captured.title ? { title: captured.title } : {}),
    at,
    names,
    skipped: skipped.slice(0, DESIGN_ASSET_LIMITS.skipped),
    ...(captured.moreSkipped + Math.max(0, skipped.length - DESIGN_ASSET_LIMITS.skipped) ? { moreSkipped: captured.moreSkipped + Math.max(0, skipped.length - DESIGN_ASSET_LIMITS.skipped) } : {}),
    notes: captured.notes,
    signedIn,
    bytes,
    ms: captured.ms,
  };
  changeAssets(sessionId, (c) => {
    c.captures.push(capture);
    if (c.captures.length > CAPTURE_LIMITS.captures) c.captures.splice(0, c.captures.length - CAPTURE_LIMITS.captures);
  });
  return { capture, added };
}

/** One visit at desktop width. Refusals are outcomes the coordinator or the card can read. */
export async function captureDesignPage(parent: BrowseParent, raw: unknown, deps: DesignBrowseDeps & { runId?: string }, signal?: AbortSignal): Promise<DesignCaptureOutcome> {
  const problem = browseRequestProblem(raw);
  if (problem) return { kind: "refused", message: problem };
  const req = raw as DesignBrowseRequest;
  const origin = new URL(req.url).origin;
  const signedIn = !!req.signIn || !!deps.stores.accounts.forOrigin(origin);
  if (signedIn && !signedInConsented(parent.sessionId, origin)) return { kind: "needs-signed-in-consent", origin };
  const out = await designBrowse(parent, { ...req, sizes: ["desktop"] }, { limitMs: CAPTURE_LIMITS.attemptMs, ...deps, capture: true }, signal);
  if (out.kind !== "pictures") return out;
  if (!out.capture) return { kind: "refused", message: "The visit finished but brought back no capture." };
  const kept = keepCapture(parent.sessionId, out.capture.url, new Date().toISOString(), out.capture, signedIn || out.signedIn, deps.runId);
  // Nothing new costs nothing: the same image keeps what was said about it.
  if (kept.added.length) describe(parent, kept.added);
  return { kind: "captured", ...kept };
}
