import assert from "node:assert/strict";
import { test } from "node:test";
import { homeOnBoot, isOverviewHash, LAUNCH_KEY, launchHome, leaveOverview, OVERVIEW_HREF } from "./overview-route";

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

test("homeOnBoot: only the plain address, only narrow", () => {
  for (const h of ["", "#", "#/"]) assert.equal(homeOnBoot(h, true), true, h);
  for (const h of ["#/s/x", "#/projects", "#/overview"]) assert.equal(homeOnBoot(h, true), false, h);
  for (const h of ["", "#", "#/"]) assert.equal(homeOnBoot(h, false), false, `wide ${h}`);
});

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test("a narrow launch at '/' puts Home over the list; leaving goes back, never to a new '#/'", () => {
  const storage = memoryStorage();
  const history: string[] = ["(start)"];
  const env = (hash: string, narrow = true) => ({
    hash,
    narrow,
    storage,
    replace: (h: string) => (history[history.length - 1] = h),
    push: (h: string) => history.push(h),
  });
  assert.equal(launchHome(env("")), true);
  assert.deepEqual(history, ["#/", OVERVIEW_HREF], "the list, then Home above it");
  assert.equal(storage.getItem(LAUNCH_KEY), "1");
  const calls: string[] = [];
  leaveOverview(
    () => calls.push("back"),
    (h) => calls.push(`go ${h}`),
  );
  assert.deepEqual(calls, ["back"], "Back to the list beneath, never a new #/ entry");
  // A reload of the same tab keeps where it is.
  assert.equal(launchHome(env("#/")), false);
  assert.deepEqual(history, ["#/", OVERVIEW_HREF]);
});

test("a launch at a deep link, or wide, doesn't redirect, and marks the tab", () => {
  const storage = memoryStorage();
  const pushed: string[] = [];
  const env = (hash: string, narrow: boolean) => ({ hash, narrow, storage, replace: () => pushed.push("replace"), push: (h: string) => pushed.push(h) });
  assert.equal(launchHome(env("#/s/abc", true)), false);
  assert.equal(launchHome(env("", true)), false, "the tab was already launched");
  assert.equal(launchHome({ ...env("", false), storage: memoryStorage() }), false, "wide");
  assert.deepEqual(pushed, []);
});
