// where: the claims for a source file, ranked by shared interface tokens, or for a name; bounded, stateless.
import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, cli, pages, write } from "./map-fixture.mjs";

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
  assert.deepEqual(j.counts, { claims: 2, defines: 1, mentions: 1 });
  assert.deepEqual(cli(root, ["where", "/api/send"]).j.lines.map((l) => [l.id, l.spans]), [["§ed.seed/compose", ["POST /api/send"]]]);
  assert.equal(cli(root, ["where", "draft"]).j.lines.length, 0, "draft is not a whole name inside draftId");
  const forced = cli(root, ["where", "src/editor.ts", "--token"]).j;
  assert.equal(forced.mode, "token");
  const none = cli(root, ["where", "nope/missing.ts"], { json: false }).r;
  assert.equal(none.status, 1);
  assert.match(none.stdout, /^no file nope\/missing.ts under the root and no record lists it: searched as a token$/m);
  assert.match(none.stdout, /^nope\/missing.ts: no claim uses it in backticks$/m);
  assert.equal(cli(root, ["where"]).j.code, "usage");
  assert.match(cli(root, ["where", "--help"]).j.help, /^where <path\|token>/);
});
