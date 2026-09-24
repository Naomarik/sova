// Run: npx tsx --test server/sessions-context.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-context-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-context-test--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const { getSessionSummary, listSessions } = await import("./sessions-index");
const { canonicalPath } = await import("./paths");

/** A live pid that isn't this process: a terminal holding a session, as far as the registry knows. */
const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
after(() => {
  sleeper.kill();
  rmSync(agentDir, { recursive: true, force: true });
});

/** A session file made of `lines` (objects, or raw strings for torn ones) after the header and a
 *  first user message — a zero-input husk would be hidden from the list. `tail` is appended
 *  verbatim, so a test can leave the last line without its newline. */
function session(id: string, lines: unknown[], tail = ""): string {
  const path = join(sessionsDir, `2026-09-20T00-00-00-000Z_${id}.jsonl`);
  const all = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-20T00:00:00.000Z", cwd: "/tmp" }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } }),
    ...lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))),
  ];
  writeFileSync(path, all.join("\n") + "\n" + tail);
  return canonicalPath(path);
}

function outlineEntry(now: string, generatedAt: number, topics: unknown[], overall?: string) {
  return { type: "custom", id: `o${generatedAt}`, parentId: null, customType: "topic-outline", data: { version: 2, now, generatedAt, topics, ...(overall === undefined ? {} : { overall }) } };
}

function topic(id: string, heading: string) {
  return { id, heading, anchor: { entryId: "u1" } };
}

function assistant(id: string, usage: unknown, model = "anthropic/claude-opus-5") {
  const [provider, m] = model.split("/");
  return { type: "message", id, parentId: null, message: { role: "assistant", provider, model: m, content: "ok", ...(usage === undefined ? {} : { usage }) } };
}

test("topics come from the last outline entry; an earlier one is ignored", async () => {
  const p = session("outline-latest", [
    outlineEntry("early work", 1000, [topic("t1", "A")]),
    outlineEntry("later work", 2000, [topic("t1", "A"), topic("t2", "B"), topic("t3", "C")]),
  ]);
  const s = await getSessionSummary(p);
  assert.equal(s?.outlineNow, "later work");
  assert.equal(s?.outlineAt, 2000);
  assert.equal(s?.outlineTopics, 3);
});

test("an outline entry with an empty topics array counts 0", async () => {
  const p = session("outline-empty", [outlineEntry("just started", 1000, [])]);
  const s = await getSessionSummary(p);
  assert.equal(s?.outlineNow, "just started");
  assert.equal(s?.outlineTopics, 0);
});

test("the gist comes from the same entry as the now line", async () => {
  const p = session("outline-gist", [
    outlineEntry("early work", 1000, [topic("t1", "A")], "Fixing the auth flow"),
    outlineEntry("Committed dc63576 with all checks green", 2000, [topic("t1", "A")], "Sova theming: palette, fonts, Themes tab"),
  ]);
  const s = await getSessionSummary(p);
  assert.equal(s?.outlineGist, "Sova theming: palette, fonts, Themes tab");
  assert.equal(s?.outlineNow, "Committed dc63576 with all checks green");
});

test("a snapshot without an overall line reports no gist", async () => {
  const p = session("outline-no-gist", [outlineEntry("just started", 1000, [])]);
  const s = await getSessionSummary(p);
  assert.equal(s?.outlineGist, undefined);
  assert.equal(s?.outlineNow, "just started");
});

test("context tokens come from the tail's last assistant usage", async () => {
  const p = session("ctx-tokens", [
    assistant("a1", { input: 10, cacheRead: 20, cacheWrite: 30, output: 5 }),
    assistant("a2", { input: 100, cacheRead: 200, cacheWrite: 300, output: 7 }),
  ]);
  const s = await getSessionSummary(p);
  assert.deepEqual(s?.context, { tokens: 600, window: null });
});

test("a compaction closer to EOF than the usage means no context", async () => {
  const p = session("ctx-compacted", [
    assistant("a1", { input: 100, cacheRead: 200, cacheWrite: 300 }),
    { type: "compaction", id: "c1", parentId: "a1", entryIds: ["u1", "a1"] },
  ]);
  const s = await getSessionSummary(p);
  assert.equal(s?.context, undefined);
});

test("a tail with no assistant usage has no context", async () => {
  const p = session("ctx-none", [
    assistant("a1", undefined),
    { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "again" } },
  ]);
  const s = await getSessionSummary(p);
  assert.equal(s?.context, undefined);
});

test("a torn trailing line is skipped, not fatal", async () => {
  const p = session(
    "ctx-torn",
    [assistant("a1", { input: 1, cacheRead: 2, cacheWrite: 3 }), outlineEntry("still here", 1000, [topic("t1", "A")])],
    // torn mid-append: it names an assistant usage, so the scan reaches JSON.parse and must recover
    '{"type":"message","id":"a2","message":{"role":"assistant","usage":{"input":999,"cacheRe',
  );
  const s = await getSessionSummary(p);
  assert.deepEqual(s?.context, { tokens: 6, window: null });
  assert.equal(s?.outlineTopics, 1);
});

test("the window is null without a resolver and the resolved number with one", async () => {
  const p = session("ctx-window", [assistant("a1", { input: 1000, cacheRead: 500, cacheWrite: 0 }, "anthropic/claude-opus-5")]);
  assert.deepEqual((await getSessionSummary(p))?.context, { tokens: 1500, window: null });
  const refs: string[] = [];
  const s = await getSessionSummary(p, (ref) => {
    refs.push(ref);
    return 200_000;
  });
  assert.deepEqual(s?.context, { tokens: 1500, window: 200_000 });
  assert.deepEqual(refs, ["anthropic/claude-opus-5"]);
});

// ---- The outline across growth, and a hosted chat's own live record ---------------------------

/** A tool result the size of a screenshot `read`: two of these push anything before them out of
 *  the summary's 256 KB tail window, which is what emptied a live session's row. */
function bulk(id: string, bytes: number) {
  return { type: "message", id, parentId: null, message: { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "x".repeat(bytes) }] } };
}

/** Appends whole lines, as a writer does. */
function append(path: string, ...lines: unknown[]) {
  appendFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

/** A sessions-extension live record for `sessionFile`, owned by `pid`, broadcasting `outline`. */
function liveRecord(name: string, sessionFile: string, pid: number, outline: unknown) {
  writeFileSync(
    join(liveDir, `${name}.json`),
    JSON.stringify({ heartbeat: Date.now(), session: { sessionFile, pid, mode: "rpc", status: "idle" }, presence: { status: "idle", outline } }),
  );
}

test("an outline that growth pushes out of the tail window is carried, not lost", async () => {
  const lines = [outlineEntry("reading screenshots", 1000, [topic("t1", "A"), topic("t2", "B")], "Transcript bugs: duplicated messages")];
  const p = session("outline-carried", lines);
  assert.equal((await getSessionSummary(p))?.outlineGist, "Transcript bugs: duplicated messages");
  append(p, bulk("r1", 150_000), bulk("r2", 150_000));
  const s = await getSessionSummary(p);
  assert.equal(s?.outlineGist, "Transcript bugs: duplicated messages");
  assert.equal(s?.outlineNow, "reading screenshots");
  assert.equal(s?.outlineAt, 1000);
  assert.equal(s?.outlineTopics, 2);
  // The same bytes read cold, by a server that never watched them grow, are past the window: the
  // outline above is the carried one, not the product of a longer read.
  const cold = session("outline-carried-cold", lines);
  append(cold, bulk("r1", 150_000), bulk("r2", 150_000));
  assert.equal((await getSessionSummary(cold))?.outlineGist, undefined);
});

test("growth that brings a newer outline shows it, and one with nothing to say keeps the carried one", async () => {
  const p = session("outline-newer", [outlineEntry("early", 1000, [topic("t1", "A")], "First purpose")]);
  await getSessionSummary(p);
  append(p, bulk("r1", 300_000));
  assert.equal((await getSessionSummary(p))?.outlineGist, "First purpose");
  append(p, outlineEntry("", 2000, [], "Still drafting")); // an empty "now" is no summary, as in a cold read
  assert.equal((await getSessionSummary(p))?.outlineGist, "First purpose");
  append(p, outlineEntry("later", 3000, [topic("t1", "A"), topic("t2", "B")], "Second purpose"));
  const s = await getSessionSummary(p);
  assert.equal(s?.outlineGist, "Second purpose");
  assert.equal(s?.outlineAt, 3000);
  assert.equal(s?.outlineTopics, 2);
});

test("an outline torn mid-append at one read is read once its writer finishes the line", async () => {
  const line = JSON.stringify(outlineEntry("finished the line", 2000, [topic("t1", "A")], "Torn, then whole"));
  const cut = Math.floor(line.length / 2);
  const p = session("outline-torn-then-whole", [outlineEntry("before", 1000, [], "Before the tear")], line.slice(0, cut));
  assert.equal((await getSessionSummary(p))?.outlineGist, "Before the tear");
  appendFileSync(p, `${line.slice(cut)}\n`);
  assert.equal((await getSessionSummary(p))?.outlineGist, "Torn, then whole");
});

test("a file that shrank is read afresh: nothing is carried across it", async () => {
  const p = session("outline-shrunk", [outlineEntry("soon gone", 1000, [topic("t1", "A")], "Rewritten away")]);
  assert.equal((await getSessionSummary(p))?.outlineGist, "Rewritten away");
  session("outline-shrunk", []); // the same path, rewritten shorter: header and first message only
  assert.equal((await getSessionSummary(p))?.outlineGist, undefined);
});

test("a file rewritten longer, not appended to, is read afresh too", async () => {
  const p = session("outline-rewritten", [outlineEntry("old", 1000, [], "Before the rewrite")]);
  assert.equal((await getSessionSummary(p))?.outlineGist, "Before the rewrite");
  // The same path with other bytes where the outline was, and more of them: a size check alone
  // would take this for growth and carry the outline the new file doesn't have.
  session("outline-rewritten", [bulk("r1", 2_000)]);
  assert.equal((await getSessionSummary(p))?.outlineGist, undefined);
});

test("a hosted chat's row takes its outline from this server's own live record, which doesn't make it live", async () => {
  const p = session("outline-own-record", []); // no outline within reach in the file
  liveRecord(`p${process.pid}-own00001`, p, process.pid, { now: "Reading the screenshots", overall: "Transcript bugs", topics: ["A", "B", "C"], generatedAt: 5000 });
  const s = await getSessionSummary(p);
  assert.equal(s?.outlineGist, "Transcript bugs");
  assert.equal(s?.outlineNow, "Reading the screenshots");
  assert.equal(s?.outlineTopics, 3);
  assert.equal(s?.live, null); // presence stays a foreign writer's word alone
  const listed = (await listSessions()).find((x) => x.path === p);
  assert.equal(listed?.outlineGist, "Transcript bugs");
  assert.equal(listed?.outlineTopics, 3);
  assert.equal(listed?.live, null);
});

test("a foreign writer's outline is preferred to this server's own", async () => {
  const p = session("outline-both-records", []);
  liveRecord(`p${process.pid}-own00002`, p, process.pid, { now: "ours", overall: "This server's view", topics: [], generatedAt: 5000 });
  liveRecord(`p${sleeper.pid}-tui00002`, p, sleeper.pid!, { now: "theirs", overall: "The terminal's view", topics: [], generatedAt: 5000 });
  assert.equal((await getSessionSummary(p))?.outlineGist, "The terminal's view");
  assert.equal((await listSessions()).find((x) => x.path === p)?.outlineGist, "The terminal's view");
});
