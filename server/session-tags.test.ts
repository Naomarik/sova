// Run: npx tsx --test server/session-tags.test.ts
// Session tags: the store (older automatic answers still read, never sent), manual tags, and the
// tail reader other modules share. Nothing here asks a decision provider any more.
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
  throwaway: { p: 0.1 },
};

test("wireTags: manual tags only; a stored topic, throwaway or status answer stays in the store and is never sent", () => {
  const choice = (choice: string, confidence: number) => ({ type: "choice" as const, choice, probabilities: {}, confidence });
  assert.equal(tags.wireTags(undefined), undefined);
  assert.equal(tags.wireTags({ at: 1, answers: { topic: choice("bugfix", 0.99), status: choice("done", 0.99), throwaway: { type: "boolean", p: 0.99 } } }), undefined);
  assert.deepEqual(tags.wireTags({ at: 1, answers: { topic: choice("bugfix", 0.99) }, user: ["later"] }), { user: ["later"] });
});

test("an older store with automatic answers still reads, and keeps them", () => {
  const id = freshId();
  mkdirSync(join(agentDir, "sova"), { recursive: true });
  writeFileSync(storeFile, JSON.stringify({ version: 1, liveSince: 5, sessions: { [id]: { at: 1, basis: { turnId: "a1", size: 9 }, answers: { topic: { type: "choice", choice: "bugfix", probabilities: { bugfix: 1 }, confidence: 1 } }, user: ["x"] } } }));
  assert.equal(tags.tagRecord(id)?.answers?.topic?.type, "choice");
  assert.deepEqual(tags.tagsFor(id), { user: ["x"] });
});

test("cleanUserTags: the ideas rule — lowercase, no #, deduped, ≤ 8, refuses junk", () => {
  assert.deepEqual(tags.cleanUserTags([" #Later", "later", "ux-2"]), ["later", "ux-2"]);
  assert.deepEqual(tags.cleanUserTags([]), []);
  assert.equal(typeof tags.cleanUserTags("later"), "string");
  assert.equal(typeof tags.cleanUserTags(["no spaces"]), "string");
  assert.equal(typeof tags.cleanUserTags(Array.from({ length: 9 }, (_, i) => `t${i}`)), "string");
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

