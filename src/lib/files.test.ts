import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  cachedFileIndex,
  capMentionEntries,
  ensureFileIndex,
  heldFileIndex,
  INDEX_TTL_MS,
  insertMention,
  MENTION_ROW_CAP,
  mentionEntries,
  mentionIndexStatus,
  mentionQueryParts,
  mentionTokenAt,
  NO_CWD_MESSAGE,
  shouldFetchIndex,
} from "./files";

const caretAfter = (text: string, token: string) => text.indexOf(token) + token.length;

test("mentionTokenAt finds the @ token at the start and after whitespace", () => {
  assert.deepEqual(mentionTokenAt("@sr", 3), { start: 0, end: 3, query: "sr" });
  assert.deepEqual(mentionTokenAt("look at @src/lib", caretAfter("look at @src/lib", "@src/li")), {
    start: 8,
    end: 16,
    query: "src/li",
  });
  assert.deepEqual(mentionTokenAt("a\n@x", 4), { start: 2, end: 4, query: "x" }); // newline is a boundary
});

test("mentionTokenAt never claims an email or a bare @ mid-word", () => {
  assert.equal(mentionTokenAt("user@example.com", 16), null);
  assert.equal(mentionTokenAt("ping @omar about it", 19), null); // caret left the token
});

test("mentionTokenAt ends the token at the next whitespace and tracks the caret's side", () => {
  // Caret in the middle: end still stops at the space.
  const t = mentionTokenAt("@src/li is next", 6)!;
  assert.equal(t.end, 7);
  assert.deepEqual(mentionTokenAt("@src main", 4), { start: 0, end: 4, query: "src" });
  // A bare "@" with nothing typed yet is a token with an empty query.
  assert.deepEqual(mentionTokenAt("@", 1), { start: 0, end: 1, query: "" });
});

test("mentionTokenAt keeps a quoted path (spaces) one token", () => {
  const text = 'see @"My Docs/rea';
  const caret = text.length;
  const t = mentionTokenAt(text, caret)!;
  assert.equal(t.start, text.indexOf("@"));
  assert.equal(t.query, '"My Docs/rea');
  // Esc completes the close quote: the file pick's text is one token too.
  const done = 'see @"My Docs/readme.md" now';
  const t2 = mentionTokenAt(done, done.indexOf(" now"))!;
  assert.equal(t2.query, '"My Docs/readme.md"');
});

test("mentionQueryParts splits at the last slash, ignoring the opening quote", () => {
  assert.deepEqual(mentionQueryParts("src/lib/ma"), { dir: "src/lib/", segment: "ma" });
  assert.deepEqual(mentionQueryParts("src"), { dir: "", segment: "src" });
  assert.deepEqual(mentionQueryParts('"My Docs/rea'), { dir: "My Docs/", segment: "rea" });
  assert.deepEqual(mentionQueryParts(""), { dir: "", segment: "" });
});

const FILES = [
  "AGENTS.md",
  "README.md",
  "package.json",
  "src/Composer.tsx",
  "src/ChatView.tsx",
  "src/lib/api.ts",
  "src/lib/files.ts",
  "src/components/SlashMenu.tsx",
  ".env",
  ".github/workflows/ci.yml",
];

test("mentionEntries lists one level: directories first, then names", () => {
  assert.deepEqual(
    mentionEntries(FILES, "").map((e) => e.name),
    ["src", "AGENTS.md", "package.json", "README.md"], // dot entries held back without a dot segment
  );
  const src = mentionEntries(FILES, "src/");
  assert.deepEqual(
    src.map((e) => e.name),
    ["components", "lib", "ChatView.tsx", "Composer.tsx"],
  );
  assert.deepEqual(
    src.map((e) => e.dir),
    [true, true, false, false],
  );
});

test("mentionEntries filters by the segment, case-insensitively", () => {
  assert.deepEqual(
    mentionEntries(FILES, "src/l").map((e) => e.name),
    ["lib"],
  );
  assert.deepEqual(
    mentionEntries(FILES, "SRC/c").map((e) => e.name),
    ["components", "ChatView.tsx", "Composer.tsx"], // the directory is case-insensitive too
  );
  assert.deepEqual(mentionEntries(FILES, "read"), [{ name: "README.md", path: "README.md", dir: false }]);
});

test("mentionEntries shows hidden entries once the segment starts with a dot", () => {
  assert.deepEqual(
    mentionEntries(FILES, ".").map((e) => e.name),
    [".github", ".env"], // directories first, as everywhere
  );
  assert.deepEqual(
    mentionEntries(FILES, ".g").map((e) => e.name),
    [".github"],
  );
  assert.deepEqual(mentionEntries(FILES, ".github/").map((e) => e.name), ["workflows"]);
});

test("mentionEntries takes the path through to the picked name", () => {
  const e = mentionEntries(FILES, "src/components/s").find((x) => x.name === "SlashMenu.tsx")!;
  assert.equal(e.path, "src/components/SlashMenu.tsx");
  assert.equal(e.dir, false);
});

test("mentionEntries hands back the same entry object for the same path across queries", () => {
  // What lets the menu's <For> keep its rows while the user types: it keys rows by object.
  const src = mentionEntries(FILES, "").find((e) => e.name === "src")!;
  assert.equal(mentionEntries(FILES, "s").find((e) => e.name === "src"), src);
  assert.equal(mentionEntries(FILES, "S").find((e) => e.name === "src"), src);
  const composer = mentionEntries(FILES, "src/c").find((e) => e.name === "Composer.tsx")!;
  assert.equal(mentionEntries(FILES, "src/co").find((e) => e.name === "Composer.tsx"), composer);
  assert.equal(mentionEntries(FILES, "src/").find((e) => e.name === "Composer.tsx"), composer);
  // A refetched index is a new array: its entries are its own, not the old index's.
  assert.notEqual(mentionEntries([...FILES], "").find((e) => e.name === "src"), src);
});

// 150 directories then 150 files at the top: every "f" name sorts AFTER the first 150 rows of
// the level, so a cap applied to the level instead of to the matches would find none of them.
const WIDE = [
  ...Array.from({ length: 150 }, (_, i) => `d${String(i).padStart(3, "0")}/x.ts`),
  ...Array.from({ length: 150 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`),
];

test("capMentionEntries draws the first matches and counts the rest", () => {
  const all = mentionEntries(WIDE, "f");
  assert.equal(all.length, 150, "the true total of matches");
  const { shown, more } = capMentionEntries(all, 100);
  assert.equal(shown.length, 100);
  assert.equal(shown[0]!.name, "f000.ts", "the cap applies to the matches, not to the level");
  assert.deepEqual(shown, all.slice(0, 100), "the first matches, in the menu's order");
  assert.equal(more, 50, "the “…and N more” line's number");
  assert.equal(shown.length + more, all.length, "drawn plus more is the total the head reports");
});

test("capMentionEntries leaves a list under the cap alone", () => {
  const all = mentionEntries(WIDE, "f1");
  assert.equal(all.length, 50);
  const { shown, more } = capMentionEntries(all, 100);
  assert.equal(shown, all, "the same array: nothing to cut");
  assert.equal(more, 0);
  assert.deepEqual(capMentionEntries(all, 50), { shown: all, more: 0 }, "exactly at the cap is not over it");
});

test("capMentionEntries defaults to MENTION_ROW_CAP", () => {
  const all = mentionEntries(WIDE, "");
  assert.equal(all.length, 300);
  const { shown, more } = capMentionEntries(all);
  assert.equal(shown.length, MENTION_ROW_CAP);
  assert.equal(more, 300 - MENTION_ROW_CAP);
});

test("insertMention completes a file and closes the token with a space", () => {
  const token = mentionTokenAt("edit @src/lib/fi please", "src/lib/fi".length + "edit @".length)!;
  const next = insertMention("edit @src/lib/fi please", token, { name: "files.ts", path: "src/lib/files.ts", dir: false });
  assert.equal(next.text, "edit src/lib/files.ts please");
  assert.equal(next.caret, "edit src/lib/files.ts".length);
});

test("insertMention drills into a directory: slash, no space, token continues", () => {
  const text = "edit @sr";
  const token = mentionTokenAt(text, text.length)!;
  const next = insertMention(text, token, { name: "src", path: "src", dir: true });
  assert.equal(next.text, "edit @src/");
  assert.equal(next.caret, next.text.length);
  // The menu now offers src's children for the continuing token.
  assert.deepEqual(
    mentionEntries(FILES, mentionTokenAt(next.text, next.caret)!.query).map((e) => e.name),
    ["components", "lib", "ChatView.tsx", "Composer.tsx"],
  );
});

test("insertMention quotes only paths with spaces, closing the quote on a file", () => {
  const dirText = 'see @"My Docs/rea';
  const dirToken = mentionTokenAt(dirText, dirText.length)!;
  const drilled = insertMention(dirText, dirToken, { name: "readme.md", path: "My Docs/readme.md", dir: false });
  assert.equal(drilled.text, 'see "My Docs/readme.md" ');
  assert.equal(drilled.caret, drilled.text.length);
  // Picking a directory whose name has spaces opens the quote and keeps drilling.
  const bare = "see @My";
  const bareToken = mentionTokenAt(bare, bare.length)!;
  const opened = insertMention(bare, bareToken, { name: "My Docs", path: "My Docs", dir: true });
  assert.equal(opened.text, 'see @"My Docs/');
});

test("insertMention quotes the whole path when only the directory had spaces", () => {
  const text = 'see @"My Docs/fil';
  const token = mentionTokenAt(text, text.length)!;
  const next = insertMention(text, token, { name: "files.ts", path: "My Docs/files.ts", dir: false });
  assert.equal(next.text, 'see "My Docs/files.ts" ');
});

// ---------------------------------------------------------------------------
// what the menu says, and when it fetches — both keyed by the cwd they belong to

test("mentionIndexStatus reads loading, ready, and the session's missing folder", () => {
  assert.deepEqual(mentionIndexStatus({ cwd: "/w/app", cached: false, error: null }), { state: "loading" });
  assert.deepEqual(mentionIndexStatus({ cwd: "/w/app", cached: true, error: null }), { state: "ready" });
  assert.deepEqual(mentionIndexStatus({ cwd: null, cached: false, error: null }), { state: "error", error: NO_CWD_MESSAGE });
  assert.deepEqual(mentionIndexStatus({ cwd: undefined, cached: true, error: null }), { state: "error", error: NO_CWD_MESSAGE });
});

test("mentionIndexStatus shows an error only for the cwd it happened in", () => {
  const error = { cwd: "/w/old", message: "Folder not found" };
  assert.deepEqual(mentionIndexStatus({ cwd: "/w/old", cached: false, error }), { state: "error", error: "Folder not found" });
  // The session moved: the folder we left failing says nothing about the one we are in.
  assert.deepEqual(mentionIndexStatus({ cwd: "/w/new", cached: false, error }), { state: "loading" });
  assert.deepEqual(mentionIndexStatus({ cwd: "/w/new", cached: true, error }), { state: "ready" });
});

test("shouldFetchIndex tries once per opening, and re-arms when the cwd changes", () => {
  assert.equal(shouldFetchIndex({ cwd: "/w/app", cached: false, fetchedFor: null }), true);
  assert.equal(shouldFetchIndex({ cwd: "/w/app", cached: false, fetchedFor: "/w/app" }), false, "one attempt per opening, failure included");
  assert.equal(shouldFetchIndex({ cwd: "/w/app", cached: true, fetchedFor: null }), false, "a fresh index needs no request");
  assert.equal(shouldFetchIndex({ cwd: "/w/new", cached: false, fetchedFor: "/w/old" }), true, "a menu open across a cwd switch refetches");
  assert.equal(shouldFetchIndex({ cwd: null, cached: false, fetchedFor: null }), false);
});

test("an index that ages out mid-token stays listed; the next opening refetches, once", async (t) => {
  const cwd = "/w/stale";
  let calls = 0;
  let fail = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    if (fail) return new Response(JSON.stringify({ error: "Folder not found" }), { status: 404 });
    return new Response(JSON.stringify({ files: [`v${calls}.ts`], truncated: false }), { status: 200 });
  }) as typeof fetch;
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  t.after(() => {
    globalThis.fetch = realFetch;
    mock.timers.reset();
  });

  const first = await ensureFileIndex(cwd);
  assert.equal(calls, 1);
  assert.equal(heldFileIndex(cwd), first);

  // The token stays open past the TTL. The fresh read says "refetch" (that is what the menu used
  // to list, and it listed nothing); the held index is still what the menu shows.
  mock.timers.tick(INDEX_TTL_MS + 1);
  assert.equal(cachedFileIndex(cwd), null);
  assert.equal(heldFileIndex(cwd), first);
  assert.deepEqual(
    mentionEntries(heldFileIndex(cwd)!.files, "v").map((e) => e.name),
    ["v1.ts"],
  );
  assert.deepEqual(mentionIndexStatus({ cwd, cached: !!heldFileIndex(cwd), error: null }), { state: "ready" });
  // This opening already fetched: no second request, however stale — and so no loop.
  assert.equal(shouldFetchIndex({ cwd, cached: !!cachedFileIndex(cwd), fetchedFor: cwd }), false);
  // The next opening does refetch, and the fresh index replaces the held one.
  assert.equal(shouldFetchIndex({ cwd, cached: !!cachedFileIndex(cwd), fetchedFor: null }), true);
  const second = await ensureFileIndex(cwd);
  assert.equal(calls, 2);
  assert.equal(heldFileIndex(cwd), second);
  assert.deepEqual(second.files, ["v2.ts"]);

  // A failed refetch keeps the last good index held, reports its error, and is not retried
  // within the opening.
  mock.timers.tick(INDEX_TTL_MS + 1);
  fail = true;
  await assert.rejects(ensureFileIndex(cwd), /Folder not found/);
  assert.equal(calls, 3);
  assert.equal(heldFileIndex(cwd), second);
  const error = { cwd, message: "Folder not found" };
  assert.deepEqual(mentionIndexStatus({ cwd, cached: !!heldFileIndex(cwd), error }), { state: "error", error: "Folder not found" });
  assert.equal(shouldFetchIndex({ cwd, cached: !!cachedFileIndex(cwd), fetchedFor: cwd }), false);
});
