// Run: node scripts/run-tests.mjs server/sync/logins-stores.integration.test.ts
// Store adapters against real processes and sockets, scratch dirs only: another process tearing pi's
// auth.json in place, and the Claude store-shape simulator against the mock token server over HTTP.
// The real ~/.pi and ~/.claude are never read or written. Everything else in-process:
// logins-stores.test.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_OAUTH_KEY, ClaudeCredentialStore, fingerprint, PiAuthStore, type StoreSnapshot } from "./logins-stores";
import * as claudeSim from "../../scripts/mesh-lab/mock-token-server/claude-sim.mjs";
import { createHandler, createMockTokenState } from "../../scripts/mesh-lab/mock-token-server/server.mjs";

const root = mkdtempSync(join(tmpdir(), "sova-cred-stores-int-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const scratch = () => {
  const d = join(root, `d${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const keyEntry = (key: string) => ({ type: "api_key", key });
const snapOf = (store: PiAuthStore | ClaudeCredentialStore) => store.transact((snap) => ({ result: snap }));

test("H9: a writer tearing the file byte by byte in place never yields a partial snapshot", async () => {
  const dir = scratch();
  const path = join(dir, "auth.json");
  const full = JSON.stringify({ zai: keyEntry("sk-final"), deepseek: keyEntry("sk-ds") }, null, 2);
  writeFileSync(path, "{}");
  // A child truncates, then appends one byte at a time (no lock, like a careless editor).
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fs=require("fs");const s=${JSON.stringify(full)};const fd=fs.openSync(${JSON.stringify(path)},"w");` +
        `let i=0;const t=setInterval(()=>{if(i>=s.length){clearInterval(t);fs.closeSync(fd);return;}fs.writeSync(fd,s[i++]);},1);`,
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise((r) => child.on("exit", r));
  const store = new PiAuthStore(path);
  const seen: StoreSnapshot["state"][] = [];
  let finished = false;
  void exited.then(() => (finished = true));
  while (!finished) {
    const snap = await snapOf(store);
    seen.push(snap.state);
    if (snap.state === "ok") {
      // Only ever the empty file before the tear, or the complete one after it.
      const keys = [...snap.entries.keys()].sort();
      assert.ok(keys.length === 0 || keys.join() === "deepseek,zai", keys.join());
    }
  }
  const last = await snapOf(store);
  assert.equal(last.state, "ok");
  assert.equal(last.entries.get("zai")?.fingerprint, fingerprint(keyEntry("sk-final")));
  assert.ok(seen.includes("invalid"), "the torn states were seen, and refused");
});

test("claude simulator over HTTP: refresh rotates, a reused refresh token clears the store only if unchanged", async () => {
  const state = createMockTokenState({ accessTtlS: 90 });
  const server = createServer(createHandler(state));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const a = scratch();
    const b = scratch();
    const { lineage } = await claudeSim.login(a, url);
    // Host B holds a copy of the same lineage (as after a sync).
    writeFileSync(join(b, ".credentials.json"), readFileSync(join(a, ".credentials.json")));
    assert.equal(await claudeSim.refresh(a, url), "ok", "90s token is inside the 5-min window");
    assert.equal(await claudeSim.refresh(b, url), "invalid_grant", "B's refresh token was consumed by A");
    const onB = JSON.parse(readFileSync(join(b, ".credentials.json"), "utf8"))[CLAUDE_OAUTH_KEY];
    assert.deepEqual([onB.accessToken, onB.refreshToken, onB.expiresAt], ["", "", 0]);
    assert.equal((await snapOf(new ClaudeCredentialStore(b))).entries.get(CLAUDE_OAUTH_KEY)?.dead, true);
    const sum = state.summary()[lineage]!;
    assert.deepEqual([sum.refreshes, sum.invalidGrants], [1, 1]);
    // Logout revokes the lineage and deletes the file.
    await claudeSim.logout(a, url);
    assert.equal(existsSync(join(a, ".credentials.json")), false);
    assert.equal(state.summary()[lineage]!.revoked, true);
  } finally {
    server.close();
  }
});
