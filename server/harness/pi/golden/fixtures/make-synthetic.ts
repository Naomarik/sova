// Writes fixtures/synthetic/*.jsonl: the hand-written pi session files the goldens read (README.md here).
// Run: bun server/harness/pi/golden/fixtures/make-synthetic.ts [--check]
// The committed .jsonl files are the fixtures; this is how they were written, kept so a reader can see
// what each line is for and a new fixture is written the same way. A changed fixture changes its expected
// outputs: re-record with `node scripts/harness-golden.mjs record` and review the diff with the fixture's.
// `--check` writes nothing and exits 1 when a committed file differs from what this would write.
// Every line is compact JSON (the line prefilters in the readers match `"role":"user"`), no real content.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyAlignCall, type AlignDetails, type AlignDocument } from "../../../../../pi-config/extensions/mode/align.ts";

const OUT = join(import.meta.dirname, "synthetic");
const T0 = Date.parse("2026-09-01T10:00:00.000Z");

type Json = Record<string, unknown>;

/** One session file being written: ids in order, each entry parented on the leaf unless told otherwise. */
class Session {
  lines: string[] = [];
  leaf: string | null = null;
  private n = 0;
  private t = 0;
  constructor(readonly prefix: string) {}

  /** The next entry's ISO time and ms, one second apart. */
  private tick(): { iso: string; ms: number } {
    const ms = T0 + this.t++ * 1000;
    return { iso: new Date(ms).toISOString(), ms };
  }
  nextId(): string {
    return `${this.prefix}${(++this.n).toString(16).padStart(8 - this.prefix.length, "0")}`;
  }
  header(extra: Json = {}): this {
    this.lines.push(JSON.stringify({ type: "session", version: 3, id: `0190a000-0000-7000-8000-${this.prefix.padEnd(12, "0")}`, timestamp: this.tick().iso, cwd: "/home/user/golden", ...extra }));
    return this;
  }
  raw(line: string): this {
    this.lines.push(line);
    return this;
  }
  /** Appends `{type, ...body, id, parentId, timestamp}` (pi's key order for custom entries) and moves the leaf. */
  entry(type: string, body: Json = {}, opts: { parent?: string | null; id?: string } = {}): string {
    const id = opts.id ?? this.nextId();
    const { iso } = this.tick();
    const parentId = opts.parent === undefined ? this.leaf : opts.parent;
    this.lines.push(JSON.stringify({ type, ...body, id, parentId, timestamp: iso }));
    this.leaf = id;
    return id;
  }
  /** A message entry; the message's own ms timestamp is the entry's time. */
  message(message: Json, opts: { parent?: string | null; id?: string } = {}): string {
    const ms = T0 + this.t * 1000;
    return this.entry("message", { message: { ...message, timestamp: ms } }, opts);
  }
  user(content: unknown, opts: { parent?: string | null } = {}): string {
    return this.message({ role: "user", content: typeof content === "string" ? [{ type: "text", text: content }] : content }, opts);
  }
  assistant(content: unknown[], extra: Json = {}, opts: { parent?: string | null } = {}): string {
    return this.message(
      { role: "assistant", content, api: "openai-completions", provider: "zai", model: "glm-5.3", usage: usage(1200, 80, 400, 0), stopReason: "stop", ...extra },
      opts,
    );
  }
  toolResult(toolCallId: string, toolName: string, text: string, extra: Json = {}): string {
    return this.message({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, ...extra });
  }
  custom(customType: string, data: unknown, opts: { parent?: string | null } = {}): string {
    return this.entry("custom", { customType, data }, opts);
  }
  customMessage(customType: string, content: unknown, display: boolean, details?: unknown): string {
    return this.entry("custom_message", { customType, content, display, ...(details !== undefined ? { details } : {}) });
  }
  text(): string {
    return `${this.lines.join("\n")}\n`;
  }
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number): Json {
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 } };
}

const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const text = (t: string) => ({ type: "text", text: t });
/** A 1x1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const image = { type: "image", data: PNG, mimeType: "image/png" };
/** Two resize notes pi 0.87 appends for two images (shared/image-note.ts: scale = original / displayed). */
const NOTES = [
  "[Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.28 to map to original image.]",
  "[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]",
].join("\n");

const alignEnv = { now: "2026-09-01T10:00:00.000Z", readFile: () => "" };
/** The align tool's details for a sequence of calls (the mode extension's own code writes them). */
function alignCalls(list: unknown[]): AlignDetails[] {
  let docs: AlignDocument[] = [];
  return list.map((c) => {
    const { details } = applyAlignCall(docs, c, alignEnv);
    if (details.doc) docs = [...docs.filter((d) => d.id !== details.doc!.id), details.doc];
    return JSON.parse(JSON.stringify(details)) as AlignDetails;
  });
}
const Q = (topic: string) => ({ topic, ask: `${topic}?`, recommendation: { choice: "yes", why: "simpler" } });

const teamMember = (workerId: string, role: string, extra: Json = {}) => ({ workerId, role, ownedPaths: [], backend: "pi", model: "zai/glm-5.3", groupId: "run_01", addedAt: T0, ...extra });
const teamEvent = (kind: string, workerId: string, role: string, at: number, detail?: string) => ({ version: 1, teamId: "team_01", kind, workerId, role, at, ...(detail ? { detail } : {}) });
const manifest = (data: Json) => ({ v: 1, kind: "worker-manifest", backend: "pi", ...data });
const outline = (now: string, overall: string, generatedAt: number, headings: string[]) => ({
  version: 2,
  now,
  overall,
  state: "fresh",
  generatedAt,
  topics: headings.map((h, i) => ({ id: `t${i + 1}`, heading: h, summary: [`${h} first point`, `${h} second point`, `${h} third point`], at: generatedAt, anchor: { entryId: null, timestamp: generatedAt } })),
});
const profile = (id: string, label: string, extra: Json = {}) => ({ v: 1, profile: { id, label, icon: "user", source: "sova", ...extra } });

const fixtures: Record<string, () => Session> = {
  /** Every entry type and role pi 0.87.1 writes, and every custom type the transcript renders. */
  "all-types": () => {
    const s = new Session("a").header({ parentSession: "/home/user/.pi/agent/sessions/--home-user-golden--/2026-08-31T09-00-00-000Z_0190a000-0000-7000-8000-parent000000.jsonl" });
    s.entry("model_change", { provider: "zai", modelId: "glm-5.3" });
    s.entry("thinking_level_change", { thinkingLevel: "medium" });
    s.custom("sova-profile", profile("reviewer", "Reviewer", { singleton: true }));
    s.custom("mode", { mode: "delegate", active: { major: "delegate" } });
    s.custom("mode", { minor: "spec", on: true });
    s.custom("mode", { strict: true });
    s.custom("mode", { active: { major: "code" } });
    s.user("Plain question about the parser");
    s.custom("sova-overseer-sent", { targetId: s.leaf });
    s.user([text(`Two screenshots attached /tmp/pi-clipboard-golden-0001.png\n\n${NOTES}`), image, image]);
    s.custom("sova-session-sent", { targetId: s.leaf, from: { sessionId: "0190a000-0000-7000-8000-sender000000", title: "Sender" }, hop: 2 });
    s.assistant([{ type: "thinking", thinking: "Consider the parser.", thinkingSignature: "sig-abc" }, text("Here is the answer, see /tmp/golden-chart.png"), call("call_1", "read", { path: "src/a.ts" })], { stopReason: "toolUse", usage: usage(5000, 200, 1000, 300) });
    s.toolResult("call_1", "read", "file contents line 1\nline 2", { details: { truncation: null } });
    s.assistant([call("call_2", "bash", { command: "pnpm test", timeout: 60 }), call("call_3", "edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] }), call("call_4", "agent_spawn", { name: "helper", task: "do it" })], { stopReason: "toolUse" });
    s.toolResult("call_2", "bash", "Error: tests failed", { isError: true });
    s.toolResult("call_3", "edit", "Successfully replaced text", { details: { diff: "-1 a\n+1 b", firstChangedLine: 1 } });
    s.toolResult("call_4", "agent_spawn", `spawned ag_01 ${"x".repeat(2100)}`);
    s.assistant([{ type: "future_block", payload: 1 }, text("Unknown block before me")], { stopReason: "stop" });
    s.assistant([text("partial")], { stopReason: "error", errorMessage: "429 Too Many Requests: rate limited", usage: usage(0, 0, 0, 0) });
    s.assistant([], { stopReason: "aborted", usage: usage(10, 0, 0, 0) });
    s.assistant([text("cut off")], { stopReason: "length" });
    s.assistant([text("No provider on this one")], { provider: undefined, model: undefined });
    const [created, exempt] = alignCalls([
      { ops: [{ op: "create", title: "Export", summary: "Download a session.", questions: [Q("Format"), Q("Zip")] }] },
      { ops: [{ op: "exempt", reason: "a question, no change" }] },
    ]);
    s.assistant([call("call_5", "align", {}), call("call_6", "align", {})], { stopReason: "toolUse" });
    s.toolResult("call_5", "align", "created", { details: created });
    s.toolResult("call_6", "align", "exempt", { details: exempt });
    s.message({ role: "bashExecution", command: "ls -la", output: "total 0", exitCode: 0, cancelled: false, truncated: false });
    s.message({ role: "custom", customType: "note-ext", content: "A short extension note", display: true });
    s.message({ role: "custom", customType: "note-ext", content: "Hidden extension note", display: false });
    s.message({ role: "custom", customType: "subagent-complete", content: "### ag_01 (helper) — done · task success\nAll green.", display: true });
    s.message({ role: "branchSummary", summary: "We tried a different approach.", fromId: s.leaf });
    s.message({ role: "compactionSummary", summary: "Earlier work summarized.", tokensBefore: 90000 });
    s.message({ role: "system", content: [text("Base prompt")], sections: { skills: "<available_skills>\n<skill><name>golden-skill</name><description>A skill</description><location>/home/user/.pi/skills/golden-skill/SKILL.md</location></skill>\n</available_skills>", tools: null }, toolsAdded: [{ name: "echo", description: "Echo", parameters: { type: "object" } }], toolsRemoved: [{ name: "old" }] });
    s.entry("session_info", { name: "Golden all types" });
    const target = s.leaf!;
    s.entry("label", { targetId: target, label: "checkpoint" });
    s.entry("label", { targetId: target, label: undefined });
    s.entry("compaction", { summary: "## Summary\nAll of the above.", firstKeptEntryId: target, tokensBefore: 123456, details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] } });
    s.entry("branch_summary", { fromId: target, summary: "Abandoned branch notes." });
    s.custom("btw-thread-entry", { question: "Side   question about\nthe cache?", answer: "The cache is warm.", provider: "zai", model: "glm-5.3" });
    s.custom("btw-thread-entry", { question: "Still running", answer: "" });
    s.custom("align-doc", { version: 1, doc: { id: "al_9", title: "Old", markdown: "# Old", questions: [] } });
    s.custom("align-doc", { version: 1, doc: { id: "al_9", title: "Export", markdown: "# Export\n\nDecide the format.", questions: [{ checked: true }, { checked: false }], revision: 3 } });
    s.custom("explain-doc", { id: "ex_1", topic: "The reader", summary: "", createdAt: "2026-09-01T10:01:00.000Z", parentSessionId: "p1", status: "running" });
    s.custom("explain-doc", { id: "ex_1", topic: "The reader", summary: "How the reader works.", createdAt: "2026-09-01T10:01:00.000Z", parentSessionId: "p1", model: "zai/glm-5.3" });
    s.custom("explain-doc", { id: "ex_2", topic: "Broken", summary: "", createdAt: "2026-09-01T10:02:00.000Z", parentSessionId: "p1", status: "interrupted", error: "child died" });
    s.custom("compact-handoff-run", { v: 1, id: "ho_1", status: "running", at: T0, focus: "the parser" });
    s.custom("compact-handoff-run", { v: 1, id: "ho_1", status: "saved", at: T0, path: "/home/user/golden/HANDOFF.md" });
    s.custom("compact-handoff-run", { v: 1, id: "ho_2", status: "failed", at: T0, error: "no model" });
    s.custom("sova-profile", profile("default", "Default"));
    s.custom("sova-overseer-dialog-answer", { title: "Pick one", answer: "Yes" });
    s.custom("subagents-team-event-v1", teamEvent("wrap-up", "ag_02", "writer", T0 + 60_000, "context 78% of 200k"));
    s.custom("subagents-team-event-v1", { ...teamEvent("pause", "ag_02", "writer", T0), kind: "stop" });
    s.custom("claude-login", { v: 1, login: "work", label: "Work", from: "default", fromLabel: "Personal", reason: "limit", text: "Switched to Work: Personal hit its limit." });
    s.custom("claude-login", { v: 1, login: "work" });
    s.custom("sova-baton-sent", { v: 1, targetId: target, by: "p_alice" });
    s.custom("sova-baton-handoff", { v: 1, n: 1, from: "p_alice", to: "p_bob", question: "Can you check?", briefing: "Context here" });
    s.custom("sova-baton-decision", { v: 1, by: "p_bob", area: "API", statement: "Use REST", quote: "REST is fine" });
    s.custom("sova-baton-done", { v: 1, summary: "Finished." });
    s.custom("sova-baton-offer", { v: 1, n: 2, offerId: "of_1", from: "p_bob", to: ["p_carol", "p_dave", 7], question: "Anyone?", briefing: "More" });
    s.custom("sova-baton-lease", { v: 1, n: 2, offerId: "of_1", event: "claimed", by: "p_carol" });
    s.custom("sova-baton-proposal", { v: 1, personId: "p_erin", name: "Erin", role: "QA", why: "tests", by: "p_carol" });
    s.custom("sova-baton-wrapup", { v: 1, phase: "start" });
    s.custom("sova-baton-wrapup", { v: 1, phase: "end", applied: [{ personId: "p_bob" }], refused: [], error: "one refused" });
    s.custom("topic-outline", outline("Working on the parser", "Golden fixture session", T0 + 120_000, ["Parser", "Tests"]));
    s.custom("some-extension-state", { any: "thing" });
    s.customMessage("worktree-merge", "Merged feat/golden into master", true, { version: 1, path: "/wt/golden", branch: "feat/golden", target: "master", sha: "abc1234", commits: 3, added: 10, removed: 2, fastForward: true, how: "tool" });
    s.customMessage("worktree-merge", "Merged, details unreadable", true, { version: 9 });
    s.customMessage("hidden-ext", "Never shown", false);
    s.customMessage("generic-ext", [text("A generic extension message\nwith two lines")], true);
    s.customMessage("team-report", "[Team report from coordinator lead (ag_01), team_01 — golden team · milestone]\nMilestone reached.\n(Informational: no action is requested.)", true);
    s.entry("usage", { kind: "cache_warm", provider: "anthropic", model: "claude-sonnet-5", usage: usage(0, 0, 9000, 0) });
    s.entry("context_edit", { targetId: target, replacement: null });
    s.assistant([text("Final reply after everything.")], { usage: usage(2000, 100, 60000, 500) });
    return s;
  },

  /** A top-level type and a role this version doesn't know: mid-branch, and as the leaf. */
  unknown: () => {
    const s = new Session("b").header();
    s.user("Before the unknown entry");
    s.entry("future_entry", { payload: { a: 1 } });
    s.assistant([text("Reply after the unknown entry")]);
    s.message({ role: "future_role", content: [text("from the future")] });
    s.entry("future_entry", { payload: { leaf: true } });
    return s;
  },

  /** An id-less unknown entry in a file whose other entries have ids (B §2.3.6): pins today's flattening. */
  "unknown-noid": () => {
    const s = new Session("c").header();
    const root = s.user("Root question");
    s.assistant([text("Abandoned answer")]);
    s.user("Abandoned follow-up");
    s.assistant([text("Kept answer")], {}, { parent: root });
    s.raw(JSON.stringify({ type: "future_entry", timestamp: "2026-09-01T10:10:00.000Z", payload: "no id" }));
    s.user("After the id-less entry");
    return s;
  },

  /** Two rewinds: each marker abandons a branch; the leaf is the last marker. */
  rewind: () => {
    const s = new Session("d").header();
    s.entry("model_change", { provider: "zai", modelId: "glm-5.3" });
    s.user("First question");
    const a1 = s.assistant([text("First answer")]);
    const u2 = s.user("Second question, abandoned");
    const a2 = s.assistant([text("Second answer, abandoned")]);
    s.custom("sova-rewind", { targetId: u2, fromLeafId: a2 }, { parent: a1 });
    const u3 = s.user("Second question, retyped");
    const a3 = s.assistant([text("Second answer, kept for a while")]);
    s.custom("sova-rewind", { targetId: u3, fromLeafId: a3 }, { parent: a1 });
    s.custom("sova-rewind", {}, { parent: s.leaf });
    return s;
  },

  /** A forked session: parentSession, the fork cache entry, dropped registry types, a wake_nudge result. */
  fork: () => {
    const s = new Session("e").header({ parentSession: "/home/user/.pi/agent/sessions/--home-user-golden--/2026-08-31T09-00-00-000Z_0190a000-0000-7000-8000-source000000.jsonl" });
    s.entry("model_change", { provider: "openai", modelId: "gpt-5.5" });
    s.custom("sova-fork-cache", { v: 1, key: "pck_golden", from: "0190a000-0000-7000-8000-source000000" });
    s.custom("subagents-worker-manifest", manifest({ workerId: "ag_01", name: "helper", status: "running" }));
    s.custom("subagents-team-v1", { version: 1, op: "create", team: { id: "team_01", name: "t", objective: "o", createdAt: T0 }, members: [teamMember("ag_01", "writer")] });
    s.custom("subagents-team-event-v1", teamEvent("pause", "ag_01", "writer", T0 + 1000, "pause → coordinator: wait"));
    s.custom("subagents-team-assignment-v1", { version: 1 });
    s.user("Fork from here please");
    s.assistant([call("call_w", "wake_nudge", { in: "5m" })], { stopReason: "toolUse" });
    s.toolResult("call_w", "wake_nudge", "Wake nudge n3 set for 5m", { details: { id: "n3", at: T0 + 300_000, timer: "armed" } });
    s.assistant([text("I will check back in five minutes.")]);
    return s;
  },

  /** The branch ends at a compaction: the fill is unknown (null) until the next reply. */
  "compaction-end": () => {
    const s = new Session("f").header();
    s.entry("model_change", { provider: "zai", modelId: "glm-5.3" });
    const u = s.user("Long work");
    s.assistant([text("Done with step one")], { usage: usage(80000, 500, 20000, 1000) });
    s.entry("compaction", { summary: "Step one summarized.", firstKeptEntryId: u, tokensBefore: 101000, details: { readFiles: [], modifiedFiles: ["a.ts"] } });
    return s;
  },

  /** Messages after a compaction: the fill is the next reply's, its model from the model_change before it. */
  "compaction-mid": () => {
    const s = new Session("g").header();
    s.entry("model_change", { provider: "zai", modelId: "glm-5.3" });
    const u = s.user("Long work");
    s.assistant([text("Done with step one")], { usage: usage(80000, 500, 20000, 1000) });
    s.entry("compaction", { summary: "Step one summarized.", firstKeptEntryId: u, tokensBefore: 101000 });
    s.entry("model_change", { provider: "anthropic", modelId: "claude-sonnet-5" });
    s.user("Continue");
    s.assistant([text("Step two")], { provider: undefined, model: undefined, usage: usage(3000, 100, 0, 2000) });
    s.assistant([text("errored")], { stopReason: "error", errorMessage: "overloaded", usage: usage(5000, 0, 0, 0) });
    return s;
  },

  /** The reply followed by 0.86 usage, 0.87 context_edit and system lines (the f202d276 class): tail readers
      must still find the reply. */
  "tail-0.86-0.87": () => {
    const s = new Session("h").header();
    s.entry("model_change", { provider: "anthropic", modelId: "claude-sonnet-5" });
    s.message({ role: "system", content: "Base prompt", sections: { skills: "<available_skills></available_skills>" } });
    const u = s.user("Do the thing");
    s.assistant([call("call_t", "read", { path: "x" })], { stopReason: "toolUse", provider: "anthropic", model: "claude-sonnet-5" });
    s.toolResult("call_t", "read", "x");
    s.assistant([text("The thing is done.")], { provider: "anthropic", model: "claude-sonnet-5", usage: usage(4000, 300, 50000, 700) });
    s.entry("usage", { kind: "cache_warm", provider: "anthropic", model: "claude-sonnet-5", usage: usage(0, 1, 54000, 0) });
    s.entry("context_edit", { targetId: u, replacement: { content: [text("Do the thing (edited)")] } });
    s.message({ role: "system", content: "Additional instructions", sections: { mode: "<mode>code</mode>" } });
    s.entry("usage", { kind: "future_kind", provider: "anthropic", model: "claude-sonnet-5", usage: usage(1, 1, 0, 0), note: "unknown kind" });
    return s;
  },

  /** A legacy v1 file: no ids, linear. */
  "legacy-v1": () => {
    const s = new Session("i");
    s.raw(JSON.stringify({ type: "session", id: "legacy-0001", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/home/user/legacy" }));
    s.raw(JSON.stringify({ type: "model_change", timestamp: "2025-01-01T00:00:01.000Z", provider: "anthropic", modelId: "claude-3" }));
    s.raw(JSON.stringify({ type: "message", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "user", content: "A string-content legacy question", timestamp: 1735689602000 } }));
    s.raw(JSON.stringify({ type: "message", timestamp: "2025-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "Legacy answer" }], provider: "anthropic", model: "claude-3", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 1735689603000 } }));
    s.raw(JSON.stringify({ type: "message", timestamp: "2025-01-01T00:00:04.000Z", message: { role: "user", content: "Second legacy question", timestamp: 1735689604000 } }));
    return s;
  },

  /** Blank lines, a malformed middle line, a torn last line: tolerant readers skip them, the fork reader refuses. */
  torn: () => {
    const s = new Session("j").header();
    s.user("Before the damage");
    s.raw("");
    s.raw("   ");
    s.raw('{"type":"message","id":"j-broken","parentId":');
    s.assistant([text("After the malformed line")]);
    s.raw("[1,2,3]");
    s.user("Last whole line");
    s.raw('{"type":"message","id":"j0000099","parentId":"j0000003","timestamp":"2026-09-01T10:00:09.000Z","message":{"role":"assistant","content":[{"type":"text","text":"torn');
    return s;
  },

  /** A parent cycle: the walk stops where it repeats. */
  "broken-cycle": () => {
    const s = new Session("k").header();
    s.user("Root", { parent: "k0000003" });
    s.assistant([text("Middle")]);
    s.user("Leaf closes the cycle");
    return s;
  },

  /** A dangling parent: the walk stops at the entry whose parent is missing. */
  "broken-dangling": () => {
    const s = new Session("l").header();
    s.user("Orphaned root");
    s.assistant([text("Answer")]);
    s.user("Parent is missing", { parent: "lmissing" });
    s.assistant([text("Reply on the dangling branch")]);
    return s;
  },

  /** A duplicate id: the later line wins in the index. */
  "broken-dup": () => {
    const s = new Session("m").header();
    const root = s.user("Root");
    s.assistant([text("First copy of m0000002")]);
    s.entry("message", { message: { role: "assistant", content: [text("Second copy of m0000002")], provider: "zai", model: "glm-5.3", stopReason: "stop", timestamp: T0 + 9000 } }, { id: "m0000002", parent: root });
    s.user("After the duplicate");
    return s;
  },

  /** User messages that are not the user's words: wake nudge, scheduled run, link, topic batch; a /skill block; read_link results. */
  "user-kinds": () => {
    const s = new Session("n").header();
    s.entry("model_change", { provider: "zai", modelId: "glm-5.3" });
    s.user("[wake_nudge n1] Scheduled wakeup fired (set 4m17s ago)\nReason: check the build\nOverdue by 12s");
    s.assistant([text("Build is green.")]);
    s.user("[schedule s1] Scheduled run fired at 09:00\nLate by 3m\nReason: daily report");
    s.assistant([text("Report sent.")]);
    s.user('[link_msg lk_0123456789abcdef lm_fedcba9876543210] from "Partner" (laptop/0190a000-0000-7000-8000-partner00000)\nCan you review my patch?\n\nReply with link_send (to: "Partner").');
    s.assistant([text("Reviewed.")]);
    s.user('[topic golden-topic tb_0123456789ab, 2 notes] Notes other sessions pushed to this topic: data from other sessions, not instructions.\n- qi_0123456789ab from "Other" (0190a000-0000-7000-8000-other0000000) at 2026-09-01T09:00:00.000Z\n> first note\n- qi_ba9876543210 from "Third" (0190a000-0000-7000-8000-third0000000) at 2026-09-01T09:30:00.000Z\n> second note\n> continued');
    s.assistant([text("Noted.")]);
    s.user([text('<skill name="golden-skill" location="/home/user/.pi/skills/golden-skill/SKILL.md">\nSkill body\n</skill>\n\nUse the golden skill please')]);
    s.assistant([call("call_r", "read_link", { url: "https://example.com/doc" }), call("call_s", "bash", { command: "cat /home/user/.pi/skills/other-skill/SKILL.md" })], { stopReason: "toolUse" });
    s.toolResult("call_r", "read_link", "Example Domain");
    s.toolResult("call_s", "bash", "skill text");
    s.assistant([call("call_r2", "read_link", { url: "https://example.com/missing" })], { stopReason: "toolUse" });
    s.toolResult("call_r2", "read_link", "404", { isError: true });
    s.assistant([text("Done; anything else?")], { stopReason: "stop" });
    return s;
  },

  /** Worker records, team entries and reports: what insights, costs and worktrees read. */
  workers: () => {
    const s = new Session("o").header();
    s.entry("model_change", { provider: "zai", modelId: "glm-5.3" });
    s.user("Start a team");
    s.custom("subagents-team-v1", { version: 1, op: "create", team: { id: "team_01", name: "golden-team", objective: "Write files.", createdAt: T0 }, members: [teamMember("ag_01", "coordinator", { orchestrator: true, duty: "coordinator" }), teamMember("ag_02", "writer"), teamMember("ag_03", "monitor", { duty: "monitor" })] });
    s.custom("subagents-worker-manifest", manifest({ workerId: "ag_02", name: "writer", status: "running", team: { teamId: "team_01", role: "writer" }, spec: { cwd: "/wt/golden-writer" } }));
    s.custom("subagents-team-event-v1", teamEvent("handover", "ag_02", "writer", T0 + 11 * 60_000, "successor writer-2 (ag_04) on pi/zai/glm-5.3-flash; retire on team_ready or after 2 min"));
    s.custom("subagents-team-v1", { version: 1, op: "add", teamId: "team_01", members: [teamMember("ag_04", "writer-2", { successorOf: "ag_02" })] });
    s.custom("subagents-worker-manifest", manifest({ workerId: "ag_02", status: "done", taskOutcome: "success", endedAt: T0 + 12 * 60_000 }));
    s.custom("subagents-team-event-v1", teamEvent("retire", "ag_02", "writer", T0 + 12 * 60_000, "retired: successor writer-2 (ag_04) confirmed the takeover"));
    s.custom("subagents-worker-manifest", manifest({ workerId: "ag_03", status: "lost", at: T0 + 13 * 60_000 }));
    s.customMessage("subagent-complete", "### ag_02 (writer) — done · task success\nWrote 3 files.", true);
    s.custom("subagents-worker-registry", { version: 1, workers: [{ id: "ag_09", name: "legacy" }] });
    s.custom("worktrees", { version: 1, trees: [{ path: "/wt/golden-writer", branch: "feat/golden-writer", base: "abc", baseBranch: "master", status: "active", session: "0190a000-0000-7000-8000-o00000000000", how: "created", at: T0 }] });
    s.assistant([text("The team finished.")], { usage: usage(9000, 400, 30000, 0) });
    return s;
  },

  /** A baton session (§app.baton): every baton custom type, hand-offs and the wrap-up span. */
  baton: () => {
    const s = new Session("p").header({ cwd: "/home/user/workspace/golden-org" });
    s.custom("sova-baton", { v: 1, orgId: "org_golden", projectId: "proj_1" });
    s.entry("model_change", { provider: "zai", modelId: "glm-5.3" });
    const m1 = s.user("Alice asks about the launch date");
    s.custom("sova-baton-sent", { v: 1, targetId: m1, by: "p_alice" });
    s.assistant([text("The launch is planned for Monday.")]);
    s.custom("sova-baton-handoff", { v: 1, n: 1, from: "p_alice", to: "p_bob", question: "Bob, can you confirm Monday?", briefing: "Alice needs a date" });
    const m2 = s.user([text("Bob confirms Monday, photo attached"), image]);
    s.custom("sova-baton-sent", { v: 1, targetId: m2, by: "p_bob" });
    s.assistant([text("Thanks Bob, Monday it is.")]);
    s.custom("sova-baton-decision", { v: 1, by: "p_bob", area: "Launch", statement: "Launch on Monday", quote: "Bob confirms Monday" });
    s.custom("sova-baton-offer", { v: 1, n: 2, offerId: "of_1", from: "p_bob", to: ["p_carol", "p_dave"], question: "Who can write the notes?", briefing: "Launch notes" });
    s.custom("sova-baton-lease", { v: 1, n: 2, offerId: "of_1", event: "claimed", by: "p_carol" });
    const m3 = s.user("Carol will write the notes");
    s.custom("sova-baton-sent", { v: 1, targetId: m3, by: "p_carol" });
    s.assistant([text("Great, Carol.")]);
    s.custom("sova-baton-proposal", { v: 1, personId: "p_erin", name: "Erin", role: "QA", why: "testing", by: "p_carol" });
    s.custom("sova-baton-done", { v: 1, summary: "Launch Monday, Carol writes notes." });
    s.custom("sova-baton-wrapup", { v: 1, phase: "start" });
    s.user("Operator wrap-up prompt");
    s.assistant([text("Wrap-up: updated two profiles.")]);
    s.custom("sova-baton-wrapup", { v: 1, phase: "end", applied: [{ personId: "p_bob" }, { personId: "p_carol" }], refused: [] });
    s.user("Message after the wrap-up");
    return s;
  },

  /** Align results, worktrees entries and a merge card: the incremental align and merge-readiness scans. */
  "align-merge": () => {
    const s = new Session("q").header();
    s.entry("model_change", { provider: "zai", modelId: "glm-5.3" });
    s.custom("mode", { mode: "code", active: { major: "code" } });
    s.user("Align on the export, then build it");
    const [created, second, answered, finished] = alignCalls([
      { ops: [{ op: "create", title: "Export", summary: "Download a session.", questions: [Q("Format"), Q("Zip")] }] },
      { ops: [{ op: "create", title: "Pane", summary: "Show workers.", questions: [Q("Cap")] }] },
      { doc: "al_1", ops: [{ op: "decide", q: "q1", decision: "JSONL" }] },
      { doc: "al_2", ops: [{ op: "accept_all" }, { op: "status", to: "done" }] },
    ]);
    for (const [i, d] of [created, second, answered].entries()) {
      s.assistant([call(`call_a${i}`, "align", {})], { stopReason: "toolUse" });
      s.toolResult(`call_a${i}`, "align", d!.line, { details: d });
    }
    s.assistant([text("Two questions are open on Export. Shall I go on?")]);
    s.user("Yes, build it");
    s.custom("worktrees", { version: 1, trees: [{ path: "/wt/export", branch: "feat/export", base: "abc", baseBranch: "master", status: "active", session: "0190a000-0000-7000-8000-q00000000000", how: "created", at: T0 }] });
    s.assistant([call("call_a3", "align", {}), call("call_c", "bash", { command: "pnpm test" })], { stopReason: "toolUse" });
    s.toolResult("call_a3", "align", finished!.line, { details: finished });
    s.toolResult("call_c", "bash", "run-tests (bun): 10 files, 0 fail");
    s.customMessage("worktree-merge", "Merged feat/export into master", true, { version: 1, path: "/wt/export", branch: "feat/export", target: "master", sha: "def5678", commits: 4, added: 40, removed: 3, fastForward: true, how: "tool" });
    s.custom("worktrees", { version: 1, trees: [{ path: "/wt/export", branch: "feat/export", base: "abc", baseBranch: "master", status: "merged", session: "0190a000-0000-7000-8000-q00000000000", how: "created", at: T0 }] });
    s.assistant([text("Merged. Restart the server to pick it up.\n\nAlso changes: none")]);
    return s;
  },
};

const check = process.argv.includes("--check");
mkdirSync(OUT, { recursive: true });
let differs = 0;
for (const [name, make] of Object.entries(fixtures)) {
  const file = join(OUT, `${name}.jsonl`);
  const body = make().text();
  if (check) {
    let had = "";
    try {
      had = readFileSync(file, "utf8");
    } catch {
      // missing: differs
    }
    if (had !== body) {
      differs++;
      console.log(`differs: ${name}.jsonl`);
    }
  } else writeFileSync(file, body);
}
if (check && differs) process.exit(1);
console.log(check ? "synthetic fixtures match" : `wrote ${Object.keys(fixtures).length} fixtures to ${OUT}`);
