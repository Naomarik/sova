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
process.env.PORT = "0";
const sessionsDir = join(agentDir, "sessions", "--tmp-autotitle--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
mkdirSync(join(agentDir, "sova"), { recursive: true });

const { app, server } = await import("./index");
const { readSessionTitleRecords, setSessionTitle, writeAutoTitle } = await import("./session-titles");
const { getSessionSummary } = await import("./sessions-index");
const { canonicalPath } = await import("./paths");
const at = await import("./session-autotitle");
const { DecisionError } = await import("./decide");
type LlmRuntime = import("./decide-llm").LlmRuntime;

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
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
    assert.match(prompt, /^FIRST MESSAGE:\nPlease add a diff viewer/);
    assert.ok(prompt.includes("SUMMARY LINE:\nInline git diff viewer design"));
    assert.ok(prompt.includes("- Diff viewer layout\n  - one\n  - two\n- Hunk folding"));
    assert.ok(!prompt.includes("three"));
    assert.ok(!prompt.includes("Old gist"));
  });

  test("without a summary line: the first 3 user messages, each cut to 600 characters", () => {
    const long = "x".repeat(700);
    const p = at.buildTitlePrompt({ userMessages: [long, "two", "three"], topics: [] });
    assert.ok(p.startsWith("FIRST MESSAGES:\n1. "));
    assert.equal(p.split("\n")[1]!.length, 3 + 600);
    assert.ok(p.includes("\n3. three"));
  });

  test("validateTitle: 2–9 words, ≤60 characters, quotes and a trailing period dropped", () => {
    assert.equal(at.validateTitle("Inline git diff viewer"), "Inline git diff viewer");
    assert.equal(at.validateTitle('"Session switch layout shift fix."'), "Session switch layout shift fix");
    assert.equal(at.validateTitle("  Open-questions   count: drop chat icon "), "Open-questions count: drop chat icon");
    assert.equal(at.validateTitle("Diff"), null);
    assert.equal(at.validateTitle("one two three four five six seven eight nine ten"), null);
    assert.equal(at.validateTitle(`Word ${"y".repeat(60)}`), null);
    assert.equal(at.validateTitle("two\u0007 bells"), null);
    assert.equal(at.validateTitle(7), null);
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
    assert.deepEqual(f.calls.map((c) => c.model), ["title-a", "title-b"]);
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
