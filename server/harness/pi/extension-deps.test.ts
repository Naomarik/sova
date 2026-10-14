// Run: pnpm test -- server/harness/pi/extension-deps.test.ts. The packages Sova's extensions import by name
// resolve to the very copies pi runs (§app.chat-processes/extension-loading, quirk P26), and Sova's
// package.json names each at pi's own version, so a pi upgrade that leaves one behind fails here. The same
// check on a real code copy, and pi loading every extension from it with no translation, is the
// .integration.test.ts sibling.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, test } from "node:test";
import { EXTENSION_DEPS, extensionDepDrift, packageFrom } from "./own-code";

const REPO = resolve(import.meta.dirname, "../../..");
const EXTENSIONS = join(REPO, "pi-config", "extensions");

/** Every source file of the extensions under `dir` a chat may load: tests and node_modules aside. */
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" || e.name === "tests" ? [] : sources(join(dir, e.name))) : /\.(?:[cm]?[jt]s|tsx)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name) ? [join(dir, e.name)] : [],
  );
/** The @earendil-works packages each file loads at runtime (static, re-export, import(), require), as Bun's
    scanner reads it: comments and type-only imports never count. */
function piImports(files: string[]): { file: string; pkg: string }[] {
  const scanners = new Map<string, { scan(code: string): { imports: { path: string }[] } }>();
  const scanner = (loader: string) => scanners.get(loader) ?? scanners.set(loader, new (globalThis as any).Bun.Transpiler({ loader })).get(loader)!;
  return files.flatMap((file) =>
    scanner(/\.tsx$/.test(file) ? "tsx" : /\.[cm]?ts$/.test(file) ? "ts" : "js")
      .scan(readFileSync(file, "utf8"))
      .imports.map((i) => /^@earendil-works\/[^/]+/.exec(i.path)?.[0])
      .filter((pkg): pkg is string => !!pkg)
      .map((pkg) => ({ file, pkg })),
  );
}

test("the checkout's extensions get pi's own copy of every package they import", () => {
  assert.deepEqual(extensionDepDrift(EXTENSIONS), []);
});

test("Sova's package.json names each package at the version of the copy pi runs", () => {
  const deps = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).dependencies as Record<string, string>;
  const piDir = packageFrom(join(REPO, "server"), EXTENSION_DEPS[0])!;
  for (const name of EXTENSION_DEPS.slice(1)) {
    const version = JSON.parse(readFileSync(join(packageFrom(piDir, name)!, "package.json"), "utf8")).version as string;
    assert.equal(deps[name], version, `package.json: "${name}": "${version}", the copy pi ${deps[EXTENSION_DEPS[0]]} runs`);
  }
});

test("another copy, another version or none at all is drift; pi's own copy is not", () => {
  const t = realpathSync(mkdtempSync(join(tmpdir(), "ext-deps-")));
  after(() => rmSync(t, { recursive: true, force: true }));
  const pkg = (dir: string, name: string, version: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
  };
  // A pnpm layout: pi and its dependencies side by side in .pnpm, the root linking only what it names.
  const store = (name: string, version: string) => join(t, "node_modules", ".pnpm", `${name.replace("/", "+")}@${version}`, "node_modules", name);
  const piDir = store(EXTENSION_DEPS[0], "1.0.3");
  pkg(piDir, EXTENSION_DEPS[0], "1.0.3");
  for (const name of EXTENSION_DEPS.slice(1)) pkg(join(piDir, "..", "..", name), name, "1.0.3");
  const link = (name: string, target: string) => {
    mkdirSync(join(t, "node_modules", name, ".."), { recursive: true });
    symlinkSync(target, join(t, "node_modules", name));
  };
  link(EXTENSION_DEPS[0], piDir);
  const code = join(t, "server", "harness", "pi");
  const ext = join(t, "pi-config", "extensions");
  mkdirSync(code, { recursive: true });
  mkdirSync(ext, { recursive: true });
  const names = (d: { name: string }[]) => d.map((x) => x.name);

  assert.deepEqual(names(extensionDepDrift(ext, code)), EXTENSION_DEPS.slice(1), "the root names only pi: the rest resolve nowhere");
  assert.equal(extensionDepDrift(ext, code)[0]!.extensions, null);

  // pi-ai at an older version beside pi's (the 0.87.1 a second install leaves), the others pi's own.
  const old = store(EXTENSION_DEPS[1], "0.87.1");
  pkg(old, EXTENSION_DEPS[1], "0.87.1");
  link(EXTENSION_DEPS[1], old);
  for (const name of EXTENSION_DEPS.slice(2)) link(name, realpathSync(join(piDir, "..", "..", name)));
  const drift = extensionDepDrift(ext, code);
  assert.deepEqual(names(drift), [EXTENSION_DEPS[1]], "the older copy is drift");
  assert.equal(drift[0]!.extensions, realpathSync(old));
  assert.equal(drift[0]!.pi, realpathSync(join(piDir, "..", "..", EXTENSION_DEPS[1])));

  rmSync(join(t, "node_modules", EXTENSION_DEPS[1]));
  link(EXTENSION_DEPS[1], realpathSync(join(piDir, "..", "..", EXTENSION_DEPS[1])));
  assert.deepEqual(extensionDepDrift(ext, code), [], "every one pi's own copy");
});

test("no extension loads an @earendil-works package outside EXTENSION_DEPS (npm and git packages bring their own pi copies and are outside this check)", () => {
  const found = piImports(sources(EXTENSIONS));
  assert.ok(found.some((f) => f.pkg === "@earendil-works/pi-ai") && found.some((f) => f.pkg === "@earendil-works/pi-tui"), "the scan sees the extensions' pi imports");
  const known = new Set<string>(EXTENSION_DEPS);
  assert.deepEqual(
    found.filter((f) => !known.has(f.pkg)).map((f) => `${relative(REPO, f.file)}: ${f.pkg}`),
    [],
    "an extension loads a pi package Sova's package.json doesn't name, so pi translates it in every chat: add it to EXTENSION_DEPS and package.json at pi's own version (the user's call), or import it through one that is",
  );
});

test("the import scan counts what loads, never a comment", () => {
  const t = realpathSync(mkdtempSync(join(tmpdir(), "ext-imports-")));
  after(() => rmSync(t, { recursive: true, force: true }));
  mkdirSync(join(t, "x", "tests"), { recursive: true });
  writeFileSync(
    join(t, "x", "index.ts"),
    `// import { Agent } from "@earendil-works/pi-agent-core";\n/* require("@earendil-works/pi-telemetry") */\nimport type { Model } from "@earendil-works/pi-codemode";\nimport { Agent } from "@earendil-works/pi-agent-core";\nexport { x } from "@earendil-works/chord";\nconst m = () => import("@earendil-works/pi-mcp");\nimport { complete } from "@earendil-works/pi-ai/compat";\nexport default () => [Agent, m, complete];\n`,
  );
  writeFileSync(join(t, "x", "tests", "a.ts"), `import "@earendil-works/pi-telemetry";\n`);
  writeFileSync(join(t, "x", "x.test.ts"), `import "@earendil-works/pi-telemetry";\n`);
  assert.deepEqual(
    piImports(sources(t)).map((f) => f.pkg).sort(),
    ["@earendil-works/chord", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-mcp"],
  );
  // The live tree mentions pi-agent-core only in comments: the scan above passing is the scan ignoring them.
  assert.ok(sources(EXTENSIONS).some((f) => readFileSync(f, "utf8").includes("pi-agent-core")), "the control: a comment names pi-agent-core");
});
