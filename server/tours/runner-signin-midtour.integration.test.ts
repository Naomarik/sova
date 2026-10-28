// In-place sign-in mid-tour (§app.tours/recording), split from runner-signin-inplace.integration.test.ts for the
// runner's per-file time cap: sign-outs the site draws in place mid-tour (N1–N5). Same fixtures, same assertions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type TourAction, type TourSize } from "../../shared/tour";
import { type TourAttemptResult } from "./runner";
import { TOUR_SIGN_IN_BOX_SIGNED_IN, TOUR_SIGN_IN_STALE } from "./runner-protocol";
import { failed, pngPixel, record, script } from "./runner-signin.integration.fixture";
import { inPlace, inPlaceApp } from "./runner-signin-inplace.integration.fixture";

// In-place mid-tour sign-out (§app.tours/recording). Per size the documents load: the sign-in route, then each
// view; desktop signs in at d1, so with two views the phone's route is d4 and its first view d5.
const inPlaceViews = (origin: string, routes: string[], actions?: Partial<Record<TourSize, TourAction[]>>) => {
  const s = script(origin, routes); s.signIn!.route = "/#/login";
  if (actions) for (const v of s.steps[0]!.views) if (v.kind === "page") v.actions = actions;
  return s;
};
const GREEN = [0x00, 0xaa, 0x00];
const captures = (r: TourAttemptResult) => [...r.assets.keys()].filter(f => f.startsWith("capture-")).sort();
const at = (r: TourAttemptResult | Error) => { const f = (r as { failure?: { size?: string; viewId?: string } }).failure; return [f?.size, f?.viewId]; };

test("N1 a session the site ends in place mid-tour: one silent re-sign-in on the sign-in route, both sizes recorded signed in, views × sizes captures", { timeout: 180_000 }, async () => {
  const a = await inPlaceApp({ expireAtDocs: [5] });
  try {
    const { result, asked } = await record(inPlaceViews(a.origin, ["/#/dashboard", "/#/other"]), { dryRun: false });
    assert.equal(failed(result), "recorded");
    assert.equal(a.posts(), 2, "the up-front sign-in, then exactly one re-sign-in");
    assert.equal(asked.length, 2);
    const r = result as TourAttemptResult;
    assert.deepEqual(captures(r), ["capture-1-1-desktop.png", "capture-1-1-phone.png", "capture-1-2-desktop.png", "capture-1-2-phone.png"], "views × sizes; neither the form nor the route captured");
    for (const file of captures(r)) assert.deepEqual(pngPixel(r.assets.get(file)!, 100, 220), GREEN, `${file}: signed-in content`);
    assert.equal(a.docs(), 8, "the expired view loaded twice, the route once more");
  } finally { a.close(); }
});

test("N2 a site that signs the recorder out in place again after the re-sign-in fails at the cap, nothing more typed", { timeout: 180_000 }, async () => {
  const a = await inPlaceApp({ expireAtDocs: [5, 7] });
  try {
    const { result, asked } = await record(inPlaceViews(a.origin, ["/#/dashboard", "/#/other"]), { dryRun: false });
    assert.match(failed(result), /The site signed the recorder out again, so recording stopped\./);
    assert.deepEqual(at(result), ["phone", "view-1"]);
    assert.equal(a.posts(), 2);
    assert.equal(asked.length, 2, "no third login asked for");
  } finally { a.close(); }
});

test("N3 a view showing the sign-in's password box while the sign-in route shows the recorder signed in stops, typing nothing at the view", { timeout: 120_000 }, async () => {
  const a = await inPlaceApp();
  try {
    const { result, asked } = await record(inPlaceViews(a.origin, ["/#/reauth"]));
    assert.ok(failed(result).startsWith(TOUR_SIGN_IN_BOX_SIGNED_IN), failed(result));
    assert.deepEqual(at(result), ["desktop", "view-1"]);
    assert.equal(a.posts(), 1, "only the up-front sign-in");
    assert.deepEqual(asked, ["username+password"]);
  } finally { a.close(); }
});

test("N4 one rule: a size that carried on from a held session stops as stale at a view's in-place form, before its actions, never signing in again", { timeout: 180_000 }, async () => {
  const a = await inPlaceApp({ lostWhenSignedIn: true });
  try {
    const first = await record(inPlace(a.origin));
    assert.equal(failed(first.result), "recorded");
    assert.equal(a.posts(), 1);
    a.expire();
    // The view opens a disclosure only the signed-in page has: checked after its actions only, the open would fail first.
    const s = inPlaceViews(a.origin, ["/#/dashboard"], { desktop: [{ op: "open", target: { kind: "testId", testId: "more" } }], phone: [] });
    const stale = await record(s, { storage: first.stored[0] });
    assert.ok(failed(stale.result).startsWith(TOUR_SIGN_IN_STALE), failed(stale.result));
    assert.deepEqual(at(stale.result), ["desktop", "view-1"]);
    assert.deepEqual(stale.asked, []);
    assert.equal(a.posts(), 1, "nothing typed or sent");
  } finally { a.close(); }
});

test("N5 a sign-out drawn in place after a view's fill is caught before capture: the recorder leaves the view, signs in again and records it signed in", { timeout: 180_000 }, async () => {
  // One view: desktop d1 route, d2 view; phone d3 route, d4 view, whose fill draws the form; d5 the route, expired.
  const a = await inPlaceApp({ drawOnFillAtDoc: 4, expireAtDocs: [5] });
  try {
    const fill = [{ op: "fill" as const, target: { kind: "role" as const, role: "textbox", name: "Note" }, value: "a made-up note" }];
    const { result, asked } = await record(inPlaceViews(a.origin, ["/#/dashboard"], { desktop: fill, phone: fill }), { dryRun: false });
    assert.equal(failed(result), "recorded");
    assert.equal(a.posts(), 2);
    assert.equal(asked.length, 2);
    const r = result as TourAttemptResult;
    assert.deepEqual(captures(r), ["capture-1-1-desktop.png", "capture-1-1-phone.png"]);
    for (const file of captures(r)) assert.deepEqual(pngPixel(r.assets.get(file)!, 100, 220), GREEN, `${file}: signed-in content`);
  } finally { a.close(); }
});
