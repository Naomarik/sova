// Run: npx tsx --test src/lib/regions.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { isMainThread, isTopSession } from "./regions";

const live: SessionSummary["live"] = { pid: 1, status: "idle" };
const row = (over: Partial<SessionSummary>) =>
  ({ live: null, origin: "external", archived: false, ...over }) as Pick<SessionSummary, "live" | "origin" | "archived">;

test("web sessions stay on top until archived", () => {
  assert.equal(isTopSession(row({ origin: "web" })), true);
  assert.equal(isTopSession(row({ origin: "web", archived: true })), false);
});

test("live sessions stay on top, archived or not", () => {
  assert.equal(isTopSession(row({ live })), true);
  assert.equal(isTopSession(row({ live, origin: "web", archived: true })), true);
});

test("external sessions go to the archive", () => {
  assert.equal(isTopSession(row({})), false);
});

test("fields missing from older servers count as external and not archived", () => {
  assert.equal(isTopSession({ live: null } as Pick<SessionSummary, "live" | "origin" | "archived">), false);
  assert.equal(isTopSession({ live: null, origin: "web" } as Pick<SessionSummary, "live" | "origin" | "archived">), true);
});

test("a worker session is not a main thread; an unmarked one (older server) is", () => {
  assert.equal(isMainThread({}), true);
  assert.equal(isMainThread({ workerSession: undefined }), true);
  assert.equal(isMainThread({ workerSession: true }), false);
  assert.equal(isMainThread({ overseer: true }), false, "an Overseer file is never a sidebar row");
});
