import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionContextView } from "../../shared/protocol";
import {
  clockOf,
  contextHeadline,
  contextLayout,
  contextRoom,
  fileFolder,
  flatParts,
  groupSheet,
  inWindow,
  meterShares,
  NOT_LOADED_NOTE,
  partLang,
  partMeta,
  partNote,
  partOpens,
  partSubtitle,
  shareOf,
  workerReplyKey,
  type ContextPart,
  type ContextSizes,
} from "./context-parts";

const parts: ContextPart[] = [
  { id: "instructions:file:/p/AGENTS.md", group: "instructions", label: "AGENTS.md", tokens: 3_000, path: "/p/AGENTS.md" },
  { id: "instructions:file:/h/AGENTS.md", group: "instructions", label: "~/AGENTS.md", tokens: 400, path: "/h/AGENTS.md" },
  { id: "subfolder:/p/api/AGENTS.md", group: "subfolder", label: "api/AGENTS.md", tokens: 800, path: "/p/api/AGENTS.md", folder: "api", loaded: true },
  { id: "subfolder:/p/web/AGENTS.md", group: "subfolder", label: "web/AGENTS.md", tokens: 5_000, path: "/p/web/AGENTS.md", folder: "web", loaded: false },
  { id: "rules:section:rules", group: "rules", label: "Rules", tokens: 700, text: "r" },
  { id: "rules:section:docs", group: "rules", label: "Docs", tokens: 500, text: "d" },
  { id: "skills:skill:a", group: "skills", label: "a", tokens: 1_500, path: "/s/a/SKILL.md", detail: "Does a.", read: true },
  { id: "skills:skill:b", group: "skills", label: "b", tokens: 500, path: "/s/b/SKILL.md", read: false },
  { id: "tools:tool:read", group: "tools", label: "read", tokens: 9_000, text: "{}" },
  { id: "conversation:toolResults", group: "conversation", label: "Tool results", tokens: 12_000, count: 9 },
  { id: "conversation:replies", group: "conversation", label: "Replies", tokens: 5_000, count: 4 },
  { id: "conversation:user", group: "conversation", label: "Your messages", tokens: 1_000, count: 4 },
  { id: "conversation:summary", group: "conversation", label: "Compaction summary", tokens: 2_000, text: "# Summary", at: "2026-11-05T14:06:00" },
];
const base: ContextSizes = { parts, conversation: 20_000, total: 50_000, window: 200_000 };

describe("the Context tab's groups", () => {
  test("every top line is a group, biggest first; Free is no line, Other stands apart", () => {
    const l = contextLayout(base);
    assert.deepEqual(
      l.lines.map((x) => x.label),
      ["Conversation", "Tools", "Instruction files", "Skills offered", "Rules and docs"],
    );
    assert.equal(l.lines.find((x) => x.kind === "rules")!.tokens, 1_200);
    assert.equal(l.lines.some((x) => (x.kind as string) === "free" || (x.kind as string) === "other"), false);
  });

  test("a group lists its parts whatever their count: one part is still a group", () => {
    const one = contextLayout({ ...base, parts: parts.filter((p) => p.id !== "skills:skill:b") });
    const skills = one.lines.find((x) => x.kind === "skills")!;
    assert.deepEqual(skills.parts.map((p) => p.id), ["skills:skill:a"]);
    assert.equal(skills.meta, "1 skill · 1 read");
  });

  test("Instruction files holds every file once: loaded ones biggest first, then the ones not yet loaded, which cost nothing", () => {
    const files = contextLayout(base).lines.find((x) => x.kind === "instructions")!;
    assert.deepEqual(files.parts.map((p) => p.label), ["AGENTS.md", "api/AGENTS.md", "~/AGENTS.md", "web/AGENTS.md"]);
    assert.equal(files.notLoadedFrom, 3);
    assert.equal(files.tokens, 3_000 + 400 + 800);
    assert.equal(files.meta, "3 loaded · 1 not yet loaded");
    // A group of only files not yet loaded still shows, at 0.
    const only = contextLayout({ ...base, conversation: 0, parts: parts.filter((p) => p.id === "subfolder:/p/web/AGENTS.md") }).lines;
    assert.deepEqual(only.map((x) => [x.label, x.tokens, x.meta]), [["Instruction files", 0, "0 loaded · 1 not yet loaded"]]);
    assert.equal(contextLayout({ ...base, parts: parts.filter((p) => p.group === "instructions") }).lines.find((x) => x.kind === "instructions")!.meta, "2 loaded");
  });

  describe("Skills offered", () => {
    const skill = (name: string, tokens: number, read: boolean): ContextPart => ({ id: `skills:skill:${name}`, group: "skills", label: name, tokens, path: `/s/${name}/SKILL.md`, read });
    const noSkills = parts.filter((p) => p.group !== "skills");
    const layoutOf = (...skills: ContextPart[]) => contextLayout({ ...base, parts: [...noSkills, ...skills] });
    const lineOf = (...skills: ContextPart[]) => layoutOf(...skills).lines.find((x) => x.kind === "skills")!;

    test("the skills read come first, then the rest, each biggest first, however big the unread ones are", () => {
      const line = lineOf(skill("small-unread", 100, false), skill("small-read", 200, true), skill("big-unread", 9_000, false), skill("big-read", 800, true));
      assert.deepEqual(line.parts.map((p) => p.label), ["big-read", "small-read", "big-unread", "small-unread"]);
      assert.equal(line.notReadFrom, 2);
      assert.equal(line.notLoadedFrom, -1, "nothing here is left out of the total");
    });

    test("a skill not read yet stays in the line's size, its count and Other, exactly as if it were read", () => {
      const skills = [skill("a", 1_500, true), skill("b", 500, false)];
      const mixed = layoutOf(...skills);
      const allRead = layoutOf(...skills.map((p) => ({ ...p, read: true })));
      const line = mixed.lines.find((x) => x.kind === "skills")!;
      assert.equal(line.tokens, 2_000);
      assert.equal(line.meta, "2 skills · 1 read");
      assert.equal(mixed.other, allRead.other);
      assert.deepEqual(mixed.lines.map((x) => [x.kind, x.tokens]), allRead.lines.map((x) => [x.kind, x.tokens]));
      // Its row reads as counted: in the window, a share bar, and no "+".
      const unread = line.parts.find((p) => p.label === "b")!;
      assert.equal(inWindow(unread), true);
      assert.equal(shareOf(unread.tokens, 200_000, inWindow(unread)), 0.5);
    });

    describe("skills of a folder below the chat's, and manual-only ones", () => {
      const nested = (name: string, tokens: number, extra: Partial<ContextPart>): ContextPart => ({ id: `skills:skill:/p/${name}`, group: "skills", label: name, tokens, path: `/p/${name}/SKILL.md`, folder: "svc", offered: false, read: false, ...extra });
      const start = skill("a", 100, true);
      const unread = skill("b", 50, false);
      const notOffered = nested("later", 300, {});
      const offeredOne = nested("now", 40, { offered: true });
      const manual = nested("hand", 900, { manualOnly: true });
      const ran = nested("ran", 0, { read: true });

      test("not offered and manual-only rows add nothing to any total; an offered one counts, and moves up", () => {
        const without = layoutOf(start, unread);
        const line = lineOf(start, unread, offeredOne, notOffered, manual, ran);
        assert.equal(line.tokens, 100 + 50 + 40);
        assert.deepEqual(line.parts.map((p) => p.label), ["a", "ran", "b", "now", "hand", "later"]);
        assert.equal(line.notReadFrom, 2);
        assert.equal(line.notOfferedFrom, 4);
        const all = layoutOf(start, unread, notOffered, manual);
        assert.equal(all.lines.find((x) => x.kind === "skills")!.tokens, without.lines.find((x) => x.kind === "skills")!.tokens);
        assert.equal(all.other, without.other, "Other doesn't move");
        assert.equal(all.free, without.free);
      });

      test("the line and the sheet count them apart, in their section, with what they'd add", () => {
        const line = lineOf(start, unread, offeredOne, notOffered, manual);
        assert.equal(line.meta, "3 skills · 1 read · 2 not offered yet");
        const sheet = groupSheet(line);
        assert.equal(sheet.sub, "1 read · 2 not read yet · 2 not offered yet");
        assert.deepEqual(sheet.below?.parts.map((p) => p.label), ["b", "now"]);
        assert.equal(sheet.last?.heading, "Not offered yet · not counted");
        assert.deepEqual(sheet.last?.parts.map((p) => p.label), ["hand", "later"]);
        assert.equal(shareOf(notOffered.tokens, 1000, inWindow(notOffered)), null);
        assert.equal(inWindow(manual), false);
        assert.equal(inWindow(offeredOne), true);
      });

      test("a line of nothing but not-offered rows still shows, so they can be seen", () => {
        const line = lineOf(notOffered);
        assert.equal(line.tokens, 0);
        assert.equal(groupSheet(line).sub, "0 read · 1 not offered yet");
        assert.ok(groupSheet(line).last);
      });

      test("words: a folder before the description, a Manual only chip, a note for each state", () => {
        assert.deepEqual(partMeta({ ...notOffered, detail: "Does it." }), { text: "svc/ · Does it." });
        assert.deepEqual(partMeta({ ...offeredOne, detail: "Does it." }), { chip: { word: "Not read yet", done: false }, text: "svc/ · Does it." });
        assert.deepEqual(partMeta(manual), { chip: { word: "Manual only", done: false }, text: "svc/" });
        assert.deepEqual(partMeta(ran), { chip: { word: "Read", done: true }, text: "svc/" });
        assert.match(partNote(notOffered)!, /first time the agent reads, edits or writes a file in svc/);
        assert.match(partNote(manual)!, /never offered.*\/skill:hand/);
        assert.match(partNote(ran)!, /counts under Conversation/);
        assert.match(partNote(offeredOne)!, /only what the model is offered/);
      });

      test("a starting manual-only skill is the same; a starting skill with none of this is as it was", () => {
        const startManual: ContextPart = { ...skill("m", 700, false), manualOnly: true };
        assert.equal(lineOf(start, startManual).tokens, 100);
        assert.deepEqual(partMeta(startManual), { chip: { word: "Manual only", done: false }, text: "" });
        assert.deepEqual(partMeta(unread), { chip: { word: "Not read yet", done: false }, text: "" });
      });

      test("flatParts takes the server's rows into one group, with their state", () => {
        const v = { state: "ok", cwd: "/p", window: 100, total: 1, prompt: true, instructions: [], mode: null, rules: [], tools: [], conversation: 0, nested: [], checkedAt: 0, skills: [{ id: "skill:a", label: "a", tokens: 1, read: false }], nestedSkills: [{ id: "skill:/p/x", label: "x", tokens: 2, read: false, offered: false, folder: "svc", manualOnly: true }] } as never;
        const ps = flatParts(v).filter((p) => p.group === "skills");
        assert.deepEqual(ps.map((p) => [p.label, p.folder, p.offered, p.manualOnly]), [["a", undefined, undefined, undefined], ["x", "svc", false, true]]);
      });
    });

    test("its sheet: the summary, the card of skills read, then Not read yet, with no word of not counting", () => {
      const sheet = groupSheet(lineOf(skill("a", 1_500, true), skill("b", 500, false), skill("c", 400, false)));
      assert.equal(sheet.sub, "1 read · 2 not read yet");
      assert.deepEqual(sheet.above.map((p) => p.label), ["a"]);
      assert.deepEqual(sheet.below?.parts.map((p) => p.label), ["b", "c"]);
      assert.equal(sheet.below?.heading, "Not read yet");
      assert.doesNotMatch(`${sheet.below?.heading} ${sheet.below?.note}`, /not counted|loads the first time/i);
    });

    test("with one group only that group shows: all read has no section, none read has no card", () => {
      const read = groupSheet(lineOf(skill("a", 1_500, true), skill("b", 500, true)));
      assert.equal(read.sub, "2 read");
      assert.equal(read.below, null);
      assert.deepEqual(read.above.map((p) => p.label), ["a", "b"]);
      const unread = groupSheet(lineOf(skill("a", 1_500, false), skill("b", 500, false)));
      assert.equal(unread.sub, "0 read · 2 not read yet");
      assert.deepEqual(unread.above, []);
      assert.deepEqual(unread.below?.parts.map((p) => p.label), ["a", "b"]);
    });

    test("Instruction files keeps its own heading and note, and its short line on top", () => {
      const sheet = groupSheet(contextLayout(base).lines.find((x) => x.kind === "instructions")!);
      assert.equal(sheet.sub, "3 loaded · 1 not yet loaded");
      assert.equal(sheet.below?.heading, "Not yet loaded · not counted");
      assert.equal(sheet.below?.note, NOT_LOADED_NOTE);
      assert.deepEqual(sheet.below?.parts.map((p) => p.label), ["web/AGENTS.md"]);
    });

    test("any other group has one card and no section", () => {
      const sheet = groupSheet(contextLayout(base).lines.find((x) => x.kind === "tools")!);
      assert.equal(sheet.sub, "1 tool");
      assert.equal(sheet.below, null);
    });
  });

  test("Conversation lists its counts biggest first, then the kept summary; its size is the server's estimate", () => {
    const talk = contextLayout(base).lines.find((x) => x.kind === "conversation")!;
    assert.deepEqual(talk.parts.map((p) => p.label), ["Tool results", "Replies", "Your messages", "Compaction summary"]);
    assert.equal(talk.tokens, 20_000);
    assert.equal(talk.meta, "Since the last compaction · 17 messages");
    const fresh = contextLayout({ ...base, parts: parts.filter((p) => p.id !== "conversation:summary") }).lines.find((x) => x.kind === "conversation")!;
    assert.equal(fresh.meta, "17 messages");
    // An older server sends no counts: the line stays, with nothing to list.
    const old = contextLayout({ ...base, parts: parts.filter((p) => p.group !== "conversation") }).lines.find((x) => x.kind === "conversation")!;
    assert.deepEqual([old.meta, old.parts.length], ["", 0]);
  });

  test("each group's short line", () => {
    const l = contextLayout({ ...base, parts: [...parts, { id: "mode:section:mode", group: "mode", label: "Mode", tokens: 100, text: "m" }] });
    const meta = Object.fromEntries(l.lines.map((x) => [x.kind, x.meta]));
    assert.deepEqual(meta, {
      conversation: "Since the last compaction · 17 messages",
      tools: "1 tool",
      instructions: "3 loaded · 1 not yet loaded",
      skills: "2 skills · 1 read",
      rules: "2 sections",
      mode: "Mode",
    });
  });

  test("the groups and Other add up to the total; Free is the window less it", () => {
    const l = contextLayout(base);
    const known = l.lines.reduce((n, x) => n + x.tokens, 0);
    assert.equal(l.other, 50_000 - known);
    assert.equal(known + l.other!, 50_000);
    assert.equal(l.free, 150_000);
  });

  test("Other is floored at 0 when the estimates overshoot the reported total", () => {
    assert.equal(contextLayout({ ...base, total: 10_000 }).other, 0);
  });

  test("before the first reply: the estimates alone, no Other and no room left", () => {
    const l = contextLayout({ ...base, total: null });
    assert.deepEqual([l.other, l.free], [null, null]);
    assert.equal(contextHeadline(null, 200_000), "Nothing sent yet");
    assert.equal(contextRoom(null, 200_000), null);
    assert.deepEqual(meterShares(l, 200_000), []);
  });

  test("the fill bar: a share per group then Other, never past the whole window", () => {
    const l = contextLayout(base);
    const shares = meterShares(l, 200_000);
    assert.deepEqual(shares.map((s) => s.id), [...l.lines.map((x) => x.id), "other"]);
    assert.ok(Math.abs(shares.reduce((n, s) => n + s.pct, 0) - 25) < 1e-9);
    const over = meterShares(contextLayout({ ...base, total: 400_000 }), 200_000);
    assert.ok(over.reduce((n, s) => n + s.pct, 0) <= 100 + 1e-9);
    assert.deepEqual(meterShares(l, null), []);
  });

  test("a row's share bar: none without a window or for a file not yet loaded; a sliver for a tiny part", () => {
    assert.equal(shareOf(1, 200_000), 0.5);
    assert.equal(shareOf(100_000, 200_000), 50);
    assert.equal(shareOf(0, 200_000), 0);
    assert.equal(shareOf(100, null), null);
    assert.equal(shareOf(100, 200_000, false), null);
  });
});

describe("a part's row and reading", () => {
  const get = (id: string) => parts.find((p) => p.id === id)!;

  test("what opens: a file or a text; a conversation count doesn't", () => {
    assert.equal(partOpens(get("instructions:file:/p/AGENTS.md")), true);
    assert.equal(partOpens(get("tools:tool:read")), true);
    assert.equal(partOpens(get("conversation:summary")), true);
    assert.equal(partOpens(get("conversation:replies")), false);
  });

  test("short lines: a file's folder and Loaded, a skill's description and Read or Not read yet, a count's words", () => {
    assert.deepEqual(partMeta(get("instructions:file:/p/AGENTS.md")), { chip: { word: "Loaded", done: true }, text: "This chat's folder" });
    assert.deepEqual(partMeta(get("instructions:file:/h/AGENTS.md")), { chip: { word: "Loaded", done: true }, text: "Your home folder" });
    assert.deepEqual(partMeta(get("subfolder:/p/api/AGENTS.md")), { chip: { word: "Loaded", done: true }, text: "api/" });
    assert.deepEqual(partMeta(get("subfolder:/p/web/AGENTS.md")), { text: "web/" });
    assert.deepEqual(partMeta(get("skills:skill:a")), { chip: { word: "Read", done: true }, text: "Does a." });
    assert.deepEqual(partMeta(get("skills:skill:b")), { chip: { word: "Not read yet", done: false }, text: "" });
    assert.deepEqual(partMeta(get("conversation:toolResults")), { text: "9 results" });
    assert.deepEqual(partMeta({ ...get("conversation:replies"), count: 1 }), { text: "1 reply" });
    assert.deepEqual(partMeta(get("conversation:user")), { text: "4 messages" });
    assert.deepEqual(partMeta(get("conversation:summary")), { text: `Kept from the compaction at ${clockOf("2026-11-05T14:06:00")}` });
    assert.equal(clockOf("2026-11-05T14:06:00"), "14:06");
    assert.equal(clockOf(undefined), "");
    assert.equal(fileFolder({ group: "instructions", label: "~/.pi/agent/AGENTS.md" }), "~/.pi/agent/");
    assert.equal(fileFolder({ group: "instructions", label: "/etc/AGENTS.md" }), "/etc/");
  });

  test("the subtitle is the full path for a file or a skill, else the group's name; the notes", () => {
    assert.equal(partSubtitle(get("skills:skill:a"), { label: "Skills offered" }), "/s/a/SKILL.md");
    assert.equal(partSubtitle(get("tools:tool:read"), { label: "Tools" }), "Tools");
    assert.match(partNote(get("subfolder:/p/web/AGENTS.md"))!, /^Not counted yet\. It loads the first time the agent reads, edits or writes a file in web\.$/);
    assert.equal(partNote(get("subfolder:/p/api/AGENTS.md")), null);
    assert.match(partNote(get("skills:skill:b"))!, /only what the model is offered/);
    assert.equal(partNote(get("tools:tool:read")), null);
  });

  test("a tool shows as JSON, a file by its path, anything else as markdown", () => {
    assert.equal(partLang({ group: "tools" }), "json");
    assert.equal(partLang({ group: "skills", path: "/a/SKILL.md" }), "markdown");
    assert.equal(partLang({ group: "skills", path: "/a/run.mjs" }), "javascript");
    assert.equal(partLang({ group: "rules" }), "markdown");
    assert.equal(partLang({ group: "conversation" }), "markdown");
  });
});

describe("the server's read", () => {
  test("flattens into parts with group-unique ids: nested files with their state, skills with description and read state, the conversation's counts", () => {
    const v: Extract<SessionContextView, { state: "ok" }> = {
      state: "ok", cwd: "/p", window: 1000, total: 10, prompt: true, conversation: 5, checkedAt: 0,
      instructions: [{ id: "x", label: "AGENTS.md", tokens: 3, path: "/p/AGENTS.md" }],
      mode: { id: "x", label: "Mode", tokens: 2, text: "m" },
      rules: [], skills: [{ id: "skill:pdf", label: "pdf", detail: "Read PDFs.", path: "/s/pdf/SKILL.md", tokens: 9, read: false }], tools: [{ id: "read", label: "read", tokens: 4, text: "{}" }],
      nested: [{ path: "api/AGENTS.md", abs: "/p/api/AGENTS.md", folder: "api", tokens: 1, loaded: false }],
      talk: { user: { count: 2, tokens: 3 }, replies: { count: 1, tokens: 2 }, toolResults: { count: 0, tokens: 0 }, other: { count: 0, tokens: 0 }, summary: { text: "S", tokens: 1, at: "2026-01-01T00:00:00Z" } },
    };
    const ps = flatParts(v);
    assert.deepEqual(ps.map((p) => p.group), ["instructions", "subfolder", "mode", "skills", "tools", "conversation", "conversation", "conversation"]);
    assert.equal(new Set(ps.map((p) => p.id)).size, ps.length);
    assert.deepEqual(ps[1], { id: "subfolder:/p/api/AGENTS.md", group: "subfolder", label: "api/AGENTS.md", tokens: 1, path: "/p/api/AGENTS.md", folder: "api", loaded: false });
    assert.deepEqual(ps[3], { id: "skills:skill:pdf", group: "skills", label: "pdf", tokens: 9, path: "/s/pdf/SKILL.md", detail: "Read PDFs.", read: false });
    assert.deepEqual(ps.slice(5).map((p) => [p.label, p.count, p.tokens, p.text]), [["Replies", 1, 2, undefined], ["Your messages", 2, 3, undefined], ["Compaction summary", undefined, 1, "S"]]);
    assert.deepEqual(flatParts({ ...v, talk: undefined }).filter((p) => p.group === "conversation"), []);
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
    assert.equal(contextLayout({ ...base, window: null }).free, null);
  });
});
