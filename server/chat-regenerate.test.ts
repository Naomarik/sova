// Run: npx tsx --test server/chat-regenerate.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR; these tests drive the resolution rule directly and never open a session.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-regen-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { resolveRegenerate } = await import("./chat-manager");
const { parseWakeNudge } = await import("../shared/wake");

const user = (id: string, parentId: string | null, content: unknown) => ({
  type: "message",
  id,
  parentId,
  message: { role: "user", content },
});
const text = (t: string) => [{ type: "text", text: t }];
const assistant = (id: string, parentId: string, t: string) => ({
  type: "message",
  id,
  parentId,
  message: { role: "assistant", content: [{ type: "text", text: t }], provider: "anthropic", model: "claude-opus-5" },
});
const toolResult = (id: string, parentId: string) => ({
  type: "message",
  id,
  parentId,
  message: { role: "toolResult", content: text("ok"), toolCallId: "tc1" },
});

/** u1 → a1 → u2 → t1 → a2, the ordinary shape of a two-turn branch with a tool call in the second. */
const branch = () => [user("u1", null, text("first ask")), assistant("a1", "u1", "first answer"), user("u2", "a1", text("second ask")), toolResult("t1", "u2"), assistant("a2", "t1", "second answer")];

describe("resolving what a regenerate replays", () => {
  test("walks back from the reply to the user message that started its turn", () => {
    const r = resolveRegenerate(branch(), "a2");
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.userId, "u2");
    assert.equal(r.ok && r.text, "second ask");
  });

  test("accepts a BLOCK id, because that is what the transcript renders", () => {
    // server/transcript.ts emits one row per assistant content block: `<entryId>:<n>`, and
    // `<entryId>:stop` for an aborted or errored reply. A client sending the row id it drew must
    // not be told its own reply is off the branch.
    for (const rowId of ["a2:0", "a2:3", "a2:stop"]) {
      const r = resolveRegenerate(branch(), rowId);
      assert.equal(r.ok, true, rowId);
      assert.equal(r.ok && r.userId, "u2", rowId);
    }
  });

  test("regenerating from a tool result redoes the same turn, not an earlier one", () => {
    const r = resolveRegenerate(branch(), "t1");
    assert.equal(r.ok && r.userId, "u2");
  });

  test("an earlier turn's reply replays THAT turn's message", () => {
    const r = resolveRegenerate(branch(), "a1");
    assert.equal(r.ok && r.userId, "u1");
    assert.equal(r.ok && r.text, "first ask");
  });

  test("a user row is refused: rewind is that gesture", () => {
    const r = resolveRegenerate(branch(), "u2");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "not_on_branch");
    // The sentence has to say which gesture to use, or the refusal reads as a malfunction.
    assert.match(!r.ok ? r.message : "", /rewind/i);
  });

  test("an id that is not on the branch is refused, and a colon cannot rescue a foreign id", () => {
    // After a rewind the file's TAIL is the abandoned branch, so ids off the branch are ordinary,
    // not corruption. The block-id retry must not turn one entry's id into another's: it only ever
    // strips a suffix, so a stem that is not on the branch stays refused.
    for (const id of ["nope", "nope:0", ""]) {
      const r = resolveRegenerate(branch(), id);
      assert.equal(r.ok, false, id);
      assert.equal(!r.ok && r.reason, "not_on_branch", id);
    }
  });

  test("the STORED text is replayed, not the display text", () => {
    // TranscriptItem.text has pi's clipboard paths stripped for rendering. The model was given
    // them, so replaying the display text would send a different message than the one being redone.
    const raw = "look at this /tmp/pi-clipboard-00000000-0000-0000-0000-000000000000.png please";
    const b = [user("u1", null, text(raw)), assistant("a1", "u1", "I see")];
    const r = resolveRegenerate(b, "a1");
    assert.equal(r.ok && r.text, raw);
  });

  test("stored images ride along, in order, as ImageContent", () => {
    const b = [
      user("u1", null, [
        { type: "text", text: "compare these" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "image", data: "BBBB", mimeType: "image/jpeg" },
      ]),
      assistant("a1", "u1", "they differ"),
    ];
    const r = resolveRegenerate(b, "a1");
    assert.deepEqual(r.ok && r.images, [
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "image", data: "BBBB", mimeType: "image/jpeg" },
    ]);
    assert.equal(r.ok && r.text, "compare these");
  });

  test("an image-only message is replayed with no text and its images intact", () => {
    const b = [user("u1", null, [{ type: "image", data: "AAAA", mimeType: "image/png" }]), assistant("a1", "u1", "a cat")];
    const r = resolveRegenerate(b, "a1");
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.text, "");
    assert.equal(r.ok && r.images?.length, 1);
  });

  test("a reply with nothing before it on the branch is refused rather than replayed empty", () => {
    const b = [assistant("a1", "root", "unprompted")];
    const r = resolveRegenerate(b, "a1");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "not_on_branch");
  });

  test("a user message with nothing left to send is refused, not sent blank", () => {
    const b = [user("u1", null, []), assistant("a1", "u1", "?")];
    const r = resolveRegenerate(b, "a1");
    assert.equal(r.ok, false);
  });

  test("string content (older entries) still resolves", () => {
    const b = [user("u1", null, "plain string content"), assistant("a1", "u1", "ok")];
    const r = resolveRegenerate(b, "a1");
    assert.equal(r.ok && r.text, "plain string content");
  });

  test("a MID-TURN STEER is where the walk stops — pinned, because the copy depends on it", () => {
    // `u1 → a1 → toolResult → s1 → a2`: the user steered mid-turn, so s1 is an ordinary role:user
    // entry and regenerating a2 redoes from THERE. The consequence is deliberate but not obvious:
    // rewinding to before s1 also abandons a1, a reply nobody asked to redo. Pinned so the rule
    // cannot drift, and so the confirmation copy stays honest — it must say "the message that
    // started this reply, and everything after it", not "this reply and everything after it".
    const b = [user("u1", null, text("first ask")), assistant("a1", "u1", "partial answer"), toolResult("t1", "a1"), user("s1", "t1", text("actually, do X")), assistant("a2", "s1", "done X")];
    const r = resolveRegenerate(b, "a2");
    assert.equal(r.ok && r.userId, "s1", "the STEER, not the message that started the turn");
    assert.equal(r.ok && r.text, "actually, do X");
    // And the mirror case: regenerating the EARLIER reply of that turn resolves to u1, which takes
    // the user's steer away as collateral. Also deliberate, also pinned.
    const earlier = resolveRegenerate(b, "a1");
    assert.equal(earlier.ok && earlier.userId, "u1");
  });

  test("a reply to a WAKE NUDGE is refused, not replayed as if the user typed it", () => {
    // The real tag format, from shared/wake.ts — an invented one would prove the opposite of what
    // this claims. Replaying a nudge would put "[wake_nudge …] Scheduled wakeup fired (set 4m17s
    // ago)" back on the branch as the user's own message, with an elapsed time that is now false.
    const nudge = ["[wake_nudge n1] Scheduled wakeup fired (set 4m17s ago).", "Reason: check the build", "Look at CI and report."].join("\n");
    assert.ok(parseWakeNudge(nudge), "the fixture really is a nudge by Sova's own predicate");
    const b = [user("u1", null, text("hello")), assistant("a1", "u1", "hi"), user("w1", "a1", text(nudge)), assistant("a2", "w1", "build is green")];
    const r = resolveRegenerate(b, "a2");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "wake");
    // An ordinary message that merely MENTIONS a nudge is not one: the predicate decides, and it
    // requires the tag at the start.
    const talksAbout = [user("u2", null, text("what does [wake_nudge n1] mean?")), assistant("a3", "u2", "it is a scheduler tag")];
    assert.equal(resolveRegenerate(talksAbout, "a3").ok, true);
  });

  test("non-message entries between the reply and its input are stepped over", () => {
    // model_change, thinking_level_change, usage rows and Sova's own rewind marker all sit on
    // the branch and none of them is the message that started the turn.
    const b = [
      user("u1", null, text("go")),
      { type: "model_change", id: "m1", parentId: "u1" },
      { type: "usage", id: "g1", parentId: "m1" },
      { type: "custom", id: "c1", parentId: "g1", customType: "sova-rewind", data: {} },
      assistant("a1", "c1", "done"),
    ];
    const r = resolveRegenerate(b, "a1");
    assert.equal(r.ok && r.userId, "u1");
  });
});
