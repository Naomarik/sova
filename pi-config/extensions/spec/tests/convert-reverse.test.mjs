// al_6 landing 2, check (3) and the rollback: on scratch copies of Sova's REAL spec,
//   - `migrate --reverse --write` on the cutover restores the first parent's manifest.json byte for byte, removes
//     every record file and leaves the prose alone;
//   - `migrate --write` on the first parent regenerates the cutover's manifest.json and record files byte for byte
//     (the cutover is the tool's output, nothing hand-edited, so "re-run migrate on the new tip" is a real recovery);
//   - the round trip v2 → v1 → v2 is the identity on bytes;
//   - the byte-exact rollback is `git revert` of the cutover (the reverse groups ids by area: a canonical identity).
// The dry runs write nothing. Fails until the cutover commit is on HEAD's history.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DRAFT, hashTree, env, layoutOnDisk, read } from "./layout/lib.mjs";
import { SPEC, REPO, requireCutover, archiveInto, scratch, noGit, recordsAt, showAt } from "./convert/lib.mjs";

const g = (root, ...a) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", root, ...a], { encoding: "utf8", env: env(root) }); assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`); return r.stdout; };
const migrate = (root, ...a) => {
  const r = spawnSync(process.execPath, [DRAFT, "migrate", ...a, "--root", root, "--json"], { encoding: "utf8", env: env(root), maxBuffer: 256 * 1024 * 1024 });
  let j; try { j = JSON.parse(r.stdout); } catch { assert.fail(`migrate ${a.join(" ")}: ${r.stdout.slice(0, 800)}${r.stderr.slice(0, 800)}`); }
  return { status: r.status, j };
};
/** A clean Git repo holding the spec dir of `rev` (migrate refuses a dirty spec). */
function specRepo(rev, name) {
  const root = scratch(name);
  archiveInto(rev, root, [SPEC]);
  g(root, "init", "-q"); g(root, "add", "-A"); g(root, "commit", "-qm", rev.slice(0, 12));
  return root;
}
/** manifest.json and every claims/**\/*.json, as { rel: sha256 } (the bytes the conversion owns). */
const recordBytes = (root) => hashTree(root, SPEC, { skip: (rel) => rel !== "claims" && !rel.startsWith("claims/") && rel !== "manifest.json" ? true : false });
const only = (h, pred) => Object.fromEntries(Object.entries(h).filter(([k]) => pred(k)));
/** The same, from Git objects at a commit (sha256 of each blob's bytes). */
function recordBytesAt(rev) {
  const root = scratch("at");
  archiveInto(rev, root, [SPEC]);
  return recordBytes(root);
}

describe("migrate --reverse and the forward conversion on Sova's real spec", { skip: noGit }, () => {
  let C;
  const load = () => { C ??= requireCutover(); return C; };

  let reversed = null;
  const reverse = () => {
    if (reversed) return reversed;
    const { cutover, base } = load();
    const root = specRepo(cutover, "rev");
    const before = hashTree(root);
    const dry = migrate(root, "--reverse");
    assert.equal(dry.status, 0, JSON.stringify(dry.j).slice(0, 800));
    assert.deepEqual(hashTree(root), before, "the dry run writes nothing");
    const w = migrate(root, "--reverse", "--write");
    assert.equal(w.status, 0, JSON.stringify(w.j).slice(0, 800));
    return (reversed = { root, before, got: read(root, `${SPEC}/manifest.json`), want: recordsAt(base).manifestText, base });
  };

  test("--reverse --write on the cutover restores the first parent's manifest.json, byte-identical but for the order of ids in claims; no record file is left", () => {
    const { root, before, got, want } = reverse();
    assert.equal(layoutOnDisk(root), 1);
    // Put the reversed ids in the first parent's order: then every byte must match (the meta, its key order, each
    // record's text, the indent and the trailing newline).
    const g = JSON.parse(got), w = JSON.parse(want);
    assert.deepEqual(Object.keys(g).filter((k) => k !== "claims"), Object.keys(w).filter((k) => k !== "claims"));
    assert.deepEqual(Object.keys(g.claims).sort(), Object.keys(w.claims).sort(), "the same ids");
    const reordered = JSON.stringify({ ...g, claims: Object.fromEntries(Object.keys(w.claims).map((id) => [id, g.claims[id]])) }, null, 2) + "\n";
    assert.ok(reordered === want, `beyond id order, manifest.json differs: first difference at ${[...reordered].findIndex((ch, i) => ch !== want[i])}`);
    assert.equal(Buffer.byteLength(got), Buffer.byteLength(want), "the same size");
    assert.deepEqual(Object.keys(recordBytes(root)).filter((k) => k.endsWith(".json") && k !== "manifest.json"), [], "every claims/**/*.json removed");
    const md = (h) => only(h, (k) => k.endsWith(".md"));
    assert.deepEqual(md(hashTree(root)), md(before), "every .md untouched");
  });

  // Decision (main thread, option a): the reverse is a canonical identity, ids grouped by area; the byte-exact
  // rollback is `git revert` of the cutover commit, checked here on a scratch clone of the real commit.
  test("git revert of the real cutover commit, on a scratch clone, restores manifest.json and the whole spec dir byte for byte", () => {
    const { cutover, base } = load();
    const root = scratch("revert");
    const r = spawnSync("git", ["clone", "-q", "--shared", "--no-checkout", REPO, root], { encoding: "utf8", env: env(root) });
    assert.equal(r.status, 0, r.stderr);
    g(root, "sparse-checkout", "set", "--cone", SPEC);
    g(root, "checkout", "-q", "--detach", cutover);
    assert.equal(layoutOnDisk(root), 2);
    g(root, "revert", "--no-edit", "HEAD");
    assert.ok(read(root, `${SPEC}/manifest.json`) === recordsAt(base).manifestText, "manifest.json byte for byte");
    assert.equal(g(root, "diff", "--stat", base, "HEAD", "--", SPEC, ".gitattributes"), "", "the spec dir and .gitattributes as the first parent had them");
    assert.equal(read(root, ".gitattributes"), showAt(base, ".gitattributes"), "the manifest merge attribute is back");
  });

  test("migrate --write on the first parent regenerates the cutover's record bytes exactly", () => {
    const { cutover, base } = load();
    const root = specRepo(base, "fwd");
    const before = hashTree(root);
    const dry = migrate(root);
    assert.equal(dry.status, 0, JSON.stringify(dry.j).slice(0, 800));
    assert.deepEqual(hashTree(root), before, "the dry run writes nothing");
    const w = migrate(root, "--write");
    assert.equal(w.status, 0, JSON.stringify(w.j).slice(0, 800));
    assert.deepEqual(recordBytes(root), recordBytesAt(cutover), "manifest.json and every record file as committed in the cutover");
  });

  test("round trip on the cutover: reverse, commit, forward gives back the same bytes; a second forward is refused", () => {
    const { cutover } = load();
    const root = specRepo(cutover, "trip");
    const start = hashTree(root);
    assert.equal(migrate(root, "--reverse", "--write").status, 0);
    g(root, "add", "-A"); g(root, "commit", "-qm", "reverse");
    assert.equal(migrate(root, "--write").status, 0);
    assert.deepEqual(hashTree(root), start, "every byte of the spec dir back");
    g(root, "add", "-A"); g(root, "commit", "-qm", "forward");
    const again = migrate(root, "--write");
    assert.notEqual(again.status, 0, `already format 2 must be refused: ${JSON.stringify(again.j).slice(0, 400)}`);
    assert.deepEqual(hashTree(root), start, "the refusal writes nothing");
  });
});
