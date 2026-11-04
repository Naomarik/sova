import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionContextView } from "../../shared/protocol";
import { contextHeadline, contextLines, contextRoom, flatParts, partLang, workerReplyKey, type ContextPart, type ContextSizes } from "./context-parts";

const parts: ContextPart[] = [
  { id: "file:/p/AGENTS.md", group: "instructions", label: "AGENTS.md", tokens: 3_000, path: "/p/AGENTS.md" },
  { id: "sub:/p/api/AGENTS.md", group: "subfolder", label: "api/AGENTS.md", tokens: 800, folder: "api", loaded: true },
  { id: "sub:/p/web/AGENTS.md", group: "subfolder", label: "web/AGENTS.md", tokens: 5_000, folder: "web", loaded: false },
  { id: "section:rules", group: "rules", label: "Rules", tokens: 700, text: "r" },
  { id: "section:docs", group: "rules", label: "Docs", tokens: 500, text: "d" },
  { id: "skill:a", group: "skills", label: "a", tokens: 1_500 },
  { id: "skill:b", group: "skills", label: "b", tokens: 500 },
  { id: "tool:read", group: "tools", label: "read", tokens: 9_000, text: "{}" },
];
const base: ContextSizes = { parts, conversation: 20_000, total: 50_000, window: 200_000 };

describe("the Context tab's lines", () => {
  test("one line per instruction file in the window, the other groups summed, biggest first, Free last", () => {
    const lines = contextLines(base);
    assert.deepEqual(
      lines.map((l) => l.label),
      ["Conversation", "Other", "Tools", "AGENTS.md", "Skills offered", "Rules and docs", "api/AGENTS.md", "Free"],
    );
    assert.equal(lines.find((l) => l.kind === "rules")!.tokens, 1_200);
  });

  test("a line of one part opens it; a line of several lists its group; the rest open nothing", () => {
    const one = contextLines({ ...base, parts: parts.filter((p) => p.id !== "skill:b") });
    const skills = (ls: typeof one) => ls.find((l) => l.kind === "skills")!;
    assert.equal(skills(one).opens, "skill:a");
    assert.equal(skills(one).lists, undefined);
    const several = contextLines(base);
    assert.equal(skills(several).opens, undefined);
    assert.equal(skills(several).lists, "skills");
    assert.ok(several.find((l) => l.label === "AGENTS.md")!.opens);
    for (const l of several.filter((x) => ["conversation", "other", "free"].includes(x.kind))) assert.deepEqual([l.opens, l.lists], [undefined, undefined], l.kind);
  });

  test("a tool shows as JSON, a file by its path, anything else as markdown", () => {
    assert.equal(partLang({ group: "tools" }), "json");
    assert.equal(partLang({ group: "skills", path: "/a/SKILL.md" }), "markdown");
    assert.equal(partLang({ group: "skills", path: "/a/run.mjs" }), "javascript");
    assert.equal(partLang({ group: "rules" }), "markdown");
  });

  test("a subfolder file not yet loaded costs nothing; the lines add up to the window", () => {
    const lines = contextLines(base);
    assert.equal(lines.some((l) => l.label === "web/AGENTS.md"), false);
    assert.equal(lines.find((l) => l.kind === "other")!.tokens, 50_000 - (3_000 + 800 + 1_200 + 2_000 + 9_000 + 20_000));
    assert.equal(lines.find((l) => l.kind === "free")!.tokens, 150_000);
    assert.equal(lines.reduce((n, l) => n + l.tokens, 0), 200_000);
  });

  test("Other is floored at 0 when the estimates overshoot the reported total", () => {
    assert.equal(contextLines({ ...base, total: 10_000 }).find((l) => l.kind === "other")!.tokens, 0);
  });

  test("before the first reply: the estimates alone, no Other and no Free", () => {
    const lines = contextLines({ ...base, total: null });
    assert.equal(lines.some((l) => l.kind === "other" || l.kind === "free"), false);
    assert.equal(contextHeadline(null, 200_000), "Nothing sent yet");
    assert.equal(contextRoom(null, 200_000), null);
  });

  test("the server's read flattens into parts with group-unique ids, nested files carrying their state", () => {
    const v: Extract<SessionContextView, { state: "ok" }> = {
      state: "ok", cwd: "/p", window: 1000, total: 10, prompt: true, conversation: 5, checkedAt: 0,
      instructions: [{ id: "x", label: "AGENTS.md", tokens: 3, path: "/p/AGENTS.md" }],
      mode: { id: "x", label: "Mode", tokens: 2, text: "m" },
      rules: [], skills: [], tools: [{ id: "read", label: "read", tokens: 4, text: "{}" }],
      nested: [{ path: "api/AGENTS.md", abs: "/p/api/AGENTS.md", folder: "api", tokens: 1, loaded: false }],
    };
    const ps = flatParts(v);
    assert.deepEqual(ps.map((p) => p.group), ["instructions", "subfolder", "mode", "tools"]);
    assert.equal(new Set(ps.map((p) => p.id)).size, ps.length);
    assert.deepEqual(ps[1], { id: "subfolder:/p/api/AGENTS.md", group: "subfolder", label: "api/AGENTS.md", tokens: 1, path: "/p/api/AGENTS.md", folder: "api", loaded: false });
  });

  test("a worker's reply-end key moves when a reply ends, and not while one streams", () => {
    const idle = { turns: 2, context: { tokens: 900, window: 1000 }, endedAt: undefined };
    const streaming = { ...idle, working: true, preview: "typing…", lastActivity: 5 };
    assert.equal(workerReplyKey(streaming), workerReplyKey(idle));
    assert.notEqual(workerReplyKey({ ...idle, turns: 3 }), workerReplyKey(idle));
    assert.notEqual(workerReplyKey({ ...idle, context: { tokens: 950, window: 1000 } }), workerReplyKey(idle));
    assert.notEqual(workerReplyKey({ ...idle, context: "compacted" }), workerReplyKey(idle));
    assert.notEqual(workerReplyKey({ ...idle, endedAt: 7 }), workerReplyKey(idle));
    assert.equal(workerReplyKey(undefined), "");
  });

  test("the headline and the room left", () => {
    assert.equal(contextHeadline(50_000, 200_000), "50,000 of 200,000 tokens · 25%");
    assert.equal(contextRoom(50_000, 200_000), "150k left");
    assert.equal(contextHeadline(50_000, null), "50,000 tokens · this model's limit is unknown");
    assert.equal(contextLines({ ...base, window: null }).some((l) => l.kind === "free"), false);
  });
});
