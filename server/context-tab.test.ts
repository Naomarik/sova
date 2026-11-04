// Run: pnpm test -- server/context-tab.test.ts. The Context tab's read (server/context-tab.ts) over stand-ins:
// the parts by group, a chat this server doesn't hold, the conversation estimate after a compaction, the
// nested files, the remote and unavailable answers; and pi's prompt split back into its sections.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { HEntry } from "../shared/harness";
import type { SessionSetup } from "../shared/protocol";
import { conversationTalk, conversationTokens, getContextView, labelOf, skillsRead, type ContextViewDeps } from "./context-tab";
import { splitSystemPrompt } from "./harness/pi/session";
import { scratchRoot } from "./test-scratch";

const setup: SessionSetup = {
  state: "ok",
  where: { kind: "local" },
  cwd: "/w",
  context: [
    { path: "/home/u/.pi/agent/AGENTS.md", bytes: 40, lines: 2, tokens: 10 },
    { path: "/w/AGENTS.md", bytes: 400, lines: 9, tokens: 100 },
    { path: "/w/OFF.md", bytes: 4, lines: 1, tokens: 1, off: true },
  ],
  skills: [
    { name: "pdf", path: "/s/pdf/SKILL.md", description: "Read PDFs.", bytes: 4000, lines: 80, tokens: 1000 },
    { name: "gone", path: "/s/gone/SKILL.md", bytes: 4, lines: 1, tokens: 1, off: true },
  ],
  fromRuntime: true,
  checkedAt: 1,
};
const params = { type: "object", properties: { path: { type: "string" } } };
const branch = (...e: Partial<HEntry>[]): HEntry[] => e.map((x, i) => ({ id: `e${i}`, parentId: null, ...x }) as HEntry);
const deps = (o: Partial<ContextViewDeps> = {}): ContextViewDeps => ({
  setup: async () => setup,
  held: async () => ({
    sections: { preamble: "You are pi.", tools: "- read", rules: "- Be concise", docs: "Pi docs here", project_context: "files…", skills: "skills…", mode: "# Mode: delegate", cwd: "/w" },
    tools: [{ name: "read", description: "Read a file.", parameters: params, source: "builtin" }],
    loader: null,
  }),
  branch: async () => branch({ kind: "user", blocks: [{ type: "text", text: "x".repeat(400) }] }, { kind: "assistant", blocks: [{ type: "text", text: "y".repeat(40) }], provider: "p", model: "m", contextTokens: 5000 }),
  context: async (c) => (c ? { tokens: c.tokens, window: 200_000 } : null),
  nested: () => ({ files: [{ path: "api/AGENTS.md", dir: "api", abs: "/w/api/AGENTS.md", chars: 80, loaded: true }, { path: "web/AGENTS.md", dir: "web", abs: "/w/web/AGENTS.md", chars: 41, loaded: false }], incomplete: false }),
  now: () => 7,
  ...o,
});

test("a held chat: files and skills with switched-off rows left out, the mode, the other sections as rules, the tools as JSON", async () => {
  const v = await getContextView("/s.jsonl", deps());
  assert.equal(v.state, "ok");
  if (v.state !== "ok") return;
  assert.equal(v.prompt, true);
  assert.deepEqual(v.instructions.map((p) => [p.label, p.tokens, p.path]), [
    ["/home/u/.pi/agent/AGENTS.md", 10, "/home/u/.pi/agent/AGENTS.md"],
    ["AGENTS.md", 100, "/w/AGENTS.md"],
  ]);
  assert.deepEqual(v.skills.map((p) => [p.label, p.detail, p.path]), [["pdf", "Read PDFs.", "/s/pdf/SKILL.md"]]);
  // A skill is offered, not loaded: it costs its listing, far less than its file.
  assert.ok(v.skills[0]!.tokens > 0 && v.skills[0]!.tokens < 100);
  assert.deepEqual(v.mode, { id: "section:mode", label: "Mode", text: "# Mode: delegate", tokens: 4 });
  assert.deepEqual(v.rules.map((p) => p.label), ["Preamble", "Tool list", "Rules", "Pi docs", "Working folder"]);
  assert.equal(v.tools.length, 1);
  assert.deepEqual(JSON.parse(v.tools[0]!.text!), { name: "read", description: "Read a file.", parameters: params });
  assert.equal(v.tools[0]!.tokens, Math.ceil(("Read a file." + JSON.stringify(params)).length / 4));
  assert.equal(v.total, 5000);
  assert.equal(v.window, 200_000);
  assert.deepEqual(v.nested, [
    { path: "api/AGENTS.md", abs: "/w/api/AGENTS.md", folder: "api", tokens: 20, loaded: true },
    { path: "web/AGENTS.md", abs: "/w/web/AGENTS.md", folder: "web", tokens: 11, loaded: false },
  ]);
  assert.equal(v.nestedIncomplete, undefined);
  // 440 characters of messages, less the loaded nested file's 20 tokens (it rides a tool result).
  assert.equal(v.conversation, 110 - 20);
});

test("a chat this server doesn't hold: files, skills and nested files only, prompt false; nothing sent yet is a null total", async () => {
  const v = await getContextView("/s.jsonl", deps({ held: async () => null, branch: async () => [], nested: () => ({ files: [], incomplete: true }) }));
  assert.ok(v.state === "ok");
  if (v.state !== "ok") return;
  assert.equal(v.prompt, false);
  assert.equal(v.mode, null);
  assert.deepEqual([v.rules, v.tools], [[], []]);
  assert.equal(v.instructions.length, 2);
  assert.deepEqual([v.total, v.window, v.conversation, v.nestedIncomplete], [null, null, 0, true]);
});

test("remote and unreadable sessions answer as the setup read does", async () => {
  assert.deepEqual(await getContextView("/s.jsonl", deps({ setup: async () => ({ state: "remote", where: { kind: "remote", target: "box" }, cwd: "/p", checkedAt: 1 }) })), { state: "remote", cwd: "/p", checkedAt: 7 });
  assert.deepEqual(await getContextView("/s.jsonl", deps({ setup: async () => ({ state: "unavailable", where: { kind: "local" }, cwd: "/gone", reason: "Gone.", checkedAt: 1 }) })), {
    state: "unavailable",
    cwd: "/gone",
    reason: "Gone.",
    checkedAt: 7,
  });
});

test("the conversation counts what follows the latest compaction, plus the part it kept", () => {
  const t = (n: number) => ({ kind: "user", blocks: [{ type: "text", text: "x".repeat(n) }] }) as Partial<HEntry>;
  assert.equal(conversationTokens(branch(t(400), { kind: "compaction", summary: "s".repeat(40) }, t(80))), 30);
  const kept = branch(t(400), t(800), { kind: "compaction", summary: "s".repeat(40), firstKeptEntryId: "e1" } as Partial<HEntry>, t(80));
  assert.equal(conversationTokens(kept), 230);
  // Images cost pi's flat estimate; a tool call its name and arguments.
  assert.equal(conversationTokens(branch({ kind: "assistant", blocks: [{ type: "image", data: "", mimeType: "image/png" }, { type: "toolCall", id: "c", name: "read", arguments: { p: 1 } }] })), Math.ceil((4800 + 4 + 7) / 4));
});

test("pi's rendered prompt splits back into its sections; a section quoting another tag isn't cut; a forced prompt is all preamble", () => {
  const text = ["You are pi.", "<tools>\n- read\n</tools>", "<project_context>\nA file that says\n</tools>\nand <rules>\n</project_context>", "<mode>\n# Mode\n</mode>", "<cwd>\n/w\n</cwd>"].join("\n\n");
  assert.deepEqual(splitSystemPrompt(text), { preamble: "You are pi.", tools: "- read", project_context: "A file that says\n</tools>\nand <rules>", mode: "# Mode", cwd: "/w" });
  assert.deepEqual(splitSystemPrompt("Just a forced prompt."), { preamble: "Just a forced prompt." });
});

test("subfolder files only where the chat's hook would load them: none with no context files, a confined chat's allowed ones", async () => {
  const cwd = scratchRoot("sova-context-tab-");
  after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const dir of ["sub", "private"]) {
    mkdirSync(join(cwd, dir));
    writeFileSync(join(cwd, dir, "AGENTS.md"), "# Rules here\n");
  }
  const held = (loader: unknown) => async () => ({ sections: {}, tools: [], loader: loader as never });
  const nestedOf = async (o: Partial<ContextViewDeps>) => {
    const v = await getContextView("/s.jsonl", deps({ setup: async () => ({ ...setup, cwd }), branch: async () => [], nested: undefined, ...o }));
    assert.ok(v.state === "ok");
    return v.state === "ok" ? v.nested.map((f) => f.path) : [];
  };
  // An ordinary chat: every file below its folder.
  assert.deepEqual(await nestedOf({ held: held(null) }), ["private/AGENTS.md", "sub/AGENTS.md"]);
  // A gathering-chat-like loadout (noContextFiles): its hook loads nothing, so nothing is listed.
  assert.deepEqual(await nestedOf({ held: held({ noContextFiles: true, append: "none" }) }), []);
  // A confined chat (the project overseer's): a file its allow refuses is left out.
  assert.deepEqual(await nestedOf({ held: held({ append: "none", contextFilesWithin: { root: cwd, out: [join(cwd, "private")] } }) }), ["sub/AGENTS.md"]);
});

test("the conversation by kind: your messages, replies, tool results less the loaded subfolder files, the rest; the tallies add up", () => {
  const b = branch(
    { kind: "user", blocks: [{ type: "text", text: "u".repeat(40) }] },
    { kind: "assistant", blocks: [{ type: "text", text: "a".repeat(80) }, { type: "toolCall", id: "c", name: "read", arguments: {} }] },
    { kind: "tool-result", blocks: [{ type: "text", text: "r".repeat(400) }] },
    { kind: "shell", command: "ls", output: "x".repeat(6) },
    { kind: "note", content: "n".repeat(20), display: true, inMessage: true },
    { kind: "note", content: "hidden", display: false, inMessage: false },
    { kind: "setting", what: "model", provider: "p", modelId: "m" } as Partial<HEntry>,
  );
  const t = conversationTalk(b, 30);
  assert.deepEqual(t.user, { count: 2, tokens: 12 }); // 40 + 8 characters: the message and the shell command
  assert.deepEqual(t.replies, { count: 1, tokens: Math.ceil((80 + 4 + 2) / 4) });
  assert.deepEqual(t.toolResults, { count: 1, tokens: 100 - 30 });
  assert.deepEqual(t.other, { count: 1, tokens: 5 }); // the note sent to the model; the hidden one costs nothing
  assert.equal(t.summary, undefined);
  assert.equal(t.start, "e0", "no compaction: the first message");
  const sum = t.user.tokens + t.replies.tokens + t.toolResults.tokens + t.other.tokens;
  assert.ok(Math.abs(sum - (conversationTokens(b) - 30)) <= 4, `${sum} against ${conversationTokens(b) - 30}`);
});

test("after a compaction: only what follows it (and the part it kept) is tallied, its summary is kept to read, and the transcript starts at it", () => {
  const t = (n: number) => ({ kind: "user", blocks: [{ type: "text", text: "x".repeat(n) }] }) as Partial<HEntry>;
  const b = branch(t(400), t(800), { kind: "compaction", summary: "s".repeat(40), firstKeptEntryId: "e1", at: "2026-11-05T14:06:00.000Z" } as Partial<HEntry>, t(80));
  const talk = conversationTalk(b);
  assert.deepEqual(talk.user, { count: 2, tokens: 220 });
  assert.deepEqual(talk.summary, { text: "s".repeat(40), tokens: 10, at: "2026-11-05T14:06:00.000Z" });
  assert.equal(talk.start, "e2");
  assert.equal(talk.user.tokens + talk.summary!.tokens, conversationTokens(b));
  assert.deepEqual(conversationTalk([]), { user: { count: 0, tokens: 0 }, replies: { count: 0, tokens: 0 }, toolResults: { count: 0, tokens: 0 }, other: { count: 0, tokens: 0 } });
});

test("a skill is read when what the model still sees loads it: a read of its SKILL.md, an invocation, or a shell read; one before a compaction isn't", () => {
  const call = (name: string, args: unknown) => ({ kind: "assistant", blocks: [{ type: "toolCall", id: "c", name, arguments: args }] }) as Partial<HEntry>;
  const read = skillsRead(
    branch(
      call("read", { path: "/s/old/SKILL.md" }),
      { kind: "compaction", summary: "s" } as Partial<HEntry>,
      call("read", { path: "skills/pdf/SKILL.md" }),
      { kind: "user", blocks: [{ type: "text", text: '<skill name="vis" location="/s/vis/SKILL.md">\nbody\n</skill>' }] },
      call("bash", { command: "cat /s/sh/SKILL.md" }),
      call("read", { path: "/w/README.md" }),
    ),
    "/w",
  );
  assert.deepEqual([...read.names].sort(), ["pdf", "sh", "vis"]);
  assert.ok(read.paths.has("/w/skills/pdf/SKILL.md"), "a relative path resolves against the chat's folder");
});

test("the view carries each skill's read state and the conversation's tallies", async () => {
  const v = await getContextView("/s.jsonl", deps({ branch: async () => branch({ kind: "assistant", blocks: [{ type: "toolCall", id: "c", name: "read", arguments: { path: "/s/pdf/SKILL.md" } }] }) }));
  assert.ok(v.state === "ok");
  if (v.state !== "ok") return;
  assert.deepEqual(v.skills.map((p) => [p.label, p.read]), [["pdf", true]]);
  assert.equal(v.talk?.replies.count, 1);
  const none = await getContextView("/s.jsonl", deps());
  assert.ok(none.state === "ok" && none.skills[0]!.read === false);
});

test("an instruction file's name: relative in the chat's folder, ~ under home, whole elsewhere", () => {
  assert.equal(labelOf("/h/u/p", "/h/u/p/AGENTS.md", "/h/u"), "AGENTS.md");
  assert.equal(labelOf("/h/u/p", "/h/u/AGENTS.md", "/h/u"), "~/AGENTS.md");
  assert.equal(labelOf("/h/u/p", "/h/ux/AGENTS.md", "/h/u"), "/h/ux/AGENTS.md");
});
