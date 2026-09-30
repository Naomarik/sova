// Run: npx tsx --test server/provider-limits.test.ts (or npm test). Writes only under a mkdtemp dir.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { acquireSlot, lowerAfterRateLimit, waitingText } from "../pi-config/extensions/provider-limits/gate.ts";
import { waitingSentence } from "../shared/provider-limits";
import { providerLimitsInfo, providerWaiting, saveProviderLimits } from "./provider-limits";

const root = mkdtempSync(join(tmpdir(), "sova-provider-limits-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const agentDir = () => mkdtempSync(join(root, `agent-${++n}-`));

test("GET: no file shows the defaults; a malformed file shows the defaults and why", () => {
  const dir = agentDir();
  const info = providerLimitsInfo(dir);
  assert.deepEqual(info.limits, { zai: 5, "ollama-cloud": 10 });
  assert.equal(info.stored, false);
  assert.equal(info.error, undefined);
  assert.deepEqual([info.min, info.max], [1, 999]);
  writeFileSync(join(dir, "provider-limits.json"), "{nope");
  const bad = providerLimitsInfo(dir);
  assert.equal(bad.stored, true);
  assert.match(bad.error ?? "", /not JSON/);
  assert.deepEqual(bad.limits, { zai: 5, "ollama-cloud": 10 });
});

test("PUT replaces the whole file, refuses a bad shape (400) and never overwrites an unreadable file (409)", () => {
  const dir = agentDir();
  const ok = saveProviderLimits({ limits: { zai: 3, "claude-code": 2 } }, dir);
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "provider-limits.json"), "utf8")), { version: 1, limits: { zai: 3, "claude-code": 2 } });
  assert.deepEqual(ok.status === 200 && ok.body.limits, { zai: 3, "claude-code": 2 });
  for (const body of [{ limits: { zai: 0 } }, { limits: { zai: 2.5 } }, { limits: { zai: 1000 } }, { limits: "x" }, null])
    assert.equal(saveProviderLimits(body, dir).status, 400, JSON.stringify(body));
  const empty = saveProviderLimits({ limits: {} }, dir);
  assert.equal(empty.status, 200, "no limits at all is a valid choice");
  writeFileSync(join(dir, "provider-limits.json"), '{"version":1,"limits":{"zai":"five"}}');
  const refused = saveProviderLimits({ limits: { zai: 4 } }, dir);
  assert.equal(refused.status, 409);
  assert.equal(readFileSync(join(dir, "provider-limits.json"), "utf8"), '{"version":1,"limits":{"zai":"five"}}');
});

test("GET shows a limit a 429 lowered, beside the unchanged Settings number", async () => {
  const dir = agentDir();
  saveProviderLimits({ limits: { zai: 5 } }, dir);
  const lowered = await lowerAfterRateLimit(dir, "zai", 5);
  const info = providerLimitsInfo(dir);
  assert.deepEqual(info.limits, { zai: 5 });
  assert.deepEqual(info.lowered, { zai: { limit: 4, until: lowered!.until } });
  assert.deepEqual(providerLimitsInfo(dir, lowered!.until + 1).lowered, {}, "gone once the 5 minutes are up");
});

test("waiting: read from the queue files by session id; the web's sentence is the TUI's", async () => {
  const dir = agentDir();
  saveProviderLimits({ limits: { zai: 1 } }, dir);
  const held = await acquireSlot("zai", { agentDir: dir, kind: "interactive", sessionId: "running" });
  const ac = new AbortController();
  const waiting = acquireSlot("zai", { agentDir: dir, kind: "background", sessionId: "worker-session", signal: ac.signal, pollMs: 20 }).catch(() => null);
  await new Promise((r) => setTimeout(r, 50));
  const now = Date.now() + 10_000; // past the cache
  const seen = providerWaiting(dir, now);
  assert.deepEqual(seen, { sessions: { "worker-session": { provider: "zai", inUse: 1, limit: 1, lowered: false } } });
  ac.abort();
  await waiting;
  held!.release();
  assert.deepEqual(providerWaiting(dir, now + 10_000), { sessions: {} });
  for (const w of [
    { provider: "zai", inUse: 5, limit: 5, lowered: false },
    { provider: "ollama-cloud", inUse: 4, limit: 4, lowered: true },
  ])
    assert.equal(waitingSentence(w), waitingText(w));
});
