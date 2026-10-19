import { createHash } from "node:crypto";
import { normalizeTourManifest, TOUR_LIMITS, type TourAsset, type TourManifest, type TourScript, type TourStep, type TourVerification } from "../../shared/tour";

export const tourScriptDigest = (script: TourScript): string => createHash("sha256").update(JSON.stringify(script)).digest("hex");
export function tourAsset(file: string, bytes: Uint8Array): TourAsset {
  if (!bytes.length || bytes.length > TOUR_LIMITS.assetBytes || Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a") throw new Error("Recording produced an invalid or oversized PNG.");
  return { file, mime: "image/png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
export function assertTourCoverage(script: TourScript, steps: TourStep[]): void {
  if (steps.length !== script.steps.length) throw new Error("Recording is missing steps.");
  script.steps.forEach((step, i) => {
    const recorded = steps[i];
    if (!recorded || recorded.id !== step.id || recorded.views.length !== step.views.length) throw new Error("Recording is missing views.");
    step.views.forEach((view, j) => {
      const got = recorded.views[j];
      if (!got || got.id !== view.id || got.kind !== view.kind) throw new Error("Recording view identity changed.");
      if (view.kind === "page" && (Object.keys(got.captures).length !== view.sizes.length || !view.sizes.every(s => got.captures[s]))) throw new Error("Recording is missing a required size.");
    });
  });
}
/** Called by the job service only after persisted inspection receipts, not a boolean promise. */
export function checkTourManifest(input: TourManifest, assets: ReadonlyMap<string, Uint8Array>, receipts: ReadonlySet<string>, suspicious: readonly string[], verification: TourVerification): TourManifest {
  if (!input.check.contactSheets.every(f => receipts.has(f))) throw new Error("Inspect every overview sheet before checking this edition.");
  if (!suspicious.every(f => verification.suspiciousCapturesReviewed.includes(f) && receipts.has(f)) || !verification.suspiciousCapturesReviewed.every(f => receipts.has(f))) throw new Error("Inspect every suspicious capture at full size before checking this edition.");
  const sheet = verification.suspiciousCapturesReviewed.find(f => input.check.contactSheets.includes(f));
  if (sheet) throw new Error(`suspiciousCapturesReviewed lists ${sheet}, an overview sheet: list only the captures you opened closely (each reported suspicious one included). The overview sheets count through overviewReviewed.`);
  const checked = normalizeTourManifest({ ...input, check: { ...input.check, ...verification, checkedAt: new Date().toISOString() } });
  if (!checked || assets.size !== checked.assets.length) throw new Error("The staged edition is incomplete.");
  for (const a of checked.assets) {
    const bytes = assets.get(a.file);
    if (!bytes || JSON.stringify(tourAsset(a.file, bytes)) !== JSON.stringify(a)) throw new Error("The staged picture inventory changed or is incomplete.");
  }
  return checked;
}
