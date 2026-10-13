// Run: pnpm test:int -- server/session-powers.integration.test.ts. session-limits.json is rewritten
// whole by the server and by every chat process with session powers (§chat.profiles/limits): each
// change is one read and write under the file's lock, so writers in separate processes lose none of
// each other's counts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "sova-session-limits-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("writers in separate processes lose none of each other's counts", async () => {
  const file = join(dir, "session-limits.json");
  const mod = join(import.meta.dirname, "session-powers.ts");
  const script = (id: string) =>
    `const { SessionLimits } = await import(${JSON.stringify(mod)}); const l = new SessionLimits(${JSON.stringify(id)}, undefined, ${JSON.stringify(file)}); for (let i = 0; i < 400; i++) { l.take("t" + (i % 3), false); l.userMessage(); }`;
  const run = (id: string) =>
    new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["-e", script(id)], { stdio: "ignore", env: { ...process.env, PI_CODING_AGENT_DIR: dir } });
      child.on("exit", (code) => resolve(code ?? 1));
    });
  assert.deepEqual(await Promise.all(["a", "b", "c", "d"].map(run)), [0, 0, 0, 0]);
  const all = JSON.parse(readFileSync(file, "utf8")).sessions as Record<string, { own: number }>;
  assert.deepEqual(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.own])), { a: 400, b: 400, c: 400, d: 400 });
});
