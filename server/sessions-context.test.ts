// Run: npx tsx --test server/sessions-context.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-context-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-context-test--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { getSessionSummary } = await import("./sessions-index");
const { canonicalPath } = await import("./paths");

after(() => rmSync(agentDir, { recursive: true, force: true }));

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
    outlineEntry("Committed dc63576 with all checks green", 2000, [topic("t1", "A")], "pi-web theming: palette, fonts, Themes tab"),
  ]);
  const s = await getSessionSummary(p);
  assert.equal(s?.outlineGist, "pi-web theming: palette, fonts, Themes tab");
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
