// Run: npx tsx --test server/session-titles-settings.test.ts
// Settings → Summaries → Session titles' file: defaults, the strict PUT shape, the tolerant read,
// and the atomic write. A throwaway PI_CODING_AGENT_DIR; no model is called.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-title-settings-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));
mkdirSync(join(agentDir, "sova"), { recursive: true });

const s = await import("./session-titles-settings");
const file = join(agentDir, "sova", "session-titles-settings.json");

test("defaults: off, 5 and 5 minutes, pi deepseek-v4.1-flash then Claude Code sonnet at low — never haiku", () => {
  const d = s.sessionTitleDefaults();
  assert.deepEqual(d, {
    version: 1,
    enabled: false,
    intervalMinutes: 5,
    quietMinutes: 5,
    primary: { backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash", effort: "off" },
    fallback: { backend: "claude-code", model: "sonnet", effort: "low" },
  });
  assert.ok(!JSON.stringify(d).includes("haiku"));
  assert.equal(s.sessionTitleSettingsFile(), file);
  assert.deepEqual(s.readSessionTitleSettings(), d); // no file yet
});

test("the PUT is strict: every field, in range, a valid tuple, and a fallback that isn't the primary", () => {
  const good = { ...s.sessionTitleDefaults(), enabled: true };
  assert.deepEqual(s.parseSessionTitleSettings(good), good);
  assert.deepEqual(s.parseSessionTitleSettings({ ...good, fallback: null }), { ...good, fallback: null });
  const bad: [unknown, RegExp][] = [
    [null, /Expected/],
    [{ ...good, extra: 1 }, /Unknown field "extra"/],
    [{ ...good, version: 2 }, /version/],
    [{ ...good, enabled: "yes" }, /enabled/],
    [{ ...good, intervalMinutes: 0 }, /intervalMinutes/],
    [{ ...good, intervalMinutes: 2.5 }, /intervalMinutes/],
    [{ ...good, quietMinutes: 1441 }, /quietMinutes/],
    [{ ...good, quietMinutes: -1 }, /quietMinutes/],
    [{ ...good, primary: { backend: "pi", model: "no-slash", effort: "off" } }, /primary/],
    [{ ...good, primary: { backend: "claude-code", model: "sonnet", effort: "off" } }, /primary: effort/],
    [(({ fallback: _, ...rest }) => rest)(good), /fallback is required/],
    [{ ...good, fallback: good.primary }, /same as the primary/],
  ];
  for (const [body, why] of bad) {
    const r = s.parseSessionTitleSettings(body);
    assert.ok("error" in r, JSON.stringify(body));
    assert.match(r.error, why);
  }
  assert.equal("error" in s.parseSessionTitleSettings({ ...good, quietMinutes: 0 }), false);
});

test("the read is tolerant: a field that doesn't parse is its default, a broken file is the defaults", () => {
  const d = s.sessionTitleDefaults();
  writeFileSync(file, "{nope");
  assert.deepEqual(s.readSessionTitleSettings(), d);
  writeFileSync(file, JSON.stringify({ version: 1, enabled: true, intervalMinutes: 99999, quietMinutes: 2, primary: { backend: "x" }, fallback: null }));
  assert.deepEqual(s.readSessionTitleSettings(), { ...d, enabled: true, quietMinutes: 2, fallback: null });
  writeFileSync(file, JSON.stringify({ version: 1, primary: d.fallback, fallback: d.fallback }));
  assert.equal(s.readSessionTitleSettings().fallback, null); // a fallback equal to the primary is none
});

test("the write is whole and atomic, and the next read sees it", () => {
  const next = { ...s.sessionTitleDefaults(), enabled: true, intervalMinutes: 15, fallback: null };
  s.writeSessionTitleSettings(next);
  assert.deepEqual(s.readSessionTitleSettings(), next);
  assert.ok(existsSync(file));
  assert.deepEqual(readdirSync(join(agentDir, "sova")).filter((f) => f.endsWith(".tmp")), []);
});

test("the info says why each configured model can't run, and nothing when both can", async () => {
  s.writeSessionTitleSettings(s.sessionTitleDefaults());
  const both = await s.sessionTitleSettingsInfo(async (c) => (c.backend === "pi" ? "no key for ollama-cloud" : "the Claude Code CLI isn't installed or doesn't answer"));
  assert.deepEqual(both.unusable, { primary: "no key for ollama-cloud", fallback: "the Claude Code CLI isn't installed or doesn't answer" });
  const fine = await s.sessionTitleSettingsInfo(async () => null);
  assert.equal(fine.unusable, undefined);
  assert.deepEqual(fine.backends.map((b) => b.id), ["pi", "claude-code"]);
  assert.ok(fine.backends.find((b) => b.id === "pi")!.efforts.includes("off"));
});
