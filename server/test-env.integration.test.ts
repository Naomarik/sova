// The runner started from inside a chat: the test it runs sees none of that chat process's variables.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";
import { scratchRoot } from "./test-scratch";

test("a test run from a chat's shell doesn't see the chat's own variables", () => {
  const dir = scratchRoot("test-env-");
  const probe = join(dir, "probe.test.ts");
  const seen = join(dir, "seen.json");
  const planted = join(dir, "real-homes");
  writeFileSync(probe, `import { test } from "node:test";\nimport { writeFileSync } from "node:fs";\ntest("probe", () => { writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ keys: Object.keys(process.env).filter((k) => /^SOVA_CHAT_|^PI_SESSION|^SOVA_CALLER_KEY$/.test(k)), homes: process.env.SOVA_CHAT_HOMES, root: process.env.SOVA_TEST_HOME })); });\n`);
  const root = join(import.meta.dirname, "..");
  const r = spawnSync(process.execPath, [join(root, "scripts/run-tests.mjs"), probe], {
    cwd: root,
    encoding: "utf8",
    // A chat's own homes folder planted too: the run must replace it with one in its own scratch root.
    env: { ...process.env, SOVA_CHAT_UNIT: "sova-chat-planted.service", SOVA_CHAT_ID: "planted", PI_SESSION_ID: "planted", SOVA_CALLER_KEY: "planted", SOVA_CHAT_HOMES: planted },
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const got: { keys: string[]; homes?: string; root?: string } = JSON.parse(readFileSync(seen, "utf8"));
  // Only the runner's own: its test slice, its code pin and its chat homes.
  assert.deepEqual(got.keys.filter((k) => k !== "SOVA_CHAT_SLICE" && k !== "SOVA_CHAT_CODE" && k !== "SOVA_CHAT_HOMES"), []);
  // The chat homes are the run's own throwaway folder, inside its scratch root, never the chat's (or real) one.
  assert.ok(got.root && got.homes, `homes ${got.homes} root ${got.root}`);
  assert.notEqual(got.homes, planted);
  assert.ok(got.homes.startsWith(got.root + sep), `SOVA_CHAT_HOMES ${got.homes} is outside the run's root ${got.root}`);
});
