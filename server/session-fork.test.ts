// Run: npx tsx --test server/session-fork.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-fork-test-")));
process.env.PI_CODING_AGENT_DIR = agentDir; // before paths/chat-manager compute theirs
const sessionsDir = join(agentDir, "sessions", "--tmp-fork--");
mkdirSync(sessionsDir, { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { forkSessionFile, forkPrefix, parseSourceDoc, reconstructPath, activeBranchLines } = await import("./session-fork");
const { canonicalPath } = await import("./paths");
const { FORK_CACHE_ENTRY, inheritedCacheKey } = await import("../pi-config/extensions/subagents/fork/cache.ts");
const { normalizeEntries } = await import("./transcript");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { restoreActive: restoreWorktrees, sharedWith } = await import("../pi-config/extensions/worktrees/state.ts");
const { restoreActive: restoreMode } = await import("../pi-config/extensions/mode/state.ts");
const { restoreActive: restoreSandbox } = await import("../pi-config/extensions/sandbox/state.ts");

after(() => rmSync(agentDir, { recursive: true, force: true }));

// ---- fixtures -------------------------------------------------------------
const ts = (n: number) => new Date(Date.UTC(2026, 8, 20, 0, 0, n)).toISOString();
const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const headerOf = (id: string, version = 3) => line({ type: "session", version, id, timestamp: ts(0), cwd });
const entry = (id: string, parentId: string | null, extra: Record<string, unknown> = {}) => ({
  type: "message",
  id,
  parentId,
  timestamp: ts(1),
  ...extra,
});
const user = (id: string, parentId: string | null, text: string) =>
  entry(id, parentId, { message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } });
const assistant = (id: string, parentId: string | null, content: unknown[]) =>
  entry(id, parentId, { message: { role: "assistant", content, provider: "zai", model: "glm-5.3", api: "openai-completions", stopReason: "stop", timestamp: 0 } });
const text = (t: string) => [{ type: "text", text: t }];
const toolCall = (id: string, name = "read") => [{ type: "toolCall", id, name, arguments: {} }];
const toolResult = (id: string, parentId: string, callId: string) =>
  entry(id, parentId, { message: { role: "toolResult", toolCallId: callId, toolName: "read", content: [], isError: false, timestamp: 0 } });
const custom = (id: string, parentId: string | null, customType: string, data: unknown = {}) =>
  entry(id, parentId, { type: "custom", customType, data });

let n = 0;
/** A source file on disk; returns its canonical path. */
function source(name: string, lines: string[]): string {
  const path = join(sessionsDir, `${name}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return canonicalPath(path);
}
const untouched = (path: string) => {
  const before = { text: readFileSync(path, "utf8"), st: statSync(path) };
  return () => {
    assert.equal(readFileSync(path, "utf8"), before.text, "source bytes must never change");
    const st = statSync(path);
    assert.equal(st.mtimeMs, before.st.mtimeMs, "forking must not even touch the source's mtime");
  };
};

// The canonical tree: a completed two-tool turn with a steer, then registry entries, then a
// later exchange, plus an abandoned branch hanging off u2.
const CANONICAL = [
  headerOf("src-canonical"),
  line(entry("mc1", null, { type: "model_change", provider: "zai", modelId: "glm-5.3" })),
  line(entry("tl1", "mc1", { type: "thinking_level_change", thinkingLevel: "medium" })),
  line(user("u1", "tl1", "first question")),
  line(assistant("a1", "u1", text("first answer"))),
  line(user("u2", "a1", "go read the file")),
  line(assistant("a2t", "u2", [...text("reading"), ...toolCall("t1")])),
  line(toolResult("tr1", "a2t", "t1")),
  line(user("s1", "tr1", "and summarize")),
  line(assistant("a2", "s1", text("the summary"))),
  // abandoned branch off u2 — never an ancestor of the leaf
  line(user("u2b", "u2", "abandoned road")),
  line(assistant("a2b", "u2b", text("abandoned answer"))),
  // registry entries between the reply and the next exchange: transient, must be spliced out
  line(custom("wm1", "a2", "subagents-worker-manifest", { v: 1, kind: "worker-manifest", workerId: "w-1", backend: "pi", at: 1 })),
  line(custom("te1", "wm1", "subagents-team-event-v1", { version: 1, teamId: "T", kind: "spawn", workerId: "w-1", at: 1 })),
  line(user("u3", "te1", "later question")),
  line(assistant("a3", "u3", text("later answer"))), // the leaf
];

test("fork through a completed reply copies exactly the active branch's prefix", () => {
  const path = source(`canonical-${n++}`, CANONICAL);
  const check = untouched(path);
  const r = forkSessionFile(path, "a2");
  assert.equal(r.ok, true, (r as { message?: string }).message);
  if (!r.ok) return;
  check();
  assert.notEqual(r.sessionId, "src-canonical");
  assert.equal(dirname(r.path), sessionsDir, "the fork lands beside its source");
  const [h, ...rest] = readFileSync(r.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(h.type, "session");
  assert.equal(h.id, r.sessionId);
  assert.equal(h.cwd, cwd, "the fork keeps the source's cwd");
  assert.equal(h.parentSession, path, "parentSession is the canonical source path");
  assert.deepEqual(
    rest.filter(e => e.customType !== FORK_CACHE_ENTRY).map((e) => e.id),
    ["mc1", "tl1", "u1", "a1", "u2", "a2t", "tr1", "s1", "a2"],
    "through the reply, nothing later and nothing abandoned",
  );
  // byte-for-byte: no registry sat inside this prefix, so every line is the source's own
  const raw = readFileSync(r.path, "utf8").split("\n").filter(Boolean).slice(1, -1);
  assert.deepEqual(raw, CANONICAL.slice(1, 10), "untouched entries keep their raw lines");
  assert.equal(rest.at(-1).customType, FORK_CACHE_ENTRY);
  assert.equal(rest.at(-1).parentId, "a2");
  assert.equal(inheritedCacheKey(rest), "src-canonical");
  const opened = SessionManager.open(r.path);
  assert.equal(opened.getSessionId(), r.sessionId);
  opened.appendCustomEntry("fork-test", { independent: true });
  assert.equal(opened.getBranch().at(-1)?.type, "custom", "the new session is independently writable");
  assert.ok(readFileSync(r.path, "utf8").includes('"customType":"fork-test"'));
  check();
});

test("fork through the leaf splices registry entries out and re-links the chain", () => {
  const path = source(`leaf-${n++}`, CANONICAL);
  const check = untouched(path);
  const r = forkSessionFile(path, "a3");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const entries = readFileSync(r.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(1);
  const ids = entries.filter(e => e.customType !== FORK_CACHE_ENTRY).map((e: any) => e.id);
  assert.deepEqual(ids, ["mc1", "tl1", "u1", "a1", "u2", "a2t", "tr1", "s1", "a2", "u3", "a3"], "registry entries gone");
  assert.equal(entries.some((e: any) => e.type === "custom" && String(e.customType).startsWith("subagents-")), false);
  const u3 = entries.find((e: any) => e.id === "u3")!;
  assert.equal(u3.parentId, "a2", "the entry after a dropped registry entry is re-parented onto the last kept one");
  const a3 = entries.find((e: any) => e.id === "a3")!;
  assert.equal(a3.parentId, "u3");
  check();
});

test("a reply on an abandoned branch, or unknown, is refused and writes nothing", () => {
  const path = source(`abandoned-${n++}`, CANONICAL);
  const check = untouched(path);
  for (const id of ["a2b", "u2b", "no-such-entry"]) {
    const r = forkSessionFile(path, id);
    assert.equal(r.ok, false);
    if (r.ok) continue;
    assert.equal(r.reason, "not_on_branch");
    assert.equal(r.status, 400);
  }
  check();
});

test("only an assistant reply is a fork point", () => {
  const path = source(`roles-${n++}`, CANONICAL);
  for (const id of ["u1", "tr1", "mc1", "wm1"]) {
    const r = forkSessionFile(path, id);
    assert.equal(r.ok, false, id);
    if (!r.ok) assert.equal(r.reason, "not_assistant");
  }
});

test("a reply that still owes a tool result refuses at its own boundary", () => {
  const path = source(`midturn-${n++}`, CANONICAL);
  const r = forkSessionFile(path, "a2t");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "tool_boundary");
  assert.match(r.message, /still waiting on a tool result/);
});

test("an earlier aborted turn's dangling call refuses any later boundary", () => {
  const path = source(
    `aborted-${n++}`,
    [
      headerOf("src-aborted"),
      line(user("u1", null, "q")),
      line(assistant("a1d", "u1", toolCall("t-dead"))), // aborted mid-tool, no result anywhere
      line(user("u2", "a1d", "again")),
      line(assistant("a2d", "u2", text("recovered answer"))),
    ],
  );
  const r = forkSessionFile(path, "a2d");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "tool_boundary");
  assert.match(r.message, /earlier reply/);
});

test("a context edit that removes the calling message clears the dangling call", () => {
  const path = source(
    `edited-${n++}`,
    [
      headerOf("src-edited"),
      line(user("u1", null, "q")),
      line(assistant("a1", "u1", [...text("attempt"), ...toolCall("t9")])),
      line(entry("ce1", "a1", { type: "context_edit", targetId: "a1", replacement: null })),
      line(user("u2", "ce1", "again")),
      line(assistant("a2", "u2", text("the recovered reply"))),
    ],
  );
  const r = forkSessionFile(path, "a2");
  assert.equal(r.ok, true, (r as { message?: string }).message);
  // the raw call is still in the copied bytes; only its projection is clean
  const entries = readFileSync(r.ok ? r.path : "", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(entries.some((e: any) => e.id === "a1" && e.message?.content?.some?.((b: any) => b?.type === "toolCall")));
});

test("a context edit that replaces content with text clears the call; one before a compaction is out of scope", () => {
  const replaced = source(
    `replaced-${n++}`,
    [
      headerOf("src-replaced"),
      line(user("u0", null, "q0")),
      line(assistant("a0", "u0", toolCall("t-old"))), // dangling, but before the retained range
      line(entry("c1", "a0", { type: "compaction", summary: "sum", firstKeptEntryId: "u1", tokensBefore: 10 })),
      line(user("u1", "c1", "q1")),
      line(assistant("a1", "u1", [...text("x"), ...toolCall("t2")])),
      line(entry("ce1", "a1", { type: "context_edit", targetId: "a1", replacement: { content: "plain" } })),
      line(user("u2", "ce1", "q2")),
      line(assistant("a2", "u2", text("done"))),
    ],
  );
  const r = forkSessionFile(replaced, "a2");
  assert.equal(r.ok, true, (r as { message?: string }).message);
});

test("a rewind marker moves the branch: pre-rewind replies are off it", () => {
  const path = source(
    `rewound-${n++}`,
    [
      headerOf("src-rewound"),
      line(user("u1", null, "q")),
      line(assistant("a1", "u1", text("answer"))),
      line(user("u2", "a1", "later")),
      line(assistant("a2", "u2", text("later answer"))),
      line(custom("rw", "u1", "sova-rewind", { targetId: "u1", fromLeafId: "a2" })), // the leaf now
    ],
  );
  const doc = parseSourceDoc(readFileSync(path, "utf8"));
  assert.equal(doc.ok, true);
  if (!doc.ok) return;
  const walked = activeBranchLines(doc.doc);
  assert.equal(walked.ok, true);
  if (walked.ok) assert.deepEqual(walked.branch.map((l) => l.entry.id), ["u1", "rw"], "the marker is the leaf; the branch rewound to u1");
  const refused = forkSessionFile(path, "a2");
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "not_on_branch");
  const r = forkSessionFile(path, "a1");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "not_on_branch", "a1 left the active branch with the rewind");
});

test("malformed sources refuse: wrong version, torn tail, missing ids, cyclic ancestry", () => {
  const bad: Array<[string, string[]]> = [
    ["v2 header", [headerOf("s", 2), line(user("u1", null, "q"))]],
    ["torn tail", [headerOf("s"), line(user("u1", null, "q")), '{"type":"mess']],
    ["id-less entry", [headerOf("s"), line({ type: "message", parentId: null, message: { role: "user" } })]],
    ["header not first", [line(user("u1", null, "q")), headerOf("s")]],
    ["cycle", [headerOf("s"), line(user("u1", "u2", "q")), line(user("u2", "u1", "a"))]],
    ["dangling parent", [headerOf("s"), line(user("u1", "ghost", "q"))]],
  ];
  const parseBad = new Set(["v2 header", "torn tail", "id-less entry", "header not first"]);
  for (const [name, lines] of bad) {
    const path = source(`bad-${name.replace(/\W+/g, "-")}-${n++}`, lines);
    const parsed = parseSourceDoc(readFileSync(path, "utf8"));
    const r = forkSessionFile(path, "u1");
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.equal(r.reason, "invalid", `${name}: ${r.message}`);
    if (parseBad.has(name)) assert.equal(parsed.ok, false, `${name} must fail the strict parse, not be skipped`);
    else assert.equal(parsed.ok, true, `${name} parses; the ancestry walk refuses it`);
  }
});

test("a legacy fanout member refuses", () => {
  const path = source(`fanout-${n++}`, [
    headerOf("src-fanout"),
    line(custom("fm", null, "sova-fanout-member", {})),
    line(user("u1", "fm", "q")),
    line(assistant("a1", "u1", text("answer"))),
  ]);
  const r = forkSessionFile(path, "a1");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "unsupported");
});

test("reconstructPath re-links around drops and keeps untouched lines verbatim", () => {
  const doc = parseSourceDoc(CANONICAL.join("\n") + "\n");
  assert.equal(doc.ok, true);
  if (!doc.ok) return;
  const prefix = forkPrefix(doc.doc, "a3");
  assert.equal(prefix.ok, true);
  if (!prefix.ok) return;
  const kept = prefix.prefix;
  assert.deepEqual(
    kept.map((l) => l.entry.id),
    ["mc1", "tl1", "u1", "a1", "u2", "a2t", "tr1", "s1", "a2", "u3", "a3"],
  );
  assert.notEqual(kept[9]!.raw, CANONICAL[14], "u3's line was rewritten (its parent changed)");
  assert.equal(JSON.parse(kept[9]!.raw).parentId, "a2");
  assert.equal(kept[8]!.raw, CANONICAL[9], "a2's line is byte-identical");
  const roundTrip = kept.map((l) => JSON.parse(l.raw));
  for (let i = 1; i < roundTrip.length; i++)
    assert.equal(roundTrip[i]!.parentId, roundTrip[i - 1]!.id, `chain intact at ${roundTrip[i]!.id}`);
});

test("the actual SDK and extension folds restore settings at the selected reply, not later settings", () => {
  const worktrees = { version: 1, trees: [{ path: join(cwd, "branch"), branch: "feat/x", base: "abc", status: "active", session: "src-state", how: "created", at: 1 }] };
  const mode = { version: 1, mode: "delegate", strict: true, minorModes: ["align"] };
  const sandbox = { version: 1, on: true, level: "workspace-write", backend: "linux-bwrap", enforcement: "full" };
  const lines = [
    headerOf("src-state"),
    line(entry("mc1", null, { type: "model_change", provider: "zai", modelId: "glm-5.3" })),
    line(entry("tl1", "mc1", { type: "thinking_level_change", thinkingLevel: "medium" })),
    line(custom("wt", "tl1", "worktrees", worktrees)),
    line(custom("sb", "wt", "sandbox", sandbox)),
    line(custom("mode", "sb", "mode", { mode: "delegate", active: mode })),
    line(user("u1", "mode", "q")),
    line(assistant("a1", "u1", text("answer"))),
    line(custom("mode2", "a1", "mode", { mode: "normal", active: { version: 1, mode: "normal", strict: false, minorModes: [] } })),
    line(custom("wt2", "mode2", "worktrees", { version: 1, trees: [] })),
    line(custom("sb2", "wt2", "sandbox", { ...sandbox, on: false, enforcement: "none" })),
    line(entry("mc2", "sb2", { type: "model_change", provider: "other", modelId: "later-model" })),
    line(user("u2", "mc2", "later")),
    line(assistant("a2", "u2", text("later answer"))),
  ];
  const path = source(`state-${n++}`, lines);
  const check = untouched(path);
  const r = forkSessionFile(path, "a1");
  assert.equal(r.ok, true, (r as { message?: string }).message);
  if (!r.ok) return;
  const copied = readFileSync(r.path, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(copied.slice(1, -1), lines.slice(1, 8), "the selected prefix stays byte-identical");
  const entries = copied.map(l => JSON.parse(l));
  const sm = SessionManager.inMemory(cwd, undefined, entries);
  const branch = sm.getBranch();
  assert.deepEqual(restoreWorktrees(branch), worktrees);
  assert.equal(sharedWith(restoreWorktrees(branch)!.trees[0]!, r.sessionId), "src-state");
  assert.deepEqual(restoreMode(branch), mode);
  assert.deepEqual(restoreSandbox(branch), sandbox);
  assert.deepEqual(sm.buildSessionContext().model, { provider: "zai", modelId: "glm-5.3" });
  assert.equal(sm.buildSessionContext().thinkingLevel, "medium");
  check();
});

test("leading worker registries are removed without leaving a dangling root", () => {
  const path = source(`registry-root-${n++}`, [
    headerOf("src-registry-root"),
    line(custom("wm", null, "subagents-worker-manifest", {})),
    line(user("u1", "wm", "q")),
    line(assistant("a1", "u1", text("answer"))),
  ]);
  const result = forkSessionFile(path, "a1");
  assert.ok(result.ok);
  const entries = readFileSync(result.path, "utf8").trim().split("\n").map(l=>JSON.parse(l));
  assert.equal(entries[1].id, "u1");
  assert.equal(entries[1].parentId, null);
});

test("nested forks of inherited replies keep the root cache key, not the intermediate fork id", () => {
  const path = source(`nested-${n++}`, CANONICAL);
  const parentCheck = untouched(path);
  const first = forkSessionFile(path, "a3");
  assert.ok(first.ok);
  const firstCheck = untouched(first.path);
  // a1 precedes the cache metadata added at the end of the first fork's file.
  const nested = forkSessionFile(first.path, "a1");
  assert.ok(nested.ok);
  const nestedEntries = readFileSync(nested.path, "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(inheritedCacheKey(nestedEntries), "src-canonical");
  assert.notEqual(inheritedCacheKey(nestedEntries), first.sessionId);
  assert.notEqual(nested.sessionId, first.sessionId);
  assert.notEqual(nested.sessionId, "src-canonical");
  assert.equal(new Set(nestedEntries.slice(1).map(e => e.id)).size, nestedEntries.length - 1, "metadata never collides with copied entry ids");
  assert.deepEqual(nestedEntries.filter(e => e.type === "message").map(e => e.id), ["u1", "a1"]);
  firstCheck();
  parentCheck();
});

test("copied wake schedules cannot re-arm, while their model-visible history is unchanged", () => {
  const wakeMessage = { role: "toolResult", toolCallId: "wake-call", toolName: "wake_nudge", content: text("Scheduled n1"), details: { action: "schedule", nudge: { id: "n1", fireAt: 1, createdAt: 0, reason: "source job" }, active: [] }, isError: false, timestamp: 0 };
  const wakeResult = entry("tr", "call", { message: wakeMessage });
  const path = source(`wake-${n++}`, [
    headerOf("src-wake"),
    line(user("u1", null, "check later")),
    line(assistant("call", "u1", toolCall("wake-call", "wake_nudge"))),
    line(wakeResult),
    line(assistant("a1", "tr", text("scheduled"))),
  ]);
  const check = untouched(path);
  const result = forkSessionFile(path, "a1");
  assert.ok(result.ok);
  const entries = readFileSync(result.path, "utf8").trim().split("\n").map(l=>JSON.parse(l));
  const copiedResult = entries.find(e=>e.id==="tr").message;
  assert.equal(copiedResult.details, undefined, "wake-nudge reconstruct has no copied schedule to arm");
  assert.deepEqual(copiedResult.content, wakeMessage.content);
  assert.deepEqual({ ...copiedResult, details: wakeMessage.details }, wakeMessage);
  check();
});

test("cache metadata creates neither model context nor a transcript notice", () => {
  const entries: any[] = [
    { type: "session", version: 3, id: "child", timestamp: new Date(0).toISOString(), cwd: "/tmp/fork" },
    { type: "message", id: "u1", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "hello", timestamp: 0 } },
    { type: "custom", customType: FORK_CACHE_ENTRY, data: { v: 1, key: "root" }, id: "cache", parentId: "u1", timestamp: new Date(0).toISOString() },
  ];
  const manager = SessionManager.inMemory("/tmp/fork", undefined, entries);
  assert.deepEqual(manager.buildSessionProjection().messages.map((m: any) => m.role), ["user"]);
  assert.deepEqual(normalizeEntries(entries).map((row) => row.kind), ["user"]);
  assert.equal(manager.getSessionId(), "child", "cache affinity is not the conversation id");
});
