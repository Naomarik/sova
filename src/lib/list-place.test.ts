// Run: pnpm test -- src/lib/list-place.test.ts
// The list place's declaration (§app.extensions/list-place): what a good answer keeps, what a bad
// one loses, and how a row is read by it: its owner only through the key the local declaration
// names, on any host's row; the person menu's choice and the caller lookup.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  effectivePersonFilter,
  labelPairs,
  LIST_PEOPLE_MAX,
  listExtensions,
  OWNER_HOPS_MAX,
  ownerOf,
  parentLookup,
  passesPersonFilter,
  personOfCaller,
  sameDeclaration,
  validateListAnswer,
  validPerson,
  type ListDeclaration,
} from "./list-place";
import * as mesh from "./mesh";
type SessionSummary = import("../../shared/protocol").SessionSummary;

const ext = { id: "team-bar", title: "Team bar" };
const kim = { id: "kim", name: "Kim Ortega", initials: "KO", callers: ["operator"] };
const lee = { id: "lee", name: "Lee Varga", initials: "lv", callers: ["peer:node-lee"] };
const good = { people: [kim, lee], ownerKey: "owner", self: "kim" };
const decl = validateListAnswer(good, ext).answer!;
const row = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: "s-1", path: "/state/sessions/a.jsonl", cwd: "/w", title: "T", createdAt: "", lastActiveAt: "", model: null, ...over }) as SessionSummary;

describe("an answer", () => {
  test("a good one: the people, the owner key under the declaring extension, you", () => {
    const v = validateListAnswer(good, ext);
    assert.equal(v.bad, false);
    assert.equal(v.malformed, false);
    assert.deepEqual(v.answer, {
      extension: "team-bar",
      extensionTitle: "Team bar",
      ownerExt: "team-bar",
      ownerKey: "owner",
      self: "kim",
      people: [kim, { ...lee, initials: "LV" }],
    });
    assert.equal(validateListAnswer({ ...good, ownerExt: "team-bar-host" }, ext).answer?.ownerExt, "team-bar-host");
    assert.equal(validateListAnswer({ people: [kim], ownerKey: "owner" }, ext).answer?.self, undefined);
  });

  test("a bad person is dropped alone, and the answer counts as bad", () => {
    for (const p of [
      { ...kim, id: "has space" },
      { ...kim, initials: "K" },
      { ...kim, initials: "KOR" },
      { ...kim, initials: "K!" },
      { ...kim, name: "" },
      { ...kim, name: "<b>Kim</b>" },
      { ...kim, name: "x".repeat(41) },
      { ...kim, callers: "operator" },
      { ...kim, callers: Array.from({ length: 9 }, (_, i) => `peer:${i}`) },
      { ...kim, callers: ["has space"] },
      "kim",
      null,
    ]) {
      assert.equal(validPerson(p), null, JSON.stringify(p));
      const v = validateListAnswer({ people: [p, lee], ownerKey: "owner" }, ext);
      assert.equal(v.bad, true);
      assert.deepEqual(v.answer?.people.map((x) => x.id), ["lee"]);
    }
    const twice = validateListAnswer({ people: [lee, { ...lee, name: "Other" }], ownerKey: "owner" }, ext);
    assert.equal(twice.bad, true);
    assert.equal(twice.answer?.people.length, 1, "a repeated id keeps the first");
    const many = validateListAnswer({ people: Array.from({ length: LIST_PEOPLE_MAX + 5 }, (_, i) => ({ ...kim, id: `p${i}` })), ownerKey: "owner" }, ext);
    assert.equal(many.bad, true);
    assert.equal(many.answer?.people.length, LIST_PEOPLE_MAX);
  });

  test("a bad owner key, owner extension or self, or no person, drops it whole", () => {
    for (const raw of [
      undefined,
      [],
      "x",
      { ...good, ownerKey: undefined },
      { ...good, ownerKey: "Owner" },
      { ...good, ownerKey: "team-bar:owner" },
      { ...good, ownerExt: "../x" },
      { ...good, ownerExt: 3 },
      { ...good, self: "nobody" },
      { ...good, people: [] },
      { ...good, people: "kim" },
      { ...good, people: [{ id: "x" }] },
    ]) {
      const v = validateListAnswer(raw, ext);
      assert.equal(v.malformed, true, JSON.stringify(raw));
      assert.equal(v.answer, null);
    }
  });

  test("null (a 204) declares nothing, and is no fault", () => {
    assert.deepEqual(validateListAnswer(null, ext), { answer: null, bad: false, malformed: false });
  });

  test("only running extensions whose offers name the list place are asked", () => {
    assert.deepEqual(
      listExtensions([
        { id: "a", title: "A", status: "ok", offers: { screens: ["row"] } },
        { id: "b", title: "B", status: "ok", offers: { screens: ["list"] } },
        { id: "c", title: "C", status: "down", offers: { screens: ["list"] } },
        { id: "d", title: "D", status: "ok" },
      ]),
      [{ id: "b", title: "B" }],
    );
    assert.deepEqual(listExtensions(undefined), []);
  });

  test("the same declaration twice is the same: a re-ask that changes nothing redraws nothing", () => {
    assert.ok(sameDeclaration(decl, validateListAnswer(good, ext).answer));
    assert.ok(!sameDeclaration(decl, validateListAnswer({ ...good, self: "lee" }, ext).answer));
    assert.ok(!sameDeclaration(decl, validateListAnswer({ ...good, people: [kim, { ...lee, callers: [] }] }, ext).answer));
    assert.ok(sameDeclaration(null, null));
    assert.ok(!sameDeclaration(decl, null));
  });
});

describe("a row, read by the declaration", () => {
  test("its owner is the label under the declaration's own extension and key, on any host's row", () => {
    assert.equal(ownerOf(decl, row({ labels: { "team-bar": { owner: "lee" } } }))?.name, "Lee Varga");
    assert.equal(ownerOf(decl, row({ path: "/peer/sessions/r.jsonl", labels: { "team-bar": { owner: "kim" } } }))?.id, "kim");
    // Any other extension's labels, or any other key, are never read as the owner.
    assert.equal(ownerOf(decl, row({ labels: { other: { owner: "lee" } } })), undefined);
    assert.equal(ownerOf(decl, row({ labels: { "team-bar": { team: "lee" } } })), undefined);
    // A person the declaration doesn't name has no mark.
    assert.equal(ownerOf(decl, row({ labels: { "team-bar": { owner: "zed" } } })), undefined);
    assert.equal(ownerOf(decl, row()), undefined);
    assert.equal(ownerOf(null, row({ labels: { "team-bar": { owner: "lee" } } })), undefined, "no declaration: nothing read");
  });

  test("a helper chat follows the chat that started it: its parent's owner is its owner", () => {
    const parent = row({ id: "p-1", path: "/state/sessions/p.jsonl", labels: { "team-bar": { owner: "kim" } } });
    const helper = row({ id: "h-1", path: "/state/sessions/h.jsonl", workerSession: true, workerOf: { id: "p-1", path: "/state/sessions/p.jsonl" } });
    const up = parentLookup([parent, helper]);
    assert.equal(passesPersonFilter(decl, "kim", helper, up), true);
    assert.equal(passesPersonFilter(decl, "lee", helper, up), false);
    assert.equal(ownerOf(decl, helper, up)?.name, "Kim Ortega");
    // Its own label, when it has one, wins.
    const own = row({ ...helper, labels: { "team-bar": { owner: "lee" } } });
    assert.equal(ownerOf(decl, own, parentLookup([parent, own]))?.id, "lee");
    // A helper of a helper climbs on, within the bound.
    const deep = row({ id: "h-2", path: "/state/sessions/h2.jsonl", workerSession: true, workerOf: { id: "h-1", path: "/state/sessions/h.jsonl" } });
    assert.equal(ownerOf(decl, deep, parentLookup([parent, helper, deep]))?.id, "kim");
  });

  test("a helper chat whose parent the page doesn't hold stays unowned; a loop or a long chain ends", () => {
    const helper = row({ id: "h-1", workerSession: true, workerOf: { id: "gone", path: "/state/sessions/gone.jsonl" } });
    const up = parentLookup([helper]);
    assert.equal(ownerOf(decl, helper, up), undefined);
    assert.equal(passesPersonFilter(decl, "kim", helper, up), false);
    assert.equal(ownerOf(decl, helper), undefined, "no lookup: its own labels only");
    // A parent on another host is not this host's chat of the same id.
    const parent = row({ id: "p-1", path: "/peer/sessions/p.jsonl", labels: { "team-bar": { owner: "kim" } } });
    const local = row({ id: "h-3", workerSession: true, workerOf: { id: "p-1", path: "/state/sessions/p.jsonl" } });
    mesh.noteHost("/peer/sessions/p.jsonl", "peer-1");
    assert.equal(ownerOf(decl, local, parentLookup([parent, local])), undefined);
    // Two helpers naming each other: the walk stops.
    const a = row({ id: "a", workerSession: true, workerOf: { id: "b", path: "" } });
    const b = row({ id: "b", workerSession: true, workerOf: { id: "a", path: "" } });
    assert.equal(ownerOf(decl, a, parentLookup([a, b])), undefined);
    // A chain longer than OWNER_HOPS_MAX parents is cut.
    const chain = Array.from({ length: OWNER_HOPS_MAX + 2 }, (_, i) =>
      row({ id: `c${i}`, ...(i === 0 ? { labels: { "team-bar": { owner: "kim" } } } : { workerSession: true as const, workerOf: { id: `c${i - 1}`, path: "" } }) }),
    );
    const chainUp = parentLookup(chain);
    assert.equal(ownerOf(decl, chain[OWNER_HOPS_MAX]!, chainUp)?.id, "kim", "exactly the bound: found");
    assert.equal(ownerOf(decl, chain[OWNER_HOPS_MAX + 1]!, chainUp), undefined, "past it: unowned");
  });

  test("the person menu: Everyone first, a choice only while the declaration names that person", () => {
    assert.equal(effectivePersonFilter(null, decl), null);
    assert.equal(effectivePersonFilter("lee", decl), "lee");
    assert.equal(effectivePersonFilter("zed", decl), null);
    assert.equal(effectivePersonFilter("lee", null), null);
    const lees = row({ labels: { "team-bar": { owner: "lee" } } });
    assert.equal(passesPersonFilter(decl, "lee", lees), true);
    assert.equal(passesPersonFilter(decl, "kim", lees), false);
    assert.equal(passesPersonFilter(decl, "kim", row()), false, "an unowned chat is no one's");
    assert.equal(passesPersonFilter(decl, null, row()), true, "Everyone keeps every row");
  });

  test("a caller is a person by exact match on their callers", () => {
    assert.equal(personOfCaller(decl, "peer:node-lee")?.id, "lee");
    assert.equal(personOfCaller(decl, "operator")?.id, "kim");
    assert.equal(personOfCaller(decl, "peer:node-le"), undefined);
    assert.equal(personOfCaller(null, "operator"), undefined);
  });

  test("the labels the page reads: the owner key's one pair, or none", () => {
    assert.equal(labelPairs(decl), "team-bar:owner");
    assert.equal(labelPairs(validateListAnswer({ ...good, ownerExt: "host" }, ext).answer), "host:owner");
    assert.equal(labelPairs(null), null);
  });
});

const _typed: ListDeclaration = decl;
void _typed;
