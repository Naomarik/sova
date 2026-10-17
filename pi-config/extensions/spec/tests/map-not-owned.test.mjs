// notOwned on area records: check validates it, map shows it per area and counts it, and a spec
// without it shows one summary line and nothing per area.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, write } from "./map-fixture.mjs";

function probe(claims) {
  const root = mkdtempSync(join(tmpdir(), "spec-map-not-owned-"));
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims: {
    "§a/chat": { kind: "surface", requires: [], notOwned: ["§a/list", "§b.money/prices"] },
    "§a.chat/send": { kind: "behavior", requires: [] },
    "§a/list": { kind: "surface", requires: [], notOwned: [] },
    "§b/money": { kind: "surface", requires: [] },
    "§b.money/prices": { kind: "behavior", requires: [] },
    ...claims,
  } }));
  write(root, ".sova/spec/claims/a/chat.md", "# §a/chat — Chat\n\nThe chat view.\n\n## §a.chat/send — Send\n\nSending a prompt.\n");
  write(root, ".sova/spec/claims/a/list.md", "# §a/list — List\n\nThe session list.\n");
  write(root, ".sova/spec/claims/b/money.md", "# §b/money — Money\n\nWhat things cost.\n\n## §b.money/prices — Prices\n\nThe price table.\n");
  return root;
}

test("map shows each area's doesn't-own line with its owners, 'nothing declared' for [], '(not written)' when absent, and counts them", () => {
  const root = probe();
  const { j } = cli(root, ["map"]);
  assert.deepEqual(j.counts.notOwned, { written: 2, areas: 3 });
  const area = (id) => j.lines.find((l) => l.type === "area" && l.id === id);
  assert.deepEqual(area("§a/chat").notOwned, ["§a/list", "§b.money/prices"], "the overview keeps § ids only");
  assert.deepEqual(area("§a/list").notOwned, []);
  assert.ok(!("notOwned" in area("§b/money")), "absent stays absent, never []");
  const text = cli(root, ["map"], { json: false }).r.stdout;
  assert.match(text, /^doesn't own: written for 2 of 3 area\(s\)$/m);
  assert.match(text, /^    what: The chat view\.\n    doesn't own: §a\/list; §b\.money\/prices$/m);
  assert.match(text, /^    what: The session list\.\n    doesn't own: nothing declared$/m);
  assert.match(text, /^    what: What things cost\.\n    doesn't own: \(not written\)$/m);
});

test("map of one area and of one namespace count only what is in view", () => {
  const root = probe();
  const one = cli(root, ["map", "§a.chat/send"]);
  assert.equal(one.j.area.id, "§a/chat");
  assert.deepEqual(one.j.area.notOwned, [{ id: "§a/list", title: "List" }, { id: "§b.money/prices", title: "Prices" }], "the area view adds each owner's title");
  assert.deepEqual(one.j.counts.notOwned, { written: 1, areas: 1 });
  assert.match(cli(root, ["map", "§a/chat"], { json: false }).r.stdout, /^  what: The chat view\.\n  doesn't own: List \(§a\/list\); Prices/m);
  const b = cli(root, ["map", "b"]);
  assert.ok(!("notOwned" in b.j.counts), "no area in view carries it: no count, never 0");
  const text = cli(root, ["map", "b"], { json: false }).r.stdout;
  assert.match(text, /^doesn't own: no area here carries notOwned$/m);
  assert.doesNotMatch(text, /^ +doesn't own:/m, "no per-area line when no area in view carries the field");
});

test("check: a notOwned that is not a list of § ids is a record error; a misplaced, dangling or inside owner is a warning", () => {
  const ok = cli(probe(), ["check"]).j;
  assert.deepEqual(ok.findings.filter((f) => f.severity !== "info").map((f) => f.code), []);
  for (const bad of [{ notOwned: "§a/list" }, { notOwned: [{ what: "x", owner: "§a/list" }] }, { notOwned: ["a/list"] }]) {
    const j = cli(probe({ "§b/money": { kind: "surface", requires: [], ...bad } }), ["check"]).j;
    assert.equal(j.exit, 2, JSON.stringify(bad));
    assert.ok(j.findings.some((f) => f.severity === "error" && ["record-invalid", "id-invalid"].includes(f.code) && f.id === "§b/money"), JSON.stringify(bad));
  }
  const warn = cli(probe({
    "§a.chat/send": { kind: "behavior", requires: [], notOwned: [] },
    "§b/money": { kind: "surface", requires: [], notOwned: ["§z/none", "§b.money/prices", "§b/money"] },
  }), ["check"]).j;
  const codes = warn.findings.filter((f) => f.severity === "warn").map((f) => [f.code, f.id]);
  assert.deepEqual(codes.filter(([c]) => c.startsWith("not-owned") || c === "dangling-edge").sort(),
    [["dangling-edge", "§b/money"], ["not-owned-inside", "§b/money"], ["not-owned-inside", "§b/money"], ["not-owned-not-area", "§a.chat/send"]]);
  assert.notEqual(warn.exit, 2, "a misuse never makes the graph untrusted");
});

test("a spec with no notOwned anywhere: one summary line, no per-area line, no count", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-map-not-owned-none-"));
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims: { "§a/one": { kind: "surface", requires: [] } } }));
  write(root, ".sova/spec/claims/a/one.md", "# §a/one — One\n\nThe one area.\n");
  const { j } = cli(root, ["map"]);
  assert.ok(!("notOwned" in j.counts));
  assert.ok(!("notOwned" in j.lines[0]));
  const text = cli(root, ["map"], { json: false }).r.stdout;
  assert.match(text, /^doesn't own: no area here carries notOwned$/m);
  assert.doesNotMatch(text, /^ +doesn't own:/m);
});
