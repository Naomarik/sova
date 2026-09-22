// Run: npx tsx --test src/lib/group-prompt.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BatchRefusal, SessionSummary } from "../../shared/protocol";
import { composerPlaceholder, memberBlock, partialAfterRetry, partialBody, partialRetries, refusalBody, refusalSentence, targetsLine, targetsOf, withGone } from "./group-prompt";

const member = (id: string, over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, path: `/tmp/${id}.jsonl`, title: id, live: null, busy: false, archived: false, ...over }) as SessionSummary;

const refusal = (code: BatchRefusal["code"], message = "server says so"): BatchRefusal =>
  ({ id: "x", path: "/tmp/x.jsonl", code, message });

test("a member is blocked by the state the LIST can see, in the wire's own words", () => {
  assert.equal(memberBlock(member("a")), null);
  assert.equal(memberBlock(member("a", { live: { pid: 1, status: "running" } })), "tui-live");
  assert.equal(memberBlock(member("a", { archived: true })), "archived");
  assert.equal(memberBlock(member("a", { busy: true })), "mid-turn");
});

test("TUI-live outranks the other states: it is why pi-web won't write at all", () => {
  const both = member("a", { live: { pid: 1, status: "running" }, busy: true, archived: true });
  assert.equal(memberBlock(both), "tui-live");
});

test("targetsOf keeps member order and groups the blocked by reason", () => {
  const t = targetsOf([
    member("a"),
    member("b", { busy: true }),
    member("c", { live: { pid: 2, status: "running" } }),
    member("d"),
    member("e", { busy: true }),
  ]);
  assert.deepEqual(t.available, ["a", "d"]);
  assert.deepEqual(t.blocked, [
    { code: "mid-turn", ids: ["b", "e"] },
    { code: "tui-live", ids: ["c"] },
  ]);
  assert.equal(t.total, 5);
});

test("the foot names the exclusions, and says the plain count when there are none", () => {
  assert.equal(targetsLine(targetsOf([member("a"), member("b")])), "2 members");
  assert.equal(targetsLine(targetsOf([member("a")])), "1 member");
  assert.equal(
    targetsLine(targetsOf([member("a"), member("b", { busy: true }), member("c", { live: { pid: 1, status: "x" } })])),
    "1 of 3 members · 1 mid-turn · 1 open in a terminal",
  );
});

test("a refusal is pi-web's sentence, composed from the code and never parsed from the message", () => {
  assert.equal(refusalSentence(refusal("mid-turn"), "control"), "control is mid-turn");
  assert.equal(refusalSentence(refusal("tui-live"), "control"), "control is open in a terminal");
  assert.equal(refusalSentence(refusal("missing"), "control"), "control's file is gone");
  assert.equal(refusalSentence(refusal("config"), "control"), "control can't be opened");
  assert.equal(refusalSentence(refusal("old-format"), "control"), "control is in an older session format");
  assert.equal(
    refusalSentence(refusal("stale-leaf"), "control"),
    "the fork point you picked isn't control's latest message anymore",
  );
});

test("a code this build has no words for hands the server's sentence over verbatim", () => {
  assert.equal(
    refusalSentence(refusal("internal", "the runtime died"), "control"),
    "control couldn't be prompted. the runtime died",
  );
  // A code from a newer server: same path, so an older client stays honest instead of silent.
  assert.equal(
    refusalSentence({ ...refusal("internal"), code: "quota-exceeded" as BatchRefusal["code"], message: "out of quota" }, "opus"),
    "opus couldn't be prompted. out of quota",
  );
  // The server guarantees a non-blank message; if one ever arrives blank, the claim still stands alone.
  assert.equal(refusalSentence(refusal("internal", "   "), "opus"), "opus couldn't be prompted.");
});

test("the refusal banner offers the rest only when there is a rest", () => {
  assert.equal(
    refusalBody(["control is mid-turn", "glm-5.3 #2 is open in a terminal"], 5, 3),
    "2 of 5 members can't take a message right now: control is mid-turn, glm-5.3 #2 is open in a terminal. Wait for them, or send to the other 3.",
  );
  assert.equal(
    refusalBody(["control is mid-turn"], 1, 0),
    "1 of 1 member can't take a message right now: control is mid-turn.",
  );
});

test("a partial send retries per member: each button names exactly who its own press reaches", () => {
  const failed: BatchRefusal[] = [
    { ...refusal("internal", "grabbed by a terminal"), id: "a", path: "/tmp/a.jsonl" },
    { ...refusal("internal", "grabbed by a terminal"), id: "b", path: "/tmp/b.jsonl" },
  ];
  const nameOf = (id: string) => (id === "a" ? "control" : "glm-5.3 #2");
  const retries = partialRetries(failed, nameOf);
  // One button per failed member, in the order the server named them — two failed, two buttons.
  assert.deepEqual(retries, [
    { id: "a", label: "Send to control" },
    { id: "b", label: "Send to glm-5.3 #2" },
  ]);
  // The defect this replaces: one label (`Send to control`) over every failed id. A button whose
  // label names its own member and nobody else's cannot carry a second member's id, so every
  // label is checked against every other member's name.
  for (const r of retries)
    for (const other of retries.filter((x) => x.id !== r.id)) assert.ok(!r.label.includes(nameOf(other.id)));
});

test("a partial send with one straggler keeps §9's sentence exactly", () => {
  const retries = partialRetries([{ ...refusal("internal", "grabbed"), id: "a", path: "/tmp/a.jsonl" }], () => "control");
  assert.deepEqual(retries, [{ id: "a", label: "Send to control" }]);
});

test("the partial banner's body agrees with its own subject, one member or several", () => {
  assert.equal(
    partialBody(["control"], 3),
    "control was taken by another program between the check and the send, so it didn't get this message. The 3 that did are answering now.",
  );
  assert.equal(
    partialBody(["control", "glm-5.3 #2"], 3),
    "control, glm-5.3 #2 were taken by another program between the check and the send, so they didn't get this message. The 3 that did are answering now.",
  );
});

test("a retry to one of two stragglers keeps the other on the report, not the whole list", () => {
  const was = {
    failed: [
      { ...refusal("internal", "grabbed"), id: "a", path: "/tmp/a.jsonl" },
      { ...refusal("internal", "grabbed"), id: "b", path: "/tmp/b.jsonl" },
    ],
    sent: 3,
    text: "same message",
  };
  const next = partialAfterRetry(was, ["a"]);
  // Still 4 of 5 in sync, still the SAME message, and only b remains missing it — a's success
  // must not clear the record of b, which was the one-press-fixes-all assumption the single
  // button made.
  assert.equal(next?.failed.length, 1);
  assert.equal(next?.failed[0]?.id, "b");
  assert.equal(next?.sent, 4);
  assert.equal(next?.text, "same message");
});

test("a retry that reaches every straggler closes the report", () => {
  const was = { failed: [{ ...refusal("internal", "grabbed"), id: "b", path: "/tmp/b.jsonl" }], sent: 4, text: "m" };
  assert.equal(partialAfterRetry(was, ["b"]), null);
});

test("the placeholder names the group's size, not who is available, and drops the key hint when folded", () => {
  assert.equal(composerPlaceholder(4, false), "Ask all 4 members…—Enter sends, Shift+Enter adds a line");
  assert.equal(composerPlaceholder(4, true), "Ask all 4 members…");
  assert.equal(composerPlaceholder(1, false), "Ask this member…");
  // The count is the group's, so a member going mid-turn does not rewrite the box under the caret:
  // three members, none of them available, still reads "all 3".
  assert.equal(composerPlaceholder(3, true), "Ask all 3 members…");
});

test("withGone folds file-gone members in under missing, counted in the group's size", () => {
  const t = targetsOf([member("a"), member("b", { busy: true })]);
  const g = withGone(t, ["gone1", "gone2"]);
  // The foot the server's pre-check will confirm: gone members ride under `missing` (the wire's
  // own code), in the BLOCK_ORDER position, and the total is the GROUP's size, not the list's.
  assert.deepEqual(g.blocked.map((b) => [b.code, b.ids]), [
    ["mid-turn", ["b"]],
    ["missing", ["gone1", "gone2"]],
  ]);
  assert.equal(g.total, 4);
  assert.equal(targetsLine(g), "1 of 4 members · 1 mid-turn · 2 file gone");
  // No ghosts, no change — the identity, so callers need not branch.
  assert.equal(withGone(t, []), t);
  // The available set is untouched: a gone member was never sendable, never counted sendable.
  assert.deepEqual(g.available, ["a"]);
});
