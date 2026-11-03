#!/usr/bin/env node
// Merge check (optional, picked by the merge thread): the selected end-to-end walkthroughs, scripts/e2e/<x>.mjs,
// after one build (`pnpm run build`). Each hosts its own server (scripts/e2e/self-hosted.mjs). The selectors are the
// scripts' paths, appended to argv by the queue; none selected: nothing to do. See lib.mjs for the other inputs.
//   node scripts/merge-checks/e2e.mjs scripts/e2e/flow-focus.mjs [...]
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { context, niced, report, run, skip } from "./lib.mjs";

const ctx = context();
const picked = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!picked.length) skip(ctx.out, "no walkthrough selected");
const bad = picked.filter((p) => !/^scripts\/e2e\/[^/]+\.mjs$/.test(normalize(p)) || !existsSync(join(ctx.root, p)));
const files = picked.filter((p) => !bad.includes(p));
const failures = bad.map((p) => ({ name: p, file: p, message: "not a walkthrough in scripts/e2e/ of this tree" }));
if (files.length) {
  const b = await run("pnpm", ["run", "build"], { cwd: ctx.root });
  if (b !== 0) {
    report(ctx.out, { passed: 0, failed: 1, failures: [{ name: "build before the walkthroughs", message: `exit ${b}` }] });
    process.exit(1);
  }
}
let passed = 0;
for (const f of files) {
  const code = await run(...niced(ctx.root, "node", [f]), { cwd: ctx.root });
  if (code === 0) passed++;
  else failures.push({ name: f, file: f, message: `exit ${code}` });
}
report(ctx.out, { passed, failed: failures.length, failures, failingFiles: failures.flatMap((f) => (f.file ? [f.file] : [])) });
process.exit(failures.length ? 1 : 0);
