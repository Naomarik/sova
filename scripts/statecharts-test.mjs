#!/usr/bin/env node
// Run statecharts/ tests against `pnpm statecharts:watch`'s output, each run in a fresh node process.
//
//   pnpm statecharts:test               every non-matrix test namespace, one process
//   pnpm statecharts:test <ns>…         only these namespaces (or <ns>/<deftest>), one process each
//   pnpm statecharts:test --matrix      then each refit matrix deftest in its own process (~17 s each)
//
// The full cold path (compile + every matrix) stays `node scripts/build-statecharts.mjs --test`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = join(dirname(fileURLToPath(import.meta.url)), "..", "statecharts");
const out = join(project, "out", "test", "node-tests.cjs");
const argv = process.argv.slice(2);
const matrixFlag = argv.includes("--matrix");
const picks = argv.filter((a) => a !== "--matrix");
const dirs = ["src", "test"];
const files = dirs.flatMap((d) => readdirSync(join(project, d), { recursive: true }).filter((f) => /\.clj[sc]$/.test(f)).map((f) => join(d, f)));

// The watch rewrites out/ after every rebuild; give a rebuild in flight a few seconds before calling it stale.
const newest = () => Math.max(...files.map((f) => statSync(join(project, f)).mtimeMs));
const fresh = () => existsSync(out) && statSync(out).mtimeMs >= newest();
for (let i = 0; !fresh() && i < 30; i++) await new Promise((r) => setTimeout(r, 200));
if (!fresh()) {
  console.error(existsSync(out)
    ? "statecharts/out/test is older than the sources (no watch running, or its build failed): start `pnpm statecharts:watch` first"
    : "no watch output in statecharts/out/test: start `pnpm statecharts:watch` first");
  process.exit(2);
}

const matrix = "sova.statecharts.refit.matrix-test";
const nsOf = (f) => f.slice(f.indexOf("/") + 1).replace(/\.clj[sc]$/, "").split("/").join(".").replace(/_/g, "-");
const others = files.map(nsOf).filter((ns) => ns.endsWith("-test") && ns !== matrix).sort();
const cells = matrixFlag ? [...readFileSync(join(project, "test", "sova", "statecharts", "refit", "matrix_test.cljs"), "utf8")
  .matchAll(/^\(deftest\s+(\S+)/gm)].map((m) => `${matrix}/${m[1]}`) : [];
const runs = [...(picks.length ? picks : [others.join(",")]), ...cells];
for (const pick of runs) {
  const t = Date.now();
  console.log(`\n== --test=${pick.length > 120 ? `${others.length} namespaces` : pick}`);
  const r = spawnSync("node", ["--max-old-space-size=4096", out, `--test=${pick}`], { cwd: project, stdio: "inherit" });
  console.log(`== ${((Date.now() - t) / 1000).toFixed(1)} s`);
  if (r.status !== 0) process.exit(r.status ?? 1);
}
