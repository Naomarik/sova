// Run: npx tsx --test server/overseer-id-check.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-id-check-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { assistantText, editDistance, ID_NOTE_MAX, ID_NOTE_MESSAGE, idCheckNote, linkedSessionIds, nearestId, nearMaxEdits } = await import("./overseer-id-check");
const { idNoteMessage } = await import("./overseer");
const { UserTurns } = await import("./overseer-tools");
const { disposeAllChats } = await import("./chat-manager");

after(async () => {
  await disposeAllChats();
});

const A = "01a0f3ef-5c2e-7d10-9a11-0123456789ab";
const B = "01a0dc43-11aa-7b22-8c33-fedcba987654";

describe("the id check (§app.overseer/id-check)", () => {
  test("it reads every sova://s/ and sova://g/<group>/s/ link, once each; group links and plain ids are not session links", () => {
    const text = `See [one](sova://s/${A}), again sova://s/${A}. The pane [p](sova://g/g_1/s/${B}). Group [g](sova://g/g_1). Bare ${B}.`;
    assert.deepEqual(linkedSessionIds(text), [A, B]);
    assert.equal(assistantText([{ role: "user", content: "sova://s/x" }, { role: "assistant", content: [{ type: "text", text: "a" }, { type: "toolCall" }] }, { role: "assistant", content: "b" }]), "a\nb");
  });

  test("the nearest id: fewest edits, the longer shared start breaking a tie; over half the id's length is not close", () => {
    assert.equal(editDistance("kitten", "sitting"), 3);
    // A tail spliced from another session (the audit's case, 16 of 36 characters): both sources are
    // close, and the nearest is one of them, whichever needs fewer edits; alone, each is found.
    const spliced = `${A.slice(0, 20)}${B.slice(20)}`;
    for (const src of [A, B]) assert.ok(editDistance(spliced, src) <= nearMaxEdits(spliced, src), src);
    assert.ok([A, B].includes(nearestId(spliced, [A, B])!.id));
    assert.equal(nearestId(spliced, [A])?.id, A);
    assert.equal(nearestId(spliced, [B])?.id, B);
    assert.equal(nearMaxEdits(spliced, A), 18);
    // An unrelated id of the same shape is not close.
    const other = "01a0e999-40f9-7f76-b1c2-d3e4f5a6b7c8";
    assert.ok(editDistance(other, A) > nearMaxEdits(other, A), String(editDistance(other, A)));
    assert.equal(nearestId(other, [A]), null);
    // A tie on edits goes to the longer shared start.
    assert.equal(nearestId("abcd-x", ["abcd-y", "zbcd-x"])?.id, "abcd-y");
    assert.equal(nearestId("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", [A, B]), null);
  });

  test("an unknown id gets a line with the nearest id, its name and the shared start; all known writes nothing; at most 5", async () => {
    const known = new Set([A, B]);
    const deps = { known: async (id: string) => known.has(id), allIds: async () => [A, B], name: async (id: string) => (id === A ? 'Spec "tools"' : undefined) };
    assert.equal(await idCheckNote(`[a](sova://s/${A}) and [b](sova://s/${B})`, deps), null);
    const bad = `${A.slice(0, 8)}12-0000-7d10-9a11-0123456789ab`;
    const note = (await idCheckNote(`Look at [x](sova://s/${bad}) and sova://s/nonsense-id-here`, deps))!;
    const [head, ...lines] = note.content.split("\n");
    assert.match(head!, /^\[ids\] Your last reply linked session ids that match no session on this host\. Correct each link/);
    assert.deepEqual(lines, [`- ${bad} is no session here; nearest: ${A} "Spec 'tools'", same first 8 characters.`, "- nonsense-id-here is no session here; no session id is close."]);
    assert.deepEqual(note.details, { v: 1, unknown: [{ id: bad, nearest: A }, { id: "nonsense-id-here" }] });
    const many = Array.from({ length: 8 }, (_, i) => `sova://s/zz${i}`).join(" ");
    assert.equal((await idCheckNote(many, deps))!.details.unknown.length, ID_NOTE_MAX);
  });

  test("against this host's session files: a real id passes, a mistyped one is named with its nearest, hidden", async () => {
    const dir = join(agentDir, "sessions", "--tmp-id-check--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `2026-10-01T10-00-00-000Z_${A}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id: A, timestamp: "2026-10-01T10:00:00.000Z", cwd: "/tmp/id-check" })}\n`);
    const reply = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];
    assert.equal(await idNoteMessage(reply(`Done: [it](sova://s/${A}).`)), null);
    const typo = `${A.slice(0, 30)}999999`;
    const msg = (await idNoteMessage(reply(`Done: [it](sova://s/${typo}).`)))!;
    assert.equal(msg.customType, ID_NOTE_MESSAGE);
    assert.equal(msg.display, false);
    assert.ok(msg.content.includes(`- ${typo} is no session here; nearest: ${A}`), msg.content);
    assert.ok(msg.content.includes("same first 30 characters"), msg.content);
    const spliced = `${A.slice(0, 20)}ffffffffffffffff`;
    const far = (await idNoteMessage(reply(`[it](sova://s/${spliced})`)))!;
    assert.ok(far.content.includes(`- ${spliced} is no session here; nearest: ${A}`), far.content);
  });

  test("the note is state: it never makes a run read-only, nor the user's", () => {
    const turns = new UserTurns();
    const agent = { prompt: async (_m: unknown) => {}, steer: (_m: unknown) => {}, followUp: (_m: unknown) => {} };
    turns.watch(agent as never);
    const msg = { role: "user", content: "what's running?" };
    turns.send(() => agent.prompt(msg as never));
    turns.observe({ type: "agent_start" });
    turns.observe({ type: "message_start", message: msg });
    turns.observe({ type: "message_start", message: { role: "assistant", content: [] } });
    turns.observe({ type: "message_start", message: { role: "custom", customType: ID_NOTE_MESSAGE, content: "[ids] …", display: false } });
    assert.equal(turns.attended(), true);
    turns.observe({ type: "agent_start" });
    turns.observe({ type: "message_start", message: { role: "custom", customType: ID_NOTE_MESSAGE, content: "[ids] …", display: false } });
    assert.equal(turns.attended(), false);
  });
});
