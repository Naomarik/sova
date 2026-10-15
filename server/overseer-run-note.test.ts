// Run: npx tsx --test server/overseer-run-note.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-run-note-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { runNote, briefedBlockers, CLEARED_WINDOW_MS } = await import("./overseer-run-note");
const { briefText, runNoteMessage } = await import("./overseer");
const { CARDS_NOTE_MESSAGE } = await import("../shared/overseer-card");
const { historyOf } = await import("./harness/pi/reader");
const { disposeAllChats } = await import("./chat-manager");
type SessionNow = import("./overseer-run-note").SessionNow;

after(async () => {
  await disposeAllChats();
});

const NOW = new Date("2026-10-01T10:00:00Z");
const min = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** The note's part that opens with `tag` ("[cleared]"); "" when it has none. Other parts (the sessions in play) name the same sessions. */
const part = (content: string, tag: string) => content.split("\n\n").find((p) => p.startsWith(tag)) ?? "";
/** A redactor that changes nothing (briefText redacts; these fixtures hold no secret). */
const plain = () => ({ redact: (t: string) => t }) as never;
/** A brief exactly as the server writes it (briefText), as a user message on the branch. */
const brief = (at: number, items: { kind: string; id: string; title: string }[]) => ({
  type: "message",
  timestamp: iso(at),
  message: { role: "user", content: [{ type: "text", text: briefText(items as never, plain) }] },
});
const live = (over: Partial<SessionNow> = {}): SessionNow => ({ name: "A session", archived: false, waitsOnAnswers: false, ...over });

describe("the run note (§app.overseer/run-note)", () => {
  test("it opens with the time now, and says the system prompt's time is the opening time", () => {
    const n = runNote({ now: NOW, branch: [], act: { keys: new Set(), complete: true }, session: () => null });
    assert.ok(n.content.startsWith(`[now] It is ${NOW.toString()}.`), n.content);
    assert.match(n.content, /system prompt is when this conversation opened/);
    assert.deepEqual(n.details, { v: 1 });
  });

  test("briefText's lines parse back to the blockers they name", () => {
    const at = NOW.getTime() - 10 * min;
    const got = briefedBlockers(historyOf([brief(at, [{ kind: "open-questions", id: "s-1", title: "Port [the] store" }, { kind: "needs-input", id: "s-2", title: "B" }])]));
    assert.deepEqual(got, [
      { key: "s-1:open-questions", id: "s-1", kind: "open-questions", at },
      { key: "s-2:needs-input", id: "s-2", kind: "needs-input", at },
    ]);
  });

  test("a briefed blocker that cleared is listed once with why; one still a blocker is not", () => {
    const at = NOW.getTime() - 30 * min;
    const branch: unknown[] = [
      brief(at, [
        { kind: "open-questions", id: "merged", title: "M" },
        { kind: "open-questions", id: "answered", title: "Q" },
        { kind: "needs-input", id: "still", title: "S" },
        { kind: "error", id: "gone", title: "G" },
        { kind: "error", id: "arch", title: "R" },
      ]),
    ];
    const sessions: Record<string, SessionNow | null> = {
      merged: live({ name: "Merged one", merged: at + min, waitsOnAnswers: true }),
      answered: live({ name: "Answered one" }),
      still: live({ name: "Still" }),
      gone: null,
      arch: live({ name: "Archived one", archived: true }),
    };
    const input = { now: NOW, act: { keys: new Set(["still:needs-input"]), complete: true }, session: (id: string) => sessions[id] ?? null };
    const n = runNote({ ...input, branch: historyOf(branch) });
    assert.match(n.content, /\n- open-questions: \[Merged one\]\(sova:\/\/s\/merged\) — merged \(briefed 30m ago\)/);
    assert.match(n.content, /\n- open-questions: \[Answered one\]\(sova:\/\/s\/answered\) — its questions were answered in the session/);
    assert.match(n.content, /\n- error: \[gone\]\(sova:\/\/s\/gone\) — the session is gone/);
    assert.match(n.content, /\n- error: \[Archived one\]\(sova:\/\/s\/arch\) — archived/);
    assert.ok(!part(n.content, "[cleared]").includes("sova://s/still"), "a live blocker is not cleared");
    assert.equal(n.details.cleared?.length, 4);

    // The note is persisted with its details: the next run lists none of them again.
    branch.push({ type: "custom_message", customType: CARDS_NOTE_MESSAGE, content: n.content, display: false, details: n.details });
    const again = runNote({ ...input, branch: historyOf(branch) });
    assert.ok(!again.content.includes("[cleared]"), again.content);
    // A later brief names one again, and it clears again: listed again.
    branch.push(brief(NOW.getTime() - 5 * min, [{ kind: "open-questions", id: "answered", title: "Q" }]));
    const third = runNote({ ...input, branch: historyOf(branch) });
    assert.match(third.content, /\[Answered one\]\(sova:\/\/s\/answered\) — its questions were answered in the session \(briefed 5m ago\)/);
    assert.equal(third.details.cleared?.length, 1);
  });

  test("briefs older than the window are not looked at; a cut-short digest lists only what the server knows", () => {
    const old = NOW.getTime() - CLEARED_WINDOW_MS - min;
    const recent = NOW.getTime() - min;
    const branch = [brief(old, [{ kind: "error", id: "old", title: "O" }]), brief(recent, [{ kind: "error", id: "unknown", title: "U" }, { kind: "error", id: "arch", title: "R" }])];
    const session = (id: string) => (id === "arch" ? live({ archived: true }) : live());
    const n = runNote({ now: NOW, branch: historyOf(branch), act: { keys: new Set(), complete: false }, session });
    const cleared = part(n.content, "[cleared]");
    assert.ok(!cleared.includes("sova://s/old"), "outside the window");
    assert.ok(!n.content.includes("sova://s/old"), "nor in play: outside the window");
    assert.ok(!cleared.includes("sova://s/unknown"), "maybe left out of the digest by its cap");
    assert.match(n.content, /sova:\/\/s\/arch\) — archived/);
  });

  test("an open card's sessions: merged after it was raised, or archived, get a line; merged before it does not", () => {
    const raised = NOW.getTime() - 60 * min;
    const card = {
      id: "c_4",
      title: "Archive these?",
      options: [{ label: "Archive" }],
      items: [
        { kind: "session", id: "after", title: "A", n: 1 },
        { kind: "session", id: "before", title: "B", n: 2 },
        { kind: "session", id: "arch", title: "C", n: 3 },
      ],
      phase: "open",
      rev: 1,
      createdAt: iso(raised),
      updatedAt: iso(raised),
    };
    const branch = [{ type: "message", message: { role: "toolResult", toolName: "sova_card", toolCallId: "k", details: { v: 1, changes: [{ kind: "created" }], line: "created", card } } }];
    const sessions: Record<string, SessionNow> = {
      after: live({ name: "After", merged: raised + 40 * min }),
      before: live({ name: "Before", merged: raised - min }),
      arch: live({ name: "Arch", archived: true }),
    };
    const n = runNote({ now: NOW, branch: historyOf(branch), act: { keys: new Set(), complete: true }, session: (id) => sessions[id] ?? null, cardsText: "[cards] Open cards…" });
    assert.match(n.content, /\n- c_4 item 1: \[After\]\(sova:\/\/s\/after\) — merged 20m ago, after the card was raised/);
    assert.match(n.content, /\n- c_4 item 3: \[Arch\]\(sova:\/\/s\/arch\) — archived/);
    assert.ok(!n.content.includes("sova://s/before"), n.content);
    assert.ok(n.content.endsWith("[cards] Open cards…"), "the cards follow");
  });

  test("the Overseer's before_agent_start message: hidden, the cards note's type, opening with the time", async () => {
    const r = await runNoteMessage([], NOW);
    assert.equal(r.message.customType, CARDS_NOTE_MESSAGE, "the attendance rule treats it as state");
    assert.equal(r.message.display, false);
    assert.ok(r.message.content.startsWith(`[now] It is ${NOW.toString()}.`));
  });
});

describe("memory first (§app.overseer/sessions-in-play, §app.overseer/verify-first)", () => {
  const LINE = "Any other session or fact this chat has seen: zoom its line down to the message (full ids, exact words) before any other tool.";
  const sent = [{ type: "message", timestamp: iso(NOW.getTime() - 3 * min), message: { role: "toolResult", toolCallId: "c1", toolName: "sova_send", content: [{ type: "text", text: "sent" }], details: { id: "sent" }, isError: false } }];
  const note = (memory: boolean | undefined, branch: unknown[]) =>
    runNote({ now: NOW, branch: historyOf(branch), act: { keys: new Set(), complete: true }, session: () => live({ state: "idle" }), cardsText: "[cards] none", ...(memory === undefined ? {} : { memory }) }).content.split("\n\n");

  test("with memory on, the line follows the sessions in play, before the cards", () => {
    const parts = note(true, sent);
    assert.match(parts.at(-3)!, /^\[sessions in play\]/);
    assert.equal(parts.at(-2), LINE);
    assert.equal(parts.at(-1), "[cards] none");
  });

  test("with memory on and nothing in play, it stands alone after the time", () => {
    const parts = note(true, []);
    assert.equal(parts.length, 3);
    assert.equal(parts[1], LINE);
  });

  test("with memory off, zoom is never named", () => {
    for (const parts of [note(false, sent), note(undefined, sent), note(false, [])]) assert.ok(!parts.join("\n\n").includes("zoom"), parts.join("\n\n"));
  });

  test("the before_agent_start message follows the Overseer's memory switch in force (on when never set)", async () => {
    const { readOverseerSettings, writeOverseerSettings } = await import("./overseer-store");
    const was = readOverseerSettings();
    try {
      writeOverseerSettings({ ...was, memory: undefined });
      assert.ok((await runNoteMessage([], NOW)).message.content.includes(LINE), "no saved choice: memory is on");
      writeOverseerSettings({ ...was, memory: { on: true, type: "uniichat", size: 64 } });
      assert.ok((await runNoteMessage([], NOW)).message.content.includes(LINE));
      writeOverseerSettings({ ...was, memory: { on: false, type: "uniichat", size: 64 } });
      assert.ok(!(await runNoteMessage([], NOW)).message.content.includes("zoom"));
    } finally {
      writeOverseerSettings(was);
    }
  });

  describe("the prompt's id rule follows the switch", async () => {
    const { buildOverseerTools, renderOverseerPrompt, overseerLiveParts, overseerValues } = await import("./overseer");
    const { readOverseerSettings } = await import("./overseer-store");
    const { changedText, toldOn } = await import("./overseer-opening");
    const settings = (memory: { on: boolean } | undefined) => ({ ...readOverseerSettings(), memory: memory && { ...memory, type: "uniichat" as const, size: 64 } });
    const flat = (t: string) => t.replace(/\s+/g, " ");

    test("memory on (and never set): zoom output is a source, and a search only for what memory never names", () => {
      for (const s of [settings({ on: true }), settings(undefined)]) {
        const prompt = flat(renderOverseerPrompt(buildOverseerTools(), s));
        assert.ok(prompt.includes("Take a session id verbatim from a tool's output in this turn, `zoom` included."), "zoom output is a source");
        assert.ok(prompt.includes("A summary line's short id points to the message that has it whole: zoom down to it."));
        assert.ok(prompt.includes("Search with `sova_list_sessions` only when memory never names the session."));
        assert.ok(prompt.includes("A hidden `[ids]` note naming an id from your last reply as no session here means that link was wrong"));
        assert.ok(!prompt.includes("when unsure, `sova_list_sessions`"));
      }
    });

    test("memory off: the rule names no zoom, and searches when unsure", () => {
      const prompt = renderOverseerPrompt(buildOverseerTools(), settings({ on: false }));
      assert.ok(!/\bzoom\b/.test(prompt), "no zoom anywhere in the prompt");
      assert.ok(flat(prompt).includes("(`sova_list_sessions`, `sova_attention`, `sova_session`). Never type, shorten or piece one together from memory; when unsure, `sova_list_sessions` with a query first."));
      assert.ok(!prompt.includes("{{IDS}}"));
    });

    test("fixed at opening: a switch reaches the next run under [changed], never by rewriting the prompt", () => {
      const opened = overseerValues(settings({ on: true }), NOW);
      const before = renderOverseerPrompt(buildOverseerTools(), settings({ on: false }), undefined, NOW, undefined, opened);
      assert.ok(before.includes("`zoom` included"), "the prompt keeps its opening form");
      const changed = changedText(overseerLiveParts(overseerValues(settings({ on: false }), NOW)), toldOn([], overseerLiveParts(opened))).text ?? "";
      assert.ok(changed.includes("## Ids are copied, never typed (now)"), changed);
      assert.ok(flat(changed).includes("when unsure, `sova_list_sessions` with a query first"), changed);
      assert.equal(changedText(overseerLiveParts(overseerValues(settings({ on: true }), NOW)), toldOn([], overseerLiveParts(opened))).text, undefined, "no change, nothing told");
    });
  });
});

describe("the sessions in play (§app.overseer/sessions-in-play)", async () => {
  const { sessionsInPlay, sessionsInPlayText, branchLabels, promptedOnBranch, IN_PLAY_MAX } = await import("./overseer-run-note");
  const now = NOW.getTime();
  /** A sova_create_session / sova_send result on the Overseer's branch. */
  const result = (toolName: string, at: number, details: Record<string, unknown>, isError = false) => ({
    type: "message",
    timestamp: iso(at),
    message: { role: "toolResult", toolName, isError, details },
  });

  test("created, sent to (this host only, successful) and briefed in the last 24 hours, newest touch first, capped", () => {
    const branch: unknown[] = [
      result("sova_create_session", now - 50 * min, { id: "made", path: "/s/made.jsonl" }),
      result("sova_send", now - 40 * min, { id: "sent", path: "/s/sent.jsonl" }),
      result("sova_send", now - 30 * min, { id: "refused" }, true),
      result("sova_create_session", now - 20 * min, { id: "on-peer", host: "p1" }),
      result("sova_send", now - 25 * 3_600_000, { id: "old" }),
      result("sova_list_sessions", now - 5 * min, { id: "listed" }),
      brief(now - 10 * min, [{ kind: "open-questions", id: "briefed", title: "B" }, { kind: "error", id: "sent", title: "S" }]),
    ];
    assert.deepEqual(promptedOnBranch(historyOf(branch)).map((t) => t.id), ["made", "sent", "old"]);
    const play = sessionsInPlay(historyOf(branch), now, [{ id: "here", at: now - 1 * min }, { id: "made", at: now - 45 * min }]);
    assert.deepEqual(play, [
      { id: "here", prompted: now - min },
      { id: "sent", prompted: now - 40 * min, brief: { kind: "error", at: now - 10 * min } },
      { id: "briefed", brief: { kind: "open-questions", at: now - 10 * min } },
      { id: "made", prompted: now - 45 * min },
    ]);
    const many = Array.from({ length: IN_PLAY_MAX + 3 }, (_, i) => ({ id: `s${i}`, at: now - i * min }));
    assert.equal(sessionsInPlay([], now, many).length, IN_PLAY_MAX);
  });

  test("branchLabels: the badge for the worktree it speaks for, else each worktree's state; none without readiness", () => {
    const r = { trees: [{ path: "/a", branch: "feat/a", state: "merged" }, { path: "/b", branch: "feat/b", state: "in-progress" }], badge: "restart", branch: "feat/a", since: 0 } as never;
    assert.deepEqual(branchLabels(r), ["branch feat/a (merged, restart pending)", "branch feat/b (in-progress)"]);
    assert.deepEqual(branchLabels(undefined), []);
  });

  test("each row: link, id, state, branches, when prompted, the last brief; a gone session says so; nothing in play writes nothing", () => {
    const text = sessionsInPlayText(
      [
        { id: "sent", prompted: now - 40 * min, brief: { kind: "error", at: now - 10 * min } },
        { id: "arch", prompted: now - 2 * 3_600_000 },
        { id: "gone", brief: { kind: "needs-input", at: now - 5 * min } },
      ],
      (id) => (id === "sent" ? live({ name: "Port the store", state: "working", branches: ["branch feat/x (ready)"] }) : id === "arch" ? live({ name: "Old", archived: true, state: "idle" }) : null),
      now,
    )!;
    const lines = text.split("\n");
    assert.equal(lines[0], "[sessions in play] Sessions you created, prompted or were briefed about in the last 24 hours. Check one with sova_session before saying what it is doing:");
    assert.equal(lines[1], "- [Port the store](sova://s/sent) · sent · working · branch feat/x (ready) · you created or prompted it 40m ago · last brief: error 10m ago");
    assert.equal(lines[2], "- [Old](sova://s/arch) · arch · archived · you created or prompted it 2h ago");
    assert.equal(lines[3], "- gone — the session is gone");
    assert.equal(sessionsInPlayText([], () => null, now), undefined);
  });

  test("after a compaction the note carries them even with no card open; with neither, nothing is written", async () => {
    const { compactNoteMessage } = await import("./overseer");
    assert.equal(await compactNoteMessage([], now), undefined);
    const note = (await compactNoteMessage(historyOf([result("sova_send", now - 2 * min, { id: "no-such-session" })]), now))!;
    assert.equal(note.customType, CARDS_NOTE_MESSAGE);
    assert.equal(note.display, false);
    assert.match(note.content, /^\[sessions in play\] /);
    assert.ok(note.content.includes("- no-such-session — the session is gone"), note.content);
  });

  test("the run note carries them after the cleared lines and before the cards, redacted", () => {
    const branch = [result("sova_send", now - 3 * min, { id: "sent" })];
    const n = runNote({
      now: NOW,
      branch: historyOf(branch),
      act: { keys: new Set(), complete: true },
      session: (id) => (id === "sent" ? live({ name: "Secret TOKEN-x", state: "idle" }) : null),
      cardsText: "[cards] none",
      redact: (t) => t.replace("TOKEN-x", "[redacted]"),
    });
    const parts = n.content.split("\n\n");
    assert.match(parts.at(-2)!, /^\[sessions in play\]/);
    assert.ok(parts.at(-2)!.includes("[Secret [redacted]](sova://s/sent) · sent · idle"), parts.at(-2));
    assert.equal(parts.at(-1), "[cards] none");
  });
});
