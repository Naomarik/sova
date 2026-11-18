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
  regenerateTitle,
  type RegenerateDeps,
  regeneratingTitle,
  setNaming,
  setRegeneratingTitle,
  shortenCountLine,
  shortenDoneLine,
  shorteningLabel,
  undoTitleOf,
} from "./auto-title";
import type { AutoTitleResponse } from "../../shared/protocol";
import type { ToastOptions } from "./toast";

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

test("Undo writes back what the row had: nothing stored clears it, an Overseer title stays the Overseer's, any other comes back as typed", () => {
  assert.deepEqual(undoTitleOf(row("a")), { title: null });
  assert.deepEqual(undoTitleOf(row("a", { title: "Mine", titleBy: "user", originalTitle: "first message" })), { title: "Mine" });
  assert.deepEqual(undoTitleOf(row("a", { title: "first message", titleBy: "user" })), { title: "first message" }); // stored, equal to the derived one
  assert.deepEqual(undoTitleOf(row("a", { title: "Ops", titleBy: "overseer", originalTitle: "first message" })), { title: "Ops", source: "overseer" });
  assert.deepEqual(undoTitleOf(row("a", { title: "Auto", titleBy: "auto", originalTitle: "first message" })), { title: "Auto" });
  assert.deepEqual(undoTitleOf(row("a", { title: "Old", originalTitle: "first message" })), { title: "Old" }); // an older server's override
});

/** A regenerate's world: the post answers when the test says, and every toast, sentence, rename and refresh is kept. */
function fakeRegenerate(answer: () => Promise<AutoTitleResponse>) {
  const toasts: { text: string; options?: ToastOptions }[] = [];
  const said: string[] = [];
  const renames: unknown[][] = [];
  let refreshes = 0;
  const deps: RegenerateDeps = {
    post: () => answer(),
    rename: async (...args) => void renames.push(args),
    toast: (text, options) => void toasts.push(options ? { text, options } : { text }),
    announce: (t) => void said.push(t),
    refresh: () => void refreshes++,
  };
  return { deps, toasts, said, renames, refreshes: () => refreshes };
}

test("regenerate: one keyed toast runs, then names the new title with Undo; a second press meanwhile starts nothing", async () => {
  let release!: (r: AutoTitleResponse) => void;
  let posts = 0;
  const f = fakeRegenerate(() => (posts++, new Promise((r) => (release = r))));
  const s = row("/r1", { title: "first message" });
  const first = regenerateTitle(s, f.deps);
  assert.equal(regeneratingTitle("/r1"), true);
  assert.deepEqual([...f.toasts], [{ text: "Regenerating title…", options: { key: "regenerate-title:/r1" } }]);
  assert.equal(await regenerateTitle(s, f.deps), null, "the second press is refused while the first runs");
  assert.equal(posts, 1);
  release({ results: [{ path: "/r1", outcome: "named", title: "Push subscription bug" }] });
  assert.equal(await first, "Push subscription bug");
  assert.equal(regeneratingTitle("/r1"), false);
  assert.equal(f.refreshes(), 1);
  const done = f.toasts.at(-1)!;
  assert.equal(done.text, "Renamed to “Push subscription bug”.");
  assert.equal(done.options?.key, "regenerate-title:/r1", "it replaces the running toast");
  assert.equal(done.options?.action?.label, "Undo");
  assert.deepEqual(f.said, ["Regenerating title…", "Renamed to “Push subscription bug”."]);
  await done.options!.action!.run();
  assert.deepEqual(f.renames, [["/r1", null, undefined]], "a row with no stored title goes back to none");
  assert.equal(f.toasts.at(-1)!.text, "Title back to “first message”.");
  assert.equal(f.refreshes(), 2);
});

test("regenerate: Undo of an Overseer title writes it back as the Overseer's", async () => {
  const f = fakeRegenerate(async () => ({ results: [{ path: "/r2", outcome: "named", title: "New" }] }));
  await regenerateTitle(row("/r2", { title: "Ops", titleBy: "overseer", originalTitle: "first message" }), f.deps);
  await f.toasts.at(-1)!.options!.action!.run();
  assert.deepEqual(f.renames, [["/r2", "Ops", "overseer"]]);
});

test("regenerate: a title that stays replaces the running toast with why, offers no Undo, and frees the session", async () => {
  for (const answer of [async () => ({ results: [{ path: "/r3", outcome: "skipped" as const, reason: "no-model" as const }] }), () => Promise.reject(new Error("The Sova server isn't reachable"))]) {
    const f = fakeRegenerate(answer);
    assert.equal(await regenerateTitle(row("/r3"), f.deps), null);
    const last = f.toasts.at(-1)!;
    assert.match(last.text, /^Couldn't regenerate the title\. /);
    assert.deepEqual(last.options, { key: "regenerate-title:/r3" });
    assert.equal(f.said.at(-1), last.text);
    assert.equal(regeneratingTitle("/r3"), false);
    assert.equal(f.refreshes(), 1);
    assert.deepEqual(f.renames, []);
  }
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
