// al_6 landing 2, check (2): every core command and the draft tool answer the same on Sova's REAL spec before and
// after the cutover. Two scratch repos hold the same source tree (the cutover's), one with the first parent's
// .sova/spec (format 1), one with the cutover's (format 2); both get the same two-commit history (c0 the archive,
// c1 one code, prose, record and new-claim change made in each tree's own layout), so the history commands
// (census --changed, foreign) have something to compare. Allowed to differ: the root path, commit ids, cursor
// tokens, and file-level counts and write targets, which are layout-specific by design and checked on their own.
// A second pass runs the pre-cutover tools (landing 1's, at ca8ab14) on the old tree against this branch's tools on
// the new one: what a user sees across the landing. Fails until the cutover commit is on HEAD's history.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { core, draft, pages, normalizer, same, put, read, editRecords, recordsOnDisk, layoutOnDisk, hashTree, notDrafts, byCodePoint, env } from "./layout/lib.mjs";
import { PRE_CUTOVER, SPEC, TOOLS, requireCutover, recordsAt, archiveInto, scratch, noGit } from "./convert/lib.mjs";

const g = (root, ...a) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", root, ...a], { encoding: "utf8", env: env(root), maxBuffer: 256 * 1024 * 1024 }); assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
const NEW_MD = "# §zz/convert-probe — Convert probe\n\nA note the cutover test adds on top of §app/access, in both layouts.\n";

describe("Sova's real spec answers the same before and after the cutover", { skip: noGit }, () => {
  let OLD, NEW, ids, area, codeFile, ctx, dtarget, dmd, djson;
  before(() => {
    const c = requireCutover();
    const recs = recordsAt(c.base).records;
    const all = Object.keys(recs).sort(byCodePoint);
    ids = [
      all.find((i) => recs[i].kind === "surface" && recs[i].notOwned), all.find((i) => recs[i].agreed && recs[i].code?.length),
      all.find((i) => recs[i].kind === "note" && recs[i].about), all.find((i) => recs[i].core === true),
      all.find((i) => (recs[i].requires?.length ?? 0) > 3), all.find((i) => i.includes(".") && recs[i].kind === "behavior" && recs[i].code?.length),
      all.find((i) => recs[i].members), "§app/access",
    ].filter(Boolean);
    ids = [...new Set(ids)];
    const changed = all.find((i) => i.includes(".") && recs[i].kind === "behavior" && recs[i].code?.length && recs[i].requires?.length);
    area = changed.slice(1).split("/")[0].split(".")[0];
    // the draft's change: another record with several requires, in its own area (format 2: its own record file)
    dtarget = all.find((i) => i !== changed && recs[i].kind === "behavior" && (recs[i].requires?.length ?? 0) > 2 && !recs[i].requires.includes("§app/access"));
    djson = recordsAt(c.cutover).fileOf[dtarget];
    dmd = djson.replace(/\.json$/, ".md");
    codeFile = recs[changed].code[0];
    const tree = (spec) => {
      const root = scratch(spec === c.base ? "old" : "new");
      archiveInto(c.cutover, root);
      rmSync(join(root, SPEC), { recursive: true, force: true });
      archiveInto(spec, root, [SPEC]);
      g(root, "init", "-q"); g(root, "add", "-A"); g(root, "commit", "-qm", "c0");
      const c0 = g(root, "rev-parse", "HEAD");
      // c1: a code change, a prose change, a record change and a new claim, each tree in its own layout
      put(root, codeFile, read(root, codeFile) + "\n// convert-test change\n");
      put(root, `${SPEC}/claims/zz/convert-probe.md`, NEW_MD);
      editRecords(root, SPEC, (r) => {
        r[changed] = { ...r[changed], requires: [...r[changed].requires, "§app/access"] };
        r["§zz/convert-probe"] = { kind: "note", authority: "accepted", requires: ["§app/access"] };
      });
      g(root, "add", "-A"); g(root, "commit", "-qm", "c1");
      const c1 = g(root, "rev-parse", "HEAD");
      return { root, c0, c1, revs: { [c0]: "<c0>", [c1]: "<c1>" } };
    };
    OLD = tree(c.base);
    NEW = tree(c.cutover);
    ctx = c;
  });

  const matrix = (X) => {
    const m = [
      ["check"], ["census"], ["records"], ["map"], ["map", area], ["map", "§app/access"], ["graph"],
      ["where", codeFile], ["where", "spec", "lookup", "draft"], ["where", "merge", "round", "landing"], ["where", "merge-manifest", "--token"],
      ["read", "--frame"],
      ["census", "--changed", "--base", X.c0, "--related"],
      ["foreign", "--base", X.c0, "--head", X.c1],
      ["read", "§zz/convert-probe"], ["toc", "§zz/convert-probe", "--dir", "out"], ["impact", "§app/access", "--near"],
    ];
    for (const id of ids) {
      m.push(["read", id], ["read", id, "--whole"], ["read", id, "--no-frame"], ["scope", id], ["impact", id], ["impact", id, "--near"]);
      for (const dir of ["out", "in", "down", "up", "mentions"]) m.push(["toc", id, "--dir", dir]);
      m.push(["packet", id], ["packet", id, "--part", "inventory"], ["packet", id, "--part", "frontier"]);
    }
    return m;
  };
  // graph is compared whole above; paging it at a small budget takes hundreds of pages
  const PAGED = [["map"], ["where", "spec", "lookup", "draft"], ["toc", "§app/access", "--dir", "in"], ["impact", "§app/access", "--near"], ["read", "§app/access", "--whole"]];

  function compare(runA, runB, label) {
    const na = normalizer({ root: OLD.root, revs: OLD.revs }), nb = normalizer({ root: NEW.root, revs: NEW.revs });
    let answered = 0;
    for (const args of matrix(OLD)) {
      const argsB = args.map((a) => (a === OLD.c0 ? NEW.c0 : a === OLD.c1 ? NEW.c1 : a));
      const a = runA(OLD.root, args).j, b = runB(NEW.root, argsB).j;
      const refused = a.exit === 2 || a.status === "refused";
      if (!(args[0] === "toc" && args[3] === "up")) assert.ok(!refused, `${label}: format 1 answers ${args.join(" ")}: ${JSON.stringify(a).slice(0, 400)}`);
      if (!refused) answered++;
      if (args[0] === "records") { assert.deepEqual(b.records, a.records, `${label}: records`); assert.deepEqual([a.layout, b.layout], [1, 2]); continue; }
      if (args[0] === "census" && args[1] === "--changed") {
        // a count of changed files: format 1 changed manifest.json, format 2 the area files; each must count its own
        for (const [r, j, base] of [[OLD.root, a, OLD.c0], [NEW.root, b, NEW.c0]])
          assert.equal(j.census.changed, g(r, "diff", "--name-only", base).split("\n").filter(Boolean).length, `${label}: census.changed counts the changed files`);
        a.census.changed = b.census.changed = "<files>";
      }
      same(nb(b), na(a), `${label}: ${args.join(" ")}`);
    }
    assert.ok(answered >= matrix(OLD).length - ids.length, `${label}: ${answered} of ${matrix(OLD).length} commands answered (only toc --dir up may refuse)`);
    let paged = 0;
    for (const args of PAGED) {
      const pa = pages(OLD.root, args, { budget: 4000 }), pb = pages(NEW.root, args, { budget: 4000 });
      if (pa.length > 1) paged++;
      same(pb.map(nb), pa.map(na), `${label}: every page of ${args.join(" ")}`);
    }
    assert.ok(paged >= 3, `${label}: ${paged} commands paged (cursors followed across layouts)`);
  }

  test("the trees are what they say: format 1 and format 2 of the same records", () => {
    assert.equal(layoutOnDisk(OLD.root), 1);
    assert.equal(layoutOnDisk(NEW.root), 2);
    assert.deepEqual(recordsOnDisk(NEW.root).records, recordsOnDisk(OLD.root).records);
    assert.ok(ids.length >= 5, JSON.stringify(ids));
    assert.ok(dtarget && djson.startsWith("claims/"), `${dtarget} in ${djson}`);
  });

  test("every core command, this branch's tools on both trees", () => compare(core, core, "branch tools"));

  test("across the landing: the pre-cutover tools on the old tree, this branch's tools on the new one", () => {
    const old = scratch("tools");
    archiveInto(PRE_CUTOVER, old, [TOOLS]);
    const oldCore = (root, args) => {
      const r = spawnSync(process.execPath, [join(old, TOOLS, "sova-spec.mjs"), ...args, "--root", root, "--json"], { encoding: "utf8", env: env(root), maxBuffer: 256 * 1024 * 1024 });
      let j; try { j = JSON.parse(r.stdout); } catch { assert.fail(`old tools ${args.join(" ")}: ${r.stdout.slice(0, 400)}${r.stderr.slice(0, 400)}`); }
      return { status: r.status, j };
    };
    compare(oldCore, core, "landing");
  });

  test("the comparison sees the record files: one changed record in format 2 changes the answers", () => {
    const root = scratch("planted");
    archiveInto(ctx.cutover, root, [SPEC]);
    const ref = scratch("planted-ref");
    archiveInto(ctx.cutover, ref, [SPEC]);
    editRecords(root, SPEC, (r) => { r[dtarget] = { ...r[dtarget], requires: r[dtarget].requires.slice(1) }; });
    const n = (x) => normalizer({ root: x });
    for (const args of [["check"], ["toc", dtarget, "--dir", "out"], ["scope", dtarget]]) assert.notDeepEqual(n(root)(core(root, args).j), n(ref)(core(ref, args).j), args.join(" "));
  });

  // ---------------------------------------------------------------- the draft tool
  const OPAQUE = ["next", "cursor", "plan", "createdAt", "recordedAt", "startedAt", "treeSha256", "fileCount", "bytes"];
  const D = (rel = "") => `${SPEC}/drafts/f1/spec${rel ? `/${rel}` : ""}`;
  function propose(root) {
    put(root, D(dmd), read(root, D(dmd)).replace(/\n*$/, "\n\nA sentence the convert test adds.\n"));
    put(root, D("claims/zz/convert-draft.md"), "# §zz/convert-draft — Convert draft\n\nA draft note about §app/access.\n");
    editRecords(root, D(), (r) => {
      r["§zz/convert-draft"] = { kind: "note", authority: "accepted", requires: ["§app/access"] };
      r[dtarget] = { ...r[dtarget], requires: [...r[dtarget].requires, "§app/access"] };
    });
  }
  const STEPS = [
    ["status", "f1"], ["diff", "f1"], ["diff", "f1", "--against", "current"], ["check", "f1"], ["check", "f1", "--all"],
    ["evidence", "f1", "--id", "§zz/convert-draft", "--by", "t", "--verification", "read it", "--doc-only", "--write"],
    ["evidence", "f1", "--id", "<dtarget>", "--by", "t", "--verification", "ran it", "--commit", "HEAD", "--write"],
    ["status", "f1"], ["diff", "f1"], ["check", "f1"],
  ];

  test("draft status, diff, check, evidence and promote (preview and write) answer the same", () => {
    const na = normalizer({ root: OLD.root, revs: OLD.revs, opaque: OPAQUE }), nb = normalizer({ root: NEW.root, revs: NEW.revs, opaque: OPAQUE });
    const a0 = draft(OLD.root, ["new", "f1", "--write"]).j, b0 = draft(NEW.root, ["new", "f1", "--write"]).j;
    assert.equal(a0.exit, 0, JSON.stringify(a0).slice(0, 600));
    same(nb(b0), na(a0), "new");
    assert.equal(layoutOnDisk(NEW.root, D()), 2, "a format 2 spec's draft is format 2");
    propose(OLD.root); propose(NEW.root);
    for (const args0 of STEPS) {
      const args = args0.map((x) => (x === "<dtarget>" ? dtarget : x));
      const a = draft(OLD.root, args).j, b = draft(NEW.root, args).j;
      assert.ok(args[0] === "evidence" ? a.exit === 0 : a.exit !== 2, `${args.join(" ")}: ${JSON.stringify(a).slice(0, 500)}`);
      same(nb(b), na(a), args.join(" "));
    }
    const sel = ["--id", "§zz/convert-draft", "--id", dtarget];
    const pa = draft(OLD.root, ["promote", "f1", ...sel]).j, pb = draft(NEW.root, ["promote", "f1", ...sel]).j;
    assert.equal(pa.exit, 0, JSON.stringify(pa).slice(0, 800));
    const md = (t) => t.filter((x) => x.path.endsWith(".md")), rec = (t) => t.filter((x) => !x.path.endsWith(".md") && x.before !== x.after).map((x) => [x.path, x.action]).sort();
    same(md(pb.targets), md(pa.targets), "promote preview: prose targets");
    assert.deepEqual(rec(pa.targets), [["manifest.json", "replace"]]);
    assert.deepEqual(rec(pb.targets), [[djson, "replace"], ["claims/zz/convert-draft.json", "create"]].sort(), "format 2 writes only the two areas' record files");
    same(nb({ ...pb, targets: "<files>" }), na({ ...pa, targets: "<files>" }), "promote preview");
    const before = hashTree(NEW.root, SPEC, { skip: notDrafts });
    const wa = draft(OLD.root, ["promote", "f1", ...sel, "--plan", pa.plan, "--write"]).j, wb = draft(NEW.root, ["promote", "f1", ...sel, "--plan", pb.plan, "--write"]).j;
    assert.equal(wa.exit, 0, JSON.stringify(wa).slice(0, 800));
    same(nb({ ...wb, targets: "<files>" }), na({ ...wa, targets: "<files>" }), "promote --write");
    const after = hashTree(NEW.root, SPEC, { skip: notDrafts });
    assert.deepEqual([...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort(),
      [djson, "claims/zz/convert-draft.json", "claims/zz/convert-draft.md"].sort(), "format 2 promotion touches only those areas' files (the sentence added at the end of the .md belongs to an unselected claim); manifest.json untouched");
    assert.deepEqual(recordsOnDisk(NEW.root).records, recordsOnDisk(OLD.root).records, "the same records landed");
    same(normalizer({ root: NEW.root })(core(NEW.root, ["check"]).j), normalizer({ root: OLD.root })(core(OLD.root, ["check"]).j), "check after the promotion");
  });
});
