// An invalid script names the step, view and field at fault (§app.tours/authoring); the reveal action is
// a valid action; a dry run's full report is a valid job failure (§app.tours/recording).
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTourJob, normalizeTourScript, normalizeTourScriptRequest, tourScriptProblem, type TourScript } from "./tour";
import { tourScriptFixture } from "./tour-fixtures";

const base = (): TourScript => {
  const s = tourScriptFixture();
  s.steps.push({ id: "billing", chapter: "drafts", title: "Billing", summary: "Where invoices are.", views: [{ id: "invoice", title: "Invoice", kind: "page", note: "", route: "/billing", sizes: ["desktop", "phone"], actions: { desktop: [], phone: [] }, marks: [], masks: [] }] });
  return s;
};
const problem = (mutate: (s: Record<string, any>) => void): string | null => { const s = base() as unknown as Record<string, any>; mutate(s); assert.equal(normalizeTourScriptRequest(s), undefined, "fixture must be invalid"); return tourScriptProblem(s); };

test("a stray value inside steps, and a duplicated step, are named by place", () => {
  assert.equal(problem(s => { s.steps.push("summary"); }), "steps[2] is a string, not a step: a step is {id, chapter, title, summary, views}.");
  assert.equal(problem(s => { s.steps.push(structuredClone(s.steps[1])); }), 'steps[2] "billing" has the id "billing" again: step ids must be different.');
});

test("a view's action, mark and mask faults name the step, view and field", () => {
  assert.equal(problem(s => { s.steps[1].views[0].actions.desktop = [{ op: "click", target: { kind: "text", text: "Pay" } }]; }), 'steps[1] "billing" \u203a views[0] "invoice" \u203a actions.desktop[0]: op must be one of open, fill, wait, reveal, scroll.');
  assert.equal(problem(s => { s.steps[1].views[0].marks = [{ target: { kind: "role", role: "tabpanel", name: "x" }, label: "L", side: "right" }]; }), 'steps[1] "billing" \u203a views[0] "invoice" \u203a marks[0].target: role must be one of button, link, textbox, searchbox, combobox, checkbox, radio, tab, menuitem, heading, region, dialog, group, list, listitem, status, img, cell, columnheader, row.');
  assert.equal(problem(s => { s.steps[1].views[0].masks = [{ text: "Balance" }]; }), 'steps[1] "billing" \u203a views[0] "invoice" \u203a masks[0]: a target is {kind:"role", role, name}, {kind:"text", text} or {kind:"testId", testId}.');
  assert.equal(problem(s => { s.steps[1].views[0].marks = [{ target: { kind: "text", text: "Total" }, label: "L", side: "middle" }]; }), 'steps[1] "billing" \u203a views[0] "invoice" \u203a marks[0]: side must be "left", "right", "top" or "bottom".');
  assert.equal(problem(s => { s.steps[1].views[0].sizes = ["desktop"]; s.steps[1].views[0].actions = { desktop: [] }; }), 'steps[1] "billing" \u203a views[0] "invoice" shows one size, so it needs unavailableReason: why the other size isn\'t pictured (1 to 300 characters).');
  assert.equal(problem(s => { s.steps[1].chapter = "nope"; }), 'steps[1] "billing": chapter must be the id of one of the script\'s chapters (drafts).');
  assert.equal(problem(s => { s.steps[1].views.push({ id: "invoice", title: "Again", kind: "reference", note: "", reference: "Text." }); }), 'steps[1] "billing" \u203a views[1] "invoice" has the id "invoice" again: view ids within a step must be different.');
});

test("every invalid script gets a named problem, and a valid one none", () => {
  assert.equal(tourScriptProblem(base()), null);
  for (const mutate of [(s: Record<string, any>) => { s.title = ""; }, (s: Record<string, any>) => { s.chapters = []; }, (s: Record<string, any>) => { s.steps[0].views[0].route = "relative"; }, (s: Record<string, any>) => { s.steps[0].views[0].note = 7; }, (s: Record<string, any>) => { s.steps[0].views[0].actions.phone = [{ op: "scroll", x: 0.5, y: 0 }]; }])
    assert.notEqual(problem(mutate), null);
});

test("{op:\"reveal\", target} is a valid action, with nothing else beside its target", () => {
  const s = base();
  (s.steps[1]!.views[0] as { actions: Record<string, unknown[]> }).actions.desktop = [{ op: "reveal", target: { kind: "role", role: "button", name: "Pay" } }];
  assert.ok(normalizeTourScriptRequest(s));
  (s.steps[1]!.views[0] as { actions: Record<string, unknown[]> }).actions.desktop = [{ op: "reveal", target: { kind: "role", role: "button", name: "Pay" }, y: 3 }];
  assert.equal(normalizeTourScriptRequest(s), undefined);
});

test("a dry run's full report, with grouped problems and nearby targets, is a valid job failure", () => {
  const AT = "2026-01-02T03:04:05.000Z";
  const failure = { message: "The dry run found 3 problems in 2 views.", guidance: "Fix every problem below.", stepId: "billing", viewId: "invoice", size: "desktop",
    problems: [{ message: "Target matched 0 visible controls; exactly 1 is required.", guidance: "Use a unique name.", at: [{ stepId: "billing", viewId: "invoice", size: "desktop", action: 0 }, { stepId: "billing", viewId: "invoice", size: "phone", action: 0 }], count: 9, target: { kind: "role", role: "button", name: "Overview" }, matches: 0, nearby: [{ target: { kind: "role", role: "tab", name: "Overview" }, matches: 1 }] }],
    more: 2 };
  assert.ok(normalizeTourJob({ v: 1, id: "job-a", tourId: "tour-a", sessionId: "s1", title: "T", phase: "failed", completed: 1, total: 4, failure, createdAt: AT, updatedAt: AT }));
});

test("a page view on the sign-in route is refused by name: its path, and its hash route when the route names one; a stored script still loads", () => {
  const signIn = { route: "/login", username: { kind: "role", role: "textbox", name: "Email" }, password: { kind: "testId", testId: "password" }, submit: { kind: "role", role: "button", name: "Sign in" }, signedIn: { kind: "role", role: "link", name: "Home" } };
  const named = 'steps[1] "billing" \u203a views[0] "invoice" is the sign-in page; it is never pictured. The look lists it signed out; describe it in a reference view.';
  assert.equal(problem(s => { s.signIn = signIn; s.steps[1].views[0].route = "/login"; }), named);
  assert.equal(problem(s => { s.signIn = signIn; s.steps[1].views[0].route = "/login?next=/billing"; }), named, "a query is still the sign-in page");
  assert.equal(problem(s => { s.signIn = { ...signIn, route: "/#/login" }; s.steps[1].views[0].route = "/#/login"; }), named);
  // Collision: the same routes that are not the sign-in page stay valid.
  for (const [route, view] of [["/login", "/login-help"], ["/#/login", "/#/account"], ["/#/login", "/"], ["/login", "/billing"]] as const) {
    const s = base() as unknown as Record<string, any>; s.signIn = { ...signIn, route }; s.steps[1].views[0].route = view;
    assert.ok(normalizeTourScriptRequest(s), `${view} with sign-in ${route}`); assert.equal(tourScriptProblem(s), null);
  }
  // A view without a declared sign-in may be any route; a reference view describes the sign-in page.
  const plain = base() as unknown as Record<string, any>; plain.steps[1].views[0].route = "/login";
  assert.ok(normalizeTourScriptRequest(plain));
  // A stored script (already accepted) is never refused on load: the recorder stops it instead.
  const stored = base() as unknown as Record<string, any>; stored.signIn = signIn; stored.steps[1].views[0].route = "/login";
  assert.ok(normalizeTourScript(stored));
});
