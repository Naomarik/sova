// Run: pnpm test -- server/spec-layout-boundary.test.ts. The records-file ratchet over the repo outside pi-config
// (server/, shared/, src/, scripts/, site/, .sova/): only pi-config/extensions/spec/core/layout.mjs reads the spec's
// records. Every other source line that names manifest.json (or a MANIFEST constant) or reads a claims key off a
// parsed manifest is on pi-config/extensions/spec/tests/layout/repo-allowlist.json, by exact text, with a reason, or
// its whole file is (an unrelated manifest: tours, ideas, screenshots). The list only shrinks, like
// server/harness/boundary-baseline.json. The scanner's rule forms are proved in
// pi-config/extensions/spec/tests/layout-guard.test.mjs; here a planted reader proves this scan's roots reach it.
// SOVA_SPEC_LAYOUT_ALLOW_OUT=<absolute path> writes a draft allowlist from today's hits (reasons kept where known).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  committedAllowlist, compare, draftAllowlist, growth, isScanned, listSources, loadAllowlist, scanRepo, scanText,
} from "../pi-config/extensions/spec/tests/layout/guard-scan.mjs";

const REPO = resolve(import.meta.dirname, "..");
const ALLOW_REL = "pi-config/extensions/spec/tests/layout/repo-allowlist.json";
const ROOTS = ["server", "shared", "src", "scripts", "site", ".sova"];

const files = listSources(REPO, ROOTS);
const scans = scanRepo(REPO, files);
const allow = loadAllowlist(join(REPO, ALLOW_REL));
if (process.env.SOVA_SPEC_LAYOUT_ALLOW_OUT) writeFileSync(process.env.SOVA_SPEC_LAYOUT_ALLOW_OUT, `${JSON.stringify(draftAllowlist(scans, allow), null, 2)}\n`);

test("the repo scan reaches every root and the known spec readers (it cannot pass by scanning nothing)", () => {
  assert.ok(files.length > 500, `${files.length} files scanned`);
  for (const root of ROOTS.filter((r) => r !== "src" && r !== "shared"))
    assert.ok(files.some((f) => f.startsWith(`${root}/`)), `${root}/ is scanned`);
  for (const f of ["server/spec-lookup.ts", "server/spec-draft-writer.ts", ".sova/playbooks/merge-round/scripts/round.mjs", "scripts/sim/lib/checks.mjs"])
    assert.ok(files.includes(f), `${f} is scanned`);
  assert.ok((scans.get("server/spec-lookup.ts") ?? []).some((h) => h.rule === "names-manifest"), "spec-lookup's existence probe is found");
  assert.equal(files.some((f) => f.startsWith("pi-config/")), false, "pi-config has its own guard");
  assert.equal(isScanned("server/spec-layout-boundary.test.ts"), false, "tests are exempt");
});

test("a planted direct reader in any scanned root fails the ratchet", () => {
  const planted = 'const ids = Object.keys(JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8")).claims);';
  for (const root of ROOTS) {
    const f = `${root}/planted-reader.ts`;
    assert.equal(isScanned(f), true, f);
    const r = compare(new Map([...scans, [f, scanText(planted)]]), allow);
    assert.ok(r.unlisted.some((u) => u.file === f && u.rule === "names-manifest") && r.unlisted.some((u) => u.file === f && u.rule === "reads-claims"), f);
  }
});

test("only core/layout.mjs reads the spec's records outside pi-config (allowlist exact, reasons given)", () => {
  const r = compare(scans, allow);
  assert.deepEqual(r.problems, [], `\n${r.problems.join("\n")}\n`);
});

test("the repo allowlist only shrinks (against the committed list at the merge base with master)", () => {
  const before = committedAllowlist(REPO, ALLOW_REL);
  if (!before) return; // the change that adds the list has nothing to grow past
  assert.deepEqual(growth(before.allow, allow), [], `grew past ${before.at}`);
});
