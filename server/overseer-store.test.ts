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

describe("the one-time move off the old five quick actions (version 2)", () => {
  const old = () => store.OLD_QUICK_ACTIONS.map((a) => ({ ...a }));
  const fileWith = (name: string, body: Record<string, unknown>) => {
    const file = join(agentDir, name);
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
    return file;
  };
  const stored = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

  test("a version 1 file holding exactly the old five reads back as the new two and is written once as version 2, the rest kept", () => {
    const file = fileWith("v1-old.json", { version: 1, model: "p/m", proactivity: "brief", quickActions: old(), caps: { promptsPerTurn: 4 }, odd: "kept" });
    const s = store.readOverseerSettings(file);
    assert.deepEqual(s.quickActions, store.DEFAULT_QUICK_ACTIONS);
    assert.equal(s.model, "p/m");
    assert.equal(s.proactivity, "brief");
    assert.equal(s.caps.promptsPerTurn, 4);
    const disk = stored(file);
    assert.equal(disk.version, 2);
    assert.deepEqual(disk.quickActions, store.DEFAULT_QUICK_ACTIONS);
    assert.deepEqual(disk.caps, { promptsPerTurn: 4 }, "every other field as it was stored, not normalized");
    assert.equal(disk.odd, "kept");
  });

  test("an unversioned file with the old five moves the same way", () => {
    const file = fileWith("v0-old.json", { quickActions: old() });
    assert.deepEqual(store.readOverseerSettings(file).quickActions.map((a) => a.id), ["get-moving", "tidy"]);
    assert.equal(stored(file).version, 2);
  });

  test("a version 2 file holding the old What Needs Me exactly, or the whole old five, reads back unchanged and is never rewritten", () => {
    const one = fileWith("v2-needs-me.json", { version: 2, quickActions: [old()[0]] });
    const before = readFileSync(one, "utf8");
    assert.deepEqual(store.readOverseerSettings(one).quickActions, [store.OLD_QUICK_ACTIONS[0]]);
    assert.equal(readFileSync(one, "utf8"), before);
    const five = fileWith("v2-five.json", { version: 2, quickActions: old() });
    assert.deepEqual(store.readOverseerSettings(five).quickActions, store.OLD_QUICK_ACTIONS);
    assert.deepEqual(stored(five).quickActions, store.OLD_QUICK_ACTIONS);
  });

  test("a version 1 list with any change at all is kept as it is, and the file still becomes version 2", () => {
    const edits: [string, (l: ReturnType<typeof old>) => unknown[]][] = [
      ["a prompt edited", (l) => (l[0]!.prompt += " Now.", l)],
      ["a label edited", (l) => (l[2]!.label = "Running", l)],
      ["a description edited", (l) => (l[4]!.description = "Where.", l)],
      ["an id changed", (l) => (l[1]!.id = "done", l)],
      ["reordered", (l) => [l[1], l[0], ...l.slice(2)]],
      ["one removed", (l) => l.slice(0, 4)],
      ["one added", (l) => [...l, { id: "mine", label: "Mine", description: "", prompt: "Do mine." }]],
    ];
    for (const [why, edit] of edits) {
      const list = edit(old());
      const file = fileWith(`v1-${why.replace(/\W+/g, "-")}.json`, { version: 1, quickActions: list });
      assert.deepEqual(store.readOverseerSettings(file).quickActions, list, why);
      const disk = stored(file);
      assert.equal(disk.version, 2, why);
      assert.deepEqual(disk.quickActions, list, why);
    }
  });

  test("after the move nothing compares again: the old five saved back stay", () => {
    const file = fileWith("v1-then-back.json", { version: 1, quickActions: old() });
    const s = store.readOverseerSettings(file);
    store.writeOverseerSettings({ ...s, quickActions: old() }, file);
    assert.deepEqual(store.readOverseerSettings(file).quickActions, store.OLD_QUICK_ACTIONS);
    assert.equal(stored(file).version, 2);
  });

  test("a missing file is not created, and a corrupt one is left alone", () => {
    const missing = join(agentDir, "v-missing.json");
    store.readOverseerSettings(missing);
    assert.throws(() => readFileSync(missing));
    const bad = join(agentDir, "v-corrupt.json");
    writeFileSync(bad, "{not json");
    assert.deepEqual(store.readOverseerSettings(bad).quickActions, store.DEFAULT_QUICK_ACTIONS);
    assert.equal(readFileSync(bad, "utf8"), "{not json");
  });
});

describe("overseer settings", () => {
  test("a missing file reads as the defaults: badge only, two quick actions, the documented caps", () => {
    const s = store.readOverseerSettings(join(agentDir, "none.json"));
    assert.equal(s.proactivity, "badge");
    assert.equal(s.version, 2);
    assert.deepEqual(s.quickActions.map((a) => [a.id, a.label]), [["get-moving", "Get Things Moving"], ["tidy", "Tidy Up"]]);
    assert.equal(s.quickActions[0]!.description, "Every session stuck on a next step, checked now, on one card. Nothing is sent until you apply.");
    assert.equal(s.quickActions[1]!.description, "Finished and stale sessions sorted onto one card to archive or keep. Nothing is archived until you apply.");
    assert.match(s.quickActions[0]!.prompt, /^Get things moving\. .* Send nothing until I apply\.$/);
    assert.match(s.quickActions[1]!.prompt, /^Tidy up\. .*Archive & Remove Worktree and default to it\. .* Archive nothing until I apply\.$/);
    // Each passes the PUT's own limits, so Reset to Defaults then Save never refuses them.
    assert.ok(!("error" in store.parseSettings({ quickActions: s.quickActions }, true)));
    // Reading it never created the file.
    assert.throws(() => readFileSync(join(agentDir, "none.json")));
    assert.deepEqual(s.caps, { createPerTurn: 5, promptsPerTurn: 10, archivesPerTurn: 50, concurrentSessions: 10, explorePerTurn: 2, linksPerTurn: 3, orgWritesPerTurn: 20, gatherPerTurn: 3, extRunsPerTurn: 5 });
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
    assert.equal((store.parseSettings({ caps: { archivesPerTurn: 1.5 } }, true) as { error: string }).error, "Sessions archived must be a whole number from 0 to 1,000.");
    assert.match((store.parseSettings({ quickActions: [{ label: "", prompt: "x" }] }, true) as { error: string }).error, /label/);
    const ok = store.parseSettings({ model: "p/m", proactivity: "brief", extraSystemPrompt: "Be terse." }, true);
    assert.ok(!("error" in ok) && ok.model === "p/m" && ok.proactivity === "brief" && ok.extraSystemPrompt === "Be terse.");
  });

  test("an old extCommands list (§app.overseer/extension-commands: every marked command is on, no switches) is ignored, never refused, and the next save drops it", () => {
    const tolerant = store.parseSettings({ extCommands: ["ext.acme.launch", 7], caps: { extRunsPerTurn: 2 } }, false);
    assert.ok(!("error" in tolerant) && !("extCommands" in tolerant) && tolerant.caps.extRunsPerTurn === 2);
    const put = store.parseSettings({ extCommands: "not even a list", proactivity: "brief" }, true);
    assert.ok(!("error" in put) && !("extCommands" in put) && put.proactivity === "brief", "a PUT that still sends one is not refused for it");
    // A file an older Sova wrote: it reads, and writing it back leaves the list out.
    const file = join(agentDir, "old-ext.json");
    writeFileSync(file, JSON.stringify({ version: 2, proactivity: "badge", extCommands: ["ext.a.b"], caps: { extRunsPerTurn: 3 } }));
    const read = store.readOverseerSettings(file);
    assert.ok(!("extCommands" in read) && read.caps.extRunsPerTurn === 3);
    store.writeOverseerSettings(read, file);
    assert.ok(!("extCommands" in JSON.parse(readFileSync(file, "utf8"))));
  });

  test("the exploratory agent defaults to Claude Code on the catalog's current Opus (Opus 5.5) at medium; a bad one falls back on read and is refused on PUT", () => {
    assert.deepEqual(store.readOverseerSettings(join(agentDir, "none.json")).explorer, { backend: "claude-code", model: "claude-opus-5-5", effort: "medium" });
    const tolerant = store.parseSettings({ explorer: { backend: "pi", model: "no-slash", effort: "low" } }, false);
    assert.ok(!("error" in tolerant));
    assert.deepEqual(tolerant.explorer, store.DEFAULT_EXPLORER);
    assert.match((store.parseSettings({ explorer: { backend: "claude-code", model: "opus", effort: "off" } }, true) as { error: string }).error, /^explorer: effort/);
    const ok = store.parseSettings({ explorer: { backend: "pi", model: "ollama-cloud/glm-5.3", effort: "low" }, caps: { explorePerTurn: 1 } }, true);
    assert.ok(!("error" in ok));
    assert.deepEqual(ok.explorer, { backend: "pi", model: "ollama-cloud/glm-5.3", effort: "low" });
    assert.equal(ok.caps.explorePerTurn, 1);
    for (const model of ["claude-opus-5", "claude-opus-5[1m]", "Claude-Opus-5"]) {
      assert.match((store.parseSettings({ explorer: { backend: "claude-code", model, effort: "medium" } }, true) as { error: string }).error, /not allowed for the exploratory agent/, model);
      assert.deepEqual((store.parseSettings({ explorer: { backend: "claude-code", model, effort: "medium" } }, false) as { explorer: unknown }).explorer, store.DEFAULT_EXPLORER, `${model} on read → the default`);
    }
    assert.match((store.parseSettings({ explorer: { backend: "pi", model: "anthropic/claude-opus-5", effort: "low" } }, true) as { error: string }).error, /not allowed/);
    const ok55 = store.parseSettings({ explorer: { backend: "claude-code", model: "claude-opus-5-5[1m]", effort: "high" } }, true);
    assert.ok(!("error" in ok55), "Opus 5.5 by its old [1m] id is fine");
    assert.equal((ok55 as { explorer: { model: string } }).explorer.model, "claude-opus-5-5", "and reads as its catalog id");
    const old = store.parseSettings({ explorer: { backend: "claude-code", model: "opus[1m]", effort: "medium" } }, false) as { explorer: { model: string } };
    assert.equal(old.explorer.model, "claude-opus-5-5", "an old alias reads as the catalog model it means");
    assert.match((store.parseSettings({ explorer: { backend: "claude-code", model: "claude-opus-5", effort: "medium" } }, true) as { error: string }).error, /use claude-opus-5-5 \(Opus 5\.5\)/);
    const file = join(agentDir, "ov-explorer.json");
    store.writeOverseerSettings(ok, file);
    assert.deepEqual(store.readOverseerSettings(file).explorer, ok.explorer, "it persists");
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

describe("Settings QA: the server's Overseer limits, as the form checks them (feat/settings-forms-qa)", () => {
  const err = (raw: unknown) => (store.parseSettings(raw, true) as { error?: string }).error;
  test("a limit goes up to 1000 on PUT and on read; 1001 is refused naming the limit as the form does", () => {
    assert.equal(store.CAP_MAX, 1000);
    const ok = store.parseSettings({ caps: { createPerTurn: 1000, concurrentSessions: 501 } }, true);
    assert.ok(!("error" in ok) && ok.caps.createPerTurn === 1000 && ok.caps.concurrentSessions === 501);
    assert.equal(err({ caps: { createPerTurn: 1001 } }), "Sessions created must be a whole number from 0 to 1,000.");
    assert.equal(err({ caps: { concurrentSessions: -1 } }), "Running at once must be a whole number from 0 to 1,000.");
    const read = store.parseSettings({ caps: { archivesPerTurn: 800 } }, false);
    assert.ok(!("error" in read) && read.caps.archivesPerTurn === 800, "a stored 800 reads back as 800, not the default");
  });
  test("quick action and extra-instruction refusals name the field in words", () => {
    const qa = (patch: Record<string, string>) => ({ quickActions: [{ label: "A", prompt: "p" }, { label: "B", prompt: "p", ...patch }] });
    assert.equal(err(qa({ label: "x".repeat(40 + 1) })), "Quick action 2's label can be at most 40 characters.");
    assert.equal(err(qa({ prompt: "x".repeat(2000 + 1) })), "Quick action 2's prompt can be at most 2,000 characters.");
    assert.equal(err(qa({ description: "x".repeat(120 + 1) })), "Quick action 2's description can be at most 120 characters.");
    assert.equal(err(qa({ label: "x".repeat(40) })), undefined);
    assert.equal(err({ quickActions: Array.from({ length: store.QUICK_ACTIONS_MAX + 1 }, () => ({ label: "a", prompt: "p" })) }), "There can be at most 12 quick actions.");
    assert.equal(err({ quickActions: Array.from({ length: store.QUICK_ACTIONS_MAX }, () => ({ label: "a", prompt: "p" })) }), undefined);
    assert.equal(err({ extraSystemPrompt: "x".repeat(store.EXTRA_PROMPT_MAX + 1) }), "Extra instructions can be at most 8,000 characters.");
    assert.equal(err({ extraSystemPrompt: "x".repeat(store.EXTRA_PROMPT_MAX) }), undefined);
  });
});
