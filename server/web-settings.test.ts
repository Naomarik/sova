// Run: npx tsx --test server/web-settings.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// pi-web's own settings store (server/web-settings.ts): the experimental Claude Code provider
// switch. What matters here is that it defaults OFF under every kind of damage — a missing file,
// junk, a foreign version, a non-boolean — because a settings file that fails open would turn on
// an experimental provider nobody asked for. The write path is re-read + merge, like
// web-sessions.ts, so a key another writer added is not lost.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-web-settings-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the module below computes its path
const FILE = join(agentDir, "pi-web", "settings.json");

const { readWebSettings, writeWebSettings, claudeCodeProviderEnabled } = await import("./web-settings");

const put = (text: string) => {
  mkdirSync(join(agentDir, "pi-web"), { recursive: true });
  writeFileSync(FILE, text);
};
const stored = () => JSON.parse(readFileSync(FILE, "utf8"));

test("a missing file reads as off", () => {
  assert.deepEqual(readWebSettings(), { experimental: { claudeCodeProvider: false } });
  assert.equal(claudeCodeProviderEnabled(), false);
});

test("every damaged shape reads as off rather than throwing", () => {
  for (const text of [
    "",
    "{",
    "null",
    "[]",
    '"a string"',
    "{}", // no version
    '{"version":2,"experimental":{"claudeCodeProvider":true}}', // a version we do not know
    '{"version":1}', // no experimental
    '{"version":1,"experimental":null}',
    '{"version":1,"experimental":[]}',
    '{"version":1,"experimental":{}}',
    '{"version":1,"experimental":{"claudeCodeProvider":"true"}}', // the string, not the boolean
    '{"version":1,"experimental":{"claudeCodeProvider":1}}',
  ]) {
    put(text);
    assert.deepEqual(readWebSettings(), { experimental: { claudeCodeProvider: false } }, `for ${text || "(empty)"}`);
  }
});

test("a well-formed file round-trips", () => {
  put('{"version":1,"experimental":{"claudeCodeProvider":true}}');
  assert.equal(claudeCodeProviderEnabled(), true);
  put('{"version":1,"experimental":{"claudeCodeProvider":false}}');
  assert.equal(claudeCodeProviderEnabled(), false);
});

test("writing on, then off, is visible to the next read", () => {
  assert.deepEqual(writeWebSettings({ experimental: { claudeCodeProvider: true } }), {
    experimental: { claudeCodeProvider: true },
  });
  assert.equal(claudeCodeProviderEnabled(), true);
  assert.equal(stored().version, 1);

  assert.deepEqual(writeWebSettings({ experimental: { claudeCodeProvider: false } }), {
    experimental: { claudeCodeProvider: false },
  });
  assert.equal(claudeCodeProviderEnabled(), false);
});

test("a bad body is refused and changes nothing on disk", () => {
  writeWebSettings({ experimental: { claudeCodeProvider: true } });
  const before = readFileSync(FILE, "utf8");
  for (const body of [
    null,
    undefined,
    [],
    "nope",
    {},
    { experimental: null },
    { experimental: [] },
    { experimental: {} },
    { experimental: { claudeCodeProvider: "true" } },
    { experimental: { claudeCodeProvider: 1 } },
    { claudeCodeProvider: true }, // right leaf, wrong place
  ]) {
    const result = writeWebSettings(body);
    assert.ok("error" in result, `expected a refusal for ${JSON.stringify(body) ?? "undefined"}`);
  }
  assert.equal(readFileSync(FILE, "utf8"), before);
  assert.equal(claudeCodeProviderEnabled(), true);
});

test("a write re-reads the file, keeping keys it does not know about", () => {
  put('{"version":1,"somethingElse":{"keep":"me"},"experimental":{"claudeCodeProvider":false,"other":7}}');
  writeWebSettings({ experimental: { claudeCodeProvider: true } });
  const after = stored();
  assert.deepEqual(after.somethingElse, { keep: "me" }, "an unknown top-level key survived");
  assert.equal(after.experimental.other, 7, "an unknown experimental key survived");
  assert.equal(after.experimental.claudeCodeProvider, true);
});

test("a corrupt file is replaced rather than blocking the write", () => {
  put("{ this is not json");
  assert.deepEqual(writeWebSettings({ experimental: { claudeCodeProvider: true } }), {
    experimental: { claudeCodeProvider: true },
  });
  assert.equal(claudeCodeProviderEnabled(), true);
});
