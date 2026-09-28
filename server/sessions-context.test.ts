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
});

test("a first read finds the last outline however far from the end it lies", async () => {
  // Past several deep chunks, with the entry's name in a message between (not an entry: skipped),
  // and a later outline whose "now" is empty (no summary: the earlier one stands).
  const p = session("outline-deep", [
    outlineEntry("too old", 500, [], "An earlier purpose"),
    outlineEntry("far back", 1000, [topic("t1", "A"), topic("t2", "B")], "Deep purpose"),
  ]);
  append(p, bulk("r0", 900_000), { type: "message", id: "m", parentId: null, message: { role: "user", content: 'about the "topic-outline" entry' } });
  append(p, bulk("r1", 1_500_000), outlineEntry("", 1500, [], "Drafting"), bulk("r2", 400_000));
  const s = await getSessionSummary(p);
  assert.equal(s?.outlineGist, "Deep purpose");
  assert.equal(s?.outlineNow, "far back");
  assert.equal(s?.outlineAt, 1000);
  assert.equal(s?.outlineTopics, 2);
  // What grows after the deep read is read alone, and the deep find is carried past it.
  append(p, bulk("r3", 300_000));
  assert.equal((await getSessionSummary(p))?.outlineGist, "Deep purpose");
  append(p, outlineEntry("newest", 2000, [topic("t1", "A")], "Newest purpose"));
  assert.equal((await getSessionSummary(p))?.outlineGist, "Newest purpose");
});

test("an outline line longer than a read chunk, across chunk edges, is read whole", async () => {
  const big = outlineEntry("big snapshot", 1000, Array.from({ length: 4000 }, (_, i) => topic(`t${i}`, "x".repeat(300))), "Huge outline");
  assert.ok(JSON.stringify(big).length > 1024 * 1024 + 16 * 1024);
  const p = session("outline-huge-line", [big]);
  append(p, bulk("r1", 600_000));
  const s = await getSessionSummary(p);
  assert.equal(s?.outlineGist, "Huge outline");
  assert.equal(s?.outlineTopics, 4000);
});

test("a file with no outline anywhere lists none, and its growth is read alone", async () => {
  const p = session("outline-none-deep", [bulk("r0", 2_500_000)]);
  assert.equal((await getSessionSummary(p))?.outlineNow, undefined);
  append(p, outlineEntry("arrived", 1000, [], "Late purpose"));
  assert.equal((await getSessionSummary(p))?.outlineGist, "Late purpose");
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

// ---- The mode the composer's switch reads before the chat's own "mode" message ------------------

function modeEntry(id: string, mode: string, minorModes: string[]) {
  return { type: "custom", id, parentId: null, customType: "mode", data: { mode, active: { version: 1, mode, strict: false, minorModes } } };
}

test("the mode is the file's newest snapshot however far back, a legacy marker pins nothing, and growth is read alone", async () => {
  const p = session("mode-deep", [modeEntry("m1", "normal", []), modeEntry("m2", "delegate", ["align", "spec"])]);
  // A legacy marker (no snapshot) after it, then far more than the tail window.
  append(p, { type: "custom", id: "m3", parentId: null, customType: "mode", data: { mode: "normal" } }, bulk("r1", 1_500_000));
  assert.deepEqual((await getSessionSummary(p))?.mode, { mode: "delegate", minorModes: ["align", "spec"] });
  append(p, bulk("r2", 300_000));
  assert.deepEqual((await getSessionSummary(p))?.mode, { mode: "delegate", minorModes: ["align", "spec"] });
  append(p, modeEntry("m4", "normal", ["vis"]));
  assert.deepEqual((await getSessionSummary(p))?.mode, { mode: "normal", minorModes: ["vis"] });
  assert.deepEqual((await listSessions()).find((x) => x.path === p)?.mode, { mode: "normal", minorModes: ["vis"] });
});

test("a file that pins no mode reads the default for sessions, as it is now", async () => {
  const p = session("mode-default", [bulk("r1", 400_000)]);
  writeFileSync(join(agentDir, "mode.json"), JSON.stringify({ mode: "delegate", strict: false, minorModes: ["spec"] }));
  assert.deepEqual((await getSessionSummary(p))?.mode, { mode: "delegate", minorModes: ["spec"] });
  // The default changes without the file changing: the next read says so.
  writeFileSync(join(agentDir, "mode.json"), JSON.stringify({ mode: "normal", strict: false, minorModes: [] }));
  assert.deepEqual((await listSessions()).find((x) => x.path === p)?.mode, { mode: "normal", minorModes: [] });
});

test("the outline and the mode are found in one read, whichever lies deeper", async () => {
  const p = session("mode-and-outline", [modeEntry("m1", "delegate", ["vis"])]);
  append(p, bulk("r1", 1_200_000), outlineEntry("recent", 1000, [topic("t1", "A")], "Recent purpose"), bulk("r2", 400_000));
  const s = await getSessionSummary(p);
  assert.equal(s?.outlineGist, "Recent purpose");
  assert.deepEqual(s?.mode, { mode: "delegate", minorModes: ["vis"] });
});

// ---- The thinking level the composer's model indicator reads before the chat's hello ------------

test("the thinking level is the file's newest thinking_level_change however far back, and growth is read alone", async () => {
  const p = session("thinking-deep", [
    { type: "thinking_level_change", id: "k1", parentId: null, thinkingLevel: "low" },
    { type: "thinking_level_change", id: "k2", parentId: null, thinkingLevel: "medium" },
  ]);
  // The entry's name in a message after it is not an entry: skipped.
  append(p, { type: "message", id: "m", parentId: null, message: { role: "user", content: '{"type":"thinking_level_change"}' } }, bulk("r1", 1_200_000));
  assert.equal((await getSessionSummary(p))?.thinking, "medium");
  append(p, bulk("r2", 300_000));
  assert.equal((await getSessionSummary(p))?.thinking, "medium");
  append(p, { type: "thinking_level_change", id: "k3", parentId: null, thinkingLevel: "high" });
  assert.equal((await listSessions()).find((x) => x.path === p)?.thinking, "high");
});

test("a file with no thinking_level_change lists no level", async () => {
  const p = session("thinking-none", [bulk("r1", 100_000)]);
  assert.equal((await getSessionSummary(p))?.thinking, undefined);
});

// ---- The head's team chip before the view's insight loads ---------------------------------------

/** Entries chained one after another from u1, so the active branch is all of them. */
function chain(prefix: string, lines: Record<string, unknown>[], parent = "u1") {
  return lines.map((l, i) => ({ ...l, id: `${prefix}${i}`, parentId: i === 0 ? parent : `${prefix}${i - 1}` }));
}
const member = (workerId: string, role: string) => ({ workerId, role, orchestrator: false, backend: "pi", ownedPaths: [], addedAt: 1 });
const teamCreate = (id: string, name: string, members: unknown[]) => ({
  type: "custom", customType: "subagents-team-v1", data: { version: 1, op: "create", team: { id, name, objective: "o", createdAt: 1 }, members },
});
const teamAdd = (teamId: string, members: unknown[]) => ({ type: "custom", customType: "subagents-team-v1", data: { version: 1, op: "add", teamId, members } });
const teamEvent = (teamId: string, kind: string) => ({
  type: "custom", customType: "subagents-team-event-v1", data: { version: 1, teamId, kind, workerId: "ag_01", role: "lead", at: 1000 },
});
const note = (text: string) => ({ type: "message", message: { role: "user", content: text } });

test("a session with a team lists its first team's name, member count and pause; one without lists none", async () => {
  assert.equal((await getSessionSummary(session("team-none", chain("a", [note("no team here")]))))?.team, undefined);
  const p = session("team-chip", chain("a", [
    teamCreate("team_01", "Explain UX", [member("ag_01", "lead"), member("ag_02", "writer")]),
    teamCreate("team_02", "Second", [member("ag_05", "solo")]),
    teamAdd("team_01", [member("ag_03", "reviewer")]),
    teamEvent("team_01", "pause"),
  ]));
  const s = await getSessionSummary(p);
  assert.equal(s?.team?.name, "Explain UX");
  assert.equal(s?.team?.members, 3);
  assert.match(s?.team?.paused ?? "", /paused/);
  // Growth is read alone: a resume ends the pause.
  appendFileSync(p, JSON.stringify({ ...teamEvent("team_01", "resume"), id: "a9", parentId: "a3" }) + "\n");
  assert.deepEqual((await listSessions()).find((x) => x.path === p)?.team, { name: "Explain UX", members: 3 });
});

test("a team only on an abandoned branch is not the session's", async () => {
  const p = session("team-off-branch", [
    ...chain("a", [teamCreate("team_01", "Gone", [member("ag_01", "lead")])]),
    ...chain("b", [note("rewound past it")]),
  ]);
  assert.equal((await getSessionSummary(p))?.team, undefined);
});

// ---- The workers a cold session's records restore, before its runtime's first "workers" --------

const manifest = (workerId: string, at = 1) => ({ type: "custom", customType: "subagents-worker-manifest", data: { v: 1, kind: "worker-manifest", workerId, backend: "pi", at } });

test("a session's restorable workers are its branch's manifests, one per worker; none lists none", async () => {
  assert.equal((await getSessionSummary(session("workers-none", chain("w", [note("no workers")]))))?.restoredWorkers, undefined);
  const p = session("workers-restored", [
    // A worker only on an abandoned branch is not restored with this one.
    ...chain("x", [manifest("ag_09")]),
    ...chain("w", [manifest("ag_01"), manifest("ag_02"), manifest("ag_01", 2), note("later")]),
  ]);
  assert.equal((await getSessionSummary(p))?.restoredWorkers, 2);
  appendFileSync(p, JSON.stringify({ ...manifest("ag_03"), id: "w9", parentId: "w3" }) + "\n");
  assert.equal((await listSessions()).find((x) => x.path === p)?.restoredWorkers, 3);
});

// ---- The sandbox the composer's shield reads before the chat's hello ----------------------------

const sandboxEntry = (id: string, on: boolean) => ({ type: "custom", id, parentId: null, customType: "sandbox", data: { version: 1, on, level: "workspace-write", backend: "bwrap", enforcement: "full" } });

test("the sandbox is the file's newest sandbox entry, listed only while on", async () => {
  const p = session("sandbox-on", [sandboxEntry("s1", false), sandboxEntry("s2", true), { type: "custom", id: "s3", parentId: null, customType: "sandbox", data: { version: 9 } }]);
  append(p, bulk("r1", 600_000));
  assert.deepEqual((await getSessionSummary(p))?.sandbox, { on: true, enforcement: "full", status: "Sandbox on · workspace-write · full enforcement" });
  append(p, sandboxEntry("s4", false));
  assert.equal((await listSessions()).find((x) => x.path === p)?.sandbox, undefined);
  assert.equal((await getSessionSummary(session("sandbox-none", [bulk("r1", 1000)])))?.sandbox, undefined);
});
