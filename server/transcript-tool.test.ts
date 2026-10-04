// Run: pnpm exec tsx --test server/transcript-tool.test.ts. Slim rows (§chat.transcript/slim-rows):
// no entry copy and no signature on any row or route, each entry's facts once, a tool row's folded
// line, "+n −m" and failure computed as the card computes them from the whole entry, and
// GET /api/transcript/tool answering exactly the arguments and output the opened card showed when
// the row carried its entry. A throwaway PI_CODING_AGENT_DIR and an ephemeral loopback port.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { TOOL_CONTENT_MAX_IDS, type ToolContentResponse, type TranscriptItem } from "../shared/protocol";
import { argsSummary, contentText } from "../src/lib/message";
import { summaryStats } from "../src/lib/tool-diff-stats";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-tool-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";
const sessionsDir = join(agentDir, "sessions", "--tmp-tool--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { app, server } = await import("./index");
const { canonicalPath } = await import("./paths");
const { toWireEvent, disposeAllChats } = await import("./chat-manager");
const { claudeToolContent } = await import("./transcript-tool");
if (!server.listening) await new Promise((r) => server.once("listening", r));
const { AUTH_COOKIE, sovaToken } = await import("./auth");
const AUTH = { Cookie: `${AUTH_COOKIE}=${sovaToken()}` };

after(async () => {
  await disposeAllChats();
  server.close();
  server.closeAllConnections?.();
  rmSync(agentDir, { recursive: true, force: true });
});

const T = "2026-10-03T00:00:00.000Z";
const SIG = "c2lnbmF0dXJl".repeat(500);
const PATCH = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n";
const LONG = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");

const entries: Record<string, unknown>[] = [
  { type: "model_change", id: "mc", provider: "zai", modelId: "glm-5.3" },
  { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 } },
  {
    type: "message",
    id: "a1",
    message: {
      role: "assistant",
      provider: "zai",
      model: "glm-5.3",
      usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 115, cost: { total: 0.01 } },
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "plan it", thinkingSignature: SIG },
        { type: "text", text: "Running it.", textSignature: SIG },
        { type: "toolCall", id: "c-bash", name: "bash", arguments: { command: "ls -la\necho two", timeout: 30 }, thoughtSignature: SIG },
        { type: "toolCall", id: "c-edit", name: "edit", arguments: { path: "/p/a.ts", edits: [{ oldText: "old", newText: "new" }] } },
        { type: "toolCall", id: "c-card", name: "sova_card", arguments: { title: "Pick" } },
        { type: "toolCall", id: "c-fail", name: "read", arguments: { path: "/nope" } },
      ],
    },
  },
  { type: "message", id: "r-bash", message: { role: "toolResult", toolCallId: "c-bash", toolName: "bash", isError: false, content: [{ type: "text", text: LONG }] } },
  { type: "message", id: "r-edit", message: { role: "toolResult", toolCallId: "c-edit", toolName: "edit", isError: false, content: [{ type: "text", text: "Edited." }], details: { patch: PATCH } } },
  { type: "message", id: "r-card", message: { role: "toolResult", toolCallId: "c-card", toolName: "sova_card", isError: false, content: [{ type: "text", text: "Shown." }], details: { v: 1, line: "x" } } },
  { type: "message", id: "r-fail", message: { role: "toolResult", toolCallId: "c-fail", toolName: "read", isError: true, content: [{ type: "text", text: "" }, { type: "text", text: "ENOENT" }] } },
  { type: "message", id: "r-img", message: { role: "toolResult", toolCallId: "c-orphan", toolName: "screenshot", isError: false, content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] } },
  { type: "mystery", id: "m1", payload: { thinkingSignature: SIG, keep: 1 } },
];

function writeSession(name: string): string {
  const path = canonicalPath(join(sessionsDir, `2026-10-03T00-00-00-000Z_${name}.jsonl`));
  let parent: string | null = null;
  const lines = [{ type: "session", version: 3, id: name, timestamp: T, cwd: agentDir }];
  for (const e of entries) {
    lines.push({ ...e, parentId: parent, timestamp: T } as never);
    parent = e.id as string;
  }
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

const path = writeSession("slim");
const get = async (url: string) => {
  const r = await app.request(url, { headers: AUTH });
  return { status: r.status, text: await r.text() };
};
const whole = async () => JSON.parse((await get(`/api/transcript?path=${encodeURIComponent(path)}`)).text).items as TranscriptItem[];
const tools = async (ids: string[]) => {
  const r = await get(`/api/transcript/tool?path=${encodeURIComponent(path)}&ids=${ids.map(encodeURIComponent).join(",")}`);
  assert.equal(r.status, 200, r.text);
  return (JSON.parse(r.text) as ToolContentResponse).items;
};

/** What master's card read off the row's entry: src/lib/message.ts toolCallArgs and toolResultView. */
const entry = (id: string) => entries.find((e) => e.id === id)! as any;
const masterArgs = (callId: string) => entry("a1").message.content.find((b: any) => b.id === callId).arguments;
const masterOutput = (id: string) => contentText(entry(id).message.content);

describe("slim rows", () => {
  test("no row carries an entry copy, and nothing anywhere carries a signature", async () => {
    for (const q of ["", "&tail=1", "&view=light"]) {
      const { text } = await get(`/api/transcript?path=${encodeURIComponent(path)}${q}`);
      assert.ok(!text.includes("Signature"), `no signature (${q || "whole"})`);
      assert.ok(!text.includes(SIG.slice(0, 40)), `no signature bytes (${q || "whole"})`);
      assert.ok(!/"raw":/.test(text), `no raw (${q || "whole"})`);
    }
    const unknown = (await whole()).find((it) => it.id === "m1");
    assert.deepEqual((unknown?.entry as any)?.payload, { keep: 1 }, "an unknown row keeps its entry, without its signature");
  });

  test("each entry's facts ride its first row only; every row has its time", async () => {
    const items = await whole();
    const reply = items.filter((it) => it.id.startsWith("a1:"));
    assert.equal(reply.length, 6);
    assert.deepEqual(reply[0]!.meta, {
      type: "message",
      role: "assistant",
      provider: "zai",
      model: "glm-5.3",
      usage: entry("a1").message.usage,
      stopReason: "toolUse",
    });
    assert.ok(reply.slice(1).every((it) => it.meta === undefined));
    assert.ok(items.every((it) => it.at === T));
    assert.equal(items.find((it) => it.id === "r-fail")?.meta?.isError, true);
    assert.equal(items.find((it) => it.id === "r-bash")?.meta?.isError, false);
  });

  test("a tool call's row carries the card's folded line; its content is withheld", async () => {
    const items = await whole();
    for (const [row, callId] of [["a1:2", "c-bash"], ["a1:3", "c-edit"], ["a1:5", "c-fail"]] as const) {
      const it = items.find((x) => x.id === row)!;
      assert.equal(it.tool?.summary ?? "", argsSummary(masterArgs(callId)), row);
      assert.equal(it.tool?.lazy, true);
      assert.equal(it.tool?.args, undefined);
      assert.equal(it.tool?.bytes, JSON.stringify(masterArgs(callId)).length);
    }
    const bash = items.find((x) => x.id === "r-bash")!;
    assert.equal(bash.text, undefined, "a lazy result row carries no output");
    assert.equal(bash.tool?.bytes, LONG.length);
    const edit = items.find((x) => x.id === "r-edit")!;
    assert.deepEqual(edit.tool?.stats, summaryStats("edit", entry("r-edit").message.details));
    assert.deepEqual(edit.tool?.stats, { added: 1, removed: 1 });
    assert.deepEqual(items.find((x) => x.id === "r-img")?.images, ["data:image/png;base64,AAAA"], "images stay on the row");
  });

  test("a card tool keeps its whole content on its rows", async () => {
    const items = await whole();
    const call = items.find((x) => x.id === "a1:4")!;
    assert.deepEqual(call.tool?.args, { title: "Pick" });
    assert.equal(call.tool?.lazy, undefined);
    const result = items.find((x) => x.id === "r-card")!;
    assert.equal(result.text, "Shown.");
    assert.equal(result.tool?.output, "Shown.");
    assert.deepEqual(result.tool?.details, { v: 1, line: "x" });
  });

  test("the route answers exactly what the opened card showed", async () => {
    const got = await tools(["a1:2", "a1:3", "a1:5", "r-img", "nope"]);
    assert.deepEqual(got["a1:2"], { args: masterArgs("c-bash"), result: { output: masterOutput("r-bash"), isError: false } });
    assert.equal(got["a1:2"]!.result!.output, LONG, "the whole output, not the 2,000-character cut");
    assert.deepEqual(got["a1:3"], { args: masterArgs("c-edit"), result: { output: "Edited.", isError: false, details: { patch: PATCH } } });
    assert.deepEqual(got["a1:5"], { args: { path: "/nope" }, result: { output: "ENOENT", isError: true } }, "empty text blocks skipped, as the card joins them");
    assert.deepEqual(got["r-img"], { result: { output: "", isError: false } }, "an orphan result, by its own id");
    assert.equal("nope" in got, false);
  });

  test("the route refuses no ids, too many, and a file that isn't there", async () => {
    assert.equal((await get(`/api/transcript/tool?path=${encodeURIComponent(path)}`)).status, 400);
    const many = Array.from({ length: TOOL_CONTENT_MAX_IDS + 1 }, (_, i) => `x${i}`).join(",");
    assert.equal((await get(`/api/transcript/tool?path=${encodeURIComponent(path)}&ids=${many}`)).status, 400);
    assert.equal((await get(`/api/transcript/tool?path=${encodeURIComponent(join(sessionsDir, "gone.jsonl"))}&ids=a`)).status, 404);
  });

  test("a Claude Code worker's file answers the same way", async () => {
    const file = join(agentDir, "cc.jsonl");
    const lines = [
      { type: "assistant", uuid: "ca", timestamp: T, message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pwd" } }] } },
      { type: "user", uuid: "cu", timestamp: T, message: { role: "user", content: [{ tool_use_id: "t1", type: "tool_result", content: LONG }] } },
    ];
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const got = await claudeToolContent(file, ["ca:0", "cu:0"]);
    assert.equal(got["ca:0"]?.result?.output, LONG);
    assert.equal((got["ca:0"]?.args as { command?: string })?.command, "pwd");
    assert.deepEqual(got["cu:0"], got["ca:0"]?.result ? { result: got["ca:0"].result } : undefined);
  });
});

describe("streamed events", () => {
  test("a whole message forwarded to the browser carries no signature", () => {
    const message = entry("a1").message;
    for (const event of [{ type: "message_end", message }, { type: "turn_end", message, toolResults: [] }, { type: "agent_end", messages: [message] }]) {
      const wire = JSON.stringify(toWireEvent(event));
      assert.ok(!wire.includes("Signature"), event.type);
      assert.ok(wire.includes("plan it") && wire.includes("Running it."), `${event.type} keeps the content`);
    }
    assert.ok(JSON.stringify(message).includes("thinkingSignature"), "the SDK's own object is untouched");
  });
});
