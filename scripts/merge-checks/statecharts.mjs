#!/usr/bin/env node
// Merge check: the statecharts' tests, cold (`node scripts/build-statecharts.mjs --test`: compile and run
// every CLJS test; a merge copy has no `statecharts:watch` running), only when the change touches
// statecharts/ or their scripts. Needs a JVM and the Clojure CLI. See lib.mjs for inputs.
//   node scripts/merge-checks/statecharts.mjs [--base <rev>] [--changed <file>]
import { existsSync } from "node:fs";
import { join } from "node:path";
import { context, niced, report, run, skip, touchesStatecharts } from "./lib.mjs";

const ctx = context();
if (!ctx.changed.some(touchesStatecharts)) skip(ctx.out, "no change to the statecharts");
if (!existsSync(join(ctx.root, "scripts", "build-statecharts.mjs"))) skip(ctx.out, "no scripts/build-statecharts.mjs in this tree");
const code = await run(...niced(ctx.root, "node", ["scripts/build-statecharts.mjs", "--test"]), { cwd: ctx.root });
report(ctx.out, { passed: code === 0 ? 1 : 0, failed: code === 0 ? 0 : 1, failures: code === 0 ? [] : [{ name: "statecharts tests", file: "statecharts", message: `exit ${code}` }] });
process.exit(code === 0 ? 0 : 1);
