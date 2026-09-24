// Run: npx tsx --test server/topic-outline-settings.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi/agent/topic-outline.json is never
// read or written.
//
// Settings → Summaries writes the topic-outline extension's config file, which the TUI and every
// runtime read. What matters: the read agrees with what the extension would run, a bad body never
// touches the file, and a save changes the chain and NOTHING else — not the other keys, and not a
// kept summarizer's own timeout and budget.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-topic-outline-settings-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the module below computes its path
const FILE = join(agentDir, "topic-outline.json");

const { readSummarizerSettings, writeSummarizerSettings, parseSummarizerSettings, topicOutlineFile } = await import(
  "./topic-outline-settings"
);

const DEFAULTS = {
  primary: { backend: "claude-code", model: "haiku" },
  fallback: { backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash" },
};
/** A file shaped like the user's real one, with keys this screen must never touch. */
const FULL = {
  summarizers: [
    { backend: "claude-code", model: "haiku", timeoutMs: 45000, maxBudgetUsd: 0.05 },
    { backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash", timeoutMs: 60000, extra: { keep: true } },
  ],
  trigger: { debounceMs: 3000, minNewMessages: 2 },
  shareWithSessions: "summary",
  shareLastHeading: true,
  claudeBin: "/somewhere/claude",
  limits: { maxTopics: 40, maxBullets: 3 },
  unknownKey: [1, "two", null],
};

const put = (value: unknown) => writeFileSync(FILE, typeof value === "string" ? value : JSON.stringify(value));
const stored = () => JSON.parse(readFileSync(FILE, "utf8"));

beforeEach(() => rmSync(FILE, { force: true }));

test("the file is the agent dir's topic-outline.json", () => {
  assert.equal(topicOutlineFile(), FILE);
});

test("a missing file reads as the extension's defaults", () => {
  const info = readSummarizerSettings();
  assert.deepEqual(info.settings, DEFAULTS);
  assert.deepEqual(info.defaults, DEFAULTS);
  assert.equal(info.usingDefaults, true);
  assert.equal(info.beyond, 0);
  assert.equal(info.unreadable, undefined);
});

test("a file whose chain the extension would skip reads as the defaults, as the extension reads it", () => {
  for (const summarizers of [undefined, [], "haiku", [{ backend: "openai", model: "x" }], [{ backend: "pi", model: "" }], [null, 3]]) {
    put({ summarizers, trigger: { debounceMs: 1 } });
    const info = readSummarizerSettings();
    assert.deepEqual(info.settings, DEFAULTS, JSON.stringify(summarizers));
    assert.equal(info.usingDefaults, true);
  }
});

test("unusable entries are skipped the way sanitizeSummarizers skips them", () => {
  put({ summarizers: [{ backend: "nope", model: "x" }, { backend: "pi", model: "a/b" }, "junk", { backend: "claude-code", model: "sonnet" }] });
  const info = readSummarizerSettings();
  assert.deepEqual(info.settings, { primary: { backend: "pi", model: "a/b" }, fallback: { backend: "claude-code", model: "sonnet" } });
  assert.equal(info.usingDefaults, false);
});

test("a one-entry chain has no fallback; entries past the second are counted", () => {
  put({ summarizers: [{ backend: "pi", model: "a/b" }] });
  assert.deepEqual(readSummarizerSettings().settings, { primary: { backend: "pi", model: "a/b" }, fallback: null });
  put({ summarizers: [{ backend: "pi", model: "a/b" }, { backend: "pi", model: "a/c" }, { backend: "pi", model: "a/d" }, { backend: "pi", model: "a/e" }] });
  assert.equal(readSummarizerSettings().beyond, 2);
});

test("an unreadable file reads as the defaults and says why", () => {
  for (const text of ["{", "[]", "null", '"s"']) {
    put(text);
    const info = readSummarizerSettings();
    assert.deepEqual(info.settings, DEFAULTS);
    assert.ok(info.unreadable, text);
  }
});

test("the body is validated strictly", () => {
  const good = { primary: { backend: "pi", model: "a/b" }, fallback: null };
  assert.deepEqual(parseSummarizerSettings(good), good);
  for (const body of [
    null,
    [],
    "x",
    {},
    { primary: { backend: "pi", model: "a/b" } }, // fallback must be said, even as null
    { ...good, extra: 1 },
    { primary: null, fallback: null },
    { primary: { backend: "openai", model: "a/b" }, fallback: null },
    { primary: { backend: "pi", model: "" }, fallback: null },
    { primary: { backend: "pi", model: 5 }, fallback: null },
    { primary: { backend: "pi", model: "no-slash" }, fallback: null },
    { primary: { backend: "pi", model: "/b" }, fallback: null },
    { primary: { backend: "pi", model: "a/" }, fallback: null },
    { primary: { backend: "pi", model: "a/b c" }, fallback: null },
    { primary: { backend: "pi", model: "a/b\n" }, fallback: null },
    { primary: { backend: "claude-code", model: "a/b" }, fallback: null },
    { primary: { backend: "claude-code", model: "--dangerously-skip-permissions" }, fallback: null },
    { primary: { backend: "pi", model: "a/b", timeoutMs: 5 }, fallback: null }, // not settable here
    { primary: { backend: "pi", model: "a/b" }, fallback: { backend: "pi" } },
    { primary: { backend: "pi", model: "a/b" }, fallback: { backend: "pi", model: "a/b" } }, // same as primary
  ]) {
    assert.ok("error" in parseSummarizerSettings(body), JSON.stringify(body));
  }
});

test("a bad body is refused with 400 and changes nothing on disk", () => {
  put(FULL);
  const before = readFileSync(FILE, "utf8");
  const result = writeSummarizerSettings({ primary: { backend: "pi", model: "x" }, fallback: null });
  assert.ok("error" in result && result.status === 400);
  assert.equal(readFileSync(FILE, "utf8"), before);
});

test("an unreadable file is refused with 409 and left as it was", () => {
  put("{ not json");
  const result = writeSummarizerSettings({ primary: { backend: "pi", model: "a/b" }, fallback: null });
  assert.ok("error" in result && result.status === 409);
  assert.equal(readFileSync(FILE, "utf8"), "{ not json");
});

test("a save changes the chain and nothing else", () => {
  put(FULL);
  const result = writeSummarizerSettings({ primary: { backend: "pi", model: "openai/gpt-x" }, fallback: { backend: "claude-code", model: "haiku" } });
  assert.ok(!("error" in result));
  assert.deepEqual(result.settings, { primary: { backend: "pi", model: "openai/gpt-x" }, fallback: { backend: "claude-code", model: "haiku" } });
  const { summarizers, ...rest } = stored();
  const { summarizers: _old, ...fullRest } = FULL;
  assert.deepEqual(rest, fullRest);
  // The new model is written bare; the kept one keeps its own timeout and budget, in its new slot.
  assert.deepEqual(summarizers, [
    { backend: "pi", model: "openai/gpt-x" },
    { backend: "claude-code", model: "haiku", timeoutMs: 45000, maxBudgetUsd: 0.05 },
  ]);
  // Key order is kept too: the chain stays where it was in the file.
  assert.deepEqual(Object.keys(stored()), Object.keys(FULL));
});

test("a kept entry keeps fields this screen doesn't know", () => {
  put(FULL);
  writeSummarizerSettings({ primary: { backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash" }, fallback: null });
  assert.deepEqual(stored().summarizers, [{ backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash", timeoutMs: 60000, extra: { keep: true } }]);
});

test("saving what is already there leaves the file's values unchanged", () => {
  put(FULL);
  writeSummarizerSettings(DEFAULTS);
  assert.deepEqual(stored(), FULL);
});

test("with no file, keeping a default keeps the default's timeout and budget", () => {
  const result = writeSummarizerSettings({ primary: { backend: "claude-code", model: "haiku" }, fallback: { backend: "pi", model: "a/b" } });
  assert.ok(!("error" in result));
  assert.equal(result.usingDefaults, false);
  assert.deepEqual(stored(), {
    summarizers: [{ backend: "claude-code", model: "haiku", timeoutMs: 45000, maxBudgetUsd: 0.05 }, { backend: "pi", model: "a/b" }],
  });
});

test("entries past the second are dropped by a save, and nothing is left behind in the folder", () => {
  put({ ...FULL, summarizers: [...FULL.summarizers, { backend: "pi", model: "a/c" }] });
  assert.equal(readSummarizerSettings().beyond, 1);
  const result = writeSummarizerSettings(DEFAULTS);
  assert.ok(!("error" in result));
  assert.equal(result.beyond, 0);
  assert.equal(stored().summarizers.length, 2);
  assert.deepEqual(
    readdirSync(agentDir).filter((f) => f.endsWith(".tmp")),
    [],
  );
  assert.ok(existsSync(FILE));
});

test("Reset to Defaults after a change writes the default entries, timeout and budget included", () => {
  put({ ...FULL, summarizers: [{ backend: "pi", model: "a/b", timeoutMs: 9 }] });
  const result = writeSummarizerSettings(DEFAULTS);
  assert.ok(!("error" in result));
  assert.deepEqual(stored().summarizers, [
    { backend: "claude-code", model: "haiku", timeoutMs: 45000, maxBudgetUsd: 0.05 },
    { backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash", timeoutMs: 60000 },
  ]);
  assert.equal(stored().claudeBin, FULL.claudeBin);
});
