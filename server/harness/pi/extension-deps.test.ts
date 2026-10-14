// Run: pnpm test -- server/harness/pi/extension-deps.test.ts. The packages Sova's extensions import by name
// resolve to the very copies pi runs (§app.chat-processes/extension-loading, quirk P26), and Sova's
// package.json names each at pi's own version, so a pi upgrade that leaves one behind fails here. The same
// check on a real code copy, and pi loading every extension from it with no translation, is the
// .integration.test.ts sibling.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { EXTENSION_DEPS, extensionDepDrift, packageFrom } from "./own-code";

const REPO = resolve(import.meta.dirname, "../../..");
const EXTENSIONS = join(REPO, "pi-config", "extensions");

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
