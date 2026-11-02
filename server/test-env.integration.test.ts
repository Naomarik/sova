// The runner started from inside a chat: the test it runs sees none of that chat process's variables.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratchRoot } from "./test-scratch";

test("a test run from a chat's shell doesn't see the chat's own variables", () => {
  const dir = scratchRoot("test-env-");
  const probe = join(dir, "probe.test.ts");
  const seen = join(dir, "seen.json");
  writeFileSync(probe, `import { test } from "node:test";\nimport { writeFileSync } from "node:fs";\ntest("probe", () => { writeFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.keys(process.env).filter((k) => /^SOVA_CHAT_|^PI_SESSION|^SOVA_CALLER_KEY$/.test(k)))); });\n`);
  const root = join(import.meta.dirname, "..");
  const r = spawnSync(process.execPath, [join(root, "scripts/run-tests.mjs"), probe], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SOVA_CHAT_UNIT: "sova-chat-planted.service", SOVA_CHAT_ID: "planted", PI_SESSION_ID: "planted", SOVA_CALLER_KEY: "planted" },
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const keys: string[] = JSON.parse(readFileSync(seen, "utf8"));
  // Only the runner's own: its test slice and its code pin.
  assert.deepEqual(keys.filter((k) => k !== "SOVA_CHAT_SLICE" && k !== "SOVA_CHAT_CODE"), []);
});
