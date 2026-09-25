// Run: npx tsx --test server/overseer-store.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-overseer-store-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const store = await import("./overseer-store");
const seen = await import("./seen");

after(() => rmSync(agentDir, { recursive: true, force: true }));

describe("overseer state rotation (/clear)", () => {
  test("the first file has no history", () => {
    assert.deepEqual(store.rotateState(null, "a"), { state: { version: 1, current: "a", history: [] }, dropped: [] });
  });

  test("each clear pushes the old current to the front; past 20 the oldest are dropped, to delete", () => {
    let st = store.rotateState(null, "s0").state;
    const dropped: string[] = [];
    for (let i = 1; i <= 23; i++) {
      const r = store.rotateState(st, `s${i}`);
      st = r.state;
      dropped.push(...r.dropped);
    }
    assert.equal(st.current, "s23");
    assert.equal(st.history.length, store.HISTORY_MAX);
    assert.deepEqual(st.history.slice(0, 3), ["s22", "s21", "s20"]);
    assert.equal(st.history.at(-1), "s3");
    assert.deepEqual(dropped, ["s0", "s1", "s2"]);
  });

  test("re-pointing at an id already in history never duplicates it", () => {
    const r = store.rotateState({ version: 1, current: "b", history: ["a", "c"] }, "a");
    assert.deepEqual(r.state, { version: 1, current: "a", history: ["b", "c"] });
  });

  test("a written state reads back; a corrupt file reads as none", () => {
    const file = join(agentDir, "st.json");
    store.writeOverseerState({ version: 1, current: "x", history: ["y", "x", "y"] }, file);
    assert.deepEqual(store.readOverseerState(file), { version: 1, current: "x", history: ["y"] });
    writeFileSync(file, "{not json");
    assert.equal(store.readOverseerState(file), null);
  });
});

describe("overseer settings", () => {
  test("a missing file reads as the defaults: badge only, five quick actions, the documented caps", () => {
    const s = store.readOverseerSettings(join(agentDir, "none.json"));
    assert.equal(s.proactivity, "badge");
    assert.deepEqual(s.quickActions.map((a) => a.label), ["What Needs Me", "What Finished", "What's Running", "Tidy Up", "Where Was I"]);
    assert.deepEqual(s.caps, { createPerTurn: 5, promptsPerTurn: 10, archivesPerTurn: 50, concurrentSessions: 5 });
    assert.equal(s.model, null);
  });

  test("tolerant on read: each bad field falls back alone, the good ones stand", () => {
    const s = store.parseSettings({ model: 7, thinking: "high", proactivity: "loud", caps: { createPerTurn: 2, promptsPerTurn: -1 } }, false);
    assert.ok(!("error" in s));
    assert.equal(s.model, null);
    assert.equal(s.thinking, "high");
    assert.equal(s.proactivity, "badge");
    assert.equal(s.caps.createPerTurn, 2);
    assert.equal(s.caps.promptsPerTurn, 10);
  });

  test("strict on PUT: the first bad field is the answer", () => {
    assert.deepEqual(store.parseSettings({ proactivity: "loud" }, true), { error: 'proactivity must be "off", "badge" or "brief"' });
    assert.match((store.parseSettings({ caps: { archivesPerTurn: 1.5 } }, true) as { error: string }).error, /caps.archivesPerTurn/);
    assert.match((store.parseSettings({ quickActions: [{ label: "", prompt: "x" }] }, true) as { error: string }).error, /label/);
    const ok = store.parseSettings({ model: "p/m", proactivity: "brief", extraSystemPrompt: "Be terse." }, true);
    assert.ok(!("error" in ok) && ok.model === "p/m" && ok.proactivity === "brief" && ok.extraSystemPrompt === "Be terse.");
  });

  test("the composer's write-back patches model and thinking and keeps everything else", () => {
    const file = join(agentDir, "ov.json");
    const base = store.parseSettings({ proactivity: "brief", extraSystemPrompt: "keep me" }, true);
    assert.ok(!("error" in base));
    store.writeOverseerSettings(base, file);
    store.patchOverseerSettings({ model: "zai/glm" }, file);
    const s = store.readOverseerSettings(file);
    assert.equal(s.model, "zai/glm");
    assert.equal(s.proactivity, "brief");
    assert.equal(s.extraSystemPrompt, "keep me");
  });
});

describe("notes and the audit log", () => {
  test("notes are capped on write", () => {
    const file = join(agentDir, "notes.md");
    assert.equal(store.writeNotes("x".repeat(store.NOTES_MAX + 10), file).length, store.NOTES_MAX);
    assert.equal(store.readNotes(join(agentDir, "missing.md")), "");
  });

  test("each action is one JSON line, oversized args are truncated rather than dropped", () => {
    const file = join(agentDir, "actions.jsonl");
    store.logAction({ at: "t", overseerId: "o", toolCallId: "c1", tool: "sova_send", args: { text: "hi" }, outcome: "ok" }, file);
    store.logAction({ at: "t", overseerId: "o", toolCallId: "c2", tool: "sova_send", args: { text: "y".repeat(9000) }, outcome: "refused", error: "cap" }, file);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0].args, { text: "hi" });
    assert.equal(lines[1].outcome, "refused");
    assert.ok(typeof lines[1].args.truncated === "string");
  });
});

describe("seen store and unread", () => {
  test("stamps never go backwards", () => {
    const file = join(agentDir, "seen.json");
    seen.markSeen("a", 200, file);
    seen.markSeen("a", 100, file);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).a, 200);
  });

  test("unread = a reply newer than the stamp, idle, not on screen; never for a session never seen", () => {
    const base = { seenAt: 100, lastReplyAt: 200, viewing: false, running: false };
    assert.equal(seen.isUnread(base), true);
    assert.equal(seen.isUnread({ ...base, lastReplyAt: 100 }), false);
    assert.equal(seen.isUnread({ ...base, viewing: true }), false);
    assert.equal(seen.isUnread({ ...base, running: true }), false);
    assert.equal(seen.isUnread({ ...base, seenAt: undefined }), false);
  });

  test("an open socket counts as looking until the last one closes", () => {
    seen.trackViewer("v", 1);
    seen.trackViewer("v", 1);
    seen.trackViewer("v", -1);
    assert.equal(seen.isViewing("v"), true);
    seen.trackViewer("v", -1);
    assert.equal(seen.isViewing("v"), false);
  });
});
