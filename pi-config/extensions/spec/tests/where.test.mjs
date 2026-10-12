// where: the claims for a source file, ranked by shared interface tokens, or for a name; bounded, stateless.
import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, cli, pages, write } from "./map-fixture.mjs";
import { termsOf } from "../core/topic.mjs";

test("where PATH: every claim whose code lists the file, ranked by the rare interface tokens they share with it", () => {
  const root = fixture();
  const { j } = cli(root, ["where", "src/editor.ts"]);
  assert.equal(j.mode, "path");
  assert.deepEqual(j.file, { path: "src/editor.ts", state: "read", mapped: true });
  assert.deepEqual(j.counts, { claims: 2, ranked: 2, unranked: 0 });
  assert.deepEqual(j.lines.map((l) => [l.type, l.id]), [["ranked", "§ed.seed/compose"], ["ranked", "§ed/seed"]]);
  assert.deepEqual(j.lines[0].shared.sort(), ["Composer.send()", "POST /api/send", "draftId"]);
  assert.deepEqual(j.lines[1].shared, ["EditorPane"]);
  assert.equal(j.exit, 0);
  const shared = cli(root, ["where", "./src/shared.ts"]).j;
  assert.equal(shared.query, "src/shared.ts");
  assert.deepEqual(shared.lines.map((l) => [l.type, l.id, l.tokens]), [["ranked", "§ed.seed/compose", 3], ["unranked", "§ot/coder", 0]], "a claim sharing no token stays, after the ranked ones");
  const text = cli(root, ["where", "src/shared.ts"], { json: false }).r.stdout;
  assert.match(text, /^src\/shared.ts: 2 claim\(s\) list this file in their code$/m);
  assert.match(text, /^    shares: `draftId`$/m);
  assert.match(text, /^  §ot\/coder — Coder  note · unlabelled · no interface token$/m);
});

test("where shows the top 10 and names the rest; --all lists every claim, paged, none dropped", () => {
  const root = fixture();
  const ids = Array.from({ length: 13 }, (_, i) => `§many/c${String.fromCharCode(97 + i)}`);
  const m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  for (const id of ids) {
    m.claims[id] = { kind: "note", code: ["src/save.ts"] };
    write(root, `.sova/spec/claims/many/${id.split("/")[1]}.md`, `# ${id} — Part\n\nA part that names no interface token.\n`);
  }
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  const top = cli(root, ["where", "src/save.ts"]).j;
  assert.equal(top.total, 14);
  assert.equal(top.shown, 10);
  assert.equal(top.lines.length, 10);
  assert.match(cli(root, ["where", "src/save.ts"], { json: false }).r.stdout, /^4 more not shown: where 'src\/save.ts' --all$/m);
  const all = pages(root, ["where", "src/save.ts", "--all"], 1500).flatMap((p) => p.lines);
  assert.equal(all.length, 14);
  assert.deepEqual(new Set(all.map((l) => l.id)), new Set([...ids, "§ed.seed/save"]));
});

test("where on a file no record lists: says so, exit 1, with labelled unmapped candidates, never an empty success", () => {
  const root = fixture();
  const { j } = cli(root, ["where", "src/unmapped.ts"]);
  assert.equal(j.mode, "path");
  assert.equal(j.counts.claims, 0);
  assert.deepEqual(j.lines.map((l) => [l.type, l.id]), [["candidate", "§ed.seed/compose"], ["candidate", "§ot/uses"]]);
  assert.equal(j.exit, 1);
  const text = cli(root, ["where", "src/unmapped.ts"], { json: false }).r.stdout;
  assert.match(text, /^src\/unmapped.ts: no claim lists this file$/m);
  assert.match(text, /^UNMAPPED CANDIDATES: no record lists this file;/m);
});

test("where reads the file through the core's refusals: a symlinked file is reported as unread, its claims still listed", () => {
  const root = fixture();
  symlinkSync(join(root, "src/editor.ts"), join(root, "src/link.ts"));
  const { j } = cli(root, ["where", "src/link.ts"]);
  assert.equal(j.mode, "path");
  assert.equal(j.file.state, "refused");
  assert.deepEqual(j.lines.map((l) => [l.type, l.id]), [["unranked", "§ot/coder"]]);
  assert.equal(j.exit, 1);
  assert.match(cli(root, ["where", "src/link.ts"], { json: false }).r.stdout, /^could not read src\/link.ts \(refused\): claims are listed from code lists only, unranked$/m);
  assert.equal(cli(root, ["where", "../outside.ts"]).j.mode, "token", "a path outside the root is never read");
});

test("where TOKEN: claims that define it (heading or first sentence) before those that mention it; whole names only", () => {
  const root = fixture();
  const { j } = cli(root, ["where", "draftId"]);
  assert.equal(j.mode, "token");
  assert.deepEqual(j.lines.map((l) => [l.type, l.id]), [["defines", "§ed.seed/compose"], ["mentions", "§ot/uses"]]);
  assert.deepEqual(j.counts, { claims: 2, defines: 1, mentions: 1, topic: 0 });
  assert.deepEqual(cli(root, ["where", "/api/send"]).j.lines.filter((l) => l.type !== "topic").map((l) => [l.id, l.spans]), [["§ed.seed/compose", ["POST /api/send"]]]);
  assert.equal(cli(root, ["where", "draft"]).j.lines.filter((l) => l.type !== "topic").length, 0, "draft is not a whole name inside draftId");
  const forced = cli(root, ["where", "src/editor.ts", "--token"]).j;
  assert.equal(forced.mode, "token");
  const none = cli(root, ["where", "nope/missing.ts"], { json: false }).r;
  assert.equal(none.status, 1);
  assert.match(none.stdout, /^no file nope\/missing.ts under the root and no record lists it: searched as a token$/m);
  assert.match(none.stdout, /^nope\/missing.ts: no claim uses it in backticks$/m);
  assert.equal(cli(root, ["where"]).j.code, "usage");
  assert.match(cli(root, ["where", "--help"]).j.help, /^where <path\|token\|topic words…>/);
});

test("where --json never hides results silently: past the top 10 it says how many more and how to page them, and text and JSON agree", () => {
  const root = fixture();
  const m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  const ids = Array.from({ length: 12 }, (_, i) => `§foo/part-${String.fromCharCode(97 + i)}`);
  for (const id of ids) {
    m.claims[id] = { kind: "note", requires: [] };
    write(root, `.sova/spec/claims/foo/${id.split("/")[1]}.md`, `# ${id} — Part\n\nThis part passes \`Foo\` along.\n`);
  }
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  const { j } = cli(root, ["where", "Foo"]);
  assert.equal(j.total, 12);
  assert.equal(j.shown, 10);
  const hidden = j.total - j.shown;
  const signalled = (j.status === "more" && typeof j.next === "string") || (j.notShown === hidden && typeof j.hint === "string");
  assert.ok(signalled, `2 hidden results carry a signal: ${JSON.stringify({ status: j.status, remaining: j.remaining, next: j.next, notShown: j.notShown, hint: j.hint })}`);
  const text = cli(root, ["where", "Foo"], { json: false }).r.stdout;
  assert.equal((text.match(/^  §/gm) ?? []).length, j.shown, "text lists what JSON shows");
  assert.equal(Number(/^(\d+) more not shown/m.exec(text)?.[1]), hidden, "text and JSON name the same hidden count");
  const all = j.next ? pages(root, ["where", "Foo"], 12000).flatMap((p) => p.lines) : cli(root, ["where", "Foo", "--all"]).j.lines;
  assert.deepEqual(new Set(all.map((l) => l.id)), new Set(ids), "following the signal reaches every claim");
});

test("where --json on a path that does not exist says the file is absent, then searches it as a token", () => {
  const root = fixture();
  const { j } = cli(root, ["where", "src/no-such-file.ts"]);
  assert.equal(j.file?.state, "absent", JSON.stringify(j));
  assert.match(JSON.stringify([j.note, j.notes, j.message, j.unknowns, j.file]), /no file|absent|does not exist|not found/i, "a note says so");
  assert.equal(j.exit, 1);
  assert.equal(cli(root, ["where", "src/editor.ts"]).j.file.state, "read", "an existing path is still read");
});

test("where WORDS: several unquoted words are one query, ranked as a topic in rows of their own kind; a topic-only hit exits 0", () => {
  const root = fixture();
  const { j } = cli(root, ["where", "editor", "pane"]);
  assert.equal(j.mode, "token");
  assert.equal(j.query, "editor pane");
  assert.deepEqual(j.topicTerms, ["editor", "pane"]);
  assert.equal(j.counts.claims, 0);
  assert.ok(j.counts.topic > 0);
  assert.equal(j.lines[0].id, "§ed/seed", "the passage holding both words ranks first");
  assert.deepEqual(j.lines[0].matched, ["editor", "pane"]);
  assert.equal(typeof j.lines[0].score, "number");
  assert.ok(j.lines.every((l) => l.type === "topic"));
  assert.equal(j.exit, 0);
  assert.match(j.notice, /literal name match/);
  assert.match(j.topicNotice, /topic row/);
  assert.deepEqual(cli(root, ["where", "editor pane"]).j.lines, j.lines, "the same words quoted give the same rows");
  const text = cli(root, ["where", "editor", "pane"], { json: false }).r;
  assert.equal(text.status, 0);
  assert.match(text.stdout, /^editor pane: no claim uses it in backticks$/m);
  assert.match(text.stdout, /^TOPIC MATCHES: ranked by the query's words/m);
  assert.match(text.stdout, /^    matched: editor, pane$/m);
  const none = cli(root, ["where", "zzqx", "blorf"]).j;
  assert.deepEqual([none.counts.claims, none.counts.topic, none.exit], [0, 0, 1], "neither kind finding a claim is exit 1");
  assert.match(cli(root, ["where", "zzqx"], { json: false }).r.stdout, /^as a topic: no other claim matches its words$/m);
});

test("where: a claim found by name is not repeated as a topic row; a file keeps the path reading, with no topic rows", () => {
  const root = fixture();
  assert.deepEqual(cli(root, ["where", "draftId"]).j.lines.map((l) => l.type), ["defines", "mentions"]);
  const both = cli(root, ["where", "draftId", "editor"]).j;
  assert.equal(both.query, "draftId editor");
  assert.ok(both.lines.some((l) => l.type === "topic" && l.id === "§ed/seed"));
  const path = cli(root, ["where", "src/editor.ts"]).j;
  assert.equal(path.mode, "path");
  assert.ok(path.lines.every((l) => l.type !== "topic"));
  assert.equal(path.topicNotice, undefined);
  assert.equal(path.counts.topic, undefined);
  assert.equal(cli(root, ["where", "src/editor.ts", "src/save.ts"]).j.mode, "token", "only a single argument is read as a file");
});

test("where: name rows keep their top ten and topic rows fill only the places left free; a cut name row exits 1, a cut topic row does not", () => {
  const root = fixture();
  const m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  const add = (id, prose) => {
    m.claims[id] = { kind: "note", requires: [] };
    write(root, `.sova/spec/claims/${id.slice(1).split("/")[0]}/${id.split("/")[1]}.md`, `# ${id} — Part\n\n${prose}\n`);
  };
  for (let i = 0; i < 10; i++) add(`§foo/name-${String.fromCharCode(97 + i)}`, "This part passes `Foo` along.");
  for (let i = 0; i < 4; i++) add(`§bar/word-${String.fromCharCode(97 + i)}`, "This part is about foo, in plain words.");
  for (let i = 0; i < 13; i++) add(`§gad/get-${String.fromCharCode(97 + i)}`, "A gizmo turns.");
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  const { j } = cli(root, ["where", "Foo"]);
  assert.deepEqual([j.counts.claims, j.counts.topic, j.total, j.shown, j.notShown], [10, 4, 14, 10, 4]);
  assert.deepEqual(j.lines.map((l) => l.type), Array(10).fill("defines"), "ten name rows fill the ten: no topic row displaces one");
  assert.equal(j.exit, 0, "every name row is shown");
  assert.equal(j.hint, "where 'Foo' --token --all");
  const all = cli(root, ["where", "Foo", "--all"]).j;
  assert.equal(all.lines.length, 14);
  assert.equal(all.exit, 0);
  add("§foo/name-x", "This part passes `Foo` along."); add("§foo/name-y", "This part passes `Foo` along.");
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  const cut = cli(root, ["where", "Foo"]).j;
  assert.deepEqual([cut.counts.claims, cut.shown, cut.notShown, cut.exit], [12, 10, 6, 1], "name rows left out: exit 1");
  assert.ok(cut.lines.every((l) => l.type === "defines"));
  add("§bar/plain", "A draftid named in plain words.");
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  const free = cli(root, ["where", "draftId"]).j;
  assert.deepEqual(free.lines.slice(0, 2).map((l) => l.type), ["defines", "mentions"]);
  assert.ok(free.lines.slice(2).length > 0 && free.lines.slice(2).every((l) => l.type === "topic") && free.exit === 0, "topic rows fill the places name rows leave free");
  const tail = cli(root, ["where", "gizmo"]).j;
  assert.deepEqual([tail.counts.topic, tail.shown, tail.notShown, tail.exit], [13, 10, 3, 0], "topic rows past the ten are counted, and the answer still succeeds");
  assert.match(cli(root, ["where", "gizmo"], { json: false }).r.stdout, /^3 more not shown: where 'gizmo' --token --all$/m);
});

test("topic words: a word's -s, -ed and -ing forms land on one term, and -tion words are not cut to a shorter word", () => {
  assert.deepEqual(termsOf("mentioned functioning"), termsOf("mention function"));
  assert.deepEqual(termsOf("mentions sessions trees"), termsOf("mention session tree"));
  assert.notDeepEqual(termsOf("caption"), termsOf("caps"));
  assert.deepEqual(termsOf("read-only spec/rules.md"), ["spec/rules.md", "read", "spec", "rule"]);
});
