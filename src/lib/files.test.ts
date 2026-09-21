import assert from "node:assert/strict";
import { test } from "node:test";
import { insertMention, mentionEntries, mentionQueryParts, mentionTokenAt } from "./files";

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
