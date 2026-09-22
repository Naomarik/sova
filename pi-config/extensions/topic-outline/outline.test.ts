import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPrompt, extractJsonObject, parseSummarizerJson, SummarizerChain } from "./summarizers/chain.ts";
import { SummarizerError, type SummarizeInput, type SummarizerResult } from "./types.ts";
import { fingerprintKey, fingerprintOf, isMarkedMessage, locateMarker, locateMarkerRow, markerOrdinalIndex, markerRows, sameFingerprint, stripAnsi } from "./anchors.ts";
import { NowLine, OutlineStore, applyUpdates, earliestUserRequest, extractDelta, lastMessageEntryId } from "./state.ts";
import { HEADLESS_FLAG, shouldRunOutline } from "./policy.ts";

const input = (over: Partial<SummarizeInput> = {}): SummarizeInput => ({
  existingOutline: "none",
  newLines: ["[m1] USER: fix auth"],
  validRefs: new Set(["m1"]),
  signal: new AbortController().signal,
  ...over,
});

const valid = JSON.stringify({
  now: "Editing auth.ts",
  overall: "Fixing the auth flow",
  topicUpdates: [{ kind: "new", heading: "Auth flow fix", anchor: "m1", summary: ["Patched token refresh"] }],
});

test("buildPrompt carries the anchor request and asks overall to lead with the subject", () => {
  const prompt = buildPrompt(input({ purpose: "make pi-web themable: palette and fonts" }));
  assert.ok(prompt.includes("SESSION ANCHOR"));
  assert.ok(prompt.includes("make pi-web themable: palette and fonts"));
  // The anchor is stated before the messages it anchors, so a truncated tail never loses it.
  assert.ok(prompt.indexOf("SESSION ANCHOR") < prompt.indexOf("NEW MESSAGES:"));
  // The anchor is offered, never asserted: it can be a mid-session message on an older session.
  assert.ok(prompt.includes("it may be a mid-session message"));
  assert.ok(prompt.includes("when they disagree, the topics win"));
  // The one rule the sidebar depends on: "overall" is what the session is for, front-loaded.
  assert.ok(prompt.includes('"overall": what this session is FOR'));
  assert.ok(/first few words/.test(prompt));
  // A real change of goal is allowed; progress alone is not a reason to rewrite it.
  assert.ok(/Rewrite it when the user's goal actually changes/.test(prompt));
});

test("buildPrompt says the anchor is unknown rather than leaving the section empty", () => {
  const prompt = buildPrompt(input());
  assert.ok(prompt.includes("SESSION ANCHOR"));
  assert.ok(prompt.includes("\nunknown\n"));
});

test("earliestUserRequest reads the branch, not the delta's first follow-up", () => {
  const entries = [
    { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "  " }] } },
    { id: "u2", type: "message", message: { role: "user", content: [{ type: "text", text: "make pi-web themable" }] } },
    { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } },
    { id: "u3", type: "message", message: { role: "user", content: [{ type: "text", text: "also fix the placeholder" }] } },
  ];
  assert.equal(earliestUserRequest(entries), "make pi-web themable");
  // A follow-up-only view (compaction ate the opening) still yields the earliest text it has.
  assert.equal(earliestUserRequest(entries.slice(2)), "also fix the placeholder");
  assert.equal(earliestUserRequest([]), "");
  assert.equal(earliestUserRequest([entries[2]]), "");
});

test("parseSummarizerJson accepts clean JSON and fenced/messy JSON", () => {
  const clean = parseSummarizerJson(valid, new Set(["m1"]));
  assert.equal(clean.now, "Editing auth.ts");
  assert.equal(clean.topicUpdates[0].heading, "Auth flow fix");
  const messy = parseSummarizerJson("```json\n" + valid + "\n``` trailing words", new Set(["m1"]));
  assert.equal(messy.overall, "Fixing the auth flow");
});

test("parseSummarizerJson drops updates with unknown anchors but keeps the envelope", () => {
  const raw = JSON.stringify({
    now: "n", overall: "o",
    topicUpdates: [
      { kind: "new", heading: "Bad anchor", anchor: "m99", summary: ["x"] },
      { kind: "new", heading: "Good anchor", anchor: "m1", summary: ["y"] },
    ],
  });
  const result = parseSummarizerJson(raw, new Set(["m1"]));
  assert.equal(result.topicUpdates.length, 1);
  assert.equal(result.topicUpdates[0].heading, "Good anchor");
});

test("parseSummarizerJson rejects garbage envelopes", () => {
  assert.throws(() => parseSummarizerJson("not json at all", new Set()), SummarizerError);
  assert.throws(() => parseSummarizerJson('{"foo": 1}', new Set()), SummarizerError);
  assert.equal(extractJsonObject('prefix {"a": {"b": 1}} suffix'), '{"a": {"b": 1}}');
  assert.equal(extractJsonObject('{"s": "}"}'), '{"s": "}"}');
});

test("SummarizerChain falls back, then backoffs the failing backend", async () => {
  const calls: string[] = [];
  const failing = {
    name: "first",
    async summarize(): Promise<SummarizerResult> { calls.push("first"); throw new SummarizerError("boom"); },
  };
  const working = {
    name: "second",
    async summarize(): Promise<SummarizerResult> {
      calls.push("second");
      return { now: "n", overall: "o", topicUpdates: [] };
    },
  };
  const chain = new SummarizerChain([failing, working]);
  const got = await chain.run(input());
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(got.backend, "second");
  // First backend is paused now; only the fallback runs.
  await chain.run(input());
  assert.deepEqual(calls, ["first", "second", "second"]);
  assert.match(chain.summarizeStatus(), /first paused/);
});

test("SummarizerChain fails with all-errors message when everything fails", async () => {
  const make = (label: string) => ({
    name: label,
    async summarize(): Promise<SummarizerResult> { throw new SummarizerError(`no ${label}`); },
  });
  const chain = new SummarizerChain([make("a"), make("b")]);
  await assert.rejects(() => chain.run(input()), /all summarizers failed/);
  await assert.rejects(() => new SummarizerChain([]).run(input()), /all summarizers failed/);
});

test("isMarkedMessage mirrors pi's transcript components", () => {
  assert.equal(isMarkedMessage({ role: "user", content: [{ type: "text", text: "hi" }] }), true);
  assert.equal(isMarkedMessage({ role: "user", content: "hi" }), true);
  assert.equal(isMarkedMessage({ role: "user", content: " " }), false);
  assert.equal(isMarkedMessage({ role: "assistant", content: [{ type: "text", text: "done" }] }), true);
  assert.equal(isMarkedMessage({ role: "assistant", content: [{ type: "toolCall", name: "bash" }, { type: "text", text: "x" }] }), false);
  assert.equal(isMarkedMessage({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] }), true);
  assert.equal(isMarkedMessage({ role: "toolResult", content: [{ type: "text", text: "ok" }] }), false);
  // Errored/aborted/truncated replies render a notice line, so they carry a marker even without text.
  assert.equal(isMarkedMessage({ role: "assistant", content: [], stopReason: "error" }), true);
  assert.equal(isMarkedMessage({ role: "assistant", content: [], stopReason: "stop" }), false);
  assert.equal(isMarkedMessage({ role: "assistant", content: [{ type: "toolCall", name: "bash" }], stopReason: "aborted" }), false);
  // Skill invocations only mark the trailing user text.
  const skill = '<skill name="s" location="/x/SKILL.md">\nbody\n</skill>';
  assert.equal(isMarkedMessage({ role: "user", content: skill }), false);
  assert.equal(isMarkedMessage({ role: "user", content: `${skill}\n\nand then this` }), true);
  assert.equal(fingerprintOf({ role: "user", content: `${skill}\n\nand then this` }), "andthenthis");
});

test("extractDelta slices by basis and anchors only user/final-assistant messages", () => {
  const entries = [
    { id: "e1", type: "message", message: { role: "user", content: [{ type: "text", text: "fix auth please" }] } },
    { id: "e2", type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/auth.ts" } }] } },
    { id: "e3", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "file contents" }] } },
    { id: "e4", type: "message", message: { role: "assistant", content: [{ type: "text", text: "I fixed it" }] } },
  ];
  const delta = extractDelta(entries, "e1");
  assert.equal(lastMessageEntryId(entries), "e4");
  assert.equal(delta[0].entryId, "e2");
  assert.equal(delta.at(-1)?.entryId, "e4");
  // Only the final assistant message is anchorable.
  assert.ok(delta.at(-1)?.anchor);
  assert.equal(delta.find(line => line.entryId === "e2")?.anchor, undefined);
  // Path basenames are included, commands suppressed.
  assert.match(delta.map(line => line.line).join("\n"), /read · auth\.ts/);
  // Full extraction from scratch includes the user anchor.
  const all = extractDelta(entries, "nope");
  assert.equal(all[0].entryId, "e1");
  assert.ok(all[0].anchor);
  // bash commands are suppressed even though they are tool calls.
  const withBash = extractDelta([
    { id: "b1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "export TOKEN=secret && ls" } }] } },
  ]);
  assert.ok(!withBash.map(line => line.line).join("\n").includes("TOKEN"));
});

test("OutlineStore applies new+updates, assigns ids, snapshots and restores", () => {
  const store = new OutlineStore();
  const anchors = new Map([
    ["m1", { entryId: "e1", role: "user" as const, fingerprint: "fix auth" }],
    ["m5", { entryId: "e5", role: "assistant" as const, fingerprint: "done" }],
  ]);
  const limits = { maxTopics: 40, maxBullets: 3 };
  assert.ok(store.apply({
    now: "Investigating", overall: "Auth fix",
    topicUpdates: [{ kind: "new", heading: "Auth flow", anchor: "m1", summary: ["Explored tokens"] }],
  }, anchors, "e1", limits));
  assert.equal(store.topics[0].id, "t1");
  assert.equal(store.state, "fresh");
  assert.ok(store.apply({
    now: "Verifying", overall: "Auth fix",
    topicUpdates: [{ kind: "update", topicId: "t1", heading: "Auth flow", anchor: "m5", summary: ["Verified"] }],
  }, anchors, "e5", limits));
  // An update replaces the topic's summary and moves its anchor forward.
  assert.deepEqual(store.topics[0].summary, ["Verified"]);
  assert.equal(store.topics[0].anchor.entryId, "e5");
  // Snapshot round-trip through restore().
  const data = store.snapshot();
  const entry = { id: "snap", type: "custom", customType: "topic-outline", data };
  const restored = new OutlineStore();
  restored.restore([{ id: "e0", type: "message", message: { role: "user", content: [{ type: "text", text: "x" }] } }, entry]);
  assert.equal(restored.topics.length, 1);
  assert.equal(restored.basisLeafId, "e5");
  assert.equal(restored.state, "stale");
  // Garbage snapshot leaves the store empty.
  const dead = new OutlineStore();
  dead.restore([{ id: "bad", type: "custom", customType: "topic-outline", data: { version: 99 } }]);
  assert.equal(dead.topics.length, 0);
  assert.equal(dead.state, "none");
});

test("manual #-topics are appended instantly and capped", () => {
  const store = new OutlineStore();
  const topic = store.addManualTopic("My heading", { entryId: "e9", role: "user", fingerprint: "my heading" });
  assert.equal(topic.manual, true);
  assert.equal(store.topics[0].heading, "My heading");
  assert.equal(store.state, "stale");
});

test("lastHeading prefers the latest manual # heading, else the latest topic", () => {
  const limits = { maxTopics: 40, maxBullets: 3 };
  const anchors = new Map([["m1", { entryId: "e1", role: "user" as const, fingerprint: "a" }]]);
  const store = new OutlineStore();
  assert.equal(store.lastHeading, "");
  store.apply({ now: "", overall: "", topicUpdates: [{ kind: "new", heading: "Model topic", anchor: "m1", summary: [] }] }, anchors, "e1", limits);
  assert.equal(store.lastHeading, "Model topic");
  store.topics = [...store.topics, { ...store.topics[0], id: "t9", heading: "Newer topic", at: store.topics[0].at + 1 }];
  assert.equal(store.lastHeading, "Newer topic");
  store.addManualTopic("Auth fix", { entryId: "e2", role: "user", fingerprint: "auth fix" });
  assert.equal(store.lastHeading, "Auth fix");
  // Later model topics never override a user heading.
  store.apply({ now: "", overall: "", topicUpdates: [{ kind: "new", heading: "Later model", anchor: "m1", summary: [] }] }, anchors, "e1", limits);
  assert.equal(store.lastHeading, "Auth fix");
  store.addManualTopic("Deploy", { entryId: "e3", role: "user", fingerprint: "deploy" });
  store.noteManualHeading("Auth fix");
  assert.equal(store.lastHeading, "Auth fix");
});

test("lastHeading survives snapshot round-trip; old snapshots restore without it", () => {
  const store = new OutlineStore();
  store.addManualTopic("Auth fix", { entryId: "e2", role: "user", fingerprint: "auth fix" });
  const data = store.snapshot();
  assert.equal(data.version, 2);
  assert.equal(data.lastHeading, "Auth fix");
  const restored = new OutlineStore();
  restored.restore([{ id: "s", type: "custom", customType: "topic-outline", data }]);
  assert.equal(restored.lastHeading, "Auth fix");
  // Pre-lastHeading snapshot: falls back to the latest topic, no throw.
  const { lastHeading: _a, lastManualHeading: _b, ...old } = data;
  const legacy = new OutlineStore();
  legacy.restore([{ id: "s", type: "custom", customType: "topic-outline", data: { ...old, topics: [{ ...data.topics[0], manual: undefined }] } }]);
  assert.equal(legacy.lastManualHeading, "");
  assert.equal(legacy.lastHeading, "Auth fix");
  legacy.restore([]);
  assert.equal(legacy.lastHeading, "");
});

test("the anchor request is kept once, survives snapshots, and older snapshots restore empty", () => {
  const store = new OutlineStore();
  assert.equal(store.purpose, "");
  store.notePurpose("## Make pi-web themable — palette and fonts");
  // First one wins: later requests are topics, not a new reason for the session to exist.
  store.notePurpose("also fix the placeholder text");
  assert.equal(store.purpose, "Make pi-web themable — palette and fonts");
  const data = store.snapshot();
  assert.equal(data.purpose, "Make pi-web themable — palette and fonts");
  const restored = new OutlineStore();
  restored.restore([{ id: "s", type: "custom", customType: "topic-outline", data }]);
  assert.equal(restored.purpose, "Make pi-web themable — palette and fonts");
  const { purpose: _p, ...old } = data;
  const legacy = new OutlineStore();
  legacy.restore([{ id: "s", type: "custom", customType: "topic-outline", data: old }]);
  assert.equal(legacy.purpose, "");
  // A snapshot taken before any user message carries no purpose key at all.
  assert.equal("purpose" in legacy.snapshot(), false);
  store.notePurpose("x".repeat(900));
  restored.clear();
  assert.equal(restored.purpose, "");
  const long = new OutlineStore();
  long.notePurpose("x".repeat(900));
  assert.ok(long.purpose.length <= 401);
});

test("broadcast includes lastHeading unless sharing is off or shareLastHeading is false", () => {
  const store = new OutlineStore();
  assert.equal(store.broadcast("s", "now-only")?.lastHeading, undefined);
  store.addManualTopic("Auth fix", { entryId: "e2", role: "user", fingerprint: "auth fix" });
  assert.equal(store.broadcast("s", "now-only")?.lastHeading, "Auth fix");
  assert.equal(store.broadcast("s", "summary")?.lastHeading, "Auth fix");
  assert.equal(store.broadcast("s", "off"), undefined);
  const hidden = store.broadcast("s", "now-only", false);
  assert.ok(hidden && !("lastHeading" in hidden));
  store.lastManualHeading = "x".repeat(200);
  assert.ok((store.broadcast("s", "now-only")?.lastHeading?.length ?? 0) <= 81);
});

test("summary broadcast includes per-topic detail: newest first, capped, control-stripped", () => {
  const store = new OutlineStore();
  const anchor = { entryId: "e1", role: "user" as const, fingerprint: "x" };
  store.topics = Array.from({ length: 8 }, (_, i) => ({
    id: `t${i + 1}`, heading: `Topic ${i + 1}`, anchor, at: 1000 + i,
    summary: [`bullet a${i + 1}`, `bullet b${i + 1}`, `bullet c${i + 1}`, `bullet d${i + 1}`],
  }));
  // Oldest topic was updated most recently: it must lead.
  store.topics[0] = { ...store.topics[0], at: 5000 };
  store.topics[7] = {
    ...store.topics[7],
    heading: `Bad\x1b[31m\x00head\u0085ing ${"h".repeat(100)}`,
    summary: ["line\none\ttab\x07bell", "y".repeat(300), "\x00\x01", "dropped"],
  };

  const detail = store.broadcast("s", "summary")?.detail;
  assert.ok(detail);
  assert.equal(detail.length, 6);
  assert.deepEqual(detail.map(d => d.heading.slice(0, 7)), ["Topic 1", "Bad hea", "Topic 7", "Topic 6", "Topic 5", "Topic 4"]);
  assert.deepEqual(detail[0].bullets, ["bullet a1", "bullet b1", "bullet c1"]);
  for (const item of detail) {
    assert.ok(item.heading.length <= 60);
    assert.ok(item.bullets.length <= 3);
    for (const text of [item.heading, ...item.bullets]) {
      assert.ok(text.length <= 120);
      assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f]/);
    }
  }
  const bad = detail[1];
  assert.ok(bad.heading.startsWith("Bad head ing hhh"), bad.heading);
  assert.ok(bad.heading.endsWith("…"));
  assert.equal(bad.heading.length, 60);
  assert.equal(bad.bullets[0], "line one tab bell");
  assert.equal(bad.bullets[1], `${"y".repeat(119)}…`);
  assert.equal(bad.bullets.length, 2, "control-only bullet dropped, 4th bullet never considered");

  const nowOnly = store.broadcast("s", "now-only");
  assert.ok(nowOnly && !("detail" in nowOnly));
  assert.equal(store.broadcast("s", "off"), undefined);
  // Existing summary fields unchanged.
  assert.equal(store.broadcast("s", "summary")?.topics?.length, 8);
});

test("config shareLastHeading defaults on and honors an explicit false", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadConfig } = await import("./config.ts");
  const dir = mkdtempSync(join(tmpdir(), "outline-cfg-"));
  assert.equal(loadConfig("", false, dir).shareLastHeading, true);
  writeFileSync(join(dir, "topic-outline.json"), JSON.stringify({ shareLastHeading: false }));
  assert.equal(loadConfig("", false, dir).shareLastHeading, false);
  writeFileSync(join(dir, "topic-outline.json"), JSON.stringify({ shareLastHeading: "no" }));
  assert.equal(loadConfig("", false, dir).shareLastHeading, true);
});

test("NowLine derives status from lifecycle events without any model", () => {
  const line = new NowLine();
  assert.equal(line.text(), "Idle");
  line.agentStart();
  assert.equal(line.text(), "Running");
  line.toolStart("a", "edit", { path: "/deep/dir/auth.ts" });
  assert.equal(line.text(), "Running: edit · auth.ts");
  line.toolStart("b", "bash", { command: "rm -rf /" });
  assert.equal(line.text(), "Running: edit · auth.ts, bash");
  line.toolEnd("b");
  line.toolEnd("a");
  line.agentSettled();
  assert.equal(line.text(), "Idle");
  line.agentStart();
  line.errored("boom\nwith details");
  assert.equal(line.text(), "Error: boom with details");
  line.promptStart(false);
  assert.equal(line.text(), "Needs input");
  line.promptEnd();
  line.agentSettled();
  // Errors stay sticky once settled (like the sessions extension) until the next run clears them.
  assert.equal(line.text(), "Error: boom with details");
  line.agentStart();
  assert.equal(line.text(), "Running");
});

test("marker mapping: ordinals follow context order; locate verifies by fingerprint", () => {
  const entries = [
    { id: "e1", type: "message", message: { role: "user", content: [{ type: "text", text: "first question" }] } },
    { id: "e2", type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } },
    { id: "e3", type: "message", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } },
    { id: "e4", type: "message", message: { role: "user", content: [{ type: "text", text: "second question" }] } },
  ];
  const index = markerOrdinalIndex(entries);
  assert.equal(index.get("e1")?.ordinal, 0);
  assert.equal(index.get("e2"), undefined);
  assert.equal(index.get("e3")?.ordinal, 1);
  assert.equal(index.get("e4")?.ordinal, 2);

  const mark = "\x1b]133;A\x07";
  const lines = [
    "header line",
    `${mark}first question`,
    "tool stuff without marker",
    `${mark}final answer`,
    `${mark}second question`,
  ];
  assert.deepEqual(markerRows(lines), [1, 3, 4]);
  assert.equal(locateMarkerRow(lines, 2, "second question"), 4);
  assert.equal(locateMarkerRow(lines, 0, "first question"), 1);
  // Wrong ordinal but right fingerprint falls back to the scan.
  assert.equal(locateMarkerRow(lines, 1, "first question"), 1);
  assert.equal(locateMarkerRow(lines, 1, "not present anywhere"), undefined);
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
});

test("fingerprints survive markdown rendering, wrapping, links, and emoji", () => {
  const message = { role: "user", content: [{ type: "text", text: "# Fix *Auth* flow\nSee [the docs](https://x.y/z) 🚀 now" }] };
  assert.equal(fingerprintOf(message), "fixauthflowseethedocsnow");
  // Rendered: heading marker gone, styled, OSC 8 link (ST-terminated), wrapped over rows.
  const rendered = ["\x1b[1mFix Auth\x1b[22m", " flow", "See \x1b]8;;https://x.y/z\x1b\\the docs\x1b]8;;\x1b\\ 🚀 now"];
  assert.equal(stripAnsi(rendered[2]), "See the docs 🚀 now");
  assert.ok(fingerprintKey(rendered.map(stripAnsi).join("")).includes(fingerprintOf(message)));
  assert.equal(fingerprintKey("Ünïcode 日本語 ＡＢＣ"), "ünïcode日本語abc");
  // Older raw-text fingerprints still identify the message.
  assert.ok(sameFingerprint("# Fix *Auth* flow See [the docs](https://x.y/z)", fingerprintOf(message)));
  assert.ok(!sameFingerprint("", ""));
});

test("locateMarker spans wrapped rows, prefers the nearest duplicate, and trusts ordinals only on matching counts", () => {
  const mark = "\x1b]133;A\x07";
  const lines = [
    `${mark}`, " continue", "",
    `${mark}`, " a long message that", " wraps onto another row", "",
    `${mark}`, " continue", "",
    `${mark}`, " \x1b[31mtransformed\x1b[0m", "",
  ];
  const wrapped = locateMarker(lines, 1, "a long message that wraps onto");
  assert.deepEqual(wrapped, { row: 3, fingerprintMatched: true, markers: 4 });
  // Text must stay inside its own message: row 0's segment ends before the next marker.
  assert.equal(locateMarkerRow(lines, 0, "continuealong"), undefined);
  // Duplicate text: nearest to the expected ordinal wins.
  assert.equal(locateMarkerRow(lines, 3, "continue"), 7);
  assert.equal(locateMarkerRow(lines, 0, "continue"), 0);
  // Markdown transformer rewrote the text: trust the ordinal only when marker counts agree.
  assert.deepEqual(locateMarker(lines, 3, "original text", 4), { row: 10, fingerprintMatched: false, markers: 4 });
  assert.equal(locateMarkerRow(lines, 3, "original text", 3), 10); // +1: a reply still streaming
  assert.equal(locateMarkerRow(lines, 3, "original text", 6), undefined);
  assert.equal(locateMarkerRow(lines, 3, "original text"), undefined);
});

test("shouldRunOutline: the TUI always runs; other modes only with the headless flag", () => {
  assert.equal(HEADLESS_FLAG, "topic-outline-headless");
  assert.equal(shouldRunOutline({ mode: "tui", headless: undefined }), true);
  assert.equal(shouldRunOutline({ mode: "tui", headless: true }), true);
  for (const mode of ["print", "json", "rpc", undefined]) {
    assert.equal(shouldRunOutline({ mode, headless: undefined }), false, `${mode} without flag`);
    assert.equal(shouldRunOutline({ mode, headless: false }), false, `${mode} flag false`);
    assert.equal(shouldRunOutline({ mode, headless: "true" }), false, `${mode} flag string`);
    assert.equal(shouldRunOutline({ mode, headless: true }), true, `${mode} with flag`);
  }
});
