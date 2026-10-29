// The declaration size cap (§tools.spec/declaration-cap): a claim's size is its prose bytes in its claim file only,
// so every case runs in both record layouts (and with a draft whose base and spec are in different layouts) and must
// give the same answer. check counts, draft check warns on crossing or growing, promotion warns, nothing refuses and
// no exit status moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SPEC, core, draft, put, read, tmp, writeSpec, same, normalizer } from "./layout/lib.mjs";

const CAP = 6144;
const META = { _: "Size cap fixture.", grammar: { claimsRoot: "claims/", directoryKinds: ["section"] } };
const RECORDS = {
  "§aa/one": { kind: "surface", authority: "accepted", requires: [] },
  "§aa.one/big": { kind: "behavior", authority: "accepted", requires: [] },
  "§aa.one/small": { kind: "behavior", authority: "accepted", requires: [] },
  "§aa.one/edge": { kind: "behavior", authority: "accepted", requires: [] },
  "§bb/two": { kind: "note", authority: "accepted" },
};
// A paragraph of n bytes (ASCII words, wrapped), so a declaration's size is set by its body.
const para = (n) => { const w = "lorem ipsum dolor sit amet ".repeat(Math.ceil(n / 27)).slice(0, n - 1); return `${w.replace(/(.{1,99})( |$)/g, "$1\n").trimEnd()}\n`; };
const h2 = (id, title, body) => `## ${id} — ${title}\n\n${body}`;
// One claim file whose H2 spans have the given body sizes; the edge claim is padded to exactly `edge` bytes in all.
function claimFile({ big = 8000, small = 500, edge = CAP, extra = "" } = {}) {
  const lede = "# §aa/one — One\n\nThe one area.\n";
  const head = "## §aa.one/edge — Edge\n\n";
  const edgeBody = "x".repeat(edge - Buffer.byteLength(head) - 1) + "\n";
  return [lede, h2("§aa.one/big", "Big", para(big)), h2("§aa.one/small", "Small", para(small)), head + edgeBody, extra].filter(Boolean).join("\n");
}
const CLAIMS = () => ({ "aa/one.md": claimFile(), "bb/two.md": "# §bb/two — Two\n\nA note.\n" });

function spec(layout, { meta = META, records = RECORDS, claims = CLAIMS() } = {}) {
  const root = tmp("spec-cap-");
  writeSpec(root, { layout, meta, records, claims });
  return root;
}
const ok = (r, label) => { assert.notEqual(r.j?.exit, 2, `${label}: ${JSON.stringify(r.j).slice(0, 1500)}`); return r.j; };
const sizeOf = (j, id) => j.declarations.find((d) => d.id === id)?.bytes;
const overCapOf = (j) => (j.coreFindings ?? []).filter((f) => f.code === "declaration-over-cap");
const edit = (root, name, text) => put(root, `${SPEC}/drafts/${name}/spec/claims/aa/one.md`, text);
const freshDraft = (root, name) => ok(draft(root, ["new", name, "--write"]), `new ${name}`);

for (const layout of [1, 2]) {
  test(`layout ${layout}: check counts the cap and each declaration's prose bytes, and its exit doesn't move`, () => {
    const root = spec(layout);
    const j = ok(core(root, ["check"]), "check");
    assert.equal(j.counts.cap, CAP);
    // big is over; edge is exactly at the cap, so not over.
    assert.equal(j.counts.overCap, 1, JSON.stringify(j.declarations));
    assert.equal(sizeOf(j, "§aa.one/edge"), CAP, "the edge claim is exactly the cap (its heading and body, trailing blank lines left out)");
    const body = read(root, `${SPEC}/claims/aa/one.md`);
    const smallSpan = body.slice(body.indexOf("## §aa.one/small"), body.indexOf("## §aa.one/edge")).replace(/\n+$/, "\n");
    assert.equal(sizeOf(j, "§aa.one/small"), Buffer.byteLength(smallSpan), "bytes are the declaration's span in the claim file");
    assert.ok(!j.findings.some((f) => f.code === "declaration-over-cap"), "no finding per declaration");
    // The same spec with a cap nothing reaches: the exit and findings are identical, so the size never moved them.
    const roomy = spec(layout, { meta: { ...META, declarationCap: 1_000_000 } });
    const k = ok(core(roomy, ["check"]), "check roomy");
    assert.equal(k.counts.overCap, 0);
    assert.equal(k.exit, j.exit);
    same(k.findings, j.findings, "findings with and without an over-cap claim");
  });

  test(`layout ${layout}: declarationCap in the spec's settings overrides the cap; a bad one warns and the default holds`, () => {
    const j = ok(core(spec(layout, { meta: { ...META, declarationCap: 600 } }), ["check"]), "check 600");
    assert.equal(j.counts.cap, 600);
    assert.equal(j.counts.overCap, 2, "big and edge are over 600 B; small (about 520 B) is not");
    for (const bad of [0, -5, 12.5, "6144", null]) {
      const k = core(spec(layout, { meta: { ...META, declarationCap: bad } }), ["check"]).j;
      assert.equal(k.counts.cap, CAP, `cap ${JSON.stringify(bad)}`);
      assert.ok(k.findings.some((f) => f.code === "declaration-cap-invalid" && f.severity === "warn"), `cap ${JSON.stringify(bad)}: ${JSON.stringify(k.findings)}`);
    }
  });

  test(`layout ${layout}: draft check warns on crossing, growing and a new over-cap claim; not on unchanged or shrinking`, () => {
    const root = spec(layout);
    const base = ok(draft(root, ["check", (freshDraft(root, "same"), "same")]), "check same");
    assert.deepEqual(overCapOf(base), [], "an unchanged over-cap claim is not introduced");
    assert.equal(base.preexisting["declaration-over-cap"], 1, JSON.stringify(base.preexisting));

    freshDraft(root, "cross");
    edit(root, "cross", claimFile({ small: 7000 }));
    const cross = ok(draft(root, ["check", "cross"]), "check cross");
    const c = overCapOf(cross);
    assert.deepEqual(c.map((f) => f.id), ["§aa.one/small"], JSON.stringify(cross.coreFindings));
    assert.equal(c[0].severity, "warn");
    assert.equal(c[0].cap, CAP);
    assert.ok(c[0].was < CAP && c[0].bytes > CAP, JSON.stringify(c[0]));
    assert.match(c[0].message, /split it by topic into sibling claims/);
    assert.equal(cross.exit, base.exit, "the warning doesn't change draft check's exit");

    freshDraft(root, "edge");
    edit(root, "edge", claimFile({ edge: CAP + 1 }));
    assert.deepEqual(overCapOf(ok(draft(root, ["check", "edge"]), "check edge")).map((f) => [f.id, f.was, f.bytes]), [["§aa.one/edge", CAP, CAP + 1]], "one byte past the cap crosses it");

    freshDraft(root, "grow");
    edit(root, "grow", claimFile({ big: 8100 }));
    const grow = ok(draft(root, ["check", "grow"]), "check grow");
    assert.deepEqual(overCapOf(grow).map((f) => f.id), ["§aa.one/big"]);
    assert.ok(overCapOf(grow)[0].bytes > overCapOf(grow)[0].was);
    assert.equal(grow.preexisting["declaration-over-cap"], undefined, "the grown claim is introduced, not also counted as preexisting");

    freshDraft(root, "shrink");
    edit(root, "shrink", claimFile({ big: 7000 }));
    const shrink = ok(draft(root, ["check", "shrink"]), "check shrink");
    assert.deepEqual(overCapOf(shrink), [], "a claim still over the cap but smaller is not introduced");
    assert.equal(shrink.preexisting["declaration-over-cap"], 1);
    assert.deepEqual(overCapOf(ok(draft(root, ["check", "shrink", "--all"]), "check --all")).map((f) => f.id), ["§aa.one/big"], "--all lists the over-cap claims the base had");

    freshDraft(root, "add");
    edit(root, "add", claimFile({ extra: h2("§aa.one/added", "Added", para(9000)) }));
    put(root, `${SPEC}/drafts/add/spec/manifest.json`, read(root, `${SPEC}/drafts/add/spec/manifest.json`)); // layout 1 records below
    addRecord(root, `${SPEC}/drafts/add/spec`, layout, "§aa.one/added", { kind: "behavior", authority: "accepted", requires: [] });
    const add = ok(draft(root, ["check", "add"]), "check add");
    const a = overCapOf(add);
    assert.deepEqual(a.map((f) => f.id), ["§aa.one/added"], JSON.stringify(add.coreFindings));
    assert.equal(a[0].was, undefined, "a new claim has no size on the base");
  });

  test(`layout ${layout}: promotion warns for the selected over-cap claims and never refuses; agree's plan stays clean`, () => {
    const root = spec(layout);
    freshDraft(root, "p");
    // The note §bb/two grows past the cap (a note takes doc-only evidence); the over-cap §aa.one/big, unselected and
    // unchanged, gets no warning.
    put(root, `${SPEC}/drafts/p/spec/claims/bb/two.md`, `# §bb/two — Two\n\n${para(7000)}`);
    const ev = draft(root, ["evidence", "p", "--id", "§bb/two", "--by", "t", "--verification", "fixture", "--doc-only", "--write"]).j;
    assert.equal(ev.exit, 0, JSON.stringify(ev).slice(0, 1000));
    const pre = ok(draft(root, ["promote", "p", "--id", "§bb/two"]), "promote preview");
    assert.deepEqual(pre.refusals, []);
    assert.equal(pre.sizeWarnings.length, 1, JSON.stringify(pre.sizeWarnings));
    assert.match(pre.sizeWarnings[0], /^§bb\/two is \d+ B of prose \(was \d+ B\), over the 6144 B cap/);
    assert.deepEqual(pre.driftWarnings, [], "the size warning is not a drift warning");
    const w = draft(root, ["promote", "p", "--id", "§bb/two", "--plan", pre.plan, "--write"]).j;
    assert.equal(w.written, true, JSON.stringify(w).slice(0, 1500));
    assert.equal(w.exit, 0, "the warning doesn't change promote's exit");
    assert.equal(w.sizeWarnings.length, 1);
    assert.ok(sizeOf(ok(core(root, ["check"]), "check after"), "§bb/two") > CAP, "the over-cap claim landed");

    // agree on a no-code record over the cap still promotes: the warning never makes its plan unclean.
    freshDraft(root, "ag");
    edit(root, "ag", claimFile({ edge: CAP + 50 }));
    const ag = draft(root, ["agree", "ag", "--id", "§aa.one/edge", "--by", "omar (t)", "--verification", "fixture go-ahead", "--write"], { extraEnv: { SPEC_AGREE_SOURCE: "chat:c1#m3" } }).j;
    assert.equal(ag.exit, 0, JSON.stringify(ag).slice(0, 2000));
    assert.equal(ag.promotion?.written, true, JSON.stringify(ag.promotion));
  });
}

// The records of a spec dir, in whichever layout it is in: add one.
function addRecord(root, dir, layout, id, rec) {
  if (layout === 1) {
    const m = JSON.parse(read(root, `${dir}/manifest.json`));
    m.claims[id] = rec;
    put(root, `${dir}/manifest.json`, JSON.stringify(m, null, 2) + "\n");
  } else {
    const f = `${dir}/claims/aa/one.json`, r = JSON.parse(read(root, f));
    r[id] = rec;
    put(root, f, JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2) + "\n");
  }
}

test("both layouts give the same sizes, counts and warnings", () => {
  const run = (layout) => {
    const root = spec(layout);
    freshDraft(root, "x");
    edit(root, "x", claimFile({ small: 7000, big: 8100 }));
    const n = normalizer({ root });
    const c = n(ok(core(root, ["check"]), "check"));
    const d = n(ok(draft(root, ["check", "x"]), "draft check"));
    return { counts: c.counts, sizes: c.declarations.map((x) => [x.id, x.bytes]), warnings: overCapOf(d).map(({ file, ...f }) => f), pre: d.preexisting["declaration-over-cap"] ?? 0 };
  };
  same(run(2), run(1), "layout 2 against layout 1");
});

test("a draft whose base is in the old single-list layout and whose spec is per area splits the same way", () => {
  const root = spec(1);
  freshDraft(root, "mixed");
  const dir = `${SPEC}/drafts/mixed/spec`;
  rmSync(join(root, dir), { recursive: true, force: true });
  writeSpec(root, { layout: 2, meta: META, records: RECORDS, claims: { ...CLAIMS(), "aa/one.md": claimFile({ small: 7000, big: 8100 }) }, spec: dir });
  const d = ok(draft(root, ["check", "mixed"]), "draft check");
  assert.deepEqual(overCapOf(d).map((f) => f.id).sort(), ["§aa.one/big", "§aa.one/small"], JSON.stringify(d.coreFindings).slice(0, 1500));
  assert.ok(overCapOf(d).every((f) => typeof f.was === "number"), "each was measured on the old-layout base");
});
