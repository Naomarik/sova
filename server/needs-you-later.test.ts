// Run: npx tsx --test server/needs-you-later.test.ts (or npm test). Needs you = real blockers only,
// every row clearable with Later (§app.overseer/attention-digest). Files in a temp dir only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { AttentionItem, SessionSummary } from "../shared/protocol";
import { type AttentionRow, buildDigest, sessionItems, withBatonLater } from "./attention";
import { bringBack, LATER_MAX_AGE_MS, laterKey, parseLaterKey, putAway, resetLaterCache, withoutLater } from "./needs-you-later";

const NOW = Date.parse("2026-09-30T11:00:00.000Z");
const dir = mkdtempSync(join(tmpdir(), "sova-later-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const freshFile = () => join(dir, `later-${++n}.json`);

function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    path: `/s/${id}.jsonl`,
    cwd: "/home/u/proj",
    title: `Session ${id}`,
    createdAt: "2026-09-30T08:00:00.000Z",
    lastActiveAt: new Date(NOW - 60_000).toISOString(),
    model: "a/b",
    live: null,
    busy: false,
    origin: "web",
    archived: false,
    ...over,
  };
}
const row = (s: SessionSummary, over: Partial<AttentionRow> = {}): AttentionRow => ({ summary: s, dialogs: [], queued: 0, failedWorkers: 0, activitySince: 0, ...over });
const digest = (rows: AttentionRow[], file: string, now = NOW) => buildDigest(rows, now, "/home/u", [], (items) => withoutLater(items, now, file));
const acts = (d: { items: AttentionItem[] }) => d.items.filter((i) => i.tier === "act").map((i) => `${i.id}:${i.kind}`);
const keysOf = (d: { items: AttentionItem[] }, id: string) => d.items.filter((i) => i.id === id && i.later).map((i) => i.later!);
const align = (ids: string[]) => ({ openDocs: 1, openQuestions: ids.length, questionIds: ids, questionDocs: 1, lead: { id: "al_3", title: "Needs you" } });
const signals = (kinds: ("looping" | "asks-you")[]) => ({ at: NOW - 5000, turnId: "t", provider: "jev" as const, kinds });

describe("Needs you lists only real blockers", () => {
  test("act = open questions, dialogs, errored turns, subagent errors, baton hand-offs; each carries a Later key", () => {
    const rows = [
      row(summary("q", { align: align(["al_3/q1"]) })),
      row(summary("d"), { dialogs: ["Overwrite?"], dialogIds: ["dlg1"] }),
      row(summary("e", { turnError: { message: "529 overloaded" } }), { lastReplyAt: NOW - 7000 }),
      row(summary("w"), { failedWorkers: 1, workerErrorAt: NOW - 3000 }),
      row(summary("b", { baton: { needsYou: { from: "Ann", question: "Which venue?", since: NOW - 100 } } as SessionSummary["baton"] })),
    ];
    const d = digest(rows, freshFile());
    assert.deepEqual(acts(d).sort(), ["b:baton-needs-you", "d:needs-input", "e:error", "q:open-questions", "w:worker-error"]);
    assert.ok(d.items.filter((i) => i.tier === "act").every((i) => typeof i.later === "string" && parseLaterKey(i.later)?.id === i.id));
    assert.equal(d.badge.act, 5);
  });

  test("the audit's false alarms are decide at most: asks-you (01a0f1f2 'If you want, I can inspect…'), team-stalled (01a0eced), ready/waiting to merge", () => {
    const rows = [
      row(summary("01a0f1f2", { signals: signals(["asks-you"]) }), { signalText: { sentence: "If you want, I can inspect its full transcript, kill it, or steer it.", stuckWorkers: [] } }),
      row(summary("01a0eced"), { teamStall: { since: NOW - 1320 * 60_000, names: ["velocity-metrics"] } }),
      row(summary("01a0def5", { readiness: { trees: [], badge: "ready", branch: "feat/cc-sandbox", since: NOW - 1000 } })),
      row(summary("01a0edcd", { readiness: { trees: [], badge: "waiting", branch: "feat/x", since: NOW - 1000 } })),
    ];
    const d = digest(rows, freshFile());
    assert.deepEqual(acts(d), []);
    assert.deepEqual(d.badge, { act: 0, decide: 4 });
    assert.deepEqual(
      d.items.filter((i) => i.kind !== "finished").map((i) => `${i.tier}:${i.kind}:${i.detail}`).sort(),
      [
        "decide:asks-you:Asks you: If you want, I can inspect its full transcript, kill it, or steer it.",
        "decide:ready-to-merge:Ready to merge: feat/cc-sandbox",
        "decide:ready-to-merge:Waiting for your OK: feat/x",
        "decide:team-stalled:Waiting on velocity-metrics, quiet for 1320 min.",
      ],
    );
    assert.ok(d.items.every((i) => i.later === undefined), "no Later key off the act tier");
  });
});

describe("Later hides an item until its anchor moves", () => {
  test("open questions: hidden while every open question was put away; a new or reopened one brings it back, an answered one does not", () => {
    const file = freshFile();
    const first = digest([row(summary("s", { align: align(["al_3/q1", "al_3/q2"]) }))], file);
    assert.equal(putAway(keysOf(first, "s"), NOW, file), 1);
    assert.deepEqual(acts(digest([row(summary("s", { align: align(["al_3/q1", "al_3/q2"]) }))], file)), [], "the same questions: hidden");
    const hidden = digest([row(summary("s", { align: align(["al_3/q2"]) }))], file);
    assert.deepEqual(acts(hidden), [], "one answered: still hidden");
    assert.deepEqual([hidden.badge.act, hidden.counts.act], [0, 0], "out of the counts and the need-you badge too");
    assert.deepEqual(acts(digest([row(summary("s", { align: align(["al_3/q2", "al_3/q4"]) }))], file)), ["s:open-questions"], "a new question: back");
  });

  test("a dialog: a new dialog id brings it back; a user message or a look changes nothing", () => {
    const file = freshFile();
    const r = (ids: string[], over: Partial<SessionSummary> = {}) => row(summary("d", over), { dialogs: ids.map(() => "Pick"), dialogIds: ids });
    putAway(keysOf(digest([r(["x1"])], file), "d"), NOW, file);
    assert.deepEqual(acts(digest([r(["x1"], { seenAt: NOW, lastActiveAt: new Date(NOW).toISOString() })], file)), [], "seen, and a newer lastActiveAt: still hidden");
    assert.deepEqual(acts(digest([r(["x1", "x2"])], file)), ["d:needs-input"]);
  });

  test("an errored turn and a subagent error: a newer one brings it back", () => {
    const file = freshFile();
    const err = (at: number) => row(summary("e", { turnError: { message: "429" } }), { lastReplyAt: at });
    putAway(keysOf(digest([err(NOW - 9000)], file), "e"), NOW, file);
    assert.deepEqual(acts(digest([err(NOW - 9000)], file)), []);
    assert.deepEqual(acts(digest([err(NOW - 1000)], file)), ["e:error"], "a new errored turn");
    const w = (at: number) => row(summary("w"), { failedWorkers: 1, workerErrorAt: at });
    putAway(keysOf(digest([w(NOW - 5000)], file), "w"), NOW, file);
    assert.deepEqual(acts(digest([w(NOW - 5000)], file)), []);
    assert.deepEqual(acts(digest([w(NOW - 100)], file)), ["w:worker-error"], "a new subagent error");
  });

  test("the store survives a restart; undo brings an item back; a moved-on or month-old entry is dropped", () => {
    const file = freshFile();
    const r = row(summary("q", { align: align(["al_1/q1"]) }));
    const keys = keysOf(digest([r], file), "q");
    putAway(keys, NOW, file);
    resetLaterCache(); // a restart: only the file is left
    assert.deepEqual(acts(digest([r], file)), []);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).items["q:open-questions"].anchor[0], "qal_1/q1");
    assert.equal(bringBack(keys, file), 1);
    assert.deepEqual(acts(digest([r], file)), ["q:open-questions"]);
    putAway(keys, NOW, file);
    assert.deepEqual(acts(digest([r], file, NOW + LATER_MAX_AGE_MS + 1)), ["q:open-questions"], "older than 30 days: back");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).items, {});
    putAway(keys, NOW, file);
    digest([row(summary("q", { align: align(["al_1/q9"]) }))], file);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).items, {}, "the anchor moved on: the entry is gone for good");
  });

  test("keys: only our own shape is accepted", () => {
    const file = freshFile();
    assert.equal(putAway(["nope", 3, "", laterKey("a", "error", ["t1"])], NOW, file), 1);
    assert.equal(parseLaterKey(Buffer.from(JSON.stringify(["a", "error"])).toString("base64url")), null);
    assert.deepEqual(parseLaterKey(laterKey("a", "error", ["t1"])), { id: "a", kind: "error", anchor: ["t1"] });
  });

  test("a session item's key is the same across reads while nothing changes (the client's row identity)", () => {
    const r = row(summary("s", { align: align(["al_3/q1"]) }), { lastReplyAt: NOW - 1 });
    assert.equal(sessionItems(r, NOW)[0]!.later, sessionItems(r, NOW + 60_000)[0]!.later);
  });
});

describe("Later on the Organizations region's baton and roster rows", () => {
  type Baton = NonNullable<SessionSummary["baton"]>;
  const baton = (over: Partial<Baton>, at = NOW - 60_000) => row(summary("g", { lastActiveAt: new Date(at).toISOString(), baton: { holder: null, state: "needs-you", ...over } as Baton }));

  test("a person waiting on you: hidden until a new hand-off or a new message on it", () => {
    const file = freshFile();
    const waiting = (handoff: number, at?: number) => baton({ needsYou: { from: "Ann", question: "Which venue?", since: NOW - 90_000, handoff } }, at);
    putAway(keysOf(digest([waiting(2)], file), "g"), NOW, file);
    assert.deepEqual(acts(digest([waiting(2)], file)), []);
    assert.deepEqual(acts(digest([waiting(2, NOW - 1000)], file)), ["g:baton-needs-you"], "a new message on the same hand-off");
    putAway(keysOf(digest([waiting(2, NOW - 1000)], file), "g"), NOW, file);
    assert.deepEqual(acts(digest([waiting(3, NOW - 1000)], file)), ["g:baton-needs-you"], "a new hand-off");
  });

  test("send-link: anchored on the open offer, else the hand-off", () => {
    const file = freshFile();
    const send = (over: Partial<NonNullable<Baton["sendLink"]>>) => baton({ state: "open", sendLink: { to: "Bob", question: "Dates?", since: NOW - 90_000, handoff: 1, ...over } });
    putAway(keysOf(digest([send({ offerId: "of1" })], file), "g"), NOW, file);
    assert.deepEqual(acts(digest([send({ offerId: "of1" })], file)), []);
    assert.deepEqual(acts(digest([send({ offerId: "of2" })], file)), ["g:baton-needs-you"], "a new offer");
    assert.equal(parseLaterKey(keysOf(digest([send({})], file), "g")[0])?.anchor[0], "h1");
  });

  test("a roster proposal: its own key per proposed person, hidden until a new proposal", () => {
    const file = freshFile();
    const p = (id: string) => ({ personId: id, name: id, role: "", by: "Ann", since: NOW - 5000 });
    const r = (...ids: string[]) => baton({ state: "open", proposals: ids.map(p) });
    const first = digest([r("p1")], file);
    const keys = first.items.filter((i) => i.kind === "roster-proposal").map((i) => i.later!);
    assert.equal(keys.length, 1);
    putAway(keys, NOW, file);
    const both = digest([r("p1", "p2")], file);
    assert.deepEqual(both.items.filter((i) => i.kind === "roster-proposal").map((i) => i.detail), ["Approve p2 proposed by Ann?"], "p1 stays away; p2 is new");
    assert.deepEqual(digest([r("p1", "p2")], file).items.filter((i) => i.kind === "roster-proposal").length, 1, "p2 showing does not bring p1 back");
  });
});

describe("the session list's baton fields carry the same Later keys, and drop a put-away wait", () => {
  test("needsYou.later / sendLink.later / proposals[i].later equal the digest's; a put-away one leaves the row until it moves", () => {
    const file = freshFile();
    const lat = (items: { later: string }[]) => withoutLater(items, NOW, file);
    const s = summary("g", { baton: { holder: null, state: "needs-you", needsYou: { from: "Ann", question: "Venue?", since: NOW - 9000, handoff: 2 }, proposals: [{ personId: "p1", name: "Bo", role: "", by: "Ann", since: NOW - 5000 }] } as SessionSummary["baton"] });
    const listed = withBatonLater(s, lat);
    const d = digest([row(s)], file);
    assert.equal(listed.baton?.needsYou?.later, d.items.find((i) => i.kind === "baton-needs-you")?.later);
    assert.equal(listed.baton?.proposals?.[0]?.later, d.items.find((i) => i.kind === "roster-proposal")?.later);
    putAway([listed.baton!.needsYou!.later!], NOW, file);
    const after = withBatonLater(s, lat);
    assert.equal(after.baton?.needsYou, undefined, "put away: gone from the row");
    assert.equal(after.baton?.proposals?.length, 1, "the proposal is its own");
    assert.equal(after.baton?.state, "needs-you", "the rest of the field stays");
    const moved = withBatonLater({ ...s, lastActiveAt: new Date(NOW).toISOString() }, lat);
    assert.ok(moved.baton?.needsYou?.later, "a new message on the hand-off: back");
  });
});
