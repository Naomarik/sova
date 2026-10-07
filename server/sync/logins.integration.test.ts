// Run: node scripts/run-tests.mjs server/sync/logins.integration.test.ts
// Login sync's refreshes over real HTTP (§mesh.sync/logins): the mock rotating token server on a
// loopback port, pi's OWN refresh code (piRefresher) and the Claude store-shape simulator reaching it
// through fetch, as in the Docker lab. Every sync scenario, with the mock called in-process:
// logins.test.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_OAUTH_KEY, piRefresher } from "./logins-stores";
import { createHandler, createMockTokenState } from "../../scripts/mesh-lab/mock-token-server/server.mjs";
import * as claudeSim from "../../scripts/mesh-lab/mock-token-server/claude-sim.mjs";

const root = mkdtempSync(join(tmpdir(), "sova-cred-sync-int-"));
after(() => rmSync(root, { recursive: true, force: true }));

const mock = createMockTokenState({ accessTtlS: 90 });
const mockServer = createServer(createHandler(mock));
await new Promise<void>((r) => mockServer.listen(0, "127.0.0.1", r));
const mockUrl = `http://127.0.0.1:${(mockServer.address() as { port: number }).port}`;
const realFetch = globalThis.fetch;
// pi-ai posts to the fixed https://auth.openai.com/oauth/token; in the lab that name resolves to
// the mock, here the fetch is routed to it, over HTTP.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://auth.openai.com/")) return realFetch(new URL(new URL(url).pathname, mockUrl), init);
  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
  mockServer.close();
});

const sha = (s: unknown) => createHash("sha256").update(String(s)).digest("hex");
const latest = (lineage: string) => mock.summary()[lineage] as { refreshSha256: string; refreshes: number };

test("pi's own refresh reaches the token server over HTTP and rotates the login", async () => {
  const dir = join(root, "pi");
  mkdirSync(dir, { recursive: true });
  const authPath = join(dir, "auth.json");
  const { lineage, credential } = mock.login({ shape: "pi" });
  // auth.json as pi keeps it (one entry per provider), written here: this file reaches pi only through
  // Sova's own store (piRefresher), never by importing it.
  writeFileSync(authPath, JSON.stringify({ "openai-codex": credential }), { mode: 0o600 });
  await piRefresher(authPath)("openai-codex", 0);
  assert.equal(latest(lineage).refreshes, 1);
  const entry = (JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { refresh: string }>)["openai-codex"]!;
  assert.equal(sha(entry.refresh), latest(lineage).refreshSha256, "the rotated refresh token is the one on disk");
});

test("the Claude simulator logs in and refreshes against the token server over HTTP", async () => {
  const dir = join(root, "claude");
  mkdirSync(dir, { recursive: true });
  const { lineage } = await claudeSim.login(dir, mockUrl);
  assert.equal(await claudeSim.refresh(dir, mockUrl, { force: true }), "ok");
  const saved = (JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8")) as Record<string, { refreshToken: string }>)[CLAUDE_OAUTH_KEY]!;
  assert.equal(sha(saved.refreshToken), latest(lineage).refreshSha256);
});
