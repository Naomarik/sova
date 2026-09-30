#!/usr/bin/env node
// Rebuild the vendored organization statecharts bundle: org-charts/ (CLJS) → server/vendor/org-charts.js.
//
//   node scripts/build-org-charts.mjs          release build of HEAD's org-charts/, copied into server/vendor/
//   node scripts/build-org-charts.mjs --check  release build of HEAD's org-charts/; exit 1 if it differs
//                                              from the vendored file
//   node scripts/build-org-charts.mjs --test   compile and run the CLJS tests under Node (engine + charts),
//                                              on the working tree: several processes, one after another
//
// The release build and --check never read the working tree: they `git archive HEAD org-charts/` into a
// temp dir and build there. Several people edit org-charts/ at once (some of them mutation-testing), so a
// bundle built from the shared tree can ship a stray edit; the vendored bundle is HEAD's, always.
//
// Needs a JVM and the Clojure CLI (deps from ~/.m2 or Maven). `pnpm build` never runs this: Sova's own
// build and tests use the committed bundle. `-Srepro` keeps a user-level `:build`/`:shadow` alias out.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
if (args.has("--dirty")) {
  console.error("--dirty is gone: the release build and --check always build HEAD (commit first); --test runs the working tree.");
  process.exit(2);
}
// --test works on the tree; a release build or --check on a fresh export of HEAD.
let scratch = null;
let project = join(root, "org-charts");
if (!args.has("--test")) {
  scratch = mkdtempSync(join(tmpdir(), "org-charts-build-"));
  const tar = execFileSync("git", ["archive", "--format=tar", "HEAD", "org-charts"], { cwd: root, maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", scratch], { input: tar });
  project = join(scratch, "org-charts");
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  console.log(`building org-charts/ as committed at ${head}`);
}
// [built, vendored] per build: the shipped bundle.
const modules = [[join(project, "out", "lib", "org-charts.js"), join(root, "server", "vendor", "org-charts.js")]];

// Timbre's compile-time elision: debug/trace/info log calls are removed from the release build.
const jvm = ["-J-Dtaoensso.timbre.min-level.edn=:warn"];

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, { cwd: project, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function shadow(...argv) {
  run("clojure", ["-Srepro", ...jvm, "-M:build", "-m", "shadow.cljs.devtools.cli", ...argv]);
}

// The chart matrices don't fit one Node heap together (4 GB, OOM after ~97 min), so --test runs every other
// test namespace in one process, then each matrix deftest in its own, one after another; the first failure
// stops it. One piece by hand: node org-charts/out/test/node-tests.cjs --test=<ns>[/<deftest>],…
if (args.has("--test")) {
  shadow("compile", "test");
  const matrix = "sova.org-charts.charts.refit.matrix-test";
  const nsOf = (file) => file.replace(/\.clj[sc]$/, "").split("/").join(".").replace(/_/g, "-");
  const files = ["src", "test"].flatMap((dir) => readdirSync(join(project, dir), { recursive: true })).filter((f) => /\.clj[sc]$/.test(f));
  const others = files.map(nsOf).filter((ns) => ns.endsWith("-test") && ns !== matrix).sort();
  const cells = [...readFileSync(join(project, "test", "sova", "org_charts", "charts", "refit", "matrix_test.cljs"), "utf8")
    .matchAll(/^\(deftest\s+(\S+)/gm)].map((m) => `${matrix}/${m[1]}`);
  for (const pick of [others.join(","), ...cells]) {
    console.log(`\n== node-tests --test=${pick.length > 120 ? `${others.length} namespaces` : pick}`);
    run("node", ["--max-old-space-size=4096", join(project, "out", "test", "node-tests.cjs"), `--test=${pick}`]);
  }
  process.exit(0);
}

// Timbre records each log call's source file, so the library's jar path (and with it the builder's home
// directory) lands in the bundle. The repository is public and --check must pass on any machine:
// normalise it, then refuse to ship if a machine path is still in there.
function normalised(built) {
  const text = readFileSync(built, "utf8").replace(/jar:file:[^"'\s]*?\/\.m2\/repository\//g, "jar:file:~/.m2/repository/");
  for (const local of [homedir(), root, ...(scratch ? [scratch] : [])]) {
    if (text.includes(local)) throw new Error(`the bundle still contains a local path (${local})`);
  }
  return text;
}

// shadow's build cache leaks into the release output (its key misses e.g. JVM properties and ns aliases),
// so a cached build and a fresh checkout rename identifiers differently. Always build lib from scratch.
rmSync(join(project, ".shadow-cljs", "builds", "lib"), { recursive: true, force: true });
shadow("release", "lib");
const texts = modules.map(([built, vendored]) => [normalised(built), vendored]);
if (scratch) rmSync(scratch, { recursive: true, force: true });
if (args.has("--check")) {
  let same = true;
  for (const [text, vendored] of texts) {
    const ok = text === readFileSync(vendored, "utf8");
    same &&= ok;
    console.log(ok ? `vendored ${vendored.slice(root.length + 1)} is current (${Buffer.byteLength(text)} bytes)` : `vendored ${vendored.slice(root.length + 1)} differs from a fresh build`);
  }
  process.exit(same ? 0 : 1);
}
for (const [text, vendored] of texts) {
  writeFileSync(vendored, text);
  console.log(`${vendored.slice(root.length + 1)}: ${Buffer.byteLength(text)} bytes`);
}
