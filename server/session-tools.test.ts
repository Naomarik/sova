// Run: pnpm test -- server/session-tools.test.ts. The setup card's Tools read (§chat.transcript/setup-card-tools):
// the held chat's declared tools with pi's or Claude Code's names, the estimate, and the sentences for a
// session whose tools aren't listed. The chat is a stand-in here; server/vis-tools-sync.test.ts reads a real one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { HarnessToolInfo } from "../shared/harness";
import type { SessionSummary } from "../shared/protocol";
import { CLAUDE_MCP_TOOL_PREFIX, getSessionTools, IN_TERMINAL, NOT_HELD, SPECIAL, toolTokens } from "./session-tools";

const here = dirname(fileURLToPath(import.meta.url));
const params = { type: "object", properties: { path: { type: "string" } } };
const declared: HarnessToolInfo[] = [
  { name: "read", description: "Read a file.", parameters: params, source: "builtin" },
  { name: "align", description: "Record an alignment.", parameters: params, source: "extension", origin: "mode" },
  { name: "vis_check", description: "Check a vis block.", parameters: params, source: "sova", origin: "sova-vis-check" },
];
const chatOn = (provider: string) =>
  ({ harness: { model: () => ({ ref: `${provider}/m`, provider, id: "m", images: false }), declaredTools: () => declared } }) as never;
const deps = (o: { summary?: Partial<SessionSummary> | null; provider?: string | null }) => ({
  now: () => 7,
  summary: async () => (o.summary === undefined ? ({} as SessionSummary) : (o.summary as SessionSummary | null)),
  held: () => (o.provider === null ? undefined : chatOn(o.provider ?? "zai")),
});

test("the MCP prefix is the Claude Code provider's own (read as text: the server doesn't import claude-code)", () => {
  const types = readFileSync(join(here, "../pi-config/extensions/claude-code/provider/types.ts"), "utf8");
  const server = /export const MCP_SERVER_NAME = "([^"]+)";/.exec(types)?.[1];
  assert.ok(server, "types.ts still declares MCP_SERVER_NAME as a string literal");
  assert.match(types, /export const MCP_TOOL_PREFIX = `mcp__\$\{MCP_SERVER_NAME\}__`;/, "and builds the prefix from it");
  assert.equal(CLAUDE_MCP_TOOL_PREFIX, `mcp__${server}__`);
});

test("a held chat on a pi model: its declared tools in order, pi's names, sources and estimates", async () => {
  const r = await getSessionTools("/s.jsonl", deps({}));
  assert.equal(r.state, "ok");
  if (r.state !== "ok") return;
  assert.equal(r.backend, "pi");
  assert.deepEqual(
    r.tools.map((t) => [t.name, t.callName, t.source, t.origin]),
    [["read", "read", "builtin", undefined], ["align", "align", "extension", "mode"], ["vis_check", "vis_check", "sova", "sova-vis-check"]],
  );
  assert.ok(!("origin" in r.tools[0]!), "no origin key for a built-in");
  assert.equal(r.tools[0]!.tokens, Math.ceil(("Read a file." + JSON.stringify(params)).length / 4), "description plus the schema's JSON, ÷ 4 rounded up");
  assert.equal(toolTokens("abcde", undefined), Math.ceil(("abcde" + "{}").length / 4));
});

test("on a Claude Code model each tool is called mcp__sova__<name>; its own name stays", async () => {
  const r = await getSessionTools("/s.jsonl", deps({ provider: "claude-code-cli" }));
  assert.equal(r.state === "ok" && r.backend, "claude-code");
  if (r.state !== "ok") return;
  assert.deepEqual(r.tools.map((t) => [t.name, t.callName]), [["read", "mcp__sova__read"], ["align", "mcp__sova__align"], ["vis_check", "mcp__sova__vis_check"]]);
});

test("not listed: a chat this server doesn't hold, a terminal's session, a special session", async () => {
  assert.deepEqual(await getSessionTools("/s.jsonl", deps({ provider: null })), { state: "unavailable", reason: NOT_HELD, checkedAt: 7 });
  assert.deepEqual(await getSessionTools("/s.jsonl", deps({ summary: { live: { pid: 1 } } as never })), { state: "unavailable", reason: IN_TERMINAL, checkedAt: 7 });
  for (const special of [{ overseer: true }, { projectOverseer: { projectId: "p" } }, { baton: {} }, { org: {} }, { workerSession: true }])
    assert.deepEqual(await getSessionTools("/s.jsonl", deps({ summary: special as never })), { state: "unavailable", reason: SPECIAL, checkedAt: 7 }, JSON.stringify(special));
  assert.equal((await getSessionTools("/s.jsonl", deps({ summary: null }))).state, "ok", "no summary: the held chat still answers");
});
