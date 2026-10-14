// Run: pnpm test:int -- server/harness/pi/extension-deps.integration.test.ts. A real code copy of this checkout
// (the one a chat process runs, §app.chat-processes/code-generations): the packages its extensions import
// resolve to pi's own copies, and pi's loader, in a Bun process of its own with an empty translation cache,
// loads every one of Sova's extensions from it as a plain module, translating none
// (§app.chat-processes/extension-loading, quirk P26).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { currentGeneration } from "../../chat-runtime/generations";
import { scratchRoot } from "../../test-scratch";
import { EXTENSION_DEPS, extensionDepDrift } from "./own-code";

const REPO = resolve(import.meta.dirname, "../../..");
const t = scratchRoot("ext-deps-int-");
after(() => rmSync(t, { recursive: true, force: true }));

/** Every file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])) : [];

test("a fresh code copy: its extensions get pi's own packages, and pi loads every one with no translation", async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, SOVA_CHAT_CODE_ROOT: join(t, "code") };
  delete env.SOVA_BUILD;
  delete env.SOVA_CHAT_CODE;
  const gen = await currentGeneration({ repo: REPO, root: join(t, "code"), env, log: () => {} });
  assert.equal(gen.live, false, `a copy was made (${(gen as { why?: string }).why ?? ""})`);
  const extensions = join(gen.dir, "pi-config", "extensions");
  assert.deepEqual(extensionDepDrift(extensions, join(gen.dir, "server", "harness", "pi")), [], "every package from pi's own copy");

  // The extension entries pi discovers in the copy: <dir>/index.ts and top-level .ts files.
  const entries = readdirSync(extensions)
    .sort()
    .flatMap((n) => {
      const p = join(extensions, n);
      if (statSync(p).isDirectory()) return existsSync(join(p, "index.ts")) ? [p] : [];
      return n.endsWith(".ts") && !n.endsWith(".test.ts") ? [p] : [];
    });
  assert.ok(entries.length >= 20, `Sova's extensions found (${entries.length})`);

  const piEntry = join(realpathSync(join(gen.dir, "node_modules", EXTENSION_DEPS[0])), "dist", "index.js");
  assert.ok(piEntry.startsWith(join(t, "code")), "pi from the copy's own node_modules");
  const probe = join(t, "probe.mjs");
  writeFileSync(
    probe,
    `const [piEntry, cwd, agentDir, ...paths] = process.argv.slice(2);
const pi = await import(piEntry);
const r = await pi.discoverAndLoadExtensions(paths, cwd, agentDir);
console.log("RESULT " + JSON.stringify({ loaded: r.extensions.map((e) => e.resolvedPath ?? e.path), errors: r.errors.map((e) => ({ path: e.path, error: String(e.error) })) }));
process.exit(0);
`,
  );
  const agentDir = join(t, "agent");
  const cwd = join(t, "cwd");
  const tmp = join(t, "tmp");
  for (const d of [agentDir, cwd, tmp]) mkdirSync(d, { recursive: true });
  const closed = "http://127.0.0.1:9";
  const { stdout } = await promisify(execFile)(process.execPath, [probe, piEntry, cwd, agentDir, ...entries], {
    cwd,
    env: { ...env, JITI_DEBUG: "1", TMPDIR: tmp, PI_CODING_AGENT_DIR: agentDir, HTTPS_PROXY: closed, HTTP_PROXY: closed, https_proxy: closed, http_proxy: closed },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, `the probe answered:\n${stdout.slice(-2000)}`);
  const r = JSON.parse(line.slice(7)) as { loaded: string[]; errors: { path: string; error: string }[] };
  assert.deepEqual(r.errors, [], "no extension failed to load");
  assert.equal(r.loaded.length, entries.length, "every extension loaded");
  // The instrument: jiti's debug log names each native attempt, so a quiet log is not a log that is off.
  const tried = stdout.split("\n").filter((l) => l.includes("[try-native]")).length;
  assert.ok(tried >= entries.length, `jiti logged its native attempts (${tried})`);
  const fallbacks = stdout.split("\n").filter((l) => /Using fallback|\[transpile\]/.test(l));
  assert.deepEqual(fallbacks, [], "no extension went through pi's translating fallback");
  assert.deepEqual(filesUnder(tmp).filter((f) => f.includes("jiti")), [], "and nothing was translated into jiti's cache");
});
