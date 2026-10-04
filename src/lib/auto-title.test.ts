// Run: npx tsx --test src/lib/auto-title.test.ts — the Name sessions button's rules
// (§app.session-list/auto-titles): which rows it counts, its label, and how a press splits by host.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import {
  batchesByHost,
  isNameable,
  nameableRows,
  nameLabel,
  nameSessions,
  namingIn,
  regenerateOutcome,
  regeneratingTitle,
  setNaming,
  setRegeneratingTitle,
  shortenCountLine,
  shortenDoneLine,
  shorteningLabel,
} from "./auto-title";

const row = (path: string, over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: path, path, cwd: "/", title: "first message", createdAt: "", lastActiveAt: "", model: null, live: null, busy: false, origin: "web", archived: false, ...over }) as SessionSummary;

test("nameable: no stored title of any kind, not a draft-only row, not a worker or Overseer file", () => {
  assert.equal(isNameable(row("a")), true);
  assert.equal(isNameable(row("a", { titleBy: "auto", title: "Auto", originalTitle: "first message" })), false);
  assert.equal(isNameable(row("a", { titleBy: "user" })), false); // even equal to the derived title
  assert.equal(isNameable(row("a", { titleBy: "overseer", originalTitle: "x" })), false);
  assert.equal(isNameable(row("a", { originalTitle: "x" })), false); // an older server's override
  assert.equal(isNameable(row("a", { draftPreview: "typing…" })), false);
  assert.equal(isNameable(row("a", { workerSession: true })), false);
  assert.equal(isNameable(row("a", { overseer: true })), false);
});

test("a section counts each session once", () => {
  const rows = [row("a"), row("b", { titleBy: "user" }), row("a"), row("c")];
  assert.deepEqual(nameableRows(rows).map((s) => s.path), ["a", "c"]);
});

test("the label counts, and says when it is running", () => {
  assert.equal(nameLabel(1), "Name 1 session");
  assert.equal(nameLabel(12), "Name 12 sessions");
  assert.equal(nameLabel(3, true), "Naming 3 sessions…");
});

test("a press splits by host, and caps each request at the route's limit", () => {
  const host = (p: string) => (p.startsWith("peer:") ? "laptop" : null);
  assert.deepEqual(batchesByHost(["a", "peer:x", "b", "peer:y"], host), [["a", "b"], ["peer:x", "peer:y"]]);
  const many = Array.from({ length: 450 }, (_, i) => `s${i}`);
  assert.deepEqual(batchesByHost(many, () => null).map((b) => b.length), [200, 200, 50]);
});

test("a host that fails (an older peer's 404) skips its rows silently; the others are named", async () => {
  const host = (p: string) => (p.startsWith("peer:") ? "old-peer" : null);
  const sent: string[][] = [];
  const out = await nameSessions(["a", "peer:x"], {
    hostOf: host,
    post: async (paths) => {
      sent.push(paths);
      if (paths[0]!.startsWith("peer:")) throw Object.assign(new Error("Not found"), { status: 404 });
      return { results: paths.map((path) => ({ path, outcome: "named" as const, title: "A title" })) };
    },
  });
  assert.deepEqual(sent, [["a"], ["peer:x"]]);
  assert.deepEqual(out, [
    { path: "a", outcome: "named", title: "A title" },
    { path: "peer:x", outcome: "skipped", reason: "failed" },
  ]);
});

test("the in-flight mark is per section and survives until cleared", () => {
  assert.equal(namingIn("t"), false);
  setNaming("t", true);
  assert.equal(namingIn("t"), true);
  assert.equal(namingIn("a"), false);
  setNaming("t", false);
  assert.equal(namingIn("t"), false);
});

test("regenerate: a named result is the new title; anything else is one toast that says the title stayed and why", () => {
  assert.deepEqual(regenerateOutcome({ results: [{ path: "/a", outcome: "named", title: "Push subscription bug" }] }), { title: "Push subscription bug" });
  const raced = regenerateOutcome({ results: [{ path: "/a", outcome: "skipped", reason: "explicit" }] });
  assert.ok("error" in raced && raced.error.startsWith("Couldn't regenerate the title. The title changed"), JSON.stringify(raced));
  const none = regenerateOutcome({ results: [{ path: "/a", outcome: "skipped", reason: "no-model" }] });
  assert.ok("error" in none && /Neither title model can run/.test(none.error));
  const thrown = regenerateOutcome(new Error("The Sova server isn't reachable"));
  assert.deepEqual(thrown, { error: "Couldn't regenerate the title. The Sova server isn't reachable." });
  assert.ok("error" in regenerateOutcome({ results: [] }));
});

test("regenerating is per open session, and survives a remount", () => {
  assert.equal(regeneratingTitle("/a"), false);
  setRegeneratingTitle("/a", true);
  assert.equal(regeneratingTitle("/a"), true);
  assert.equal(regeneratingTitle("/b"), false);
  setRegeneratingTitle("/a", false);
  assert.equal(regeneratingTitle("/a"), false);
});

test("Shorten long titles' lines: the count before, the busy label, and what was done after", () => {
  assert.equal(shortenCountLine(0), "No title is longer than 36 characters.");
  assert.equal(shortenCountLine(1), "1 title is longer than 36 characters.");
  assert.equal(shortenCountLine(12), "12 titles are longer than 36 characters.");
  assert.equal(shorteningLabel(1), "Shortening 1 title…");
  assert.equal(shorteningLabel(3), "Shortening 3 titles…");
  const named = { path: "/a", outcome: "named" as const, title: "Short" };
  const failed = { path: "/b", outcome: "skipped" as const, reason: "failed" as const };
  assert.equal(shortenDoneLine([named, named]), "Shortened 2 of 2 titles.");
  assert.equal(shortenDoneLine([named, failed]), "Shortened 1 of 2 titles. 1 couldn't be shortened.");
});
