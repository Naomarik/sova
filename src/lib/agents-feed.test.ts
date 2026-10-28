// Run: node scripts/run-tests.mjs src/lib/agents-feed.test.ts
// The app's one agents poll asks for per-session tokens only while an Agents board wants them
// (§app.insights/session-token-rate): every other page's poll stays as it was.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentsTokensWanted, wantAgentsTokens } from "./agents-feed";

test("tokens are asked for only while a board wants them; each stop counts once", () => {
  assert.equal(agentsTokensWanted(), false, "no board: the sidebar's poll asks for none");
  const a = wantAgentsTokens();
  const b = wantAgentsTokens();
  assert.equal(agentsTokensWanted(), true);
  a();
  a();
  assert.equal(agentsTokensWanted(), true, "a second stop from the same board changes nothing");
  b();
  assert.equal(agentsTokensWanted(), false, "the last board gone: asking stops");
});
