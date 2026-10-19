// record_tour look's request checks, the script it runs and its answer's bounds (§app.tours/look).
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTourScriptRequest } from "../../shared/tour";
import { normalizeTourLookResult, tourLookAnswer, tourLookProblem, tourLookScript, tourLookUrl, type TourLookRequest } from "./look";

const source = { kind: "site" as const, origin: "https://app.example.test" };
const signIn = { route: "/login", username: { kind: "role" as const, role: "textbox", name: "Email" }, password: { kind: "testId" as const, testId: "password" }, submit: { kind: "role" as const, role: "button", name: "Sign in" }, signedIn: { kind: "role" as const, role: "heading", name: "Dashboard" } };

test("a look request is checked by name; its pages become one step each at both sizes, no marks or masks", () => {
  const request: TourLookRequest = { source, signIn, pages: [{ route: "/" }, { route: "/#/settings", actions: [{ op: "reveal", target: { kind: "role", role: "button", name: "Save" } }] }, { route: "/billing", actions: { phone: [{ op: "scroll", x: 0, y: 400 }] } }] };
  assert.equal(tourLookProblem(request), null);
  const script = normalizeTourScriptRequest(tourLookScript(request));
  assert.ok(script, "a valid script");
  assert.equal(script!.steps.length, 3);
  for (const step of script!.steps) {
    const view = step.views[0]!;
    assert.equal(view.kind, "page");
    if (view.kind !== "page") continue;
    assert.deepEqual(view.sizes, ["desktop", "phone"]);
    assert.deepEqual([view.marks, view.masks], [[], []]);
  }
  const [, second, third] = script!.steps.map(s => s.views[0]!) as { actions: Record<string, unknown[]> }[];
  assert.equal(second!.actions.desktop!.length, 1); assert.equal(second!.actions.phone!.length, 1, "one list serves both sizes");
  assert.deepEqual(third!.actions.desktop, []); assert.equal(third!.actions.phone!.length, 1);
  assert.equal(script!.signIn?.route, "/login");
});

test("a look with only a sign-in route lists that page alone; without one it needs a page", () => {
  assert.equal(tourLookProblem({ source, signInRoute: "/login", pages: [] }), null);
  assert.ok(normalizeTourScriptRequest(tourLookScript({ source, signInRoute: "/login", pages: [] })), "a page-less script still validates (a reference step the child skips)");
  assert.match(tourLookProblem({ source, pages: [] })!, /at least one page, or signInRoute/);
  assert.match(tourLookProblem({ source, signIn, signInRoute: "/login", pages: [] })!, /signIn or signInRoute, not both/);
  assert.match(tourLookProblem({ source, pages: Array.from({ length: 11 }, () => ({ route: "/" })) })!, /at most 10 pages/);
  assert.match(tourLookProblem({ source, pages: [{ route: "settings" }] })!, /^pages\[0\]: route must be a path/);
  assert.match(tourLookProblem({ source, pages: [{ route: "/" }, { route: "/x", actions: [{ op: "click", target: { kind: "text", text: "Go" } }] }] })!, /^pages\[1\] › actions\.desktop\[0\]: op must be one of/);
  assert.match(tourLookProblem({ pages: [{ route: "/" }] })!, /needs source/);
  assert.match(tourLookProblem({ source, pages: [{ route: "/" }], marks: [] })!, /doesn't take marks/);
  assert.match(tourLookProblem({ source, signIn: { ...signIn, password: { kind: "text", text: "Password" } }, pages: [{ route: "/" }] })!, /signIn\.password must name the box by role or testId/);
});

test("the child's answer is bounded; the agent's answer names the tour id to reuse", () => {
  const size = { url: "/", controls: [{ role: "heading", name: "Dashboard", matches: 1, onFirstScreen: true, y: 10, h: 30 }], links: ["/#/settings"] };
  assert.ok(normalizeTourLookResult({ pages: [{ route: "/", desktop: size, phone: size }], signInPage: { route: "/login", ...size } }));
  assert.equal(normalizeTourLookResult({ pages: [{ route: "/", desktop: { ...size, controls: Array.from({ length: 41 }, () => size.controls[0]) } }] }), undefined);
  assert.equal(normalizeTourLookResult({ pages: Array.from({ length: 11 }, () => ({ route: "/" })) }), undefined);
  const answer = tourLookAnswer("tour-abc", { pages: [] });
  assert.equal(answer.tourId, "tour-abc");
  assert.match(answer.next, /dry run with tourId "tour-abc"/);
  assert.equal(tourLookUrl("https://app.example.test/a?b=1#/c", "https://app.example.test"), "/a?b=1#/c");
  assert.equal(tourLookUrl("https://idp.example.test/x", "https://app.example.test"), "https://idp.example.test/x");
});

test("a look page on the sign-in route (signIn.route or signInRoute) is refused by name: the look lists that page signed out", () => {
  const named = (i: number) => `pages[${i}] is the sign-in page; it is never pictured. The look lists it signed out; leave it out of pages.`;
  assert.equal(tourLookProblem({ source, signIn, pages: [{ route: "/" }, { route: "/login" }] }), named(1));
  assert.equal(tourLookProblem({ source, signInRoute: "/login", pages: [{ route: "/login?next=/" }] }), named(0));
  assert.equal(tourLookProblem({ source, signInRoute: "/#/login", pages: [{ route: "/#/login" }] }), named(0));
  // Collision: other routes, and the same path under another hash route, are pages like any other.
  assert.equal(tourLookProblem({ source, signInRoute: "/#/login", pages: [{ route: "/" }, { route: "/#/account" }] }), null);
  assert.equal(tourLookProblem({ source, signIn, pages: [{ route: "/login-help" }] }), null);
  assert.equal(tourLookProblem({ source, pages: [{ route: "/login" }] }), null, "no sign-in declared: any route");
});
