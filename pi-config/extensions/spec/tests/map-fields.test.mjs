// map, graph and impact --near on a probe spec where every optional record field is set:
// embeds, about, core, agreed, members.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, write } from "./map-fixture.mjs";

function probe() {
  const root = mkdtempSync(join(tmpdir(), "spec-map-fields-"));
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims: {
    "§p/panel": { kind: "surface", requires: [], code: ["src/panel.ts"] },
    "§p.panel/bold": { kind: "behavior", requires: [] },
    "§s/seed": { kind: "surface", requires: [] },
    "§s.seed/edit": { kind: "behavior", requires: ["§p/panel"] },
    "§x/embedder": { kind: "behavior", requires: [], embeds: ["§p/panel"], code: ["src/x.ts"], evidence: "verified", agreed: { by: "ana", at: "2026-09-01" } },
    "§x/plan": { kind: "behavior", requires: [], agreed: { by: "bo", at: "2026-10-02T10:00:00Z" } },
    "§x/later": { kind: "surface", code: ["src/x.ts"], evidence: "unreviewed", agreed: { by: "cy", at: "2026-09-15" } },
    "§n/why": { kind: "note", about: ["§p/panel"] },
    "§n/bold-note": { kind: "note", about: ["§p.panel/bold"] },
    "§g/rules": { kind: "surface", requires: [] },
    "§g.rules/voice": { kind: "behavior", requires: [], core: true },
    "§section/set": { kind: "section", members: ["§p.panel/bold"] },
  } }));
  write(root, ".sova/spec/claims/p/panel.md", "# §p/panel — Panel\n\nThe panel every editor draws.\n\n## §p.panel/bold — Bold\n\nBold text in the panel.\n");
  write(root, ".sova/spec/claims/s/seed.md", "# §s/seed — Seed\n\nThe seed area.\n\n## §s.seed/edit — Edit\n\nEditing builds on the panel (§p/panel).\n");
  write(root, ".sova/spec/claims/x/embedder.md", "# §x/embedder — Embedder\n\nIt draws the panel inside itself.\n");
  write(root, ".sova/spec/claims/x/plan.md", "# §x/plan — Plan\n\nA plan agreed and not yet built.\n");
  write(root, ".sova/spec/claims/x/later.md", "# §x/later — Later\n\nAgreed, mapped, but not reviewed yet.\n");
  write(root, ".sova/spec/claims/n/why.md", "# §n/why — Why the panel\n\nWhy the panel looks as it does.\n");
  write(root, ".sova/spec/claims/n/bold-note.md", "# §n/bold-note — Bold note\n\nA note on bold.\n");
  write(root, ".sova/spec/claims/g/rules.md", "# §g/rules — Rules\n\nGround rules.\n\n## §g.rules/voice — Voice\n\nSay what happened.\n");
  write(root, ".sova/spec/claims/section/set.md", "# §section/set — Set\n\nA set of behaviors.\n");
  write(root, "src/panel.ts", "export const panel = 1;\n");
  write(root, "src/x.ts", "export const x = 1;\n");
  return root;
}

test("the probe spec is a valid graph with every field set", () => {
  const root = probe();
  const { j } = cli(root, ["check"]);
  assert.deepEqual(j.findings.filter((f) => f.severity === "error"), []);
});

test("impact --near counts embedders as consumers and lists about notes; it never says none while impact lists them", () => {
  const root = probe();
  const plain = cli(root, ["impact", "§p/panel"]).j;
  assert.deepEqual(plain.consumers.map((c) => c.id).sort(), ["§s.seed/edit", "§x/embedder"]);
  const { j } = cli(root, ["impact", "§p/panel", "--near"]);
  const consumers = j.lines.filter((l) => l.group === "consumer");
  assert.deepEqual(consumers.map((l) => [l.id, l.requires, l.embeds ?? null]), [["§s.seed/edit", ["§p/panel"], null], ["§x/embedder", [], ["§p/panel"]]]);
  assert.deepEqual(j.lines.filter((l) => l.group === "about").map((l) => [l.id, l.about]), [["§n/bold-note", "§p.panel/bold"], ["§n/why", "§p/panel"]]);
  assert.deepEqual(j.lines.filter((l) => l.group === "container").map((l) => l.id), ["§section/set"]);
  const text = cli(root, ["impact", "§p/panel", "--near"], { json: false }).r.stdout;
  assert.match(text, /^  §x\/embedder — Embedder  behavior · -\/verified · \d+ B · embeds §p\/panel$/m);
  assert.match(text, /^notes about it \(named only\) \(2\)$/m);
  assert.doesNotMatch(text, /consumers.*: none/);
  const h2 = cli(root, ["impact", "§p.panel/bold", "--near"]).j;
  assert.deepEqual(h2.lines.filter((l) => l.group === "consumer").map((l) => [l.id, l.via ?? null]), [["§s.seed/edit", "parent"], ["§x/embedder", "parent"]]);
  assert.deepEqual(h2.lines.filter((l) => l.group === "about").map((l) => [l.id, l.via ?? null]), [["§n/bold-note", null], ["§n/why", "parent"]]);
});

test("map counts embeds in required-by and crossing edges, with the edge's kind", () => {
  const root = probe();
  const a = cli(root, ["map", "§p/panel"]).j;
  assert.equal(a.lines.find((l) => l.id === "§p/panel").requiredBy, 2);
  assert.deepEqual(a.lines.filter((l) => l.type === "in").map((l) => [l.from, l.kind]), [["§s.seed/edit", "requires"], ["§x/embedder", "embeds"]]);
  const x = cli(root, ["map", "§x/embedder"]).j;
  assert.deepEqual(x.lines.filter((l) => l.type === "out").map((l) => [l.to, l.kind]), [["§p/panel", "embeds"]]);
  assert.match(cli(root, ["map", "§p/panel"], { json: false }).r.stdout, /^  §x\/embedder → §p\/panel \(embeds\)$/m);
});

test("map counts agreed claims that are not built, with decision dates, never ages; agreed says who decided and when", () => {
  const root = probe();
  const { j } = cli(root, ["map"]);
  assert.deepEqual(j.counts.agreedNotBuilt, { agreed: 3, notBuilt: 2, oldest: "2026-09-15", newest: "2026-10-02" }, "built = code plus reviewed or verified");
  const text = cli(root, ["map"], { json: false }).r.stdout;
  assert.match(text, /^agreed \(decision\), not built: 2 of 3 agreed · decided 2026-09-15 … 2026-10-02$/m);
  assert.doesNotMatch(text, /agreed to this text|days? ago/);
  const plan = cli(root, ["map", "§x/plan"]).j;
  assert.deepEqual(plan.lines[0].agreed, { by: "bo", at: "2026-10-02T10:00:00Z" });
  assert.equal(plan.lines[0].built, false);
  assert.match(cli(root, ["map", "§x/plan"], { json: false }).r.stdout, /· agreed \(decision\) 2026-10-02T10:00:00Z by bo, not built$/m);
  const built = cli(root, ["map", "§x/embedder"]).j;
  assert.equal(built.lines[0].built, true);
  assert.deepEqual(built.counts.agreedNotBuilt, { agreed: 1, notBuilt: 0, oldest: null, newest: null });
  const none = cli(root, ["map", "g"]).j;
  assert.ok(!("agreedNotBuilt" in none.counts));
  assert.match(cli(root, ["map", "g"], { json: false }).r.stdout, /^agreed-not-built: no record here carries agreed$/m);
});

test("graph carries embeds and about edges, core and agreed on nodes", () => {
  const root = probe();
  const { j } = cli(root, ["graph"], { budget: 32768 });
  assert.equal(j.status, "done");
  const has = (kind, from, to) => j.edges.some((e) => e.kind === kind && e.from === from && e.to === to);
  assert.ok(has("embeds", "§x/embedder", "§p/panel"));
  assert.ok(has("about", "§n/why", "§p/panel"));
  assert.ok(has("about", "§n/bold-note", "§p.panel/bold"));
  assert.ok(has("member", "§section/set", "§p.panel/bold"));
  assert.equal(j.counts.byKind.embeds, 1);
  assert.equal(j.counts.byKind.about, 2);
  const node = (id) => j.nodes.find((n) => n.id === id);
  assert.equal(node("§g.rules/voice").core, true);
  assert.equal(node("§g/rules").core, undefined);
  assert.deepEqual(node("§x/plan").agreed, { by: "bo", at: "2026-10-02T10:00:00Z" });
  assert.equal(node("§p/panel").agreed, undefined);
});
