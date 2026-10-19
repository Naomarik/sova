import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tourManifestFixture, tourReferenceFixture } from "../../shared/tour-fixtures";
import type { TourSignInRequirement } from "../../shared/tour";
import { takeTourSignIn, tourCoverageQuestion, tourSignInWantsAccount, tourJobActive, tourJobLabel, tourPosition, tourPreviewItems, tourQuestion, tourShareAllowed, tourSignInPayload, TOUR_SIGNIN_EMPTY } from "./tour-state";

describe("tour reader state", () => {
  it("resumes by stable ids, not array positions, including a reference at either size", () => {
    const m = tourManifestFixture();
    const duplicate = structuredClone(m.steps[0]!); duplicate.id = "inserted"; duplicate.n = 1;
    m.steps.unshift(duplicate); m.steps[1]!.n = 2;
    assert.deepEqual(tourPosition(m, { stepId: "find-draft", viewId: "overview", size: "phone" }), { step: 1, view: 0 });
    assert.deepEqual(tourPosition(m, { stepId: "gone", viewId: "overview", size: "phone" }), { step: 0, view: 0 });
    assert.deepEqual(tourPosition(m, { stepId: "find-draft", viewId: "gone", size: "desktop" }), { step: 0, view: 0 });
    assert.deepEqual(tourPosition(tourReferenceFixture(), { stepId: "find-draft", viewId: "overview", size: "phone" }), { step: 0, view: 0 });
  });
  it("identifies exact tour, edition, main step and named view in a draft question", () => {
    const m = tourManifestFixture();
    const question = tourQuestion(m, 0, 0);
    for (const fact of [m.title, m.id, m.editionId, m.steps[0]!.id, m.steps[0]!.views[0]!.id]) assert.ok(question.includes(fact));
    const changed = structuredClone(m); changed.editionId = "edition-new";
    assert.notEqual(tourQuestion(changed, 0, 0), question);
    const coverage = tourCoverageQuestion(m, 0, 0);
    for (const fact of [m.title, m.id, m.editionId, m.steps[0]!.id, m.steps[0]!.views[0]!.id]) assert.ok(coverage.includes(fact));
    assert.ok(coverage.includes("wait for someone with access"));
  });
  it("reviews both pictures, reference text, and missing-size explanations rather than just the cover", () => {
    const m = tourManifestFixture();
    assert.deepEqual(tourPreviewItems(m).map(p => p.capture?.image), ["desktop.png", "phone.png"]);
    const v = m.steps[0]!.views[0]!; delete v.captures.phone; v.unavailableReason = "Phone doesn't offer this panel.";
    const items = tourPreviewItems(m);
    assert.equal(items.length, 2); assert.equal(items[1]!.capture, undefined); assert.equal(items[1]!.view.unavailableReason, v.unavailableReason);
    const refs = tourPreviewItems(tourReferenceFixture());
    assert.equal(refs.length, 1); assert.equal(refs[0]!.view.kind, "reference"); assert.equal(refs[0]!.capture, undefined);
  });
  it("reports honest queue/size stages and treats terminal states as terminal", () => {
    assert.equal(tourJobLabel("queued", undefined, 3), "Waiting · 3 in line");
    assert.equal(tourJobLabel("dry-run"), "Rehearsing");
    assert.equal(tourJobLabel("recording", "desktop"), "Recording desktop");
    assert.equal(tourJobLabel("recording", "phone"), "Recording phone");
    for (const phase of ["ready", "failed", "cancelled", "interrupted"] as const) assert.equal(tourJobActive(phase), false);
    for (const phase of ["queued", "checking", "needs-site-approval", "needs-test-account"] as const) assert.equal(tourJobActive(phase), true);
  });
});

it("Re-record is offered only with a checked edition; a first recording that ended without one says to ask the agent", async () => {
  const { tourRecordAgain, TOUR_ASK_TO_RECORD } = await import("./tour-state");
  for (const phase of ["failed", "interrupted", "cancelled", "ready"] as const) {
    assert.equal(tourRecordAgain(phase, true), "button", `${phase} with an edition`);
    assert.equal(tourRecordAgain(phase, false), "ask", `${phase} without one: Re-record would always refuse`);
  }
  for (const phase of ["queued", "dry-run", "recording", "checking", "needs-site-approval", "needs-test-account"] as const) {
    assert.equal(tourRecordAgain(phase, true), null, `${phase}: nothing while it runs`);
    assert.equal(tourRecordAgain(phase, false), null, phase);
  }
  assert.equal(TOUR_ASK_TO_RECORD, "To record this tour again, ask the agent in this chat.");
  describe("form sign-in on the card", () => {
    const login: TourSignInRequirement = { origin: "https://workshop.example.test", kind: "form", fields: ["username", "password"] };
    const code: TourSignInRequirement = { origin: "https://workshop.example.test", kind: "form", fields: ["code"] };
    const typed = { account: "", username: "  ada.example  ", password: "fixture pw ", code: "" };
    it("sends exactly the fields the requirement names, never the others", () => {
      assert.deepEqual(tourSignInPayload(login, typed), { origin: login.origin, username: "ada.example", password: "fixture pw " }, "username trimmed, password exactly as typed");
      assert.deepEqual(tourSignInPayload(code, { ...typed, code: " 123456 " }), { origin: code.origin, code: "123456" });
      assert.equal("password" in tourSignInPayload(code, { ...typed, code: "1" })!, false, "a code reply never carries a typed password");
      assert.equal("code" in tourSignInPayload(login, { ...typed, code: "1" })!, false, "a login never carries a code");
    });
    it("stays disabled until the asked-for fields are filled", () => {
      for (const f of [TOUR_SIGNIN_EMPTY, { ...typed, password: "" }, { ...typed, username: "   " }]) assert.equal(tourSignInPayload(login, f), null, JSON.stringify(f));
      assert.equal(tourSignInPayload(code, { ...typed, code: "  " }), null, "a password alone doesn't answer a code request");
    });
    it("submitting empties every field, whatever the request then does", () => {
      const taken = takeTourSignIn(login, typed);
      assert.ok(taken.body);
      assert.deepEqual(taken.fields, { account: "", username: "", password: "", code: "" });
      assert.notEqual(taken.fields, TOUR_SIGNIN_EMPTY, "a fresh object, so the frozen empty value is never shared state");
    });
    it("a three-box sign-in asks for an Account first, and only then sends one", () => {
      const three: TourSignInRequirement = { origin: login.origin, kind: "form", fields: ["account", "username", "password"] };
      assert.equal(tourSignInWantsAccount(three), true);
      assert.equal(tourSignInWantsAccount(login), false, "the card shows no Account field for a two-box sign-in");
      assert.equal(tourSignInWantsAccount(code), false);
      const withAccount = { ...typed, account: "  BOX-7  " };
      assert.deepEqual(tourSignInPayload(three, withAccount), { origin: three.origin, account: "BOX-7", username: "ada.example", password: "fixture pw " });
      assert.equal(tourSignInPayload(three, { ...withAccount, account: "  " }), null, "listed means required");
      assert.equal("account" in tourSignInPayload(login, withAccount)!, false, "unlisted means never sent, even if typed");
      assert.equal("account" in tourSignInPayload(code, { ...withAccount, code: "1" })!, false);
      assert.deepEqual(takeTourSignIn(three, withAccount).fields, { account: "", username: "", password: "", code: "" }, "submitting empties the account too");
      assert.equal(tourJobLabel("needs-sign-in", undefined, undefined, three), "Waiting for you to sign in");
    });
    it("labels the wait by what it needs, and keeps polling and Cancel", () => {
      assert.equal(tourJobLabel("needs-sign-in", undefined, undefined, login), "Waiting for you to sign in");
      assert.equal(tourJobLabel("needs-sign-in", undefined, undefined, code), "Waiting for a sign-in code");
      assert.equal(tourJobLabel("needs-sign-in"), "Waiting for you to sign in");
      assert.equal(tourJobActive("needs-sign-in"), true);
      assert.equal(tourJobLabel("needs-test-account"), "Waiting for a test account", "the Basic test-account wait is unchanged");
    });
    it("offers Share only once the server has said the edition wasn't recorded signed in", () => {
      assert.equal(tourShareAllowed({ loaded: false, signedIn: false }), false, "not while loading or after a failed load");
      assert.equal(tourShareAllowed({ loaded: true, signedIn: true }), false);
      assert.equal(tourShareAllowed({ loaded: true, signedIn: false }), true);
    });
  });
});
