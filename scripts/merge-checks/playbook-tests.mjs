#!/usr/bin/env node
// Merge check: the own tests of each playbook a user starts (`playbooks/<id>/`) that the change touches, when it has a
// tests/ folder: `node --test playbooks/<id>/tests/*.test.mjs`, from the tree's root, at lowered priority
// (scripts/nice.mjs). Those tests need nothing from Sova and protect themselves (each file's tests/scratch.mjs), so they
// run bare, outside Sova's runner, which never picks them up. See lib.mjs for inputs.
//   node scripts/merge-checks/playbook-tests.mjs [--base <rev>] [--changed <file>]
// Exit 0: every touched playbook's tests passed, or none to run (SOVA_OUT {skipped}). Exit 1: one failed.
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { changedPlaybooks, context, niced, report, run, skip } from "./lib.mjs";

const ctx = context();
const touched = changedPlaybooks(ctx.changed);
if (!touched.length) skip(ctx.out, "no change to a playbook in playbooks/");
/** A playbook's test files, relative to the root, sorted; none when it has no tests/ folder (or it was removed). */
const testFiles = (id) => {
  const dir = join(ctx.root, "playbooks", id, "tests");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => `playbooks/${id}/tests/${f}`);
};
const suites = touched.map((id) => ({ id, files: testFiles(id) })).filter((s) => s.files.length);
if (!suites.length) skip(ctx.out, `no tests/ folder in the changed playbooks (${touched.join(", ")})`);
/** Node itself, whatever runs this check (started by Bun, process.execPath is Bun, whose node:test needs `bun test`). */
const nodeBin = () => {
  if (!process.versions.bun) return process.execPath;
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(dir, "node"), constants.X_OK);
      return join(dir, "node");
    } catch {
      // not here
    }
  }
  return "node";
};
const node = nodeBin();
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT; // inherited from a node --test above us, it makes a suite skip every file and pass
const failures = [];
let passed = 0;
for (const { id, files } of suites) {
  const code = await run(...niced(ctx.root, node, ["--test", ...files]), { cwd: ctx.root, env });
  if (code === 0) passed++;
  else failures.push({ name: `playbook ${id}: node --test playbooks/${id}/tests/*.test.mjs`, file: `playbooks/${id}/tests`, message: `exit ${code}` });
}
const without = touched.filter((id) => !suites.some((s) => s.id === id));
report(ctx.out, { passed, failed: failures.length, failures, ...(without.length ? { notes: [`no tests/ folder: ${without.join(", ")}`] } : {}) });
console.log(failures.length ? `playbook tests: ${failures.length} failed` : `playbook tests: ${passed} passed`);
process.exit(failures.length ? 1 : 0);
