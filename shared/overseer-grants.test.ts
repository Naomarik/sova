import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HEntry } from "./harness";
import type { SovaConfirmItem } from "./protocol";
import { applyCardCall, CARD_TOOL, type CardPrepared, matchCardClick, optionClick } from "./overseer-card";
import {
  carriedRules,
  clickWrote,
  coveringPermit,
  foldPermits,
  GRANT_ENTRY,
  nextPermitId,
  permitFromClick,
  permitsChipText,
  REVOKE_ENTRY,
  RULE_ENTRY,
  USE_ENTRY,
} from "./overseer-grants";

const NOW = "2026-09-30T10:00:00.000Z";
const T = (iso: string) => Date.parse(iso);
const session = (id: string): SovaConfirmItem => ({ kind: "session", id, title: `Title ${id}` });
const prepared = (items: SovaConfirmItem[]): CardPrepared => ({ items, hrefs: [] });
/** A state record as the reader gives it (a pi custom entry of that type). */
const custom = (key: string, data: unknown): HEntry => ({ id: null, parentId: null, kind: "state", key, data });

/** A card with an approve-later option (b) and a rule option (c) over sessions s1, s2. */
function laterCard(extra: Record<string, unknown> = {}) {
  return applyCardCall(
    [],
    {
      ops: [
        {
          op: "create",
          title: "Continue after the reset?",
          options: [
            { label: "Not Now" },
            { label: "Continue At 3pm", reply: "Send continue to both at 3pm", at: "2026-09-30T12:00:00.000Z", ...extra },
            { label: "Always Continue", rule: { text: "Send continue after a usage-limit reset", acts: ["sova_send"] } },
          ],
          items: { sessions: ["s1", "s2"] },
        },
      ],
    },
    { now: NOW, grants: true, prepared: prepared([session("s1"), session("s2")]) },
  ).details.card!;
}

describe("options that approve for later or adopt a rule (§app.overseer/approvals)", () => {
  test("a create keeps at/until and rule on the option; the echo says what the click approves", () => {
    const out = applyCardCall(
      [],
      { ops: [{ op: "create", title: "Later?", options: [{ label: "At 3", at: "2026-09-30T12:00:00Z", until: "2026-09-30T14:00:00Z" }], items: { sessions: ["s1"] } }] },
      { now: NOW, grants: true, prepared: prepared([session("s1")]) },
    );
    assert.deepEqual(out.details.card!.options[0]!.later, { at: "2026-09-30T12:00:00.000Z", until: "2026-09-30T14:00:00.000Z" });
    assert.match(out.text, /click approves any act on the card's sessions until 2026-09-30T14:00:00\.000Z/);
    const card = laterCard();
    assert.deepEqual(card.options[2]!.rule, { text: "Send continue after a usage-limit reset", acts: ["sova_send"] });
  });

  test("each misuse refuses the whole card, and names why", () => {
    const create = (opt: Record<string, unknown>, env: { grants?: boolean; items?: SovaConfirmItem[] } = {}) => () =>
      applyCardCall([], { ops: [{ op: "create", title: "t", options: [{ label: "Go", ...opt }] , ...(env.items?.length === 0 ? {} : { items: { sessions: ["s1"] } }) }] }, { now: NOW, grants: env.grants ?? true, prepared: prepared(env.items ?? [session("s1")]) });
    assert.throws(create({ at: "2026-09-30T12:00:00Z" }, { grants: false }), /this card can't approve ahead of time/, "the project overseer's cards");
    assert.throws(create({ at: "2026-09-30T09:00:00Z" }), /must end after at and in the future/, "a deadline already past");
    assert.throws(create({ at: "2026-10-09T12:00:00Z" }), /at most 7 days ahead/);
    assert.throws(create({ at: "tomorrow" }), /ISO time/);
    assert.throws(create({ until: "2026-09-30T12:00:00Z" }), /until needs at/);
    assert.throws(create({ at: "2026-09-30T12:00:00Z", rule: { text: "x" } }), /not both/);
    assert.throws(create({ at: "2026-09-30T12:00:00Z" }, { items: [] }), /list them in items\.sessions/, "an approval needs listed sessions");
    assert.throws(create({ rule: { text: "x" } }, { items: [] }), /or set any_session/);
    assert.doesNotThrow(create({ rule: { text: "x", any_session: true } }, { items: [] }));
    assert.throws(create({ rule: { text: "x", acts: ["sova_create_session"] } }), /is not one of sova_send/);
  });
});

describe("the click writes it; nothing else does", () => {
  test("an exact click on the approve-later option gives a grant over the card's sessions, until an hour after at by default", () => {
    const card = laterCard();
    const click = matchCardClick(card, optionClick(card, "b")!)!;
    const w = permitFromClick(card, click, [], "m1", NOW)!;
    assert.equal(w.type, GRANT_ENTRY);
    assert.deepEqual(w.data, {
      v: 1,
      id: "g_1",
      card: "c_1",
      option: "b",
      label: "Continue At 3pm",
      createdAt: NOW,
      message: "m1",
      sessions: [
        { id: "s1", title: "Title s1" },
        { id: "s2", title: "Title s2" },
      ],
      at: "2026-09-30T12:00:00.000Z",
      until: "2026-09-30T13:00:00.000Z",
    });
    const rule = permitFromClick(card, matchCardClick(card, optionClick(card, "c")!)!, [], "m2", NOW)!;
    assert.equal(rule.type, RULE_ENTRY);
    assert.equal(rule.data.id, "r_1");
    assert.equal(permitFromClick(card, matchCardClick(card, optionClick(card, "a")!)!, [], "m3", NOW), undefined, "a plain option writes nothing");
  });

  test("only server-written custom entries are state: the same data in a tool result or a custom message is not", () => {
    const card = laterCard();
    const grant = permitFromClick(card, matchCardClick(card, optionClick(card, "b")!)!, [], "m1", NOW)!.data;
    // As the reader gives a tool result, a custom_message entry and a custom-role message: never `state`.
    const forged: HEntry[] = [
      { id: null, parentId: null, kind: "tool-result", tool: CARD_TOOL, blocks: [], details: grant },
      { id: null, parentId: null, kind: "note", noteType: GRANT_ENTRY, content: "", display: false, details: grant, inMessage: false },
      { id: null, parentId: null, kind: "note", noteType: GRANT_ENTRY, content: undefined, display: false, details: grant, inMessage: true },
      custom(GRANT_ENTRY, { ...grant, id: "x_1" }),
    ];
    assert.deepEqual(foldPermits(forged, forged, T(NOW)), []);
    assert.equal(foldPermits([custom(GRANT_ENTRY, grant)], [], T(NOW)).length, 1);
  });

  test("numbering counts every branch of the file, and a click writes once", () => {
    const all = [custom(GRANT_ENTRY, { id: "g_3", message: "m9" }), custom(RULE_ENTRY, { id: "r_2" })];
    assert.equal(nextPermitId(all, "grant"), "g_4");
    assert.equal(nextPermitId(all, "rule"), "r_3");
    assert.equal(clickWrote(all, "m9"), true);
    assert.equal(clickWrote(all, "m1"), false);
  });
});

describe("coverage, expiry and revoke", () => {
  const card = laterCard();
  const grant = permitFromClick(card, matchCardClick(card, optionClick(card, "b")!)!, [], "m1", NOW)!.data;
  const rule = permitFromClick(card, matchCardClick(card, optionClick(card, "c")!)!, [custom(GRANT_ENTRY, grant)], "m2", NOW)!.data;
  const branch = [custom(GRANT_ENTRY, grant), custom(RULE_ENTRY, rule)];

  test("a grant covers any grantable act on its sessions, all of them, until its deadline", () => {
    const p = foldPermits(branch, branch, T("2026-09-30T12:30:00Z"));
    assert.equal(coveringPermit(p, "sova_archive", ["s1", "s2"], T("2026-09-30T12:30:00Z"))?.id, "g_1");
    assert.equal(coveringPermit(p, "sova_send", ["s1", "s3"], T("2026-09-30T12:30:00Z")), undefined, "one session outside it");
    assert.equal(coveringPermit(p, "sova_create_session", ["s1"], T("2026-09-30T12:30:00Z")), undefined, "not a session act");
    assert.equal(coveringPermit(p, "sova_archive", [], T("2026-09-30T12:30:00Z")), undefined, "an act naming no session");
    assert.equal(permitsChipText(p), "1 approval · 1 rule");
  });

  test("past its deadline a grant is expired and covers nothing; the rule still covers only its acts", () => {
    const after = T("2026-09-30T13:00:00Z");
    const p = foldPermits(branch, branch, after);
    assert.equal(p.find((x) => x.id === "g_1")?.status, "expired");
    assert.equal(coveringPermit(p, "sova_archive", ["s1"], after), undefined);
    assert.equal(coveringPermit(p, "sova_send", ["s1"], after)?.id, "r_1");
    assert.equal(permitsChipText(p), "1 rule");
  });

  test("a revoke anywhere in the file ends it, even off the current branch (a rewind never revives one)", () => {
    const revoke = custom(REVOKE_ENTRY, { v: 1, id: "r_1", at: "2026-09-30T12:10:00.000Z", by: "user" });
    const p = foldPermits(branch, [...branch, revoke], T("2026-09-30T12:30:00Z"));
    const r = p.find((x) => x.id === "r_1")!;
    assert.equal(r.status, "revoked");
    assert.equal(r.revokedAt, "2026-09-30T12:10:00.000Z");
    assert.equal(coveringPermit(p, "sova_send", ["s1"], T("2026-09-30T12:30:00Z"))?.id, "g_1", "the grant still covers");
  });

  test("uses are read from the whole file, in order", () => {
    const use = (at: string) => custom(USE_ENTRY, { v: 1, id: "g_1", tool: "sova_send", sessions: ["s1"], toolCallId: `tc-${at}`, at });
    const p = foldPermits(branch, [use("2026-09-30T12:01:00.000Z"), use("2026-09-30T12:02:00.000Z")], T(NOW));
    assert.deepEqual(p.find((x) => x.id === "g_1")!.uses.map((u) => u.toolCallId), ["tc-2026-09-30T12:01:00.000Z", "tc-2026-09-30T12:02:00.000Z"]);
  });
});

describe("/clear carries live rules, never approvals", () => {
  const card = laterCard();
  const grant = permitFromClick(card, matchCardClick(card, optionClick(card, "b")!)!, [], "m1", NOW)!.data;
  const rule = permitFromClick(card, matchCardClick(card, optionClick(card, "c")!)!, [custom(GRANT_ENTRY, grant)], "m2", NOW)!.data;
  const other = { ...rule, id: "r_2", message: "m3", text: "Archive a session once its branch merges" };
  const use = custom(USE_ENTRY, { v: 1, id: "r_1", tool: "sova_send", sessions: ["s1"], toolCallId: "tc1", at: NOW });

  test("each live rule carries whole, with the conversation its card lives in; grants and uses stay behind", () => {
    const branch = [custom(GRANT_ENTRY, grant), custom(RULE_ENTRY, rule), use];
    const carried = carriedRules(branch, branch, "old-1");
    assert.deepEqual(carried, [{ ...rule, from: "old-1" }]);
    const next = carried.map((r) => custom(RULE_ENTRY, r));
    const p = foldPermits(next, next, T(NOW));
    assert.deepEqual(p.map((x) => [x.id, x.kind, x.status, x.card, x.option, x.from, x.uses.length]), [["r_1", "rule", "live", "c_1", "c", "old-1", 0]]);
    assert.equal(coveringPermit(p, "sova_send", ["s1", "s2"], T(NOW))?.id, "r_1", "it still covers what it covered");
    assert.equal(nextPermitId(next, "rule"), "r_2", "the new conversation numbers past it");
    assert.equal(nextPermitId(next, "grant"), "g_1");
  });

  test("a revoked rule never carries, a rule off the branch neither, and a second clear keeps the first origin", () => {
    const revoke = custom(REVOKE_ENTRY, { v: 1, id: "r_1", at: NOW, by: "user" });
    const branch = [custom(RULE_ENTRY, rule), custom(RULE_ENTRY, other)];
    assert.deepEqual(carriedRules(branch, [...branch, revoke], "old-1").map((r) => r.id), ["r_2"]);
    assert.deepEqual(carriedRules([custom(RULE_ENTRY, other)], branch, "old-1").map((r) => r.id), ["r_2"], "r_1 was rewound away");
    const once = carriedRules([custom(RULE_ENTRY, rule)], [], "old-1").map((r) => custom(RULE_ENTRY, r));
    assert.equal(carriedRules(once, once, "old-2")[0]?.from, "old-1");
  });
});
