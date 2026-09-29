#!/usr/bin/env node
// Rebuild the vendored organization statecharts bundle: org-charts/ (CLJS) → server/vendor/org-charts.js.
//
//   node scripts/build-org-charts.mjs          release build, copied into server/vendor/
//   node scripts/build-org-charts.mjs --test   compile and run the CLJS tests under Node (engine + charts)
//   node scripts/build-org-charts.mjs --check  release build into org-charts/out only; exit 1 if it differs
//                                              from the vendored file
//   --dirty                                    allow uncommitted changes under org-charts/src (refused
//                                              by default: the vendored bundle must match committed code)
//
// Needs a JVM and the Clojure CLI (deps from ~/.m2 or Maven). `pnpm build` never runs this: Sova's own
// build and tests use the committed bundle. `-Srepro` keeps a user-level `:build`/`:shadow` alias out.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const project = join(root, "org-charts");
// [built, vendored] per build: the shipped bundle.
const modules = [[join(project, "out", "lib", "org-charts.js"), join(root, "server", "vendor", "org-charts.js")]];
const args = new Set(process.argv.slice(2));

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

if (args.has("--test")) {
  shadow("compile", "test");
  run("node", [join(project, "out", "test", "node-tests.cjs")]);
  process.exit(0);
}

// Timbre records each log call's source file, so the library's jar path (and with it the builder's home
// directory) lands in the bundle. The repository is public and --check must pass on any machine:
// normalise it, then refuse to ship if a machine path is still in there.
function normalised(built) {
  const text = readFileSync(built, "utf8").replace(/jar:file:[^"'\s]*?\/\.m2\/repository\//g, "jar:file:~/.m2/repository/");
  for (const local of [homedir(), root]) {
    if (text.includes(local)) throw new Error(`the bundle still contains a local path (${local})`);
  }
  return text;
}

// Several people edit org-charts/src at once, some of them mutation-testing: a bundle built from a dirty
// tree can ship a stray edit. Vendor only what is committed.
if (!args.has("--dirty") && !args.has("--check")) {
  const r = spawnSync("git", ["status", "--porcelain", "--", "org-charts/src", "org-charts/shadow-cljs.edn", "org-charts/deps.edn"],
    { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
  if (r.stdout.trim()) {
    console.error(`Uncommitted changes under org-charts/ (commit them, or pass --dirty):\n${r.stdout}`);
    process.exit(1);
  }
}

// shadow's build cache leaks into the release output (its key misses e.g. JVM properties and ns aliases),
// so a cached build and a fresh checkout rename identifiers differently. Always build lib from scratch.
rmSync(join(project, ".shadow-cljs", "builds", "lib"), { recursive: true, force: true });
shadow("release", "lib");
const texts = modules.map(([built, vendored]) => [normalised(built), vendored]);
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
