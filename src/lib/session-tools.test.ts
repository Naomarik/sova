import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionTools } from "../../shared/protocol";
import { CLAUDE_TOOLS_NOTE, PI_TOOLS_NOTE, sourceWord, stillOpen, TOOLS_NONE, toolsView } from "./session-tools";

const ok = (backend: "pi" | "claude-code", tools: { name: string; tokens: number; source?: "builtin" | "extension" | "sova"; origin?: string }[]): { ok: SessionTools } => ({
  ok: {
    state: "ok",
    backend,
    checkedAt: 0,
    tools: tools.map((t) => ({
      name: t.name,
      callName: backend === "claude-code" ? `mcp__sova__${t.name}` : t.name,
      description: `${t.name}: what it does.\nSecond line.`,
      source: t.source ?? "builtin",
      ...(t.origin ? { origin: t.origin } : {}),
      tokens: t.tokens,
    })),
  },
});

test("a list: heading with the count, the group's ≈tokens, the note per backend, rows in order", () => {
  const v = toolsView(ok("pi", [{ name: "read", tokens: 300 }, { name: "align", tokens: 1200, source: "extension", origin: "mode" }, { name: "vis_check", tokens: 41, source: "sova", origin: "sova-vis-check" }]));
  assert.equal(v.kind, "list");
  if (v.kind !== "list") return;
  assert.equal(v.heading, "Tools · 3");
  assert.equal(v.total, "≈1.5k tokens", "the rows added up, in the app's token words");
  assert.equal(v.note, `${PI_TOOLS_NOTE} Token counts are estimates: 4 characters per token.`);
  assert.deepEqual(v.rows.map((r) => [r.key, r.name, r.source, r.facts]), [
    ["read", "read", "built-in", "≈300 tokens"],
    ["align", "align", "mode", "≈1.2k tokens"],
    ["vis_check", "vis_check", "Sova", "≈41 tokens"],
  ]);
  assert.equal(v.rows[0]!.description, "read: what it does.\nSecond line.", "the description as the model reads it, line breaks kept");
});

test("on Claude Code: rows show mcp__sova__<name>, keyed by the tool's own name, and the note says why", () => {
  const v = toolsView(ok("claude-code", [{ name: "read", tokens: 10 }]));
  assert.ok(v.kind === "list");
  if (v.kind !== "list") return;
  assert.deepEqual([v.rows[0]!.key, v.rows[0]!.name], ["read", "mcp__sova__read"]);
  assert.ok(v.note.startsWith(CLAUDE_TOOLS_NOTE));
});

test("not listed: the server's sentence, none declared, a failed request; each under the plain heading", () => {
  assert.deepEqual(toolsView({ ok: { state: "unavailable", reason: "Tools are listed once this chat is open here.", checkedAt: 0 } }), { kind: "line", heading: "Tools", text: "Tools are listed once this chat is open here." });
  assert.deepEqual(toolsView(ok("pi", [])), { kind: "line", heading: "Tools", text: TOOLS_NONE });
  assert.deepEqual(toolsView({ error: "The Sova server isn't reachable." }), { kind: "line", heading: "Tools", text: "Couldn't read this session's tools. The Sova server isn't reachable." });
});

test("sourceWord: built-in, the extension's name (or 'extension' with none), Sova", () => {
  assert.equal(sourceWord({ source: "builtin" }), "built-in");
  assert.equal(sourceWord({ source: "extension", origin: "subagents" }), "subagents");
  assert.equal(sourceWord({ source: "extension" }), "extension");
  assert.equal(sourceWord({ source: "sova", origin: "pi-codemode" }), "Sova");
});

test("stillOpen keeps the open rows whose tool is still listed, across a switch of naming", () => {
  const before = new Set(["read", "vis_check"]);
  const after = toolsView(ok("claude-code", [{ name: "read", tokens: 1 }, { name: "bash", tokens: 1 }]));
  assert.deepEqual([...stillOpen(before, after)], ["read"], "read stays open under its Claude Code name; vis_check is gone");
  assert.deepEqual([...stillOpen(before, toolsView({ error: "x" }))], []);
});
