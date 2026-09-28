import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addedFile,
  diffSnippets,
  diffTexts,
  fromStructuredPatch,
  lineDiff,
  markRanges,
  pairLines,
  parseUnifiedPatch,
  patchStats,
  renderFile,
  splitHighlighted,
  viewKey,
  wordDiff,
  type Op,
} from "./diff";

/** Applies an op list to `a`, taking added lines from `b`: must give back `b`. */
function apply(ops: Op[], a: string[], b: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "=") {
      assert.equal(a[i], b[j], "kept lines match");
      out.push(a[i++]!);
      j++;
    } else if (op === "-") i++;
    else out.push(b[j++]!);
  }
  assert.equal(i, a.length);
  return out;
}

const GIT_PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ export function f() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
-- not a header
@@ -40 +41 @@
-x
+y
\\ No newline at end of file
diff --git a/new.md b/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.md
@@ -0,0 +1,2 @@
+# Title
+text
diff --git a/old name.txt b/new name.txt
similarity 90%
rename from old name.txt
rename to new name.txt
diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

test("parseUnifiedPatch reads git files, statuses, and hunk line numbers", () => {
  const files = parseUnifiedPatch(GIT_PATCH);
  assert.deepEqual(
    files.map((f) => [f.status, f.oldPath, f.newPath, f.added, f.removed, !!f.binary]),
    [
      ["M", "src/a.ts", "src/a.ts", 3, 3, false],
      ["A", null, "new.md", 2, 0, false],
      ["R", "old name.txt", "new name.txt", 0, 0, false],
      ["M", "img.png", "img.png", 0, 0, true],
      ["D", "gone.txt", null, 0, 1, false],
    ],
  );
  const [h1, h2] = files[0]!.hunks;
  assert.equal(h1!.heading, "export function f() {");
  assert.deepEqual(
    h1!.rows.map((r) => [r.kind, r.oldNo, r.newNo, r.text]),
    [
      ["ctx", 10, 10, "const a = 1;"],
      ["del", 11, null, "const b = 2;"],
      ["add", null, 11, "const b = 3;"],
      ["add", null, 12, "const c = 4;"],
      ["ctx", 12, 13, "const d = 5;"],
      ["del", 13, null, "- not a header"],
    ],
  );
  assert.deepEqual(
    h2!.rows.map((r) => [r.kind, r.oldNo, r.newNo, !!r.noEol]),
    [
      ["del", 40, null, false],
      ["add", null, 41, true],
    ],
  );
  assert.deepEqual(files[1]!.hunks[0]!.rows.map((r) => r.newNo), [1, 2]);
});

test("parseUnifiedPatch reads pi's jsdiff patch (no git header)", () => {
  const patch = "--- src/x.ts\n+++ src/x.ts\n@@ -3,3 +3,3 @@\n a\n-b\n+B\n c\n";
  const [f] = parseUnifiedPatch(patch);
  assert.equal(f!.oldPath, "src/x.ts");
  assert.equal(f!.status, "M");
  assert.deepEqual(f!.hunks[0]!.rows.map((r) => [r.oldNo, r.newNo]), [
    [3, 3],
    [4, null],
    [null, 4],
    [5, 5],
  ]);
  assert.deepEqual(patchStats(patch), { added: 1, removed: 1 });
});

test("fromStructuredPatch numbers Claude Code hunks", () => {
  const f = fromStructuredPatch("a.ts", [{ oldStart: 5, oldLines: 2, newStart: 5, newLines: 3, lines: [" keep", "-old", "+new", "+more"] }]);
  assert.equal(f.added, 2);
  assert.equal(f.removed, 1);
  assert.deepEqual(f.hunks[0]!.rows.map((r) => [r.kind, r.oldNo, r.newNo]), [
    ["ctx", 5, 5],
    ["del", 6, null],
    ["add", null, 6],
    ["add", null, 7],
  ]);
  assert.equal(fromStructuredPatch("n.ts", [], true).status, "A");
});

test("lineDiff is a correct edit script, minimal on simple cases", () => {
  const cases: [string[], string[]][] = [
    [[], []],
    [["a"], []],
    [[], ["a"]],
    [["a", "b", "c"], ["a", "x", "c"]],
    ["abcabba".split(""), "cbabac".split("")],
    ["the quick brown fox jumps".split(" "), "a quick brown dog jumps high".split(" ")],
  ];
  for (const [a, b] of cases) assert.deepEqual(apply(lineDiff(a, b), a, b), b);
  assert.deepEqual(lineDiff(["a", "b", "c"], ["a", "x", "c"]), ["=", "-", "+", "="]);
  // Myers finds the distance-5 script of the classic example.
  assert.equal(lineDiff("abcabba".split(""), "cbabac".split("")).filter((o) => o !== "=").length, 5);
});

test("lineDiff past its cost cap replaces the middle whole, still correct", () => {
  const a = Array.from({ length: 50 }, (_, i) => `a${i % 7}`);
  const b = Array.from({ length: 50 }, (_, i) => `b${i % 5}`);
  const ops = lineDiff(["same", ...a, "end"], ["same", ...b, "end"], 3);
  assert.deepEqual(apply(ops, ["same", ...a, "end"], ["same", ...b, "end"]), ["same", ...b, "end"]);
  assert.equal(ops.filter((o) => o === "-").length, 50);
});

test("lineDiff slides an added block to end on its blank line", () => {
  const a = ["function a() {", "}", "", "function c() {", "}"];
  const b = ["function a() {", "}", "", "function b() {", "}", "", "function c() {", "}"];
  const ops = lineDiff(a, b);
  assert.deepEqual(apply(ops, a, b), b);
  const added = b.filter((_, j) => ops.filter((o) => o !== "-")[j] === "+");
  assert.deepEqual(added, ["function b() {", "}", ""]);
});

test("unique-line anchors keep moved blocks readable and correct", () => {
  const a = ["x", "unique1", "y", "y", "unique2", "z"];
  const b = ["unique2", "x", "unique1", "y", "z"];
  assert.deepEqual(apply(lineDiff(a, b), a, b), b);
});

test("diffTexts builds hunks with context and whole texts for folds", () => {
  const old = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const neu = old.replace("line 5\n", "line five\n").replace("line 25\n", "line 25\nline 25b\n");
  const f = diffTexts(old, neu, "t.txt");
  assert.equal(f.hunks.length, 2);
  assert.deepEqual([f.hunks[0]!.oldStart, f.hunks[0]!.oldLines, f.hunks[0]!.newStart, f.hunks[0]!.newLines], [2, 7, 2, 7]);
  assert.deepEqual([f.hunks[1]!.oldStart, f.hunks[1]!.newStart, f.hunks[1]!.newLines], [23, 23, 7]);
  assert.equal(f.added, 2);
  assert.equal(f.removed, 1);
  const r = renderFile(f);
  assert.equal(r.hunks[0]!.gapBefore?.count, 1);
  assert.equal(r.hunks[1]!.gapBefore?.count, 14);
  const gap = r.hunks[1]!.gapBefore!.rows!();
  assert.deepEqual([gap[0]!.oldNo, gap[0]!.newNo, gap.length], [9, 9, 14]);
  assert.equal(r.gapAfter?.count, 2);
  assert.deepEqual(r.gapAfter!.rows!().map((x) => x.newNo), [30, 31]);
});

test("addedFile and diffSnippets", () => {
  const f = addedFile("a\nb\n", "n.ts");
  assert.equal(f.status, "A");
  assert.deepEqual(f.hunks[0]!.rows.map((r) => r.newNo), [1, 2]);
  assert.deepEqual([f.hunks[0]!.oldStart, f.hunks[0]!.oldLines, f.hunks[0]!.newStart, f.hunks[0]!.newLines], [0, 0, 1, 2]);
  const s = diffSnippets([{ oldText: "x\ny\nz", newText: "x\nY\nz" }], "s.ts");
  assert.equal(s.numbered, false);
  assert.equal(s.hunks.length, 1);
  assert.deepEqual(s.hunks[0]!.rows.map((r) => r.kind), ["ctx", "del", "add", "ctx"]);
});

test("pairLines pairs by similarity, in order", () => {
  const dels = ["const total = sum(a);", "return total;"];
  const adds = ["// new comment", "const total = sum(a, b);", "return total * 2;"];
  assert.deepEqual(pairLines(dels, adds), [
    [0, 1],
    [1, 2],
  ]);
  assert.deepEqual(pairLines(["alpha beta"], ["zzz qqq"]), []);
});

test("wordDiff marks the changed words and skips mostly-changed lines", () => {
  const w = wordDiff("  if (min < 60) return min + 'm';", "  if (min < 60) return `${min}m`;")!;
  assert.ok(w);
  const a = "const ms = now - Date.parse(iso);";
  const b = "const ms = Math.max(0, now - Date.parse(iso));";
  const d = wordDiff(a, b)!;
  assert.deepEqual(d.del, []);
  assert.deepEqual(
    d.add.map(([x, y]) => b.slice(x, y)),
    ["Math.max(0,", ")"],
  );
  assert.equal(wordDiff("abc def ghi", "xyz uvw rst"), null);
  assert.equal(wordDiff("a".repeat(1001), "b"), null);
});

test("splitHighlighted reopens spans across lines (multi-line comment)", () => {
  const html = '<span class="c">/* one\ntwo */</span> <span class="k">x</span>\n<span class="s">"a<span class="e">\\n</span>\nb"</span>';
  assert.deepEqual(splitHighlighted(html), [
    '<span class="c">/* one</span>',
    '<span class="c">two */</span> <span class="k">x</span>',
    '<span class="s">"a<span class="e">\\n</span></span>',
    '<span class="s">b"</span>',
  ]);
});

test("markRanges nests marks inside syntax spans and counts entities as one character", () => {
  const line = '<span class="k">const</span> a = &quot;x&lt;y&quot;;';
  // text: `const a = "x<y";` — mark "const a" (0..7) and "<" (12..13)
  assert.equal(
    markRanges(line, [
      [0, 7],
      [12, 13],
    ], "ins"),
    '<span class="k"><ins class="diff-word">const</ins></span><ins class="diff-word"> a</ins> = &quot;x<ins class="diff-word">&lt;</ins>y&quot;;',
  );
});

test("renderFile highlights a hunk inside a multi-line comment as comment", () => {
  const old = "/**\n * a doc line\n * more\n */\nconst x = 1;\n";
  const neu = "/**\n * a doc line changed\n * more\n */\nconst x = 1;\n";
  const r = renderFile(diffTexts(old, neu, "f.ts"));
  const rows = r.hunks[0]!.rows;
  const del = rows.find((x) => x.kind === "del")!;
  const add = rows.find((x) => x.kind === "add")!;
  assert.match(del.html, /^<span class="hljs-comment">/);
  assert.match(add.html, /^<span class="hljs-comment">.*<ins class="diff-word">.*changed<\/ins>.*<\/span>$/);
  assert.equal(del.pair, rows.indexOf(add));
  const split = r.hunks[0]!.split;
  assert.ok(split.some((s) => s.left === del && s.right === add));
});

/** git's patch for a 30-line file with line 5 and line 25 changed (two hunks, 13 lines between). */
function gitPatch(path: string): { old: string; patch: string } {
  const old = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const hunk = (at: number) =>
    `@@ -${at - 3},7 +${at - 3},7 @@\n` +
    [at - 3, at - 2, at - 1].map((n) => ` line ${n}\n`).join("") +
    `-line ${at}\n+line ${at}!\n` +
    [at + 1, at + 2, at + 3].map((n) => ` line ${n}\n`).join("");
  return { old, patch: `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${hunk(5)}${hunk(25)}` };
}

test("a git patch's folds open once the viewer adds the old side's text", () => {
  const { old, patch } = gitPatch("f.txt");
  const bare = parseUnifiedPatch(patch)[0]!;
  const gap = renderFile(bare).hunks[1]!.gapBefore!;
  assert.equal(gap.count, 13);
  assert.equal(gap.rows, null); // no text: the view must ask for it
  const r = renderFile({ ...bare, oldText: old });
  const rows = r.hunks[1]!.gapBefore!.rows!();
  assert.deepEqual([rows[0]!.oldNo, rows[0]!.newNo, rows.at(-1)!.oldNo, rows.length], [9, 9, 21, 13]);
  assert.equal(r.gapAfter?.count, 2);
});

test("viewKey: a view starts over on another file or another share of hunks, not on a re-read", () => {
  const a = parseUnifiedPatch(gitPatch("a.txt").patch)[0]!;
  const b = parseUnifiedPatch(gitPatch("b.txt").patch)[0]!;
  const again = parseUnifiedPatch(gitPatch("a.txt").patch)[0]!;
  assert.notEqual(viewKey(a), viewKey(b));
  assert.equal(viewKey(a), viewKey(again));
  assert.equal(viewKey(a), viewKey({ ...a, oldText: gitPatch("a.txt").old }));
  assert.notEqual(viewKey(a, [0]), viewKey(a, [1]));
  assert.notEqual(viewKey(a, [0]), viewKey(a));
  // A rename away from a, and a snippet diff of the same path, are other files.
  assert.notEqual(viewKey(a), viewKey({ ...a, oldPath: "z.txt", status: "R" }));
  assert.notEqual(viewKey(a), viewKey({ ...a, numbered: false }));
});

test("renderFile renders a subset of hunks without gaps between non-adjacent ones", () => {
  const old = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n");
  const neu = old.replace("l2\n", "L2\n").replace("l20\n", "L20\n").replace("l35\n", "L35\n");
  const f = diffTexts(old, neu, "x.txt");
  assert.equal(f.hunks.length, 3);
  const r = renderFile(f, [2, 0]);
  assert.deepEqual(r.hunks.map((h) => h.index), [0, 2]);
  assert.equal(r.hunks[1]!.gapBefore, null);
  assert.ok(r.hunks[0]!.gapBefore === null || r.hunks[0]!.gapBefore.count > 0);
});

test("lineDiff stays a correct edit script on random inputs, and hunks renumber consistently", () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const words = ["a", "b", "c", "", "}", "{", "x = 1", "return"];
  for (let t = 0; t < 300; t++) {
    const a = Array.from({ length: rand(30) }, () => words[rand(words.length)]!);
    const b = a.filter(() => rand(4) > 0).flatMap((l) => (rand(5) === 0 ? [l, words[rand(words.length)]!] : [l]));
    const ops = lineDiff(a, b, rand(3) === 0 ? 2 : 2000);
    assert.deepEqual(apply(ops, a, b), b);
    const f = diffTexts(a.join("\n"), b.join("\n"), "r.txt");
    for (const h of f.hunks) {
      for (const r of h.rows) {
        if (r.oldNo !== null) assert.equal(r.text, a[r.oldNo - 1]);
        if (r.newNo !== null) assert.equal(r.text, b[r.newNo - 1]);
      }
    }
  }
});

test("wordDiff never marks indentation", () => {
  const a = "    <Icon name={x} />";
  const b = "      fallback={<Icon name={x} />}";
  const w = wordDiff(a, b)!;
  assert.deepEqual(w.del, []);
  assert.deepEqual(
    w.add.map(([x, y]) => b.slice(x, y)),
    ["fallback={", "}"],
  );
});
