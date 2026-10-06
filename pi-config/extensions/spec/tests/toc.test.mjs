// toc: one hop of contents lines (what, why, size), bounded, stateless; the core's own parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec.mjs");
const roots = [];
process.on("exit", () => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function write(root, path, text) { const abs = join(root, path); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text); }

const FENCE = "```";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "spec-toc-")); roots.push(root);
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims: {
    "§a/top": { kind: "surface", requires: [] },
    "§a.top/seed": { kind: "behavior", authority: "accepted", evidence: "verified", requires: ["§b/dep", "§c/quiet", "§a.top/hint", "§z/gone"] },
    "§a.top/hint": { kind: "behavior", requires: [] },
    "§a.top/fenced": { kind: "behavior", requires: [] },
    "§a.top/codeonly": { kind: "note" },
    "§a.top/open": { kind: "behavior" },
    "§b/dep": { kind: "note" },
    "§c/quiet": { kind: "behavior", requires: ["§a.top/seed"] },
    "§d/talker": { kind: "note" },
    "§e/named": { kind: "note" },
    "§f/hidden": { kind: "note" },
  } }));
  write(root, ".sova/spec/claims/a/top.md", [
    "# §a/top — Top", "> Part of the fixture spec.", "",
    "The top frames every child below it.", "",
    "## §a.top/seed — The seed", "",
    "**Short.** The seed does one thing well, for tests.",
    "It builds on §b/dep: that is the reason. Nothing names the quiet one.",
    "It also names §e/named in prose, and `§a.top/codeonly` in single backticks.",
    "<!-- the hint lives here: §a.top/hint -->", "",
    FENCE + "text", "§a.top/fenced in a fence is not a mention", FENCE, "",
    "## §a.top/hint — Hint", "", "A hint that only a comment points at, for tests.", "",
    "## §a.top/fenced — Fenced", "", FENCE + "js", "code: 1. Not a sentence.", FENCE, "",
    "After the fence comes the real sentence. More follows.", "",
    "## §a.top/codeonly — Code only", "", FENCE, "only code here", FENCE, "",
    "## §a.top/open — Open", "", "This behavior never investigated its dependencies.", "",
  ].join("\n"));
  write(root, ".sova/spec/claims/b/dep.md", "# §b/dep — Dep\n> Quoted orientation line for the dep.\n");
  write(root, ".sova/spec/claims/c/quiet.md", "# §c/quiet — Quiet\n\nIt requires something without saying so here.\n");
  write(root, ".sova/spec/claims/d/talker.md", "# §d/talker — Talker\n\nThe talker discusses §a.top/seed at length. The top (§a.top) frames it.\n");
  write(root, ".sova/spec/claims/e/named.md", "# §e/named — Named\n\n`GET /x` returns `a: b` to callers. Then more.\n");
  write(root, ".sova/spec/claims/f/hidden.md", "# §f/hidden — Hidden\n\nNo prose mention here.\n<!-- §a.top/seed -->\n``§a.top/seed``\n\n" + FENCE + "\n§a.top/seed\n" + FENCE + "\n");
  return root;
}
function cli(root, args, { json = true, budget } = {}) {
  const r = spawnSync(process.execPath, [CORE, ...args, "--root", root, ...(json ? ["--json"] : []), ...(budget ? ["--budget", String(budget)] : [])],
    { cwd: root, encoding: "utf8" });
  assert.equal(r.error, undefined);
  assert.equal(r.stderr, "", "no stderr side channel");
  return { r, j: json || r.stdout.startsWith("{") ? JSON.parse(r.stdout) : null };
}
const toc = (root, id, dir, opt) => { const { r, j } = cli(root, ["toc", id, "--dir", dir], opt); assert.equal(r.status, j.exit); return j; };
const byId = (j) => Object.fromEntries(j.lines.map((l) => [l.id, l]));

test("out: requires then names, each with what, why and size; unknowns stay visible", () => {
  const root = fixture(), j = toc(root, "§a.top/seed", "out");
  assert.equal(j.command, "toc"); assert.equal(j.dir, "out");
  assert.deepEqual(j.lines.map((l) => [l.group, l.id]), [
    ["requires", "§a.top/hint"], ["requires", "§b/dep"], ["requires", "§c/quiet"], ["requires", "§z/gone"],
    ["named", "§a.top/codeonly"], ["named", "§e/named"]]);
  const l = byId(j);
  assert.equal(l["§b/dep"].why, "It builds on §b/dep:");
  assert.equal(l["§b/dep"].whySource, "prose");
  assert.equal(l["§c/quiet"].why, "not mentioned in this claim's text");
  assert.equal(l["§c/quiet"].whySource, "none");
  assert.equal(l["§a.top/hint"].whySource, "comment", "a comment is a written reason, labelled");
  assert.equal(l["§a.top/hint"].why, "the hint lives here: §a.top/hint");
  assert.equal(l["§z/gone"].dangling, true);
  assert.equal(l["§a.top/codeonly"].whySource, "prose", "single backticks are not masked");
  assert.ok(!("§a.top/fenced" in l), "a fenced mention is not a mention");
  assert.equal(j.seed.what, "**Short.** The seed does one thing well, for tests.");
  assert.deepEqual(j.seed.labels, { authority: "accepted", evidence: "verified" });
  assert.equal(j.seed.bytes, Buffer.byteLength(cli(root, ["scope", "§a.top/seed"]).j.passages[0].text));
  assert.equal(j.exit, 1, "a dangling target is an unknown");
  assert.match(j.footer.unknowns.map((u) => u.message).join(), /§z\/gone/);
  assert.deepEqual(j.footer.delivered, []);
  assert.equal(j.footer.listed, 6); assert.equal(j.footer.notListed, 0);
  assert.deepEqual(j.footer.otherDirections, { in: 1, down: 0, up: 1, mentions: 1 });
  assert.ok(!j.lines.some((x) => "text" in x), "a contents line never carries the passage");
});

test("what: fences skipped, blockquote only as fallback, no code quoted, code-span colons kept", () => {
  const root = fixture(), j = toc(root, "§a/top", "down"), l = byId(j);
  assert.equal(l["§a.top/fenced"].what, "After the fence comes the real sentence.");
  assert.equal(l["§a.top/codeonly"].whatSource, "none");
  assert.match(l["§a.top/codeonly"].what, /^no prose sentence: \d+ B of code$/);
  assert.equal(j.seed.what, "The top frames every child below it.", "prose wins over the blockquote");
  const dep = toc(root, "§a.top/seed", "out").lines.find((x) => x.id === "§b/dep");
  assert.equal(dep.whatSource, "blockquote");
  assert.equal(dep.what, "Quoted orientation line for the dep.");
  const named = toc(root, "§a.top/seed", "out").lines.find((x) => x.id === "§e/named");
  assert.equal(named.what, "`GET /x` returns `a: b` to callers.");
});

test("down keeps declaration order; an H1 shows lede and whole bytes; up names the parent", () => {
  const root = fixture(), j = toc(root, "§a/top", "down");
  assert.deepEqual(j.lines.map((l) => l.id), ["§a.top/seed", "§a.top/hint", "§a.top/fenced", "§a.top/codeonly", "§a.top/open"]);
  assert.ok(j.lines.every((l) => l.group === "children" && !("why" in l)));
  const passages = cli(root, ["scope", "§a/top"]).j.passages;
  assert.equal(j.seed.bytes, Buffer.byteLength(passages[0].text));
  assert.equal(j.seed.whole, passages.filter((p) => p.id === "§a/top" || p.id.startsWith("§a.top/")).reduce((n, p) => n + Buffer.byteLength(p.text), 0));
  const up = toc(root, "§a.top/hint", "up");
  assert.deepEqual(up.lines.map((l) => [l.group, l.id, l.whole]), [["parent", "§a/top", j.seed.whole]]);
  const none = toc(root, "§a/top", "up");
  assert.equal(none.lines.length, 0); assert.equal(none.exit, 0);
  assert.equal(none.notes[0].code, "no-parent");
});

test("in and mentions: the neighbour's sentence is the why; masked mentions never list", () => {
  const root = fixture(), into = toc(root, "§a.top/seed", "in");
  assert.deepEqual(into.lines.map((l) => [l.group, l.id, l.whySource]), [["required-by", "§c/quiet", "none"]]);
  const m = toc(root, "§a.top/seed", "mentions");
  assert.deepEqual(m.lines.map((l) => [l.group, l.id, l.why]), [["mentioned-by", "§d/talker", "The talker discusses §a.top/seed at length."]]);
  assert.deepEqual(toc(root, "§a/top", "mentions").lines.map((l) => l.id), ["§d/talker"], "§a.top reads as §a/top");
});

test("a § named only in a heading's title is a mention; the declaring id never mentions itself", () => {
  const root = fixture(), m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  m.claims["§g/titled"] = { kind: "note" };
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  write(root, ".sova/spec/claims/g/titled.md", "# §g/titled — Waiting on the seed (§a.top/seed, queued)\nBody text that names nothing at all here.\n");
  const j = toc(root, "§a.top/seed", "mentions"), l = byId(j);
  assert.deepEqual(j.lines.map((x) => x.id), ["§d/talker", "§g/titled"]);
  assert.equal(l["§g/titled"].why, "Waiting on the seed (§a.top/seed, queued)", "the title, without heading markup");
  assert.equal(l["§g/titled"].what, "Body text that names nothing at all here.", "what still skips the heading");
  assert.ok(!toc(root, "§g/titled", "mentions").lines.length, "nothing mentions it, and its own heading does not count");
  assert.deepEqual(toc(root, "§g/titled", "out").lines.map((x) => [x.group, x.id]), [["named", "§a.top/seed"]]);
});

test("a behavior with no requires key reads as uninvestigated, never as requires (0)", () => {
  const root = fixture(), j = toc(root, "§a.top/open", "out");
  assert.equal(j.seed.requires, null);
  assert.equal(j.exit, 1);
  assert.equal(j.footer.unknowns[0].code, "requires-uninvestigated");
  const { r } = cli(root, ["toc", "§a.top/open", "--dir", "out"], { json: false });
  assert.match(r.stdout, /OUT: requires: dependencies uninvestigated/);
  assert.doesNotMatch(r.stdout, /requires \(0\)/);
});

test("pages stay within the budget, in JSON and text, and a cursor continues exactly once", () => {
  const root = fixture(), full = toc(root, "§a.top/seed", "out");
  for (const json of [true, false]) {
    const seen = [];
    let cursor, pages = 0;
    do {
      const { r } = cli(root, ["toc", "§a.top/seed", "--dir", "out", ...(cursor ? ["--cursor", cursor] : [])], { json, budget: json ? 1400 : 1024 });
      assert.ok(Buffer.byteLength(r.stdout) <= (json ? 1400 : 1024), "whole response within budget");
      if (json) {
        const j = JSON.parse(r.stdout);
        assert.notEqual(j.status, "refused");
        assert.ok(j.lines.length);
        seen.push(...j.lines.map((l) => l.id));
        assert.equal(j.footer.notListed, j.remaining);
        cursor = j.next;
      } else {
        seen.push(...[...r.stdout.matchAll(/^ {2}(§\S+) —/gm)].map((m) => m[1]));
        cursor = /--cursor (\S+)/.exec(r.stdout)?.[1];
      }
      assert.ok(++pages < 20);
    } while (cursor);
    assert.ok(pages > 1, "the budget really paged");
    assert.deepEqual(seen, full.lines.map((l) => l.id));
  }
});

test("refusals are bounded and coded; a changed spec stales the cursor", () => {
  const root = fixture();
  assert.equal(toc(root, "§a.top/seed", "sideways").code, "usage");
  assert.equal(toc(root, "§q/none", "out").code, "unknown-id");
  assert.equal(cli(root, ["toc", "§a.top/seed"]).j.code, "usage", "--dir is required");
  const first = toc(root, "§a.top/seed", "out", { budget: 1400 });
  assert.ok(first.next);
  const m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  m.claims["§e/named"].authority = "candidate";
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  const stale = cli(root, ["toc", "§a.top/seed", "--dir", "out", "--cursor", first.next], { budget: 1400 }).j;
  assert.equal(stale.code, "token-mismatch-or-stale");
  rmSync(join(root, ".sova/spec/manifest.json"));
  const missing = toc(root, "§a.top/seed", "out");
  assert.equal(missing.exit, 2); assert.equal(missing.cause, "manifest-not-found");
});

test("toc and read leave packet and scope untouched and write nothing", () => {
  const root = fixture();
  const before = [cli(root, ["scope", "§a.top/seed"]).r.stdout, spawnSync(process.execPath, [CORE, "packet", "§a.top/seed", "--root", root], { encoding: "utf8" }).stdout];
  const tree = () => spawnSync("find", [root, "-printf", "%P %s\n"], { encoding: "utf8" }).stdout;
  const t0 = tree();
  for (const dir of ["out", "in", "down", "up", "mentions"]) toc(root, "§a.top/seed", dir);
  cli(root, ["read", "§a/top", "--whole"]);
  assert.equal(tree(), t0, "stateless: nothing stored");
  assert.deepEqual([cli(root, ["scope", "§a.top/seed"]).r.stdout, spawnSync(process.execPath, [CORE, "packet", "§a.top/seed", "--root", root], { encoding: "utf8" }).stdout], before);
});

test("flags may come before the command, as for the core's other commands; nothing else runs", () => {
  const root = fixture(), go = (args) => spawnSync(process.execPath, [CORE, ...args], { cwd: root, encoding: "utf8" });
  const after = go(["toc", "§a.top/seed", "--dir", "out", "--root", root, "--json"]);
  const before = go(["--root", root, "--json", "--dir", "out", "toc", "§a.top/seed"]);
  assert.equal(before.stdout, after.stdout); assert.equal(before.status, after.status);
  assert.equal(JSON.parse(before.stdout).command, "toc");
  const r1 = go(["read", "§a/top", "--root", root]), r2 = go(["--json", "--root", root, "read", "§a/top"]);
  assert.equal(JSON.parse(r2.stdout).items[0].text, cli(root, ["read", "§a/top"]).j.items[0].text);
  assert.match(r1.stdout, /^── §a\/top — Top/);
  const scope = go(["--root", root, "--json", "scope", "§a.top/seed"]);
  assert.equal(JSON.parse(scope.stdout).command, "scope", "other commands keep their own parser");
  const stray = go(["--root", root, "--json", "toc"]);
  assert.equal(stray.status, 2); assert.equal(JSON.parse(stray.stdout).code, "usage");
});

// ---------------------------------------------------------------- read
const read = (root, args, opt) => { const { r, j } = cli(root, ["read", ...args], opt); assert.equal(r.status, j.exit); return j; };
const scopeText = (root, id) => cli(root, ["scope", id]).j.passages[0].text;

test("read: exactly one passage, byte-exact, no closure; the footer names its links", () => {
  const root = fixture(), j = read(root, ["§a.top/seed"]);
  assert.equal(j.command, "read"); assert.equal(j.budget, 32768, "a whole passage fits one call by default");
  assert.deepEqual(j.items.map((i) => i.id), ["§a.top/seed"]);
  assert.equal(j.items[0].text, scopeText(root, "§a.top/seed"));
  assert.deepEqual(j.items[0].fragment, { start: 0, end: Buffer.byteLength(j.items[0].text), total: Buffer.byteLength(j.items[0].text), complete: true });
  assert.deepEqual(j.items[0].labels, { authority: "accepted", evidence: "verified" });
  assert.equal(j.items[0].title, "The seed");
  assert.deepEqual(j.footer.named, ["§b/dep", "§c/quiet", "§a.top/hint", "§z/gone", "§e/named", "§a.top/codeonly"]);
  assert.equal(j.status, "done"); assert.equal(j.exit, 0);
});

test("read: an H1 is its lede unless --whole; --whole is lede then children in file order", () => {
  const root = fixture(), lede = read(root, ["§a/top"]);
  assert.deepEqual(lede.items.map((i) => i.id), ["§a/top"]);
  assert.equal(lede.items[0].text, scopeText(root, "§a/top"));
  assert.equal(lede.footer.children, 5);
  const whole = read(root, ["§a/top", "--whole"]);
  assert.deepEqual(whole.items.map((i) => i.id), ["§a/top", "§a.top/seed", "§a.top/hint", "§a.top/fenced", "§a.top/codeonly", "§a.top/open"]);
  for (const it of whole.items) assert.equal(it.text, scopeText(root, it.id));
  assert.equal(lede.footer.wholeBytes, whole.items.reduce((n, i) => n + Buffer.byteLength(i.text), 0));
  assert.ok(!whole.footer.named.some((id) => id.startsWith("§a.top/") || id === "§a/top"), "delivered passages are not named as undelivered");
  assert.equal(whole.footer.children, undefined);
  assert.deepEqual(read(root, ["§a.top/seed", "--whole"]).items.map((i) => i.id), ["§a.top/seed"], "--whole on an H2 is still one passage");
});

test("read: oversized passages arrive as exact fragments within the budget, JSON and text", () => {
  const root = fixture();
  const body = ("漢🙂\\\"\t" + "q".repeat(70) + "\n").repeat(60);
  write(root, ".sova/spec/claims/e/named.md", "# §e/named — Named\n\n" + body);
  const expected = scopeText(root, "§e/named");
  let text = "", cursor, pages = 0;
  do {
    const { r } = cli(root, ["read", "§e/named", ...(cursor ? ["--cursor", cursor] : [])], { budget: 1024 });
    assert.ok(Buffer.byteLength(r.stdout) <= 1024);
    const j = JSON.parse(r.stdout);
    assert.notEqual(j.status, "refused");
    for (const it of j.items) { assert.equal(it.fragment.start, Buffer.byteLength(text)); text += it.text; }
    cursor = j.next; assert.ok(++pages < 100);
  } while (cursor);
  assert.ok(pages > 3);
  assert.equal(text, expected);
  const { r } = cli(root, ["read", "§e/named"], { json: false, budget: 1024 });
  assert.ok(Buffer.byteLength(r.stdout) <= 1024);
  assert.match(r.stdout, /^── §e\/named — Named \[note\]/);
  assert.match(r.stdout, /--cursor \S+/);
  assert.equal(r.status, 1, "more remains");
});

test("read --frame on a spec with no core record says the frame is empty, exit 0; other reads say nothing of it", () => {
  const root = fixture(), { r, j } = cli(root, ["read", "--frame"]);
  assert.equal(r.status, 0);
  assert.deepEqual([j.items, j.frame], [[], { passages: 0, empty: true }]);
  const text = cli(root, ["read", "--frame"], { json: false }).r.stdout;
  assert.match(text, /^frame: no core records in this spec \(empty\)$/m);
  assert.equal(read(root, ["§a.top/seed"]).frame, undefined, "an ordinary read stays unchanged");
  assert.doesNotMatch(cli(root, ["read", "§a.top/seed"], { json: false }).r.stdout, /frame/);
});

test("read: refusals are coded and bounded", () => {
  const root = fixture();
  assert.equal(read(root, ["§q/none"]).code, "unknown-id");
  assert.equal(read(root, ["nope"]).code, "usage");
  assert.equal(read(root, ["§a.top/seed", "--budget", "99"]).code, "usage");
  assert.equal(read(root, ["§a.top/seed", "--cursor", "abc"]).code, "token-malformed");
  assert.equal(read(root, ["§a.top/seed", "--cursor", toc(root, "§a.top/seed", "out", { budget: 1400 }).next]).code, "token-mismatch-or-stale");
});

// ---------------------------------------------------------------- what: whole sentences
test("what: a first sentence wrapped across lines comes out whole; a heading title is still its own unit", () => {
  const root = fixture();
  write(root, ".sova/spec/claims/e/named.md", "# §e/named — Named, see §a.top/seed\nThe first sentence starts on this line,\nruns on across a second line\nand ends on the third. A second sentence.\n");
  const l = byId(toc(root, "§a.top/seed", "out"));
  assert.equal(l["§e/named"].what, "The first sentence starts on this line, runs on across a second line and ends on the third.");
  const m = byId(toc(root, "§a.top/seed", "mentions"));
  assert.equal(m["§e/named"].why, "Named, see §a.top/seed", "the title is its own unit, not joined to the body");
});

test("in on an H2 lists the claims that require its H1; out on an H1 counts what its H2s require", () => {
  const root = fixture(), m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  m.claims["§h/user"] = { kind: "behavior", requires: ["§a/top", "§a.top/seed"] };
  m.claims["§i/whole"] = { kind: "behavior", requires: ["§a/top"] };
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  write(root, ".sova/spec/claims/h/user.md", "# §h/user — User\n\nIt builds on §a.top/seed directly.\n");
  write(root, ".sova/spec/claims/i/whole.md", "# §i/whole — Whole\n\nIt follows all of §a/top, every child included.\n");
  const j = toc(root, "§a.top/hint", "in");
  assert.deepEqual(j.lines.map((l) => [l.group, l.id, l.via]), [["required-by", "§a.top/seed", undefined], ["required-through-parent", "§h/user", "§a/top"], ["required-through-parent", "§i/whole", "§a/top"]]);
  assert.equal(byId(j)["§i/whole"].why, "It follows all of §a/top, every child included.", "the why names the H1");
  assert.equal(byId(j)["§h/user"].whySource, "none");
  const seed = toc(root, "§a.top/seed", "in");
  assert.deepEqual(seed.lines.map((l) => [l.group, l.id]), [["required-by", "§c/quiet"], ["required-by", "§h/user"], ["required-through-parent", "§i/whole"]],
    "a claim that requires both is listed once, directly");
  assert.equal(toc(root, "§a.top/hint", "out").footer.otherDirections.in, 3);
  const { r } = cli(root, ["toc", "§a.top/hint", "--dir", "in"], { json: false });
  assert.match(r.stdout, /^IN: required through its H1 §a\/top \(2\)$/m);
  assert.equal(toc(root, "§i/whole", "in").lines.length, 0, "an H1 has no parent to reach it through");
  const top = toc(root, "§a/top", "out");
  assert.deepEqual(top.seed.childRequires, { h2s: 1, claims: 3, of: 5, uninvestigated: 1 }, "the seed requires §b/dep, §c/quiet, §z/gone outside; §a.top/hint is inside");
  assert.match(cli(root, ["toc", "§a/top", "--dir", "out"], { json: false }).r.stdout, /OUT: its 1 H2\(s\) require or embed 3 claim\(s\) outside it: toc each H2 --dir out, or map '§a\/top'/);
  assert.equal(toc(root, "§a.top/seed", "out").seed.childRequires, undefined);
  // An embed outside the H1 counts like a requirement.
  const m2 = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  m2.claims["§a.top/hint"].embeds = ["§l/panel"]; m2.claims["§l/panel"] = { kind: "surface", requires: [] };
  write(root, ".sova/spec/manifest.json", JSON.stringify(m2));
  write(root, ".sova/spec/claims/l/panel.md", "# §l/panel — Panel\n\nA panel drawn inside the hint.\n");
  assert.deepEqual(toc(root, "§a/top", "out").seed.childRequires, { h2s: 2, claims: 4, of: 5, uninvestigated: 1 });
});

test("in lists embedders of the claim or its H1 and the notes about either; an about field is a declared why", () => {
  const root = fixture(), m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  m.claims["§j/host"] = { kind: "surface", requires: [], embeds: ["§a/top"] };
  m.claims["§k/note"] = { kind: "note", about: ["§a/top"] };
  m.claims["§k/said"] = { kind: "note", about: ["§a.top/hint"] };
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  write(root, ".sova/spec/claims/j/host.md", "# §j/host — Host\n\nThe host draws the top inside its frame.\n");
  write(root, ".sova/spec/claims/k/note.md", "# §k/note — Note\n\nA note that names nothing at all.\n");
  write(root, ".sova/spec/claims/k/said.md", "# §k/said — Said\n\nThis note explains §a.top/hint in prose.\n");
  const j = toc(root, "§a.top/hint", "in"), l = byId(j);
  assert.deepEqual(j.lines.map((x) => [x.group, x.id, x.via]),
    [["required-by", "§a.top/seed", undefined], ["embedded-through-parent", "§j/host", "§a/top"], ["about-it", "§k/said", undefined], ["about-it", "§k/note", "§a/top"]], "notes about it, then notes about its H1");
  assert.deepEqual([l["§k/note"].why, l["§k/note"].whySource], ["about §a/top (declared on the note)", "declared"]);
  assert.deepEqual([l["§k/said"].why, l["§k/said"].whySource], ["This note explains §a.top/hint in prose.", "prose"]);
  const { r } = cli(root, ["toc", "§a.top/hint", "--dir", "in"], { json: false });
  assert.match(r.stdout, /^IN: embedded through its H1 §a\/top \(1\)$/m);
  assert.match(r.stdout, /^IN: notes about it \(2\)$/m);
  assert.deepEqual(toc(root, "§a/top", "in").lines.map((x) => [x.group, x.id]), [["embedded-by", "§j/host"], ["about-it", "§k/note"]]);
});

test("agreed records show who agreed and when, and whether built, in toc and read", () => {
  const root = fixture(), m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  Object.assign(m.claims["§a.top/hint"], { agreed: { by: "operator", at: "2026-10-05" } });
  Object.assign(m.claims["§c/quiet"], { agreed: { by: "pm", at: "2026-10-01" }, code: ["src/q.txt"], evidence: "verified" });
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  write(root, "src/q.txt", "q\n");
  const l = byId(toc(root, "§a.top/seed", "out"));
  assert.deepEqual(l["§a.top/hint"].agreed, { by: "operator", at: "2026-10-05", built: false });
  assert.deepEqual(l["§c/quiet"].agreed, { by: "pm", at: "2026-10-01", built: true });
  assert.equal(l["§b/dep"].agreed, undefined, "no agreed field, no agreed key");
  const text = cli(root, ["toc", "§a.top/seed", "--dir", "out"], { json: false }).r.stdout;
  assert.match(text, /§a\.top\/hint — Hint .* · agreed \(decision\) 2026-10-05 by operator, not built$/m);
  assert.match(text, /§c\/quiet — Quiet .* · agreed \(decision\) 2026-10-01 by pm, built$/m);
  assert.deepEqual(toc(root, "§a.top/hint", "up").seed.agreed, { by: "operator", at: "2026-10-05", built: false });
  assert.deepEqual(read(root, ["§a.top/hint"]).items[0].agreed, { by: "operator", at: "2026-10-05", built: false });
  assert.match(cli(root, ["read", "§a.top/hint"], { json: false }).r.stdout, /^── §a\.top\/hint — Hint .* · agreed \(decision\) 2026-10-05 by operator, not built$/m);
});

test("read names the claim's own code files (12, then a count, missing marked); toc's seed counts them", () => {
  const root = fixture(), m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  const paths = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`);
  m.claims["§a.top/seed"].code = paths;
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  for (const p of paths.filter((_, i) => i !== 1)) write(root, p, "x\n");
  const it = read(root, ["§a.top/seed"]).items[0];
  assert.equal(it.code.length, 12); assert.equal(it.codeMore, 2);
  assert.deepEqual(it.code.slice(0, 3), [{ path: "src/f0.ts", state: "present" }, { path: "src/f1.ts", state: "missing" }, { path: "src/f2.ts", state: "present" }]);
  assert.equal(it.text, scopeText(root, "§a.top/seed"), "the passage text is unchanged");
  const text = cli(root, ["read", "§a.top/seed"], { json: false }).r.stdout;
  assert.match(text, /^ {3}code: src\/f0\.ts, src\/f1\.ts \(missing\), src\/f2\.ts, .*src\/f11\.ts, and 2 more in its record$/m);
  assert.equal(toc(root, "§a.top/seed", "up").seed.codeFiles, 14);
  assert.match(cli(root, ["toc", "§a.top/seed", "--dir", "up"], { json: false }).r.stdout, /· code 14 file\(s\), read names them/);
  assert.equal(read(root, ["§a.top/hint"]).items[0].code, undefined, "no code, no code key");
});

test("an H1 whose H2s were never investigated says so, never 'requires nothing', and exits 1", () => {
  const root = fixture(), m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  m.claims["§m/area"] = { kind: "surface", requires: [] };
  m.claims["§m.area/one"] = { kind: "behavior" };
  m.claims["§m.area/two"] = { kind: "behavior", requires: [] };
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  write(root, ".sova/spec/claims/m/area.md", "# §m/area — Area\n\nAn area of two parts.\n\n## §m.area/one — One\n\nPart one, never investigated.\n\n## §m.area/two — Two\n\nPart two, which needs nothing.\n");
  const j = toc(root, "§m/area", "out");
  assert.deepEqual(j.seed.childRequires, { h2s: 0, claims: 0, of: 2, uninvestigated: 1 });
  assert.equal(j.exit, 1, "an unknown is named");
  assert.deepEqual(j.footer.unknowns.map((u) => u.code), ["requires-uninvestigated"]);
  const text = cli(root, ["toc", "§m/area", "--dir", "out"], { json: false }).r.stdout;
  assert.match(text, /^OUT: none of its 2 H2s requires or embeds a claim outside it; 1 of its 2 H2s have no requires key: their dependencies are unknown, not none$/m);
  assert.doesNotMatch(text, /its 0 H2\(s\)/);
  m.claims["§m.area/one"].requires = [];
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  const k = toc(root, "§m/area", "out");
  assert.equal(k.exit, 0); assert.equal(k.seed.childRequires.uninvestigated, 0);
  assert.match(cli(root, ["toc", "§m/area", "--dir", "out"], { json: false }).r.stdout, /^OUT: none of its 2 H2s requires or embeds a claim outside it$/m);
});

test("read's footer speaks for the whole read, on every page", () => {
  const root = fixture();
  write(root, ".sova/spec/claims/a/top.md", readFileSync(join(root, ".sova/spec/claims/a/top.md"), "utf8").replace("A hint that only", "A hint about §e/named that only"));
  const first = read(root, ["§a/top", "--whole"], { budget: 1024 });
  assert.equal(first.status, "more");
  assert.ok(!first.footer.named.some((id) => id.startsWith("§a.top/")), "a passage this read delivers later is not named");
  const { r } = cli(root, ["read", "§a/top"], { json: false });
  assert.match(r.stdout, /named here, not delivered by this read: /);
});

test("what: a colon inside parentheses or quotes doesn't end it; the 20-character floor ignores the list marker", () => {
  const root = fixture();
  write(root, ".sova/spec/claims/e/named.md", "# §e/named — Named\n\nLogins (pi `auth.json`: keys, tokens) sync between hosts. More follows.\n");
  write(root, ".sova/spec/claims/c/quiet.md", "# §c/quiet — Quiet\n\nThe tab says \"All projects: $40\" above the list. Then more.\n");
  write(root, ".sova/spec/claims/b/dep.md", "# §b/dep — Dep\n\n- **Short run-in.** The real sentence follows.\n");
  const l = byId(toc(root, "§a.top/seed", "out"));
  assert.equal(l["§e/named"].what, "Logins (pi `auth.json`: keys, tokens) sync between hosts.");
  assert.equal(l["§c/quiet"].what, "The tab says \"All projects: $40\" above the list.");
  assert.equal(l["§b/dep"].what, "**Short run-in.** The real sentence follows.");
  write(root, ".sova/spec/claims/e/named.md", "# §e/named — Named\n\nOne part: the colon outside brackets still ends it here. More.\n");
  assert.equal(byId(toc(root, "§a.top/seed", "out"))["§e/named"].what, "One part: the colon outside brackets still ends it here.", "20 characters, so it runs on");
  // A period inside an open quote is not the end; a quoted sentence that closes the sentence is.
  write(root, ".sova/spec/claims/e/named.md", "# §e/named — Named\n\nThe list shows \"None yet. Yours appear here.\" until one exists. Then more.\n");
  write(root, ".sova/spec/claims/c/quiet.md", "# §c/quiet — Quiet\n\nThe button is labelled \"Stop the turn.\" Then more follows.\n");
  const q = byId(toc(root, "§a.top/seed", "out"));
  assert.equal(q["§e/named"].what, "The list shows \"None yet. Yours appear here.\" until one exists.");
  assert.equal(q["§c/quiet"].what, "The button is labelled \"Stop the turn.\"");
});

test("what: a thematic break is never a prose sentence", () => {
  const root = fixture();
  write(root, ".sova/spec/claims/e/named.md", "# §e/named — Named\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n");
  write(root, ".sova/spec/claims/c/quiet.md", "# §c/quiet — Quiet\n\n| a | b |\n|---|---|\n\n***\n\nThe real sentence comes after the rule.\n");
  const l = byId(toc(root, "§a.top/seed", "out"));
  assert.deepEqual([l["§e/named"].whatSource, l["§e/named"].what], ["none", "no prose sentence"]);
  assert.deepEqual([l["§c/quiet"].whatSource, l["§c/quiet"].what], ["prose", "The real sentence comes after the rule."]);
  // A body that starts with the rule, with and without a blank line after it.
  write(root, ".sova/spec/claims/e/named.md", "# §e/named — Named\n\n---\n\nAfter a leading rule comes the sentence.\n");
  write(root, ".sova/spec/claims/c/quiet.md", "# §c/quiet — Quiet\n___\nRight under the rule sits the sentence.\n");
  const k = byId(toc(root, "§a.top/seed", "out"));
  assert.deepEqual([k["§e/named"].whatSource, k["§e/named"].what], ["prose", "After a leading rule comes the sentence."]);
  assert.deepEqual([k["§c/quiet"].whatSource, k["§c/quiet"].what], ["prose", "Right under the rule sits the sentence."]);
});

test("why: a long sentence is clipped around the target's own mention, never another one in its namespace", () => {
  const root = fixture();
  const filler = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
  write(root, ".sova/spec/claims/c/quiet.md", `# §c/quiet — Quiet\n\nIt follows §a.top/hint closely, ${filler(40)}, and in the end it relies on §a.top/seed for the rest of ${filler(12)} here.\n`);
  const why = toc(root, "§a.top/seed", "in").lines.find((l) => l.id === "§c/quiet").why;
  assert.ok(why.length <= 240 && why.startsWith("…"), why);
  assert.ok(why.includes("§a.top/seed"), `the printed why names the target: ${why}`);
});

// Over the project's own spec: a what that ends mid-sentence (no "…", no sentence end) while the
// passage's text runs on to the next line of the same paragraph is a cut, never a whole sentence.
const SPEC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
test("what: over the real spec, no what line ends mid-sentence", { skip: !existsSync(join(SPEC_ROOT, ".sova/spec/manifest.json")) }, async () => {
  const { whatOf, mask } = await import("../core/toc.mjs");
  const ids = Object.keys(JSON.parse(readFileSync(join(SPEC_ROOT, ".sova/spec/manifest.json"), "utf8")).claims)
    .filter((id) => !/^§[a-z][a-z-]*\.[a-z]/.test(id) || id.startsWith("§section."));
  const cut = [];
  let checked = 0;
  for (const id of ids) {
    let cursor, texts = [];
    do {
      const r = spawnSync(process.execPath, [CORE, "read", id, "--whole", "--root", SPEC_ROOT, "--json", ...(cursor ? ["--cursor", cursor] : [])], { encoding: "utf8", maxBuffer: 1 << 26 });
      const j = JSON.parse(r.stdout);
      assert.notEqual(j.status, "refused", `${id}: ${r.stdout}`);
      for (const it of j.items) { if (it.fragment.start === 0) texts.push({ id: it.id, text: "" }); texts.at(-1).text += it.text; }
      cursor = j.next;
    } while (cursor);
    for (const d of texts) {
      const w = whatOf(d);
      if (w.whatSource !== "prose" || w.what.endsWith("…")) continue;
      checked++;
      if (/[.!?:]["'”’)\]*_`]*$/.test(w.what)) continue;
      // Where does the what's last word sit in the masked passage, and does its paragraph continue?
      const words = w.what.split(" "), m = mask(d.text, { doubleTicks: false, heading: true });
      const re = new RegExp(words.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+") + "[ \\t]*\\n[ \\t]*(\\S)");
      const hit = re.exec(m);
      if (hit && !/^[-*+|>#\d]/.test(hit[1])) cut.push(`${d.id}: ${w.what.slice(-60)}`);
    }
  }
  assert.ok(checked > 100, `checked ${checked} what lines`);
  assert.deepEqual(cut, [], `${cut.length} what line(s) cut at a line end`);
});
