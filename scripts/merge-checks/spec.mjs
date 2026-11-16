#!/usr/bin/env node
// Merge check: the product documentation (.sova/spec) reads and holds together: the spec tool's `check`
// (errors fail; warnings are printed), then `census --changed` against the base (unclaimed files are
// printed, never fail: the drafts already landed in this tree as its docs commit). Skipped when the
// tree has no spec. The spec tools: SOVA_SPEC_CORE (the queue sets the running Sova's), else the agent's. See lib.mjs.
//   node scripts/merge-checks/spec.mjs [--base <rev>] [--changed <file>]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { context, report, skip, specCore } from "./lib.mjs";

const ctx = context();
if (!existsSync(join(ctx.root, ".sova", "spec", "claims"))) skip(ctx.out, "no .sova/spec in this tree");
const core = specCore();
const fail = (name, message) => {
  console.log(`spec: ${message}`);
  report(ctx.out, { passed: 0, failed: 1, failures: [{ name, message }] });
  process.exit(1);
};
if (!existsSync(join(core, "sova-spec.mjs"))) fail("spec tools", `the spec tools aren't at ${core}, so the spec can't be checked`);
const tool = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(core, "sova-spec.mjs"), ...args, "--root", ctx.root, "--json"], { cwd: ctx.root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    return { code: err.status ?? 2, out: String(err.stdout ?? ""), err: String(err.stderr ?? err.message) };
  }
};
const c = tool(["check"]);
let errs = [];
try {
  const j = JSON.parse(c.out);
  errs = (j.findings ?? []).filter((f) => f.severity === "error").map((f) => `${f.id ?? ""} ${f.code ?? ""}: ${f.message ?? ""}`.trim());
} catch { /* no JSON */ }
if (c.code === 2) fail("spec check", `check has errors${errs.length ? `: ${errs.slice(0, 8).join("; ")}` : ` (${(c.err ?? "").trim().split("\n")[0] || "see the log"})`}`);
console.log(`spec check: ${c.code === 0 ? "ok" : "warnings"}.`);
const notes = [];
const census = tool(["census", "--changed", "--base", ctx.base]);
let unclaimed = null;
try { unclaimed = JSON.parse(census.out).census?.unclaimed ?? null; } catch { /* no JSON */ }
if (!Array.isArray(unclaimed)) notes.push("census couldn't run");
else if (unclaimed.length) notes.push(`census: ${unclaimed.length} unclaimed (${unclaimed.slice(0, 3).join(", ")}${unclaimed.length > 3 ? ", …" : ""})`);
for (const n of notes) console.log(`spec ${n}.`);
report(ctx.out, { passed: 1, failed: 0, failures: [], ...(notes.length ? { notes } : {}) });
