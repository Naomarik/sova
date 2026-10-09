// Run: npx tsx --test server/session-autotitle.test.ts
// Sova naming sessions itself (§app.session-list/auto-titles): the title store's provenance, what
// may be named, the input and the prompt (never the current title, never an agent prompt), the
// validator, the model chain, the race-safe write, the button route's dry run and the sweep.
// A throwaway PI_CODING_AGENT_DIR; every model is a fake — no model is ever called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { SessionSummary, SessionTitleSettings } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-autotitle-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-autotitle--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
mkdirSync(join(agentDir, "sova"), { recursive: true });

const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { readSessionTitleRecords, replaceAutoTitle, setSessionTitle, writeAutoTitle } = await import("./session-titles");
const { getSessionSummary } = await import("./sessions-index");
const { canonicalPath } = await import("./paths");
const at = await import("./session-autotitle");
const { DecisionError } = await import("./decide");
type LlmRuntime = import("./decide-llm").LlmRuntime;

after(async () => {
  rmSync(agentDir, { recursive: true, force: true });
});

const titlesFile = join(agentDir, "sova", "session-titles.json");
let n = 0;
const newId = () => `01234567-89ab-7cde-8f01-${String(++n).padStart(12, "0")}`;
const line = (o: unknown) => JSON.stringify(o);
const header = (id: string) => line({ type: "session", version: 3, id, timestamp: "2026-09-21T00:00:00.000Z", cwd: "/tmp" });
const user = (text: string) => line({ type: "message", id: `u${++n}`, parentId: null, timestamp: "2026-09-21T00:00:01.000Z", message: { role: "user", content: text } });
const outline = (overall: string, topics: { heading: string; summary: string[] }[]) =>
  line({ type: "custom", customType: "topic-outline", data: { version: 2, now: "The assistant is working.", overall, topics, generatedAt: 1 } });

function session(lines: string[]): { id: string; path: string } {
  const id = newId();
  const path = join(sessionsDir, `2026-09-21T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[header(id), ...lines].join("\n")}\n`);
  return { id, path: canonicalPath(path) };
}

const settings = (over: Partial<SessionTitleSettings> = {}): SessionTitleSettings => ({
  version: 1,
  enabled: true,
  intervalMinutes: 5,
  quietMinutes: 5,
  primary: { backend: "pi", model: "prov/title-a", effort: "off" },
  fallback: { backend: "pi", model: "prov/title-b", effort: "off" },
  ...over,
});

/** A fake pi runtime: `reply(model)` answers each call; every call's context and options are kept. */
function fakeRuntime(reply: (model: string) => string | Error | Promise<string>) {
  const calls: { model: string; context: { systemPrompt: string; messages: { role: string; content: { text: string }[] }[] }; options: Record<string, unknown> }[] = [];
  const runtime: LlmRuntime = {
    getModel: (_p: string, id: string) => ({ id, reasoning: false }),
    hasConfiguredAuth: () => true,
    completeSimple: async (m: never, context: unknown, options?: unknown) => {
      const model = (m as { id: string }).id;
      calls.push({ model, context: context as never, options: options as Record<string, unknown> });
      const r = await reply(model);
      if (r instanceof Error) throw r;
      return { content: [{ type: "text", text: r }], stopReason: "stop", usage: { input: 10, output: 5 } };
    },
  };
  return { runtime: async () => runtime, calls };
}

const deps = (runtime: () => Promise<LlmRuntime>, over: Partial<import("./session-autotitle").NameDeps> = {}) => ({
  runtime,
  settings: () => settings(),
  summary: (p: string) => getSessionSummary(p),
  ...over,
});

describe("the title store's provenance", () => {
  test("a v1 file reads: every bare string is an explicit user title, and a later write keeps it a bare string", () => {
    writeFileSync(titlesFile, JSON.stringify({ version: 1, titles: { a: "Legacy one", b: "Legacy two" } }));
    const r = readSessionTitleRecords();
    assert.deepEqual({ ...r.a }, { title: "Legacy one", by: "user", legacy: true });
    setSessionTitle("c", "Set by the Overseer", "overseer", 42);
    const raw = JSON.parse(readFileSync(titlesFile, "utf8"));
    assert.equal(raw.version, 2);
    assert.equal(raw.titles.a, "Legacy one"); // untouched legacy entries stay bare strings
    assert.deepEqual(raw.titles.c, { title: "Set by the Overseer", by: "overseer", at: 42 });
    // The namer never replaces a legacy or an Overseer title, redo or not.
    assert.equal(writeAutoTitle("a", "Auto over legacy", { redo: true }), false);
    assert.equal(writeAutoTitle("c", "Auto over overseer", { redo: true }), false);
    assert.equal(readSessionTitleRecords().a?.title, "Legacy one");
    // Unnamed: written; the sweep (no redo) never renames it; the button (redo) may.
    assert.equal(writeAutoTitle("d", "First auto title"), true);
    assert.equal(writeAutoTitle("d", "Second auto title"), false);
    assert.equal(writeAutoTitle("d", "Redone auto title", { redo: true }), true);
    assert.equal(readSessionTitleRecords().d?.by, "auto");
    // A user rename replaces an auto title, and clearing forgets it outright.
    setSessionTitle("d", "Mine now");
    assert.equal(readSessionTitleRecords().d?.by, "user");
    setSessionTitle("d", null);
    assert.equal(readSessionTitleRecords().d, undefined);
    for (const id of ["a", "b", "c"]) setSessionTitle(id, null);
  });

  test("an object entry with an unknown `by` is explicit, and a broken one costs only itself", () => {
    writeFileSync(titlesFile, JSON.stringify({ version: 2, titles: { x: { title: "Odd", by: "robot" }, y: { nope: 1 }, z: { title: "Auto", by: "auto", at: 5 } } }));
    const r = readSessionTitleRecords();
    assert.equal(r.x?.by, "user");
    assert.equal(r.y, undefined);
    assert.deepEqual({ ...r.z }, { title: "Auto", by: "auto", at: 5 });
    writeFileSync(titlesFile, JSON.stringify({ version: 2, titles: {} }));
    readSessionTitleRecords();
  });

  test("POST /api/sessions/title records its source, refuses a bad one, and the summary carries titleBy", async () => {
    const s = session([user("derived words here")]);
    const post = (body: unknown) => app.request("/api/sessions/title", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ path: s.path, title: "By the Overseer", source: "overseer" })).status, 200);
    assert.equal(readSessionTitleRecords()[s.id]?.by, "overseer");
    assert.equal((await getSessionSummary(s.path))?.titleBy, "overseer");
    assert.equal((await post({ path: s.path, title: "Sneaky", source: "auto" })).status, 400);
    assert.equal(readSessionTitleRecords()[s.id]?.title, "By the Overseer");
    const res = await post({ path: s.path, title: "By hand" });
    assert.equal(((await res.json()) as SessionSummary).titleBy, "user");
    // A stored title equal to the derived one still says who set it (so no button counts it).
    await post({ path: s.path, title: "derived words here" });
    const same = await getSessionSummary(s.path);
    assert.equal(same?.originalTitle, undefined);
    assert.equal(same?.titleBy, "user");
    await post({ path: s.path, title: null });
    assert.equal((await getSessionSummary(s.path))?.titleBy, undefined);
  });
});

describe("eligibility", () => {
  const base = { id: "i", path: "/p", cwd: "/", title: "t", createdAt: "", lastActiveAt: "2026-09-21T00:00:00.000Z", model: null, live: null, busy: false, origin: "web", archived: false, outlineGist: "Gist" } as SessionSummary;
  const now = Date.parse("2026-09-21T00:10:00.000Z");

  test("the button: explicit (user, Overseer, or an older server's override) and non-threads are skipped; auto may be redone", () => {
    assert.equal(at.buttonSkip(null), "not-found");
    assert.equal(at.buttonSkip({ ...base, titleBy: "user", originalTitle: "t0" }), "explicit");
    assert.equal(at.buttonSkip({ ...base, titleBy: "overseer" }), "explicit");
    assert.equal(at.buttonSkip({ ...base, originalTitle: "t0" }), "explicit");
    assert.equal(at.buttonSkip({ ...base, workerSession: true }), "not-listed");
    assert.equal(at.buttonSkip({ ...base, overseer: true }), "not-listed");
    assert.equal(at.buttonSkip({ ...base, titleBy: "auto", originalTitle: "t0" }), null);
    assert.equal(at.buttonSkip(base), null);
  });

  test("the sweep: unnamed, summarized, quiet, not archived, not a worker or Overseer file; any group member", () => {
    const ok = (s: Partial<SessionSummary>, quiet = 5 * 60_000) => at.sweepEligible({ ...base, ...s }, now, quiet);
    assert.equal(ok({}), true);
    assert.equal(ok({ titleBy: "auto" }), false); // named once
    assert.equal(ok({ titleBy: "user" }), false);
    assert.equal(ok({ originalTitle: "x" }), false);
    assert.equal(ok({ archived: true }), false);
    assert.equal(ok({ outlineGist: undefined }), false);
    assert.equal(ok({ workerSession: true }), false);
    assert.equal(ok({ overseer: true }), false);
    assert.equal(ok({ projectOverseer: { projectId: "p" } }), false);
    assert.equal(ok({ groupId: "mine" }), true); // an old group's member included (§workspace.groups/legacy-groups)
    assert.equal(ok({}, 11 * 60_000), false); // not quiet long enough
  });
});

describe("input, prompt and validation", () => {
  test("the input: first user messages (never a wake nudge), the LAST snapshot, 2 bullets per topic", async () => {
    const s = session([
      user("Please add a diff viewer to the session pane"),
      outline("Old gist", [{ heading: "Old", summary: ["x"] }]),
      user("[wake_nudge n1] Scheduled wakeup fired (set 4m ago).\nReason: (none)\nCarry on."),
      user("And make hunks collapsible"),
      outline("Inline git diff viewer design", [
        { heading: "Diff viewer layout", summary: ["one", "two", "three"] },
        { heading: "Hunk folding", summary: ["four"] },
      ]),
    ]);
    const input = await at.readTitleInput(s.path);
    assert.deepEqual(input.userMessages, ["Please add a diff viewer to the session pane", "And make hunks collapsible"]);
    assert.equal(input.summaryLine, "Inline git diff viewer design");
    assert.deepEqual(input.topics, [
      { heading: "Diff viewer layout", bullets: ["one", "two"] },
      { heading: "Hunk folding", bullets: ["four"] },
    ]);
    const prompt = at.buildTitlePrompt(input);
    // The summary line first, labelled as what the row already shows; the first message last.
    assert.match(prompt, /^SUMMARY LINE \(already shown under the title; don't just copy it, though the title may share its subject\):\nInline git diff viewer design\n/);
    assert.ok(prompt.includes("):\n- Diff viewer layout\n  - one\n  - two\n- Hunk folding"));
    assert.match(prompt, /\nFIRST MESSAGE \([^)]*\):\nPlease add a diff viewer to the session pane$/);
    assert.ok(prompt.indexOf("TOPICS") < prompt.indexOf("FIRST MESSAGE"));
    assert.ok(!prompt.includes("three"));
    assert.ok(!prompt.includes("Old gist"));
  });

  test("without a summary line: the first 3 user messages, the first whole up to 2000 characters, the others cut to 600", () => {
    const long = "x".repeat(700);
    const p = at.buildTitlePrompt({ userMessages: [long, long, "three"], topics: [] });
    assert.ok(p.startsWith("FIRST MESSAGES:\n1. "));
    assert.equal(p.split("\n")[1], `1. ${long}`);
    assert.equal(p.split("\n")[2]!.length, 3 + 600);
    assert.ok(p.split("\n")[2]!.endsWith("…"));
    assert.ok(p.includes("\n3. three"));
  });

  test("validateTitle: 2–5 words, ≤36 characters, quotes and a trailing period dropped", () => {
    assert.equal(at.TITLE_MAX_CHARS, 36);
    assert.deepEqual(at.TITLE_WORDS, { min: 2, max: 5 });
    assert.equal(at.validateTitle("Inline git diff viewer"), "Inline git diff viewer");
    assert.equal(at.validateTitle('"Session switch layout shift fix."'), "Session switch layout shift fix");
    assert.equal(at.validateTitle("  Push   subscription bug "), "Push subscription bug");
    assert.equal(at.validateTitle("Diff"), null);
    assert.equal(at.validateTitle("one two three four five six"), null); // 6 words
    assert.equal(at.validateTitle("one two three four five"), "one two three four five");
    // 36 characters is the edge: one more is refused.
    const edge = `Ab ${"c".repeat(33)}`;
    assert.equal(edge.length, 36);
    assert.equal(at.validateTitle(edge), edge);
    assert.equal(at.validateTitle(`${edge}d`), null);
    assert.equal(at.validateTitle("Session titles: shorter labels for the sidebar"), null); // the old 60-character style
    assert.equal(at.validateTitle("two\u0007 bells"), null);
    assert.equal(at.validateTitle(7), null);
  });

  test("the rules ask for the accurate subject plus one relevant detail the summary line lacks, never a reworded summary line, with no overlap ban", () => {
    const p = at.TITLE_SYSTEM_PROMPT;
    assert.match(p, /2 to 5 words, at most 36 characters/);
    assert.match(p, /noun phrase/i);
    assert.match(p, /No "X: Y"/);
    assert.match(p, /summary line under it[^\n]*already explains it/);
    // The positive ask: one concrete detail about the main subject, from the headings or the opening.
    assert.match(p, /Add what the summary line lacks: one concrete detail about that main subject, from the topic headings or the first message/);
    // Sharing the subject is allowed; a shortened, reordered or reworded summary line is not, when a detail exists.
    assert.match(p, /Sharing the summary line's subject words or phrase is fine, but when such a detail is there, never make the title just the summary line shortened, reordered or reworded/);
    // Accuracy outranks novelty: the detail never comes from a side issue, and none is invented.
    assert.match(p, /An accurate subject still comes first: never take the detail from a late bullet or side issue/);
    assert.match(p, /when there is no relevant detail to add, name the recognizable subject rather than inventing one/);
    assert.match(p, /Topic bullets are secondary recent details: they may sharpen the subject, never replace it/);
    assert.match(p, /topic headings, the summary line's overall purpose and the first message name it/);
    assert.ok(!/Never reuse its wording|its first words/.test(p), "the old no-overlap rule is gone");
    assert.match(p, /Merges, releases, pushes: name the first one or two branches or features that landed/);
    assert.ok(!/60 characters|2 to 7 words/.test(p));
    // Every example title the rules give passes the validator: the rules and the check agree.
    const examples = [...p.matchAll(/→ "([^"]+)"/g)].map((m) => m[1]!);
    assert.equal(examples.length, 3, examples.join(" | "));
    for (const e of examples) assert.equal(at.validateTitle(e), e, e);
  });

  test("Claude Code's argv: the rules as the whole system prompt, no tools, no settings, no MCP, and no --json-schema", () => {
    const argv = at.titleClaudeArgs({ backend: "claude-code", model: "sonnet", effort: "low" });
    assert.equal(argv[argv.indexOf("--system-prompt") + 1], at.TITLE_SYSTEM_PROMPT);
    assert.equal(argv[argv.indexOf("--tools") + 1], "");
    assert.equal(argv[argv.indexOf("--setting-sources") + 1], "");
    assert.ok(argv.includes("--strict-mcp-config"));
    assert.ok(argv.includes("--no-session-persistence"));
    assert.ok(!argv.includes("--json-schema"));
    assert.deepEqual(argv.slice(-2), ["--effort", "low"]);
  });
});

describe("the first request and the subject hierarchy", () => {
  // A first message shaped like the one that once lost its goal: setting first, the goal past 600.
  const setting =
    "So here's what I want. The new screen we have is very important. We have a profile picker, then the whole system context, which I don't need to look at all the time. " +
    "The system context block should be collapsed by default, and then I can expand it and see everything that's already there, which is great. The repository row is good. " +
    "We can probably keep that outside of the context block. But what I want is the following. I should be able to click on different profiles, kind of like our subagent profiles. ";
  const goal = "The goal: a grid of one-click setup buttons, each a main model plus its helper models, so one press starts the session I want.";
  const opening = (setting + "And to be clear about the shape of it, I mean real buttons, not a drop-down. ".repeat(20)).slice(0, 1060 - goal.length - 1) + " " + goal;
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const parts = (x: string) => {
    const [head, tail, ...rest] = x.split(at.FIRST_REQUEST_GAP);
    assert.equal(rest.length, 0, "exactly one gap marker");
    return { head: head!, tail: tail! };
  };

  test("a 1060-character first message with its goal past 600 reaches the model whole, with or without a summary line", () => {
    assert.equal(opening.length, 1060);
    assert.ok(opening.indexOf(goal) > 600);
    const withSummary = at.buildTitlePrompt({ userMessages: [opening], summaryLine: "One-click session setups", topics: [{ heading: "One-click setups", bullets: ["A side issue"] }] });
    const without = at.buildTitlePrompt({ userMessages: [opening, "second"], topics: [] });
    for (const p of [withSummary, without]) {
      assert.ok(p.includes(opening), "the whole message, goal included");
      assert.ok(!p.includes(at.FIRST_REQUEST_GAP) && !p.includes("…"));
    }
    assert.ok(withSummary.endsWith(`\n${opening}`));
    assert.ok(without.includes(`\n1. ${opening}\n2. second`));
  });

  test("the thresholds: 2000 characters go in whole, 2001 are excerpted to a ≤1500 head, the marker and a ≤500 tail", () => {
    assert.deepEqual([at.FIRST_REQUEST_WHOLE_MAX, at.FIRST_REQUEST_HEAD_MAX, at.FIRST_REQUEST_TAIL_MAX, at.FIRST_REQUEST_GAP, at.WORD_BOUNDARY_REACH], [2000, 1500, 500, " […] ", 40]);
    const words = "alpha beta gamma delta ".repeat(100);
    const exact = words.slice(0, 2000);
    assert.equal(at.firstRequestExcerpt(exact), exact);
    const over = words.slice(0, 2001);
    const { head, tail } = parts(at.firstRequestExcerpt(over));
    assert.ok(head.length <= 1500 && head.length >= 1500 - 40, `${head.length}`);
    assert.ok(tail.length <= 500 && tail.length >= 500 - 40, `${tail.length}`);
    // Whole words only: the head is a prefix ending at a space, the tail a suffix starting after one.
    assert.ok(over.startsWith(head) && /\s/.test(over[head.length]!));
    assert.ok(over.endsWith(tail) && /\s/.test(over[over.length - tail.length - 1]!));
    assert.equal(at.firstRequestExcerpt(""), "");
  });

  test("a long message in both forms: the excerpt keeps its start and its end", () => {
    const long = `START ${"filler words here ".repeat(200)}END goal stated last`;
    assert.ok(long.length > 2000);
    const ex = at.firstRequestExcerpt(long);
    const s = at.buildTitlePrompt({ userMessages: [long], summaryLine: "Gist", topics: [] });
    const n = at.buildTitlePrompt({ userMessages: [long, long], topics: [] });
    assert.ok(s.endsWith(`\n${ex}`));
    assert.ok(n.includes(`\n1. ${ex}\n2. `));
    assert.ok(ex.startsWith("START ") && ex.endsWith("END goal stated last"));
    // The second message keeps the 600 cut.
    assert.equal(n.split("\n")[2]!.length, 3 + at.FIRST_MESSAGE_MAX);
  });

  test("a cut moves inward at most 40 characters to a space, never outward; with none in reach it stays put", () => {
    const L = 2600;
    const start = L - 500;
    const at40 = (head: number, tail: number) => {
      const c = Array.from({ length: L }, () => "x");
      c[head] = " ";
      c[tail] = " ";
      return c.join("");
    };
    // Spaces 40 in: the head ends at 1460, the tail starts 40 later.
    let p = parts(at.firstRequestExcerpt(at40(1460, start + 39)));
    assert.equal(p.head.length, 1460);
    assert.equal(p.tail.length, 460);
    // 41 in: out of reach, so the plain cuts stand (never a space further out).
    p = parts(at.firstRequestExcerpt(at40(1459, start + 40)));
    assert.equal(p.head.length, 1500);
    assert.equal(p.tail.length, 500);
    // A space right at the cut: nothing moves.
    p = parts(at.firstRequestExcerpt(at40(1500, start - 1)));
    assert.equal(p.head.length, 1500);
    assert.equal(p.tail.length, 500);
    // No space at all.
    p = parts(at.firstRequestExcerpt("x".repeat(L)));
    assert.deepEqual([p.head.length, p.tail.length], [1500, 500]);
  });

  test("never splits a surrogate pair, at either cut", () => {
    // "a" shifts the pairs so the head cut lands inside one; "b" does the same for the tail.
    const text = `a${"😀".repeat(1100)}b`;
    const ex = at.firstRequestExcerpt(text);
    assert.ok(!lone.test(ex), "no lone surrogate");
    const { head, tail } = parts(ex);
    assert.equal(head.length, 1499);
    assert.equal(tail.length, 499);
    assert.ok(text.startsWith(head) && text.endsWith(tail));
    // A pair across each plain cut, and a space 40 or 41 from that plain cut: the surrogate step
    // counts toward the 40, so 41 away stays out of reach (the surrogate-safe cut stands).
    const L = 2600;
    const tailCut = L - 500;
    const straddled = (headSpace: number, tailSpace: number) => {
      const c = Array.from({ length: L }, () => "x");
      [c[1499], c[1500]] = ["\uD83D", "\uDE00"];
      [c[tailCut - 1], c[tailCut]] = ["\uD83D", "\uDE00"];
      c[headSpace] = " ";
      c[tailSpace] = " ";
      return c.join("");
    };
    let s = straddled(1500 - 40, tailCut + 39);
    let p = parts(at.firstRequestExcerpt(s));
    assert.deepEqual([p.head.length, p.tail.length], [1460, 460]);
    assert.ok(s.startsWith(p.head) && s.endsWith(p.tail));
    s = straddled(1500 - 41, tailCut + 40);
    p = parts(at.firstRequestExcerpt(s));
    assert.deepEqual([p.head.length, p.tail.length], [1499, 499]);
    assert.ok(!lone.test(p.head) && !lone.test(p.tail), "no lone surrogate");
    assert.ok(s.startsWith(p.head) && s.endsWith(p.tail));
    // Unicode words with spaces still trim to a word boundary.
    const words = "café über naïve 日本語 ".repeat(200);
    const w = parts(at.firstRequestExcerpt(words));
    assert.ok(words.startsWith(w.head) && /\s/.test(words[w.head.length]!));
    assert.ok(!lone.test(w.head + w.tail));
  });

  test("an empty first request still ends the prompt with its label", () => {
    const p = at.buildTitlePrompt({ userMessages: [], summaryLine: "Gist", topics: [] });
    assert.match(p, /\nFIRST MESSAGE \([^)]*\):\n$/);
  });

  test("the labels rank the subject: summary (may share its subject), headings as subjects, bullets secondary, the opening intent last", () => {
    const p = at.buildTitlePrompt({ userMessages: ["Make one-click setup buttons"], summaryLine: "One-click session setups", topics: [{ heading: "One-click setups", bullets: ["New issue: a side bug"] }] });
    const summary = p.indexOf("SUMMARY LINE (");
    const topics = p.indexOf("\nTOPICS (");
    const first = p.indexOf("\nFIRST MESSAGE (");
    assert.ok(summary === 0 && summary < topics && topics < first);
    assert.match(p, /SUMMARY LINE \([^)]*don't just copy it[^)]*may share its subject\)/);
    assert.match(p, /TOPICS \([^)]*each heading is a subject[^)]*bullets are secondary recent details[^)]*side issues\)/);
    assert.match(p, /FIRST MESSAGE \([^)]*opening intent[^)]*moved on[^)]*\)/);
    assert.match(at.TITLE_SYSTEM_PROMPT, /If the session truly moved on to a new main goal, name that goal/);
  });

  test("every example adds a content word its summary line lacks, one shares a subject phrase, and none is the presets case", () => {
    const pairs = [...at.TITLE_SYSTEM_PROMPT.matchAll(/"([^"]+)" → "([^"]+)"/g)].map((m) => ({ summary: m[1]!, title: m[2]! }));
    assert.equal(pairs.length, 3);
    for (const x of pairs) assert.equal(at.validateTitle(x.title), x.title, x.title);
    // Content words: lower-cased word tokens (hyphenated words whole), function words dropped.
    const STOP = new Set(["a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "by", "with", "from", "into", "then", "when", "is", "are", "its", "it", "as", "this", "that"]);
    const content = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? []).filter((w) => !STOP.has(w));
    const added = (summary: string, title: string) => {
      const have = new Set(content(summary));
      return content(title).filter((w) => !have.has(w));
    };
    // The check tells the two cases apart: a reordered summary line (even with a stray "the") adds nothing.
    assert.deepEqual(added("Dark mode for the settings dialog", "Settings dialog dark mode"), []);
    assert.deepEqual(added("Settings dialog dark mode", "The settings dialog dark mode"), []);
    assert.deepEqual(added("Fixing the settings dialog in dark mode", "Settings dialog contrast bug"), ["contrast", "bug"]);
    for (const x of pairs) assert.ok(added(x.summary, x.title).length >= 1, `${x.title} adds nothing to "${x.summary}"`);
    // At least one keeps the subject recognizable: two content words in a row taken from its summary line.
    const bigrams = (ws: string[]) => ws.slice(1).map((w, i) => `${ws[i]} ${w}`);
    const shared = pairs.filter((x) => {
      const have = new Set(bigrams(content(x.summary)));
      return bigrams(content(x.title)).some((b) => have.has(b));
    });
    assert.ok(shared.length >= 1, JSON.stringify(pairs));
    assert.ok(pairs.every((x) => !/preset|setup|subagent/i.test(x.summary + x.title)));
  });
});

describe("naming a session", () => {
  test("the button names an unnamed session: the call carries only the rules and the input, never the current title", async () => {
    const s = session([user("why does the list jump when I switch sessions"), outline("Fixing layout shift when switching sessions", [])]);
    writeAutoTitle(s.id, "Previous automatic name", { redo: true });
    const f = fakeRuntime(() => '{"title": "Session switch layout shift fix"}');
    const r = await at.nameSession(s.path, "button", deps(f.runtime));
    assert.deepEqual(r, { outcome: "named", title: "Session switch layout shift fix" });
    assert.deepEqual({ ...readSessionTitleRecords()[s.id], at: 0 }, { title: "Session switch layout shift fix", by: "auto", at: 0 });
    assert.equal(f.calls.length, 1);
    const call = f.calls[0]!;
    assert.equal(call.context.systemPrompt, at.TITLE_SYSTEM_PROMPT);
    assert.equal(call.context.messages.length, 1);
    const sent = JSON.stringify(call.context);
    assert.ok(!sent.includes("Previous automatic name"), "the current title never reaches the model");
    assert.equal(call.options.temperature, 0);
    assert.equal(call.options.reasoning, undefined);
  });

  test("an explicit title is never touched: no call is made", async () => {
    const s = session([user("hello there friend"), outline("Greeting", [])]);
    setSessionTitle(s.id, "Hand-set", "overseer");
    const f = fakeRuntime(() => '{"title": "Should not be used"}');
    for (const mode of ["button", "sweep"] as const) assert.deepEqual(await at.nameSession(s.path, mode, deps(f.runtime)), { outcome: "skipped", reason: "explicit" });
    assert.equal(f.calls.length, 0);
    assert.equal(readSessionTitleRecords()[s.id]?.title, "Hand-set");
  });

  test("race: a title set by hand while the model was out wins, and the answer is dropped", async () => {
    const s = session([user("tune the cache warmer"), outline("Cache warmer tuning", [])]);
    const f = fakeRuntime(() => {
      setSessionTitle(s.id, "Typed meanwhile");
      return '{"title": "Cache warmer tuning"}';
    });
    assert.deepEqual(await at.nameSession(s.path, "button", deps(f.runtime)), { outcome: "skipped", reason: "explicit" });
    assert.deepEqual({ ...readSessionTitleRecords()[s.id], at: 0 }, { title: "Typed meanwhile", by: "user", at: 0 });
  });

  test("the sweep needs a summary line and never renames; the button needs neither", async () => {
    const bare = session([user("quick question about git rebase")]);
    const f = fakeRuntime(() => '{"title": "Git rebase question"}');
    const sweep = await at.nameSession(bare.path, "sweep", deps(f.runtime));
    assert.equal(sweep.outcome, "skipped");
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await at.nameSession(bare.path, "button", deps(f.runtime)), { outcome: "named", title: "Git rebase question" });
    assert.ok(f.calls[0]!.context.messages[0]!.content[0]!.text.startsWith("FIRST MESSAGES:\n1. quick question"));
    assert.deepEqual(await at.nameSession(bare.path, "sweep", deps(f.runtime)), { outcome: "skipped", reason: "explicit", detail: "already named" });
  });

  test("the chain: a bad primary answer falls to the fallback; a model that can't run is skipped; both failing is `failed`", async () => {
    const s = session([user("x y z"), outline("Some work", [])]);
    const f = fakeRuntime((model) => (model === "title-a" ? "no json at all" : '{"title": "Fallback wins here"}'));
    assert.deepEqual(await at.nameSession(s.path, "button", deps(f.runtime)), { outcome: "named", title: "Fallback wins here" });
    // The primary's unusable reply is asked once more, then the fallback.
    assert.deepEqual(f.calls.map((c) => c.model), ["title-a", "title-a", "title-b"]);
    const g = fakeRuntime(() => '{"title": "Only the fallback"}');
    const problem = async (c: { model: string }) => (c.model === "prov/title-a" ? "turned off in Settings → Models" : null);
    const r = await at.titleFromChain(settings(), "prompt", { runtime: g.runtime, problem });
    assert.deepEqual(r, { title: "Only the fallback" });
    assert.deepEqual(g.calls.map((c) => c.model), ["title-b"]);
    const none = await at.titleFromChain(settings(), "prompt", { runtime: g.runtime, problem: async () => "no key" });
    assert.equal("failure" in none && none.failure, "no-model");
    const quota = fakeRuntime(() => new DecisionError("quota", "out of credits"));
    const q = await at.titleFromChain(settings(), "prompt", { runtime: quota.runtime });
    assert.ok("failure" in q && q.failure === "failed" && q.backoff);
  });

  test("an unusable reply is asked once more with the reason; an error is never retried", async () => {
    // Too long: the second ask carries the same input plus the refused title's size.
    const long = fakeRuntime(() => (long.calls.length === 1 ? '{"title": "Virtual scrolling for session loading"}' : '{"title": "Transcript virtual scroll"}'));
    assert.deepEqual(await at.titleFromChain(settings({ fallback: null }), "THE INPUT", { runtime: long.runtime }), { title: "Transcript virtual scroll" });
    assert.equal(long.calls.length, 2);
    const second = long.calls[1]!.context.messages[0]!.content[0]!.text;
    assert.ok(second.startsWith("THE INPUT\n\nYOUR LAST ANSWER WAS NOT USABLE"), second);
    assert.match(second, /"Virtual scrolling for session loading" is 5 words and 37 characters/);
    assert.equal(long.calls[1]!.context.messages.length, 1);
    // An empty reply: asked again, saying no title came back.
    const empty = fakeRuntime(() => (empty.calls.length === 1 ? "" : '{"title": "Org e2e round 2"}'));
    assert.deepEqual(await at.titleFromChain(settings({ fallback: null }), "IN", { runtime: empty.runtime }), { title: "Org e2e round 2" });
    assert.match(empty.calls[1]!.context.messages[0]!.content[0]!.text, /no title came back/);
    // Two unusable replies: failed after exactly two asks, no loop.
    const bad = fakeRuntime(() => '{"title": "one two three four five six"}');
    const r = await at.titleFromChain(settings({ fallback: null }), "IN", { runtime: bad.runtime });
    assert.ok("failure" in r && r.failure === "failed" && !r.backoff);
    assert.equal(bad.calls.length, 2);
    // A timed-out ask is asked once more, unchanged; two timeouts fail without a third.
    const stall = fakeRuntime(() => (stall.calls.length === 1 ? new DecisionError("timeout", "did not answer") : '{"title": "Stalled then fine"}'));
    assert.deepEqual(await at.titleFromChain(settings({ fallback: null }), "IN", { runtime: stall.runtime }), { title: "Stalled then fine" });
    assert.equal(stall.calls[1]!.context.messages[0]!.content[0]!.text, "IN");
    const stalls = fakeRuntime(() => new DecisionError("timeout", "did not answer"));
    assert.ok("failure" in (await at.titleFromChain(settings({ fallback: null }), "IN", { runtime: stalls.runtime })));
    assert.equal(stalls.calls.length, 2);
    // A quota error is not retried.
    const quota = fakeRuntime(() => new DecisionError("quota", "out of credits"));
    await at.titleFromChain(settings({ fallback: null }), "IN", { runtime: quota.runtime });
    assert.equal(quota.calls.length, 1);
    // A pi ask gets 20 s, under the shared 45 s, so two asks still end sooner than one used to.
    assert.equal(at.TITLE_PI_TIMEOUT_MS, 20_000);
  });

  test("POST /api/sessions/auto-title: a dry run says what would happen and calls nothing; bad bodies are 400", async () => {
    const unnamed = session([user("name me please"), outline("Naming test", [])]);
    const explicit = session([user("leave me be")]);
    setSessionTitle(explicit.id, "Mine");
    const husk = session([]);
    const post = (body: unknown) => app.request("/api/sessions/auto-title", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const res = await post({ paths: [unnamed.path, explicit.path, husk.path, "/etc/passwd"], dryRun: true });
    assert.equal(res.status, 200);
    const { results } = (await res.json()) as { results: { path: string; outcome: string; reason?: string }[] };
    assert.deepEqual(
      results.map((r) => [r.outcome, r.reason]),
      [["would-name", undefined], ["skipped", "explicit"], ["skipped", "no-input"], ["skipped", "not-found"]],
    );
    assert.equal(results[3]!.path, "/etc/passwd");
    assert.equal(readSessionTitleRecords()[unnamed.id], undefined);
    for (const body of [{}, { paths: [] }, { paths: [7] }, { paths: [unnamed.path], dryRun: "yes" }, { paths: Array(201).fill(unnamed.path) }]) assert.equal((await post(body)).status, 400, JSON.stringify(body).slice(0, 60));
  });
});

describe("regenerate and shorten", () => {
  const long = "A title the Overseer wrote that is far too long";

  test("regenerate replaces any title of the session, a typed one included, and the current title never reaches the model", async () => {
    for (const [by, title] of [["user", "Typed by hand title"], ["overseer", long], ["auto", "Old auto title"]] as const) {
      const s = session([user("the push subscription drops on reload"), outline("Fixing push subscriptions that drop on reload", [])]);
      if (by === "auto") writeAutoTitle(s.id, title);
      else setSessionTitle(s.id, title, by);
      const f = fakeRuntime(() => '{"title": "Push subscription bug"}');
      assert.deepEqual(await at.nameSession(s.path, "regenerate", deps(f.runtime)), { outcome: "named", title: "Push subscription bug" }, by);
      assert.equal(readSessionTitleRecords()[s.id]?.by, "auto");
      assert.ok(!JSON.stringify(f.calls[0]!.context).includes(title), "the current title never reaches the model");
    }
    // A legacy (bare string) title too, and a session with no summary line.
    const bare = session([user("rename me from scratch please")]);
    writeFileSync(titlesFile, JSON.stringify({ version: 2, titles: { ...JSON.parse(readFileSync(titlesFile, "utf8")).titles, [bare.id]: "An older bare string title" } }));
    const f = fakeRuntime(() => '{"title": "Scratch rename"}');
    assert.deepEqual(await at.nameSession(bare.path, "regenerate", deps(f.runtime)), { outcome: "named", title: "Scratch rename" });
  });

  test("regenerate race: a rename (or clear) while the model was out wins, and the answer is dropped", async () => {
    const s = session([user("tune the cache warmer"), outline("Cache warmer tuning", [])]);
    setSessionTitle(s.id, "Before the press", "user", 1);
    for (const meanwhile of [() => setSessionTitle(s.id, "Typed meanwhile", "user", 2), () => setSessionTitle(s.id, null)]) {
      const f = fakeRuntime(() => {
        meanwhile();
        return '{"title": "Cache warmer tuning"}';
      });
      const r = await at.nameSession(s.path, "regenerate", deps(f.runtime));
      assert.equal(r.outcome === "skipped" && r.reason, "explicit");
      assert.notEqual(readSessionTitleRecords()[s.id]?.title, "Cache warmer tuning");
    }
    assert.equal(readSessionTitleRecords()[s.id], undefined); // the clear stood
    // Same title, same setter, but set again (a new time): still a change, still wins.
    setSessionTitle(s.id, "Same words", "overseer", 10);
    const again = fakeRuntime(() => {
      setSessionTitle(s.id, null);
      setSessionTitle(s.id, "Same words", "overseer", 11);
      return '{"title": "Cache warmer tuning"}';
    });
    assert.equal((await at.nameSession(s.path, "regenerate", deps(again.runtime))).outcome, "skipped");
    assert.equal(readSessionTitleRecords()[s.id]?.at, 11);
  });

  test("replaceAutoTitle writes only over the entry it was given", () => {
    setSessionTitle("r1", "Seen title", "overseer", 5);
    const seen = readSessionTitleRecords().r1;
    assert.equal(replaceAutoTitle("r1", "New label", { ...seen!, at: 6 }), false);
    assert.equal(replaceAutoTitle("r1", "New label", undefined), false);
    assert.equal(replaceAutoTitle("r1", "New label", seen), true);
    assert.deepEqual({ ...readSessionTitleRecords().r1, at: 0 }, { title: "New label", by: "auto", at: 0 });
    assert.equal(replaceAutoTitle("r2", "Fresh label", undefined), true); // absent when read, absent now
    for (const id of ["r1", "r2"]) setSessionTitle(id, null);
  });

  test("shortenable: long auto, Overseer and legacy titles; never a typed one; never a short one", () => {
    assert.equal(at.shortenable({ title: long, by: "auto" }), true);
    assert.equal(at.shortenable({ title: long, by: "overseer" }), true);
    assert.equal(at.shortenable({ title: long, by: "user", legacy: true }), true);
    assert.equal(at.shortenable({ title: long, by: "user" }), false);
    assert.equal(at.shortenable({ title: "x".repeat(36), by: "auto" }), false);
    assert.equal(at.shortenable({ title: "x".repeat(37), by: "auto" }), true);
    assert.equal(at.shortenable(undefined), false);
  });

  test("shorten never touches a typed title, even when it is long; it renames the rest, and loses a race", async () => {
    const typed = session([user("typed title session"), outline("Typed", [])]);
    const over = session([user("overseer titled session"), outline("Overseer", [])]);
    const short = session([user("short titled session"), outline("Short", [])]);
    setSessionTitle(typed.id, long, "user");
    setSessionTitle(over.id, long, "overseer");
    writeAutoTitle(short.id, "Short auto title");
    const f = fakeRuntime(() => '{"title": "Short label"}');
    const typedR = await at.nameSession(typed.path, "shorten", deps(f.runtime));
    assert.deepEqual(typedR, { outcome: "skipped", reason: "explicit", detail: "typed by hand" });
    assert.deepEqual(await at.nameSession(short.path, "shorten", deps(f.runtime)), { outcome: "skipped", reason: "short" });
    assert.equal(f.calls.length, 0);
    assert.equal(readSessionTitleRecords()[typed.id]?.title, long);
    assert.deepEqual(await at.nameSession(over.path, "shorten", deps(f.runtime)), { outcome: "named", title: "Short label" });
    // A rename while the call is out wins.
    const racy = session([user("racy session"), outline("Racy", [])]);
    writeAutoTitle(racy.id, long);
    const g = fakeRuntime(() => {
      setSessionTitle(racy.id, "Renamed by hand");
      return '{"title": "Short label"}';
    });
    assert.equal((await at.nameSession(racy.path, "shorten", deps(g.runtime))).outcome, "skipped");
    assert.deepEqual({ ...readSessionTitleRecords()[racy.id], at: 0 }, { title: "Renamed by hand", by: "user", at: 0 });
  });

  test("shortenPicks: listed long titles that aren't typed, newest first, no workers or Overseer files", () => {
    const row = (id: string, last: string, over: Partial<SessionSummary> = {}) =>
      ({ id, path: `/p/${id}`, cwd: "/", title: "t", createdAt: "", lastActiveAt: last, model: null, live: null, busy: false, origin: "web", archived: false, ...over }) as SessionSummary;
    const rows = [row("a", "2026-01-01"), row("b", "2026-03-01", { archived: true }), row("c", "2026-02-01"), row("w", "2026-04-01", { workerSession: true }), row("u", "2026-05-01"), row("s", "2026-06-01")];
    const records = {
      a: { title: long, by: "auto" as const },
      b: { title: long, by: "user" as const, legacy: true as const },
      c: { title: long, by: "overseer" as const },
      w: { title: long, by: "auto" as const },
      u: { title: long, by: "user" as const },
      s: { title: "Short", by: "auto" as const },
    };
    assert.deepEqual(at.shortenPicks(rows, records).map((s) => s.id), ["b", "c", "a"]);
  });

  test("the routes: redo takes exactly one path and may name a typed title; shorten's dry run lists only what it may touch", async () => {
    const post = (url: string, body: unknown) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const typed = session([user("typed route session"), outline("Typed route", [])]);
    const typedLong = session([user("typed long route session"), outline("Typed long", [])]);
    const autoLong = session([user("auto long route session"), outline("Auto long", [])]);
    setSessionTitle(typed.id, "Mine");
    setSessionTitle(typedLong.id, long);
    writeAutoTitle(autoLong.id, long);
    const plain = (await (await post("/api/sessions/auto-title", { paths: [typed.path], dryRun: true })).json()) as { results: { outcome: string; reason?: string }[] };
    assert.deepEqual(plain.results.map((r) => [r.outcome, r.reason]), [["skipped", "explicit"]]);
    const redo = (await (await post("/api/sessions/auto-title", { paths: [typed.path], dryRun: true, redo: true })).json()) as { results: { outcome: string }[] };
    assert.deepEqual(redo.results.map((r) => r.outcome), ["would-name"]);
    for (const body of [{ paths: [typed.path, autoLong.path], redo: true }, { paths: [typed.path], redo: "yes" }])
      assert.equal((await post("/api/sessions/auto-title", body)).status, 400, JSON.stringify(body));
    const res = await post("/api/sessions/shorten-titles", { dryRun: true });
    assert.equal(res.status, 200);
    const { results } = (await res.json()) as { results: { path: string; outcome: string }[] };
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes(autoLong.path));
    assert.ok(!paths.includes(typedLong.path), "a typed title is never listed, however long");
    assert.ok(!paths.includes(typed.path));
    assert.ok(results.every((r) => r.outcome === "would-name"));
    assert.equal(readSessionTitleRecords()[autoLong.id]?.title, long); // a dry run writes nothing
    assert.equal((await post("/api/sessions/shorten-titles", { dryRun: 1 })).status, 400);
  });
});

describe("the sweep", () => {
  const now = Date.parse("2026-09-21T01:00:00.000Z");
  const row = (i: number, over: Partial<SessionSummary> = {}): SessionSummary =>
    ({ id: `s${i}`, path: `/p/${i}`, cwd: "/", title: "t", createdAt: "", lastActiveAt: new Date(now - (10 + i) * 60_000).toISOString(), model: null, live: null, busy: false, origin: "web", archived: false, outlineGist: `gist ${i}`, ...over }) as SessionSummary;

  test("at most 10 a run, newest first; a session is named once; an unusable answer waits for a new summary line", async () => {
    let rows = Array.from({ length: 13 }, (_, i) => row(i));
    const named = new Set<string>();
    const asked: string[] = [];
    const sweep = new at.AutoTitleSweep({
      settings: () => settings(),
      list: async () => rows.map((r) => (named.has(r.id) ? { ...r, titleBy: "auto" as const, originalTitle: "t" } : r)),
      now: () => now,
      name: async (s) => {
        asked.push(s.id);
        if (s.id === "s12") return { outcome: "skipped", reason: "failed" };
        named.add(s.id);
        return { outcome: "named", title: "A title" };
      },
    });
    assert.equal(await sweep.run(), 10);
    assert.deepEqual(asked.slice(0, 10).sort(), Array.from({ length: 10 }, (_, i) => `s${i}`).sort());
    assert.equal(await sweep.run(), 2); // s10, s11; s12 failed
    assert.equal(await sweep.run(), 0); // s12 declined until its line changes
    assert.equal(asked.filter((id) => id === "s12").length, 1);
    rows = rows.map((r) => (r.id === "s12" ? { ...r, outlineGist: "a new line" } : r));
    await sweep.run();
    assert.equal(asked.filter((id) => id === "s12").length, 2);
    assert.equal(asked.filter((id) => id === "s0").length, 1); // never asked twice
    sweep.stop();
  });

  test("a member of a group an older build made is named like any session", async () => {
    // The sweep is given no groups at all: nothing it reads can single out an old group's members.
    const asked: string[] = [];
    const sweep = new at.AutoTitleSweep({
      settings: () => settings(),
      list: async () => [row(1, { groupId: "old-fanout" }), row(2, { groupId: "hand-made" })],
      now: () => now,
      name: async (s) => {
        asked.push(s.id);
        return { outcome: "named", title: "A title" };
      },
    });
    assert.equal(await sweep.run(), 2);
    assert.deepEqual(asked.sort(), ["s1", "s2"]);
    sweep.stop();
  });

  test("off: nothing is listed or named; quota failures stop the run and pause the sweep", async () => {
    let enabled = false;
    let clock = now;
    let listed = 0;
    const asked: string[] = [];
    const sweep = new at.AutoTitleSweep({
      settings: () => settings({ enabled }),
      list: async () => {
        listed++;
        return [row(1), row(2), row(3), row(4)];
      },
      now: () => clock,
      name: async (s) => {
        asked.push(s.id);
        return { outcome: "skipped", reason: "failed", backoff: true };
      },
    });
    assert.equal(await sweep.run(), 0);
    assert.equal(listed, 0);
    enabled = true;
    await sweep.run();
    assert.ok(asked.length <= 2, `stopped early, asked ${asked.length}`);
    const before = asked.length;
    clock += 10 * 60_000;
    await sweep.run();
    assert.equal(asked.length, before, "paused");
    clock += at.SWEEP_BACKOFF_MS;
    await sweep.run();
    assert.ok(asked.length > before, "resumed after the pause");
    sweep.stop();
  });
});
