// al_6 landing 2, check (5): the records-file ratchets still hold after the cutover, and their allowlists only
// shrink. The guard tests themselves (layout-guard.test.mjs, server/spec-layout-boundary.test.ts) compare against
// the merge base with master, which is HEAD itself once a branch has landed; this file pins the comparison to the
// last pre-cutover master (ca8ab14), so the "only shrinks" rule stays checked against a fixed point on every tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { compare, growth, listSources, scanRepo, loadAllowlist } from "./layout/guard-scan.mjs";
import { PRE_CUTOVER, REPO, noGit, showAt } from "./convert/lib.mjs";

const LISTS = [
  ["pi-config", "pi-config/extensions/spec/tests/layout/allowlist.json", ["pi-config/extensions"]],
  ["repo", "pi-config/extensions/spec/tests/layout/repo-allowlist.json", ["server", "shared", "src", "scripts", "site", ".sova"]],
];
const entries = (a) => (a.paths?.length ?? 0) + Object.values(a.lines ?? {}).reduce((n, l) => n + l.length, 0);

for (const [name, rel, roots] of LISTS) {
  test(`${name} ratchet: only core/layout.mjs reads the records (allowlist exact, no stale entry)`, () => {
    const files = listSources(REPO, roots);
    assert.ok(files.length > 100, `${files.length} files scanned`);
    const r = compare(scanRepo(REPO, files), loadAllowlist(join(REPO, rel)));
    assert.deepEqual(r.problems, [], `\n${r.problems.join("\n")}\n`);
  });

  test(`${name} allowlist only shrinks since the last pre-cutover master`, { skip: noGit }, (t) => {
    const before = JSON.parse(showAt(PRE_CUTOVER, rel) ?? "null");
    assert.ok(before, `${rel} exists at ${PRE_CUTOVER.slice(0, 12)}`);
    const now = loadAllowlist(join(REPO, rel));
    assert.deepEqual(growth(before, now), [], `grew past ${PRE_CUTOVER.slice(0, 12)}`);
    assert.ok(entries(now) <= entries(before));
    t.diagnostic(`${entries(before)} entries at ${PRE_CUTOVER.slice(0, 12)}, ${entries(now)} now`);
  });
}

test("control: the growth check sees an added entry (it cannot pass by comparing nothing)", { skip: noGit }, () => {
  const before = JSON.parse(showAt(PRE_CUTOVER, LISTS[0][1]));
  const [file, list] = Object.entries(before.lines)[0];
  const grown = { ...before, lines: { ...before.lines, [file]: [...list, { rule: "names-manifest", text: "const p = `${SPEC}/manifest.json`;", reason: "a planted entry" }] } };
  assert.equal(growth(before, grown).length, 1);
});
