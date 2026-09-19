// Run: npx tsx --test server/claude-transcript.test.ts
// The JSONL fixtures are real lines copied verbatim out of ~/.claude/projects (Claude Code CLI
// 2.1.278): the format is not ours, so the tests pin the version we read rather than a guess.
// The resolver tests build their own projects dir under /tmp and point CLAUDE_CONFIG_DIR at it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { clearClaudeSessionCache, normalizeClaudeEntries, resolveClaudeSession } from "./claude-transcript";

// --- real CC 2.1.278 lines -------------------------------------------------
/** A typed prompt: content is a one-block array. */
const USER_LINE = "{\"parentUuid\":\"8bcf26c8-d8e9-443b-8156-db2078b01f21\",\"isSidechain\":false,\"promptId\":\"c175fce6-868a-4760-93a0-5b990186c43a\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"[Request interrupted by user for tool use]\"}]},\"uuid\":\"57333ea3-0a32-4543-9b85-c7e2c9626e22\",\"timestamp\":\"2026-09-19T04:34:33.452Z\",\"userType\":\"external\",\"entrypoint\":\"sdk-cli\",\"cwd\":\"/home/user/pi-config\",\"sessionId\":\"6fbdee30-d808-4d82-ad41-2e014e73281b\",\"version\":\"2.1.278\",\"gitBranch\":\"HEAD\"}";
/** One tool_use block, its own line; `input` is the tool's arguments. */
const TOOL_USE_LINE = "{\"parentUuid\":\"c25f84b9-790d-4e93-8ff6-4417700bc507\",\"isSidechain\":false,\"message\":{\"model\":\"claude-opus-5\",\"id\":\"msg_011CfCAmfN25DZdvsBL6fzo8\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_0184tMDWQRMxvrbn75sQuRTC\",\"name\":\"mcp__team__team_inbox\",\"input\":{},\"caller\":{\"type\":\"direct\"}}],\"container\":null,\"stop_reason\":\"tool_use\",\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":8301,\"cache_read_input_tokens\":0,\"output_tokens\":34,\"output_tokens_details\":{\"thinking_tokens\":0},\"server_tool_use\":{\"web_search_requests\":0,\"web_fetch_requests\":0},\"service_tier\":\"standard\",\"cache_creation\":{\"ephemeral_1h_input_tokens\":8301,\"ephemeral_5m_input_tokens\":0},\"inference_geo\":\"not_available\",\"iterations\":[{\"input_tokens\":2,\"output_tokens\":34,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":8301,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":8301},\"type\":\"message\"}],\"speed\":\"standard\"},\"input_transformations\":[],\"diagnostics\":null,\"context_management\":null},\"wireToolInputs\":{\"toolu_0184tMDWQRMxvrbn75sQuRTC\":{}},\"apiBlockIndex\":0,\"requestId\":\"req_011CfCAmeuydx9XVpBUFLXxG\",\"type\":\"assistant\",\"uuid\":\"79673a4a-e3a0-4b65-9e09-9777cc5b8d6b\",\"timestamp\":\"2026-09-19T04:30:06.205Z\",\"advisorModel\":\"claude-opus-5\",\"effort\":\"low\",\"perTurnEffort\":null,\"userType\":\"external\",\"entrypoint\":\"sdk-cli\",\"cwd\":\"/home/user\",\"sessionId\":\"05ef972d-bfed-4b6f-b3d0-3177c918b44d\",\"version\":\"2.1.278\",\"gitBranch\":\"HEAD\"}";
/** The result of TOOL_USE_LINE: a user line whose only block is a tool_result. */
const TOOL_RESULT_LINE = "{\"parentUuid\":\"79673a4a-e3a0-4b65-9e09-9777cc5b8d6b\",\"isSidechain\":false,\"promptId\":\"4fe4c2a8-6c87-43b2-80df-9f361b22d0a6\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_0184tMDWQRMxvrbn75sQuRTC\",\"type\":\"tool_result\",\"content\":[{\"type\":\"text\",\"text\":\"No messages delivered to you yet.\"}]}]},\"uuid\":\"12a0af6d-18c4-4106-9ccb-a7bf2471519f\",\"timestamp\":\"2026-09-19T04:30:06.215Z\",\"toolUseResult\":[{\"type\":\"text\",\"text\":\"No messages delivered to you yet.\"}],\"sourceToolAssistantUUID\":\"79673a4a-e3a0-4b65-9e09-9777cc5b8d6b\",\"userType\":\"external\",\"entrypoint\":\"sdk-cli\",\"cwd\":\"/home/user\",\"sessionId\":\"05ef972d-bfed-4b6f-b3d0-3177c918b44d\",\"version\":\"2.1.278\",\"gitBranch\":\"HEAD\"}";
/** A Bash call, for the CC -> pi tool-name mapping. */
const BASH_LINE = "{\"parentUuid\":\"df4e747e-32fe-4d95-ad31-2bf4b4cceae1\",\"isSidechain\":false,\"message\":{\"model\":\"claude-opus-5\",\"id\":\"msg_011CfCC4D4Zau7cXsD1suwos\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01BXxzUtm5byScjcRwkQ4BA5\",\"name\":\"Bash\",\"input\":{\"command\":\"cd ~/pi-config/extensions/sessions && cat ui.ts\"},\"caller\":{\"type\":\"direct\"}}],\"container\":null,\"stop_reason\":\"tool_use\",\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":10083,\"cache_read_input_tokens\":21952,\"output_tokens\":263,\"output_tokens_details\":{\"thinking_tokens\":53},\"server_tool_use\":{\"web_search_requests\":0,\"web_fetch_requests\":0},\"service_tier\":\"standard\",\"cache_creation\":{\"ephemeral_1h_input_tokens\":10083,\"ephemeral_5m_input_tokens\":0},\"inference_geo\":\"not_available\",\"iterations\":[{\"input_tokens\":2,\"output_tokens\":263,\"cache_read_input_tokens\":21952,\"cache_creation_input_tokens\":10083,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":10083},\"type\":\"message\"}],\"speed\":\"standard\"},\"input_transformations\":[],\"diagnostics\":null,\"context_management\":null},\"wireToolInputs\":{\"toolu_01BXxzUtm5byScjcRwkQ4BA5\":{\"command\":\"cd ~/pi-config/extensions/sessions && cat ui.ts\"}},\"apiBlockIndex\":1,\"requestId\":\"req_011CfCC4Ce1j2TSsr3fvp5Rt\",\"type\":\"assistant\",\"uuid\":\"aeedd3f5-5a30-48db-a32d-b2d70d670aed\",\"timestamp\":\"2026-09-19T04:46:57.602Z\",\"advisorModel\":\"claude-opus-5\",\"effort\":\"medium\",\"perTurnEffort\":null,\"userType\":\"external\",\"entrypoint\":\"sdk-cli\",\"cwd\":\"/home/user/pi-config/extensions/sessions\",\"sessionId\":\"12abbe02-73f0-4465-a7eb-8fc81811104e\",\"version\":\"2.1.278\",\"gitBranch\":\"HEAD\"}";
/** Assistant prose, one text block. */
const TEXT_LINE = "{\"parentUuid\":\"8ce0a498-5f59-4d0f-b2a8-d64c77bc9c7b\",\"isSidechain\":false,\"message\":{\"model\":\"claude-opus-5\",\"id\":\"msg_011CfCeo3mwKq5WHZxmsC7u2\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Now `state.ts`.\"}],\"container\":null,\"stop_reason\":\"tool_use\",\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":1310,\"cache_read_input_tokens\":26755,\"output_tokens\":1608,\"output_tokens_details\":{\"thinking_tokens\":0},\"server_tool_use\":{\"web_search_requests\":0,\"web_fetch_requests\":0},\"service_tier\":\"standard\",\"cache_creation\":{\"ephemeral_1h_input_tokens\":1310,\"ephemeral_5m_input_tokens\":0},\"inference_geo\":\"not_available\",\"iterations\":[{\"input_tokens\":2,\"output_tokens\":1608,\"cache_read_input_tokens\":26755,\"cache_creation_input_tokens\":1310,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":1310},\"type\":\"message\"}],\"speed\":\"standard\"},\"input_transformations\":[],\"diagnostics\":null,\"context_management\":null},\"apiBlockIndex\":0,\"requestId\":\"req_011CfCeo3FgfyLGzmrsQDuvS\",\"type\":\"assistant\",\"uuid\":\"1b2772cd-3475-4d22-9d86-1fb1863a8da4\",\"timestamp\":\"2026-09-19T10:37:35.470Z\",\"advisorModel\":\"claude-opus-5\",\"effort\":\"medium\",\"perTurnEffort\":null,\"userType\":\"external\",\"entrypoint\":\"sdk-cli\",\"cwd\":\"/home/user/pi-config\",\"sessionId\":\"54b5fef2-0193-4acb-9fa8-90a678fb4d9a\",\"version\":\"2.1.278\",\"gitBranch\":\"HEAD\"}";
/** Redacted thinking: empty text, signature only. Nothing to show. */
const THINKING_LINE = "{\"parentUuid\":\"61a4c06a-a016-4eec-86f9-65361c4f8c60\",\"isSidechain\":false,\"message\":{\"model\":\"claude-opus-5\",\"id\":\"msg_011CfCfsGnFgmz3ZuMwK9DS9\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"CAQS4AQKEAgRGAI4AUIIdGhpbmtpbmcSDDkhalL7ULhXBUPqTRoMMPO1xeTl3w567X7XIjCdH60BOruGxRTI23wvmbTJCv7vcr/y+AJR0IHDi3I289KkuxL6+P3tYdN757R+kXwq/QNJ5pZo1KjL1WTurbEoYN2/A+8CrGjkwTLA9k2kL3Z85YfTBlaUT9AL780HzfNlb8Ejx5L4bjIsvQGzNRwDQndVEsmPjibevijesZ6cdjtJwlBLPkAw2TP7pVIPFg2sc3a8PimKCRjH4TKtJckqFuYlXXwUIEkcMiqKXPZk6jmipNqa+YBvt110Pf4nUqHu4jkzEIM5wr2NIj3sh+kn2zDAA+xLL5TjinZa5I15O72R+0ls2uSc009EwKuuwEvpp2IO2ceQxGHTRbUeT5rFwlXEVt2hnRNSnvjlS6EvuuuW08smzRdJ3YYMhSfnH8tBBxeglHCNkShn6depTegY9XcDEypmyasWkSpvqjTCn054EDpDedRR0j6YTctl7bDiZaTpRotYMODvs001hGkXA5/Ba/oFC4B8nAKal1uMrVFKa7WXRZmuk+NOHLf1nfA7RQjiSBT4cXH97N3KLP+G7pSRuwcQEdcYUY2hDcqIBV/7Rx2/GuNF+5ZNewsGVv/cmdyKlRf/eLmgcaQYb/TDdGscfILS9duu+kjlIRRofp4LyeSYZwYgF19AVwtHBNbb0wb4jEDE8GxoFJ8Y31hlOR9PmJ0V4u3JnrE5kT03XmVBxw9ldMlXqc/LIi/fvTnvz3BEwDwNiMslAl4rQhNdXzJvYzsaVnuAk4P58+6rPhgB\"}],\"container\":null,\"stop_reason\":\"tool_use\",\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":4016,\"cache_read_input_tokens\":6157,\"output_tokens\":137,\"output_tokens_details\":{\"thinking_tokens\":11},\"server_tool_use\":{\"web_search_requests\":0,\"web_fetch_requests\":0},\"service_tier\":\"standard\",\"cache_creation\":{\"ephemeral_1h_input_tokens\":4016,\"ephemeral_5m_input_tokens\":0},\"inference_geo\":\"not_available\",\"iterations\":[{\"input_tokens\":2,\"output_tokens\":137,\"cache_read_input_tokens\":6157,\"cache_creation_input_tokens\":4016,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":4016},\"type\":\"message\"}],\"speed\":\"standard\"},\"input_transformations\":[],\"diagnostics\":null,\"context_management\":null},\"apiBlockIndex\":0,\"requestId\":\"req_011CfCfsG3MYXJhUaXNCNsGC\",\"type\":\"assistant\",\"uuid\":\"5a745061-502c-4bf7-900d-f8fdc50934a8\",\"timestamp\":\"2026-09-19T10:51:40.070Z\",\"advisorModel\":\"claude-opus-5\",\"effort\":\"medium\",\"perTurnEffort\":null,\"userType\":\"external\",\"entrypoint\":\"sdk-cli\",\"cwd\":\"/home/user\",\"sessionId\":\"d1f6627b-15a8-4c51-8712-a7b1a869469b\",\"version\":\"2.1.278\",\"gitBranch\":\"HEAD\"}";
/** CLI bookkeeping, no message at all. */
const LATCH_LINE = "{\"type\":\"atis-latch\",\"atis\":\"\",\"sessionId\":\"27050ff6-e65d-44b3-a316-814ecc72b69d\"}";

const parse = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

// --- resolver --------------------------------------------------------------

const roots: string[] = [];
const configDir = process.env.CLAUDE_CONFIG_DIR;
after(() => {
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDir;
  clearClaudeSessionCache();
  for (const p of roots.reverse()) rmSync(p, { recursive: true, force: true });
});

/** A throwaway ~/.claude with one project dir, wired up as CLAUDE_CONFIG_DIR. */
function projectsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-web-claude-"));
  roots.push(root);
  mkdirSync(join(root, "projects", "-home-user-webapps-pi-web"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = root;
  clearClaudeSessionCache();
  return root;
}

describe("resolveClaudeSession", () => {
  test("finds <id>.jsonl in a project dir", () => {
    const root = projectsRoot();
    const id = randomUUID();
    const file = join(root, "projects", "-home-user-webapps-pi-web", `${id}.jsonl`);
    writeFileSync(file, `${USER_LINE}\n`);
    assert.equal(resolveClaudeSession(id), file);
    assert.equal(resolveClaudeSession(id), file); // again, from the cache
  });

  test("an id that isn't a UUID never touches the filesystem", () => {
    projectsRoot();
    for (const bad of ["../../etc/passwd", "not-a-uuid", "", "*", `${randomUUID()}/x`]) {
      assert.equal(resolveClaudeSession(bad), null, bad);
    }
  });

  test("an unknown session is null", () => {
    projectsRoot();
    assert.equal(resolveClaudeSession(randomUUID()), null);
  });

  test("a symlink pointing out of the projects dir is refused", () => {
    const root = projectsRoot();
    const outside = join(root, "secret.jsonl");
    writeFileSync(outside, "{}\n");
    const id = randomUUID();
    symlinkSync(outside, join(root, "projects", "-home-user-webapps-pi-web", `${id}.jsonl`));
    assert.equal(resolveClaudeSession(id), null);
  });

  test("a missing projects dir is null, not a throw", () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), `pi-web-claude-gone-${randomUUID()}`);
    clearClaudeSessionCache();
    assert.equal(resolveClaudeSession(randomUUID()), null);
  });
});

// --- normalizer ------------------------------------------------------------

describe("normalizeClaudeEntries", () => {
  test("a prompt becomes one user row, text and timestamp in the pi shape", () => {
    const [it, ...rest] = normalizeClaudeEntries(parse([USER_LINE]));
    assert.equal(rest.length, 0);
    assert.equal(it?.kind, "user");
    assert.equal(it?.text, "[Request interrupted by user for tool use]");
    assert.equal(it?.id, "57333ea3-0a32-4543-9b85-c7e2c9626e22");
    const raw = it?.raw as any;
    assert.equal(raw.type, "message");
    assert.equal(raw.timestamp, "2026-09-19T04:34:33.452Z");
    assert.deepEqual(raw.message, { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] });
  });

  test("a tool_use row carries the tool name, call id and a pi toolCall block", () => {
    const [it] = normalizeClaudeEntries(parse([TOOL_USE_LINE]));
    assert.equal(it?.kind, "tool-call");
    assert.equal(it?.text, "mcp__team__team_inbox"); // no pi equivalent: kept as CC named it
    assert.equal(it?.toolCallId, "toolu_0184tMDWQRMxvrbn75sQuRTC");
    assert.equal(it?.id, "79673a4a-e3a0-4b65-9e09-9777cc5b8d6b:0");
    assert.equal(it?.model, "claude/claude-opus-5");
    const block = (it?.raw as any).message.content[0];
    assert.equal(block.type, "toolCall");
    assert.equal(block.id, "toolu_0184tMDWQRMxvrbn75sQuRTC");
    assert.deepEqual(block.arguments, {});
  });

  test("CC tool names map to pi's", () => {
    const [it] = normalizeClaudeEntries(parse([BASH_LINE]));
    assert.equal(it?.text, "bash");
    assert.equal((it?.raw as any).message.content[0].name, "bash");
    assert.equal((it?.raw as any).message.content[0].arguments.command, "cd ~/pi-config/extensions/sessions && cat ui.ts");
  });

  test("a tool_result pairs with its call and reads as a pi toolResult", () => {
    const items = normalizeClaudeEntries(parse([TOOL_USE_LINE, TOOL_RESULT_LINE]));
    assert.equal(items.length, 2);
    const result = items[1]!;
    assert.equal(result.kind, "tool-result");
    assert.equal(result.toolCallId, items[0]!.toolCallId);
    assert.equal(result.text, "No messages delivered to you yet.");
    const msg = (result.raw as any).message;
    assert.equal(msg.role, "toolResult");
    assert.equal(msg.isError, false);
    assert.deepEqual(msg.content, [{ type: "text", text: "No messages delivered to you yet." }]);
  });

  test("an errored result is flagged", () => {
    const line = JSON.parse(TOOL_RESULT_LINE) as any;
    line.message.content[0].is_error = true;
    const [it] = normalizeClaudeEntries([line]);
    assert.equal((it?.raw as any).message.isError, true);
  });

  test("a long result is truncated for the row text but not in raw", () => {
    const line = JSON.parse(TOOL_RESULT_LINE) as any;
    line.message.content[0].content = [{ type: "text", text: "x".repeat(5000) }];
    const [it] = normalizeClaudeEntries([line]);
    assert.equal(it?.text?.length, 2001); // 2000 + the ellipsis
    assert.equal((it?.raw as any).message.content[0].text.length, 5000);
  });

  test("assistant prose becomes an assistant-text row", () => {
    const [it] = normalizeClaudeEntries(parse([TEXT_LINE]));
    assert.equal(it?.kind, "assistant-text");
    assert.equal(it?.text, "Now `state.ts`.");
    assert.equal(it?.model, "claude/claude-opus-5");
  });

  test("signature-only thinking and bookkeeping lines produce nothing", () => {
    assert.deepEqual(normalizeClaudeEntries(parse([THINKING_LINE, LATCH_LINE])), []);
  });

  test("real thinking text does produce a row", () => {
    const line = JSON.parse(THINKING_LINE) as any;
    line.message.content[0].thinking = "Let me check the file first.";
    const [it] = normalizeClaudeEntries([line]);
    assert.equal(it?.kind, "thinking");
    assert.equal(it?.text, "Let me check the file first.");
  });

  test("sidechain lines (a nested Task agent) are skipped", () => {
    const line = JSON.parse(TEXT_LINE) as any;
    line.isSidechain = true;
    assert.deepEqual(normalizeClaudeEntries([line]), []);
  });

  test("isMeta user lines are skipped", () => {
    const line = JSON.parse(USER_LINE) as any;
    line.isMeta = true;
    assert.deepEqual(normalizeClaudeEntries([line]), []);
  });

  test("a compact_boundary system line becomes an info row; other system lines don't", () => {
    const boundary = {
      parentUuid: null,
      isSidechain: false,
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      compactMetadata: { trigger: "manual", preTokens: 532767 },
      uuid: "c9283733-de18-40cd-ba9a-a22ae6757767",
      timestamp: "2026-09-19T10:00:00.000Z",
    };
    const [it, ...rest] = normalizeClaudeEntries([boundary, { ...boundary, subtype: "hook_result" }]);
    assert.equal(rest.length, 0);
    assert.equal(it?.kind, "info");
    assert.equal(it?.text, "Compacted (532767 tokens)");
  });

  test("garbage and unknown line types are dropped, not thrown on", () => {
    assert.deepEqual(normalizeClaudeEntries([null, 42, "x", {}, { type: "file-history-snapshot" }, { type: "user" }]), []);
  });

  test("row ids stay unique across a whole file", () => {
    const items = normalizeClaudeEntries(parse([USER_LINE, TEXT_LINE, TOOL_USE_LINE, TOOL_RESULT_LINE, BASH_LINE]));
    assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  });
});
