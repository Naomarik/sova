import assert from "node:assert/strict";
import { test } from "node:test";
import { tourEditionAssetsFixture, tourManifestFixture, tourScriptFixture } from "../../shared/tour-fixtures";
import { assertTourCoverage, checkTourManifest, tourAsset, tourScriptDigest } from "./checks";

test("visual check requires actual inspection receipts for every overview and suspicious capture", () => {
  const m = tourManifestFixture(); const assets = tourEditionAssetsFixture();
  const verification = { overviewReviewed: true as const, suspiciousCapturesReviewed: ["phone.png"], notes: "Reviewed all cells and phone close-up." };
  assert.throws(() => checkTourManifest(m, assets, new Set(), ["phone.png"], verification), /every overview/);
  assert.throws(() => checkTourManifest(m, assets, new Set(["contact-sheet.png"]), ["phone.png"], verification), /every suspicious/);
  assert.equal(checkTourManifest(m, assets, new Set(["contact-sheet.png", "phone.png"]), ["phone.png"], verification).check.status, "passed");
  const altered = assets.get("phone.png")!; altered[20] = altered[20]! ^ 1;
  assert.throws(() => checkTourManifest(m, assets, new Set(["contact-sheet.png", "phone.png"]), ["phone.png"], verification), /inventory changed/);
});
test("an overview sheet listed among the suspicious captures reviewed is refused by that field's name", () => {
  const m = tourManifestFixture(); const assets = tourEditionAssetsFixture();
  const verification = { overviewReviewed: true as const, suspiciousCapturesReviewed: ["phone.png", "contact-sheet.png"], notes: "Reviewed all cells and phone close-up." };
  assert.throws(() => checkTourManifest(m, assets, new Set(["contact-sheet.png", "phone.png"]), ["phone.png"], verification), /suspiciousCapturesReviewed lists contact-sheet\.png, an overview sheet/);
});
test("missing-size and mismatched inventory cannot pass publication checks", () => {
  const script = tourScriptFixture(); const m = tourManifestFixture();
  assertTourCoverage(script, m.steps);
  delete m.steps[0]!.views[0]!.captures.phone;
  assert.throws(() => assertTourCoverage(script, m.steps), /required size/);
  assert.throws(() => tourAsset("image.png", new Uint8Array([1, 2, 3])), /invalid/);
  const original = tourScriptDigest(script); script.steps[0]!.summary += " changed";
  assert.notEqual(tourScriptDigest(script), original);
});
