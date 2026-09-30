// Run: pnpm exec tsx --test src/lib/previews.test.ts. The Previews card's words and checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PreviewView } from "../../shared/preview-links";
import { activePreviews, parsePort, previewWarning, runningLine } from "./previews";

const view = (over: Partial<PreviewView>): PreviewView => ({
  id: "pv_aaaaaaaaaaaaaaaa",
  orgId: "o",
  projectId: "p",
  port: 5173,
  createdAt: "2026-09-30T00:00:00.000Z",
  expiresAt: "2026-10-01T00:00:00.000Z",
  createdBy: "operator",
  state: "active",
  ...over,
});

test("the warning names the port, and a placeholder while none is typed", () => {
  assert.equal(previewWarning(5173), "Anyone with this link can use the app on port 5173 as if they were on this computer, including its logins, admin pages and anything it can change.");
  assert.match(previewWarning(null), /on port N as if/);
});

test("running line: the app answers, or nothing on its port", () => {
  assert.equal(runningLine(view({ running: true })), "App is running");
  assert.equal(runningLine(view({ running: false, port: 3000 })), "Nothing on port 3000");
});

test("only active previews are listed, longest-lived first", () => {
  const list = [
    view({ id: "a", expiresAt: "2026-10-01T00:00:00.000Z" }),
    view({ id: "b", state: "off" }),
    view({ id: "c", state: "expired" }),
    view({ id: "d", expiresAt: "2026-10-20T00:00:00.000Z" }),
  ];
  assert.deepEqual(activePreviews(list).map((v) => v.id), ["d", "a"]);
});

test("the port field: whole numbers 1–65535, never Sova's own defaults", () => {
  assert.deepEqual(parsePort(" 5173 "), { port: 5173 });
  for (const bad of ["", "abc", "0", "65536", "51.73", "-1"]) assert.ok("error" in parsePort(bad), bad);
  for (const own of ["4800", "4801", "4802", "4810"]) assert.match((parsePort(own) as { error: string }).error, /Sova's own/);
});
