// A Transport never carries a download cache or build output: each device fetches dependencies through the project's
// own build tools from their registries. In a worktree, a project-local cache (a Maven repository, a gitlibs folder,
// a virtualenv, a pnpm store) and every build-output folder stay here, listed as staying, never offered as a file; and
// the card's Bring From never brings a file out of a device-wide cache (~/.m2/repository, ~/.gitlibs, the cargo
// registry, go's module cache, bun's cache…), a link to one included, while a tool's own config beside it still may.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { surveyWorktree } from "./git-snapshot";
import { cleanOutsidePath, readOutside } from "./outside-file";

const root = scratchRoot("sova-transport-caches-");
after(() => {
  rmSync(root, { recursive: true, force: true });
  dropScratchAgentDir();
});
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
const put = (p: string, text = "x\n") => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

/** The project-local caches and build output that stay here, each holding a file. */
const STAYING = [".m2", ".gitlibs", ".venv", ".pnpm-store", "target", "node_modules", ".cpcache", "dist", "build", ".gradle"];

for (const [rule, ignore] of [
  ["each ignored by name", `${STAYING.join("\n")}\n.env\n`],
  ["none ignored", ".env\n"],
] as const) {
  test(`a worktree's download caches and build output stay here, never carried (${rule})`, async () => {
    const dir = join(root, rule.replace(/ /g, "-"));
    mkdirSync(dir);
    g(dir, "init", "-q", "-b", "master");
    writeFileSync(join(dir, ".gitignore"), ignore);
    put(join(dir, "src", "core.clj"), "(ns core)\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-qm", "one");
    for (const d of STAYING) put(join(dir, d, "inside", "file.bin"));
    put(join(dir, ".env"), "K=1\n");
    const s = await surveyWorktree("w", dir);
    assert.equal(s.refusal, null);
    const carried = [...s.loose.map((f) => f.path), ...s.scratch.map((d) => d.dir)];
    for (const d of STAYING) {
      assert.deepEqual(carried.filter((p) => p === d || p.startsWith(`${d}/`)), [], `nothing of ${d} is carried`);
      assert.ok(s.left.includes(d), `${d} is listed as staying here`);
    }
    assert.ok(s.loose.some((f) => f.path === ".env"), "a private file still travels");
  });
}

test("a source folder that only has a build folder's name (git tracks files in it) keeps sending its new files; a dependency folder inside it still stays", async () => {
  const dir = join(root, "source-named-build");
  mkdirSync(dir);
  g(dir, "init", "-q", "-b", "master");
  put(join(dir, "src", "build", "a.ts"), "export const a = 1;\n");
  put(join(dir, "scripts", "out", "run.mjs"), "run()\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "one");
  put(join(dir, "src", "build", "b.ts"), "export const b = 2;\n");
  put(join(dir, "scripts", "out", "new.mjs"), "next()\n");
  put(join(dir, "src", "build", "node_modules", "x", "i.js"), "dep\n");
  const s = await surveyWorktree("w", dir);
  const loose = s.loose.map((f) => f.path).sort();
  assert.deepEqual(loose, ["scripts/out/new.mjs", "src/build/b.ts"], "the user's new source files travel");
  assert.deepEqual(s.left, ["src/build/node_modules"], "the dependency folder inside it stays");
});

test("Bring From never brings a file out of a device-wide download cache, a link to one included; a tool's own config beside it may", () => {
  const home = join(root, "home");
  const cached = [
    ".m2/repository/org/x/x-1.0.jar", ".gitlibs/libs/io.github.x/y/abc123/deps.edn", ".cargo/registry/src/index/serde-1.0.0/build.rs",
    ".cargo/git/checkouts/x/abc/lib.rs", "go/pkg/mod/github.com/x/y@v1.0.0/y.go", ".bun/install/cache/react@18.0.0/index.js",
    ".npm/_cacache/index-v5/x", ".gradle/caches/modules-2/x.jar",
  ];
  for (const rel of cached) {
    put(join(home, rel));
    const asked = cleanOutsidePath(`~/${rel}`);
    assert.ok("error" in asked && /download cache/.test(asked.error), `~/${rel} is refused when asked: ${JSON.stringify(asked)}`);
    const read = readOutside(rel, home, [], []);
    assert.ok(!read.ok && /download cache/.test(read.error), `~/${rel} is never read`);
  }
  // A link elsewhere in the home to a cached file is that file.
  symlinkSync(join(home, ".m2/repository/org/x/x-1.0.jar"), join(home, "x.jar"));
  const linked = readOutside("x.jar", home, [], []);
  assert.ok(!linked.ok && /download cache/.test(linked.error));
  // A cache folder that is itself a link, moved to another disk in the home: refused by the path asked.
  const moved = join(root, "home2");
  put(join(moved, "bigdisk", "m2", "repository", "org", "y", "y-1.0.jar"));
  symlinkSync(join(moved, "bigdisk", "m2"), join(moved, ".m2"));
  const viaLink = readOutside(".m2/repository/org/y/y-1.0.jar", moved, [], []);
  assert.ok(!viaLink.ok && /download cache \(~\/\.m2\/repository\)/.test(viaLink.error), JSON.stringify(viaLink));
  // macOS's spellings.
  for (const rel of ["Library/Caches/pip/http/x", "Library/pnpm/store/v3/files/x"]) assert.ok("error" in cleanOutsidePath(`~/${rel}`), rel);
  // The tools' own config files travel as any file does.
  for (const rel of [".m2/settings.xml", ".cargo/config.toml", ".gradle/gradle.properties", ".clojure/deps.edn"]) {
    put(join(home, rel));
    assert.deepEqual(cleanOutsidePath(`~/${rel}`), { rel });
    assert.equal(readOutside(rel, home, [], []).ok, true, rel);
  }
});
