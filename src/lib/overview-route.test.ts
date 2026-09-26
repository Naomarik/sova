import assert from "node:assert/strict";
import { test } from "node:test";
import { isOverviewHash, leaveOverview, OVERVIEW_HREF } from "./overview-route";

test("isOverviewHash: the overview route only", () => {
  assert.equal(isOverviewHash(OVERVIEW_HREF), true);
  assert.equal(isOverviewHash("#/overview/"), true);
  for (const h of ["", "#/", "#/overviews", "#/overview/x", "#/sessions"]) assert.equal(isOverviewHash(h), false, h);
});

test("leaving without the list's button navigates to the list", () => {
  const calls: string[] = [];
  leaveOverview(
    () => calls.push("back"),
    (h) => calls.push(`go ${h}`),
  );
  assert.deepEqual(calls, ["go #/"]);
});

test("leaving after the list's button goes back once, then navigates", async () => {
  const g = globalThis as { location?: { hash: string } };
  g.location = { hash: "" };
  const { openOverview } = await import("./overview-route");
  openOverview();
  assert.equal(g.location.hash, OVERVIEW_HREF);
  const calls: string[] = [];
  const back = () => calls.push("back");
  const go = (h: string) => calls.push(`go ${h}`);
  leaveOverview(back, go);
  leaveOverview(back, go);
  assert.deepEqual(calls, ["back", "go #/"], "the flag is spent by the first");
  delete g.location;
});
