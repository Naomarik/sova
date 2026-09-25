// Run: npx tsx --test server/session-tags.test.ts
// Session tags against a scripted FakeProvider: the store, the wire gate, eligibility, the
// head/tail-only input, the re-tag bound, and the promise that a .jsonl is never written.
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { DecisionSettings, SessionSummary, SessionTags } from "../shared/protocol";
import type { TagsChange } from "./session-tags";

const agentDir = mkdtempSync(join(tmpdir(), "sova-session-tags-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-tags--");
mkdirSync(sessionsDir, { recursive: true });

const tags = await import("./session-tags");
const { createFakeProvider } = await import("./decide-fake");
const { DecisionError } = await import("./decide");
const { Redactor } = await import("./overseer-redact");

after(() => rmSync(agentDir, { recursive: true, force: true }));

const storeFile = join(agentDir, "sova", "session-tags.json");
const DAY = 86_400_000;
const T0 = Date.parse("2026-09-20T12:00:00.000Z");

const SETTINGS: DecisionSettings = {
  version: 1,
  jev: { enabled: true },
  fallback: null,
  features: { attention: false, tags: true },
  exclusions: [],
  neverSendTui: false,
};

let seq = 0;
const line = (o: unknown) => JSON.stringify(o);
const msg = (id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "message", id, parentId: null, timestamp: "2026-09-20T12:00:00.000Z", message: { role, content, ...extra } });

/** A session file with a user request and a finished assistant reply (ids r1/a1 unless given). */
function sessionFile(id: string, lines: string[]): string {
  const path = join(sessionsDir, `2026-09-20T12-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[line({ type: "session", version: 3, id, timestamp: "2026-09-20T12:00:00.000Z", cwd: "/work/sova" }), ...lines].join("\n")}\n`);
  return path;
}

function row(id: string, path: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    path,
    cwd: "/work/sova",
    title: "Fix the login bug",
    createdAt: new Date(T0 - 3 * 3600_000).toISOString(),
    lastActiveAt: new Date(T0).toISOString(),
    model: "anthropic/claude",
    live: null,
    busy: false,
    origin: "external",
    archived: false,
    ...over,
  };
}

function freshId(): string {
  seq++;
  return `01234567-89ab-7cde-8f01-${String(seq).padStart(12, "0")}`;
}

const REPLY = {
  topic: { probabilities: { bugfix: 0.9, feature: 0.1 } },
  status: { probabilities: { done: 0.8, in_progress: 0.2 } },
  throwaway: { p: 0.1 },
};

test("wireTags: confidence gate ≥ 0.5 on choices, P ≥ 0.75 on throwaway, manual tags always", () => {
  const choice = (choice: string, confidence: number) => ({ type: "choice" as const, choice, probabilities: {}, confidence });
  assert.equal(tags.wireTags(undefined), undefined);
  assert.equal(tags.wireTags({ at: 1, answers: { topic: choice("bugfix", 0.49), status: choice("done", 0.2), throwaway: { type: "boolean", p: 0.74 } } }), undefined);
  assert.deepEqual(tags.wireTags({ at: 1, answers: { topic: choice("bugfix", 0.5), status: choice("done", 0.5), throwaway: { type: "boolean", p: 0.75 } } }), {
    topic: "bugfix",
    status: "done",
    throwaway: true,
  });
  // An answer outside the fixed taxonomy (a hand-edited file, an older taxonomy) never reaches the wire.
  assert.equal(tags.wireTags({ at: 1, answers: { topic: choice("gardening", 0.99) } }), undefined);
  assert.deepEqual(tags.wireTags({ user: ["later"] }), { user: ["later"] });
});

test("cleanUserTags: the ideas rule — lowercase, no #, deduped, ≤ 8, refuses junk", () => {
  assert.deepEqual(tags.cleanUserTags([" #Later", "later", "ux-2"]), ["later", "ux-2"]);
  assert.deepEqual(tags.cleanUserTags([]), []);
  assert.equal(typeof tags.cleanUserTags("later"), "string");
  assert.equal(typeof tags.cleanUserTags(["no spaces"]), "string");
  assert.equal(typeof tags.cleanUserTags(Array.from({ length: 9 }, (_, i) => `t${i}`)), "string");
});

test("tagSkipReason: the shared gate (off, excluded, TUI when asked), then overseer, worker, empty draft, excluded, TUI when asked, running turn", () => {
  const r = row("x", "/nowhere");
  assert.equal(tags.tagSkipReason(r, SETTINGS), null);
  assert.equal(tags.tagSkipReason(r, { ...SETTINGS, features: { attention: true, tags: false } }), "feature-off");
  assert.equal(tags.tagSkipReason({ ...r, overseer: true } as SessionSummary, SETTINGS), "overseer");
  assert.equal(tags.tagSkipReason({ ...r, workerSession: true }, SETTINGS), "worker");
  assert.equal(tags.tagSkipReason({ ...r, draftPreview: "hi" }, SETTINGS), "empty");
  assert.equal(tags.tagSkipReason(r, { ...SETTINGS, exclusions: ["/work"] }), "excluded");
  assert.equal(tags.tagSkipReason(r, { ...SETTINGS, exclusions: ["/wor"] }), null, "a folder boundary, not a string prefix");
  assert.equal(tags.tagSkipReason(r, { ...SETTINGS, exclusions: ["~/sova"] }, { home: "/work" }), "excluded");
  const tui = { ...r, live: { pid: 1, status: "idle" } } as SessionSummary;
  const never = { ...SETTINGS, neverSendTui: true };
  assert.equal(tags.tagSkipReason(tui, SETTINGS), null);
  assert.equal(tags.tagSkipReason(tui, never), "tui");
  // Not open in a TUI now, but not Sova's: still a TUI session (its TUI may have just exited) unless
  // this server holds it; a web session is never one.
  assert.equal(tags.tagSkipReason(r, never), "tui");
  assert.equal(tags.tagSkipReason(r, never, { held: (p) => p === r.path }), null);
  assert.equal(tags.tagSkipReason({ ...r, origin: "web" }, never), null);
  assert.equal(tags.tagSkipReason({ ...tui, origin: "web" }, never), "tui", "open in a TUI wins over origin");
  assert.equal(tags.tagSkipReason({ ...r, busy: true }, SETTINGS), "defer");
  assert.equal(tags.tagSkipReason({ ...r, activity: { state: "working" } } as SessionSummary, SETTINGS), "defer");
});

test("readTailTurn: the last FINISHED reply and the user message before it; tool steps and torn lines skipped", async () => {
  const pad = "x".repeat(40 * 1024); // pushes the user message past one 16 KB chunk
  const path = sessionFile(freshId(), [
    msg("u0", "user", "old request"),
    msg("a0", "assistant", [{ type: "text", text: "old reply" }]),
    msg("u1", "user", [{ type: "text", text: "please fix login" }]),
    msg("t1", "toolResult", [{ type: "text", text: pad }]),
    msg("a1", "assistant", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Fixed it." }]),
    msg("a2", "assistant", [{ type: "text", text: "calling a tool" }], { stopReason: "toolUse" }),
  ]);
  writeFileSync(path, `${readFileSync(path, "utf8")}{"type":"message","id":"torn`, { flag: "w" });
  const size = readFileSync(path).length;
  const t = await tags.readTailTurn(path, size);
  assert.deepEqual(t, { turnId: "a1", assistant: "Fixed it.", user: "please fix login" });

  const none = sessionFile(freshId(), [msg("u1", "user", "hi")]);
  assert.equal(await tags.readTailTurn(none, readFileSync(none).length), null);
});

test("tagState: named, capped, pre-computed facts, redacted before it leaves", () => {
  const secret = "sk-test-0123456789abcdefghij";
  const redactor = new Redactor([], { MY_API_KEY: secret });
  const long = `start ${"y".repeat(5000)} the end ${secret}`;
  const s = tags.tagState(
    { ...row("x", "/p"), outlineGist: "Login fix", lastActiveAt: new Date(T0 - 3 * DAY).toISOString(), createdAt: new Date(T0 - 3 * DAY - 2 * 3600_000).toISOString() },
    { assistant: long, user: "u".repeat(2000) },
    T0,
    (v) => redactor.refresh().redactDeep(v),
  );
  assert.equal(s.project, "sova");
  assert.equal(s.summary, "Login fix");
  assert.equal(s.days_idle, 3);
  assert.equal(s.duration, "about 2 hours");
  assert.ok(String(s.last_assistant).length <= tags.LAST_ASSISTANT_MAX + "[redacted]".length);
  assert.ok(String(s.last_assistant).endsWith("the end [redacted]"), "the END of a reply is kept, and redacted");
  assert.ok(String(s.last_user).length <= tags.LAST_USER_MAX);
  assert.ok(!JSON.stringify(s).includes(secret));
});

test("SessionTagger: classifies once per reply, stores raw answers, keeps manual tags, never writes the .jsonl", async () => {
  const id = freshId();
  const path = sessionFile(id, [msg("u1", "user", "fix login"), msg("a1", "assistant", [{ type: "text", text: "Fixed." }])]);
  const before = readFileSync(path);
  const fake = createFakeProvider({ reply: REPLY });
  let now = T0;
  const tagger = new tags.SessionTagger({ provider: () => fake, settings: () => SETTINGS, now: () => now, redact: (v) => v });
  const seen: TagsChange[][] = [];
  const off = tags.onTagsChanged((c) => seen.push(c));

  tags.setUserTags(id, ["later"]);
  const out = await tagger.tag(row(id, path));
  assert.deepEqual(out, { kind: "tagged", tags: { topic: "bugfix", status: "done", user: ["later"] } satisfies SessionTags });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.purpose, "tags");
  assert.deepEqual(Object.keys(fake.calls[0]?.questions ?? {}).sort(), ["status", "throwaway", "topic"]);
  const stored = JSON.parse(readFileSync(storeFile, "utf8")).sessions[id];
  assert.equal(stored.basis.turnId, "a1");
  assert.equal(stored.answers.throwaway.p, 0.1, "the raw answer is stored, not only what passed the gate");
  assert.deepEqual(tags.tagsFor(id), { topic: "bugfix", status: "done", user: ["later"] });
  assert.deepEqual(seen.at(-1), [{ id, path, tags: { topic: "bugfix", status: "done", user: ["later"] } }]);

  // Same reply → fresh, no call.
  assert.equal((await tagger.tag(row(id, path))).kind, "fresh");
  // A new reply inside the re-tag bound → still fresh; after it → re-tagged.
  writeFileSync(path, `${readFileSync(path, "utf8")}${msg("a2", "assistant", [{ type: "text", text: "More." }])}\n`);
  now = T0 + tags.RETAG_MIN_MS - 1;
  assert.equal((await tagger.tag(row(id, path))).kind, "fresh");
  now = T0 + tags.RETAG_MIN_MS;
  assert.equal((await tagger.tag(row(id, path))).kind, "tagged");
  assert.equal(fake.calls.length, 2);
  off();

  assert.deepEqual(readFileSync(path).subarray(0, before.length), before, "the session file's bytes are the ones the test wrote");
});

test("SessionTagger: one call in flight per session; a failure stores nothing and cools the session down", async () => {
  const id = freshId();
  const path = sessionFile(id, [msg("u1", "user", "hi"), msg("a1", "assistant", [{ type: "text", text: "Hello." }])]);
  const slow = createFakeProvider({ reply: REPLY, delayMs: 20 });
  const tagger = new tags.SessionTagger({ provider: () => slow, settings: () => SETTINGS, redact: (v) => v });
  const [a, b] = await Promise.all([tagger.tag(row(id, path)), tagger.tag(row(id, path))]);
  assert.equal(slow.calls.length, 1);
  assert.equal(a, b);

  const id2 = freshId();
  const path2 = sessionFile(id2, [msg("u1", "user", "hi"), msg("a1", "assistant", [{ type: "text", text: "Hello." }])]);
  const failing = createFakeProvider({ reply: { fail: "rate-limit" } });
  const t2 = new tags.SessionTagger({ provider: () => failing, settings: () => SETTINGS, redact: (v) => v });
  const out = await t2.tag(row(id2, path2));
  assert.equal(out.kind, "failed");
  assert.ok(out.kind === "failed" && out.error instanceof DecisionError && out.error.failure === "rate-limit");
  assert.equal(tags.tagRecord(id2), undefined);
  assert.equal(t2.coolingDown(id2), true);
});

test("SessionTagger: an ineligible row is never read or sent", async () => {
  const fake = createFakeProvider({ reply: REPLY });
  const tagger = new tags.SessionTagger({ provider: () => fake, settings: () => ({ ...SETTINGS, exclusions: ["/work/sova"] }), redact: (v) => v });
  const out = await tagger.tag(row(freshId(), "/does/not/exist.jsonl"));
  assert.deepEqual(out, { kind: "skipped", reason: "excluded" });
  assert.equal(fake.calls.length, 0);
});

test("setUserTags / dropSessionTags: set, clear, and a change event only when the wire changes", () => {
  const id = freshId();
  const seen: TagsChange[][] = [];
  const off = tags.onTagsChanged((c) => seen.push(c));
  assert.deepEqual(tags.setUserTags(id, ["a", "b"]), { user: ["a", "b"] });
  assert.deepEqual(tags.setUserTags(id, ["a", "b"]), { user: ["a", "b"] });
  assert.equal(seen.length, 1, "an identical write emits nothing");
  assert.equal(tags.setUserTags(id, null), undefined);
  assert.equal(tags.tagRecord(id), undefined, "a record with nothing left is dropped");
  tags.setUserTags(id, ["c"]);
  tags.dropSessionTags([id, "never-stored"]);
  assert.equal(tags.tagsFor(id), undefined);
  assert.deepEqual(seen.at(-1), [{ id, tags: undefined }]);
  off();
});

test("liveTagPass: opens its window on first sight, tags only activity after it, closes it when switched off", async () => {
  // Isolated: the window lives in the store, so give this test its own clock far past the others.
  const fake = createFakeProvider({ reply: REPLY });
  const tagger = new tags.SessionTagger({ provider: () => fake, settings: () => SETTINGS, redact: (v) => v });
  const T = T0 + 100 * DAY;
  const oldId = freshId();
  const newId = freshId();
  const rows = [
    row(oldId, sessionFile(oldId, [msg("u1", "user", "a"), msg("a1", "assistant", "b")]), { lastActiveAt: new Date(T - DAY).toISOString() }),
    row(newId, sessionFile(newId, [msg("u1", "user", "a"), msg("a1", "assistant", "b")]), { lastActiveAt: new Date(T + 1000).toISOString() }),
  ];
  const off = { ...SETTINGS, features: { attention: false, tags: false } };
  await tags.liveTagPass(rows, tagger, off, T - 1);
  assert.equal(await tags.liveTagPass(rows, tagger, SETTINGS, T), 0, "the first pass only opens the window");
  assert.equal(await tags.liveTagPass(rows, tagger, SETTINGS, T + 2000), 1);
  assert.ok(tags.tagRecord(newId));
  assert.equal(tags.tagRecord(oldId), undefined, "older activity is the backfill's");
  await tags.liveTagPass(rows, tagger, off, T + 3000);
  assert.equal(JSON.parse(readFileSync(storeFile, "utf8")).liveSince, undefined);
});
