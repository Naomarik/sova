// Run: npx tsx --test server/overseer-run-note.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-run-note-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { runNote, briefedBlockers, CLEARED_WINDOW_MS } = await import("./overseer-run-note");
const { briefText, runNoteMessage } = await import("./overseer");
const { CARDS_NOTE_MESSAGE } = await import("../shared/overseer-card");
const { disposeAllChats } = await import("./chat-manager");
type SessionNow = import("./overseer-run-note").SessionNow;

after(async () => {
  await disposeAllChats();
});

const NOW = new Date("2026-10-01T10:00:00Z");
const min = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
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
    const got = briefedBlockers([brief(at, [{ kind: "open-questions", id: "s-1", title: "Port [the] store" }, { kind: "needs-input", id: "s-2", title: "B" }])]);
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
    const n = runNote({ ...input, branch });
    assert.match(n.content, /\n- open-questions: \[Merged one\]\(sova:\/\/s\/merged\) — merged \(briefed 30m ago\)/);
    assert.match(n.content, /\n- open-questions: \[Answered one\]\(sova:\/\/s\/answered\) — its questions were answered in the session/);
    assert.match(n.content, /\n- error: \[gone\]\(sova:\/\/s\/gone\) — the session is gone/);
    assert.match(n.content, /\n- error: \[Archived one\]\(sova:\/\/s\/arch\) — archived/);
    assert.ok(!n.content.includes("sova://s/still"), "a live blocker is not cleared");
    assert.equal(n.details.cleared?.length, 4);

    // The note is persisted with its details: the next run lists none of them again.
    branch.push({ type: "custom_message", customType: CARDS_NOTE_MESSAGE, content: n.content, display: false, details: n.details });
    const again = runNote({ ...input, branch });
    assert.ok(!again.content.includes("[cleared]"), again.content);
    // A later brief names one again, and it clears again: listed again.
    branch.push(brief(NOW.getTime() - 5 * min, [{ kind: "open-questions", id: "answered", title: "Q" }]));
    const third = runNote({ ...input, branch });
    assert.match(third.content, /\[Answered one\]\(sova:\/\/s\/answered\) — its questions were answered in the session \(briefed 5m ago\)/);
    assert.equal(third.details.cleared?.length, 1);
  });

  test("briefs older than the window are not looked at; a cut-short digest lists only what the server knows", () => {
    const old = NOW.getTime() - CLEARED_WINDOW_MS - min;
    const recent = NOW.getTime() - min;
    const branch = [brief(old, [{ kind: "error", id: "old", title: "O" }]), brief(recent, [{ kind: "error", id: "unknown", title: "U" }, { kind: "error", id: "arch", title: "R" }])];
    const session = (id: string) => (id === "arch" ? live({ archived: true }) : live());
    const n = runNote({ now: NOW, branch, act: { keys: new Set(), complete: false }, session });
    assert.ok(!n.content.includes("sova://s/old"), "outside the window");
    assert.ok(!n.content.includes("sova://s/unknown"), "maybe left out of the digest by its cap");
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
    const n = runNote({ now: NOW, branch, act: { keys: new Set(), complete: true }, session: (id) => sessions[id] ?? null, cardsText: "[cards] Open cards…" });
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
