// The chat-runtime trial's child-mode server(): gone() reports a server that exited before it answered
// (its exit code and the log's last lines), so healthy() stops at once instead of waiting out its timeout.
// Spawns a stand-in scripts/start-server.sh in a temp root: integration tier.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs, no types
import { healthy, server } from "./chat-runtime-trial/lib.mjs";

const root = mkdtempSync(join(tmpdir(), "sova-trial-gone-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** A port nothing listens on (taken, then freed). */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("healthy() stops at once on a child-mode server that exited, with its code and output", async () => {
  mkdirSync(join(root, "scripts"));
  const start = join(root, "scripts", "start-server.sh");
  writeFileSync(start, "#!/bin/sh\necho 'boot failed: no such thing'\nexit 3\n");
  chmodSync(start, 0o755);
  const log = join(root, "server.log");
  const srv = server({ tag: "gone", env: { PATH: process.env.PATH ?? "" }, mode: "child", log, root });
  srv.up();
  const base = `http://127.0.0.1:${await closedPort()}`;
  const t0 = Date.now();
  await assert.rejects(healthy(base, 60_000, () => srv.gone()), (e: Error) => {
    assert.match(e.message, /code 3/);
    assert.match(e.message, /boot failed: no such thing/);
    return true;
  });
  assert.ok(Date.now() - t0 < 10_000, `gave up in ${Date.now() - t0} ms, well under the 60 s timeout`);
  await srv.down();
});
