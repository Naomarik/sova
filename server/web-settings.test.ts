// Run: npx tsx --test server/web-settings.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// Sova's own settings store (server/web-settings.ts): Settings → Alignment's adversarial review switch
// (`alignment.review`, and its one-time reviewer seeding) and Settings → Experimental's switches, of
// which there are none right now. Review used to be Experimental's `adversarialReview`: a file with only
// that key reads it, and the first write migrates it, once. The Claude Code provider used to be a switch
// and is always on now, so an old file's `claudeCodeProvider` must be ignored — never required, never
// written, never dropped. Damage reads as the defaults rather than throwing, and the write path is
// re-read + merge, like web-sessions.ts, so a key another writer added is not lost.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-web-settings-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the module below computes its path
const FILE = join(agentDir, "sova", "settings.json");

const { readWebSettings, writeWebSettings } = await import("./web-settings");

const put = (text: string) => {
  mkdirSync(join(agentDir, "sova"), { recursive: true });
  writeFileSync(FILE, text);
};
const stored = () => JSON.parse(readFileSync(FILE, "utf8"));
const NOTHING_ON = { experimental: {}, alignment: { review: false } };
const REVIEW_ON = { experimental: {}, alignment: { review: true } };

test("a missing file reads as nothing switched on", () => {
  rmSync(FILE, { force: true });
  assert.deepEqual(readWebSettings(), NOTHING_ON);
});

test("every damaged shape reads as the defaults rather than throwing", () => {
  for (const text of [
    "",
    "{",
    "null",
    "[]",
    '"a string"',
    "{}", // no version
    '{"version":2,"experimental":{}}', // a version we do not know
    '{"version":1}', // nothing in it
    '{"version":1,"experimental":null}',
    '{"version":1,"experimental":[]}',
    '{"version":1,"alignment":null}',
    '{"version":1,"alignment":{"review":"yes"}}',
  ]) {
    put(text);
    assert.deepEqual(readWebSettings(), NOTHING_ON, `for ${text || "(empty)"}`);
  }
});

test("an old file's claudeCodeProvider is ignored on read, whichever way it was set", () => {
  for (const flag of [true, false]) {
    put(`{"version":1,"experimental":{"claudeCodeProvider":${flag}}}`);
    assert.deepEqual(readWebSettings(), NOTHING_ON);
  }
});

test("{} and {experimental: {}} are accepted, and so is a body naming only keys Sova doesn't know", () => {
  rmSync(FILE, { force: true });
  assert.deepEqual(writeWebSettings({}), NOTHING_ON, "experimental is no longer required");
  assert.equal(stored().version, 1);
  assert.deepEqual(writeWebSettings({ experimental: {} }), NOTHING_ON);
  assert.deepEqual(writeWebSettings({ experimental: { claudeCodeProvider: true, fromANewerBuild: "x" }, alignment: { fromANewerBuild: 1 } }), NOTHING_ON);
  assert.deepEqual(stored().experimental, {}, "an unknown key in a request is not written");
  assert.deepEqual(stored().alignment, { review: false });
});

test("a body that isn't an object, or whose parts aren't objects, is refused and changes nothing on disk", () => {
  put('{"version":1,"experimental":{"claudeCodeProvider":true}}');
  const before = readFileSync(FILE, "utf8");
  for (const body of [null, undefined, [], "nope", { experimental: null }, { experimental: [] }, { experimental: "on" }, { alignment: null }, { alignment: true }, { alignment: { review: "yes" } }]) {
    const result = writeWebSettings(body);
    assert.ok("error" in result, `expected a refusal for ${JSON.stringify(body) ?? "undefined"}`);
  }
  assert.deepEqual(writeWebSettings({ alignment: { review: "on" } }), { error: "Expected alignment.review to be a boolean" });
  assert.equal(readFileSync(FILE, "utf8"), before);
});

test("a write re-reads the file, keeping every key it does not know about, the old provider key included", () => {
  put('{"version":1,"somethingElse":{"keep":"me"},"experimental":{"claudeCodeProvider":false,"other":7},"alignment":{"later":1}}');
  writeWebSettings({ experimental: {} });
  const after = stored();
  assert.deepEqual(after.somethingElse, { keep: "me" }, "an unknown top-level key survived");
  assert.equal(after.experimental.other, 7, "an unknown experimental key survived");
  assert.equal(after.experimental.claudeCodeProvider, false, "the old key is left as it was, never rewritten");
  assert.equal(after.alignment.later, 1, "an unknown alignment key survived");
});

test("a corrupt file is replaced rather than blocking the write", () => {
  put("{ this is not json");
  assert.deepEqual(writeWebSettings({ experimental: {} }), NOTHING_ON);
  assert.deepEqual(stored(), { version: 1, experimental: {}, alignment: { review: false } });
});

// ── The migration: Experimental's adversarialReview becomes alignment.review, once ──────────────

test("a file with only experimental.adversarialReview reads it as the review switch", () => {
  put('{"version":1,"experimental":{"adversarialReview":true}}');
  assert.deepEqual(readWebSettings(), REVIEW_ON);
  put('{"version":1,"experimental":{"adversarialReview":false}}');
  assert.deepEqual(readWebSettings(), NOTHING_ON);
});

test("the first write stores it as alignment.review, and from then on the old key is never read", () => {
  put('{"version":1,"experimental":{"adversarialReview":true},"seeded":{"adversarialReview":true}}');
  assert.deepEqual(writeWebSettings({}), REVIEW_ON, "a write that names no review keeps the migrated value");
  assert.deepEqual(stored().alignment, { review: true });
  assert.equal(stored().experimental.adversarialReview, true, "the old key is left as it was");
  writeWebSettings({ alignment: { review: false } });
  assert.deepEqual(readWebSettings(), NOTHING_ON, "alignment.review wins over the old key");
  assert.equal(stored().experimental.adversarialReview, true);
  // An unknown experimental key in a request: an old browser's Experimental switch moves nothing.
  writeWebSettings({ experimental: { adversarialReview: true } });
  assert.deepEqual(readWebSettings(), NOTHING_ON);
});

// ── Adversarial review (§chat.alignment-review/flag, /route) ─────────────────────────────────
const { readSubagentProfiles, writeSubagentProfiles, DEFAULT_REVIEWER } = await import("../pi-config/extensions/subagents/subagent-profiles.ts");
const { delegateDefaults } = await import("../pi-config/extensions/mode/delegate.ts");
const profile = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, delegate: delegateDefaults().profiles, teams: null, members: null, specWriter: null, ...extra });
const library = () => {
  const s = readSubagentProfiles(agentDir);
  assert.equal(s.state, "ok");
  return s.state === "ok" ? s.value.profiles : [];
};
const libraryFile = join(agentDir, "subagent-profiles.json");

test("alignment.review: a boolean switch, off by default; a non-boolean is refused", () => {
  rmSync(FILE, { force: true });
  assert.deepEqual(readWebSettings(), NOTHING_ON);
  assert.deepEqual(writeWebSettings({ alignment: { review: "yes" } }), { error: "Expected alignment.review to be a boolean" });
});

test("saving it off writes nothing to the profiles", () => {
  rmSync(FILE, { force: true });
  writeSubagentProfiles(agentDir, { version: 1, profiles: [profile("a")] });
  const before = readFileSync(libraryFile, "utf8");
  assert.deepEqual(writeWebSettings({ alignment: { review: false } }), NOTHING_ON);
  writeWebSettings({});
  assert.equal(readFileSync(libraryFile, "utf8"), before);
  assert.equal(stored().seeded, undefined);
});

test("the first save that turns it on seeds keyless profiles once; None and own routes stay; off and on again seeds nothing", () => {
  rmSync(FILE, { force: true });
  const own = { primary: { backend: "claude-code", model: "claude-sonnet-5-5", effort: "high" }, fallback: null };
  writeSubagentProfiles(agentDir, { version: 1, profiles: [profile("bare"), profile("none", { reviewer: null }), profile("own", { reviewer: own })] });
  assert.deepEqual(writeWebSettings({ alignment: { review: true } }), REVIEW_ON);
  const [bare, none, mine] = library();
  assert.deepEqual(bare!.reviewer, DEFAULT_REVIEWER);
  assert.equal(none!.reviewer, null);
  assert.deepEqual(mine!.reviewer, own);
  assert.deepEqual(stored().seeded, { adversarialReview: true });
  // A profile added later without a reviewer, then off and on again: the seeding already ran.
  writeSubagentProfiles(agentDir, { version: 1, profiles: [...library(), profile("later")] });
  const before = readFileSync(libraryFile, "utf8");
  writeWebSettings({ alignment: { review: false } });
  writeWebSettings({ alignment: { review: true } });
  assert.equal(readFileSync(libraryFile, "utf8"), before, "idempotent: nothing written the second time");
  assert.equal("reviewer" in library().find((p) => p.id === "later")!, false);
});

test("a host that seeded under Experimental's switch is not seeded again by Alignment's", () => {
  put('{"version":1,"experimental":{"adversarialReview":false},"seeded":{"adversarialReview":true}}');
  writeSubagentProfiles(agentDir, { version: 1, profiles: [profile("keyless")] });
  const before = readFileSync(libraryFile, "utf8");
  writeWebSettings({ alignment: { review: true } });
  assert.equal(readFileSync(libraryFile, "utf8"), before, "the seeded mark moved with the switch");
});

test("a malformed library is never overwritten, and the seeding waits for a later save", () => {
  rmSync(FILE, { force: true });
  writeFileSync(libraryFile, "{ broken");
  writeWebSettings({ alignment: { review: true } });
  assert.equal(readFileSync(libraryFile, "utf8"), "{ broken");
  assert.equal(stored().seeded, undefined, "unmarked: retried later");
  assert.equal(stored().alignment.review, true, "the switch itself saved");
  writeSubagentProfiles(agentDir, { version: 1, profiles: [profile("fixed")] });
  writeWebSettings({ alignment: { review: true } });
  assert.deepEqual(library()[0]!.reviewer, DEFAULT_REVIEWER);
  assert.deepEqual(stored().seeded, { adversarialReview: true });
});
