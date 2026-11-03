#!/usr/bin/env node
// Merge check: the suites of the pi-config extensions the change touches, each its line in
// pi-config/README.md's Tests block, run at lowered priority (scripts/nice.mjs). See lib.mjs for inputs.
//   node scripts/merge-checks/ext-suites.mjs [--base <rev>] [--changed <file>]
// Exit 0: every suite passed, or none to run (SOVA_OUT {skipped}). Exit 1: a suite failed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changedExtensions, context, expandArgs, niced, report, run, skip, suiteOf } from "./lib.mjs";

const ctx = context();
const exts = changedExtensions(ctx.changed);
if (!exts.length) skip(ctx.out, "no change to a pi-config extension");
let readme = "";
try { readme = readFileSync(join(ctx.root, "pi-config", "README.md"), "utf8"); } catch { /* none */ }
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT; // inherited from a node --test above us, it makes a suite skip every file and pass
const failures = [];
let passed = 0;
const missing = [];
for (const ext of exts) {
  const suite = suiteOf(readme, ext);
  if (!suite) { missing.push(ext); console.log(`pi-config ${ext}: no line in pi-config/README.md's Tests block.`); continue; }
  const cwd = join(ctx.root, "pi-config", suite.dir);
  let failed = false;
  for (const argv of suite.commands) {
    const [cmd, ...rest] = expandArgs(argv, cwd);
    const code = await run(...niced(ctx.root, cmd, rest), { cwd, env });
    if (code !== 0) {
      failures.push({ name: `pi-config ${ext}: ${argv.join(" ")}`, file: `pi-config/${suite.dir}`, message: `exit ${code}` });
      failed = true;
      break;
    }
  }
  if (!failed) passed++;
}
if (!passed && !failures.length) skip(ctx.out, `no Tests line for ${missing.join(", ")}`);
report(ctx.out, { passed, failed: failures.length, failures, ...(missing.length ? { notes: [`no Tests line for ${missing.join(", ")}`] } : {}) });
console.log(failures.length ? `extension suites: ${failures.length} failed` : `extension suites: ${passed} passed`);
process.exit(failures.length ? 1 : 0);
