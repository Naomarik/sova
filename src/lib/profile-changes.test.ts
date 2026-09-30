import assert from "node:assert/strict";
import { test } from "node:test";
import type { NamedChange } from "../../shared/orgs";
import { groupChanges, revertible, valueText, writerWord } from "./profile-changes";

const ch = (at: string, personId: string, field: NamedChange["field"], to: unknown, kind: NamedChange["by"]["kind"] = "operator", extra: Partial<NamedChange> = {}): NamedChange => ({
  at,
  personId,
  name: personId === "p_1" ? "Bob" : "Tony",
  field,
  from: null,
  to,
  by: { kind },
  ...extra,
});

test("values read as words", () => {
  assert.equal(valueText("contact", { email: "b@x.io", phone: "" }), "email b@x.io");
  assert.equal(valueText("referral", { why: "Runs the bank portal.", referredBy: "p_2" }), "Runs the bank portal.");
  assert.equal(valueText("competence", { SQL: { level: 3, n: 1 } }), "SQL 3/5");
  assert.equal(valueText("skills", []), "—");
  assert.equal(valueText("decides", ["invoicing", "bank"]), "invoicing, bank");
  assert.equal(valueText("voice", null), "—");
});

test("one act is one group; another person, writer or a gap starts a new one", () => {
  const feed = [
    ch("2026-09-26T10:00:03.000Z", "p_1", "status", "active"),
    ch("2026-09-26T09:50:02.002Z", "p_1", "role", "IT", "referral", { by: { kind: "referral", sessionId: "s1" } }),
    ch("2026-09-26T09:50:02.001Z", "p_1", "status", "proposed", "referral", { by: { kind: "referral", sessionId: "s1" } }),
    ch("2026-09-26T09:50:02.000Z", "p_1", "name", "Bob", "referral", { by: { kind: "referral", sessionId: "s1" } }),
    ch("2026-09-26T09:40:00.000Z", "p_2", "voice", "Brief.", "wrapup"),
    ch("2026-09-26T09:30:00.000Z", "p_2", "skills", ["SQL"], "wrapup"),
  ];
  const g = groupChanges(feed);
  assert.deepEqual(g.map((x) => [x.name, x.by.kind, x.changes.length, x.added]), [
    ["Bob", "operator", 1, false],
    ["Bob", "referral", 3, true],
    ["Tony", "wrapup", 1, false],
    ["Tony", "wrapup", 1, false],
  ]);
});

test("a revert is never folded into the act it undoes", () => {
  const g = groupChanges([ch("2026-09-26T10:00:00.500Z", "p_2", "voice", "Old.", "operator", { revertOf: "x" }), ch("2026-09-26T10:00:00.000Z", "p_2", "role", "Eng")]);
  assert.equal(g.length, 2);
});

test("the creating name line and undone changes can't be reverted; the rest can", () => {
  const undone = new Set(["b"]);
  assert.equal(revertible({ field: "name", from: null, at: "a" }, undone), false);
  assert.equal(revertible({ field: "name", from: "Bobby", at: "c" }, undone), true);
  assert.equal(revertible({ field: "voice", from: null, at: "b" }, undone), false);
  assert.equal(revertible({ field: "voice", from: null, at: "d" }, undone), true);
});

test("the writer word: you, via the Overseer, only for the operator's change made through it (§app.overseer/org-attribution)", () => {
  assert.equal(writerWord({ kind: "operator" }), "you");
  assert.equal(writerWord({ kind: "operator", via: "overseer" }), "you, via the Overseer");
  assert.equal(writerWord({ kind: "overseer" }), "overseer");
  assert.equal(writerWord({ kind: "wrapup" }), "wrap-up");
  const via = { kind: "operator" as const, via: "overseer" as const };
  const groups = groupChanges([ch("2026-09-28T10:00:01.000Z", "p1", "role", "a", "operator", { by: via }), ch("2026-09-28T10:00:00.000Z", "p1", "skills", ["b"], "operator")]);
  assert.equal(groups.length, 2, "the user's own change and one via the Overseer are separate acts");
});

test("valueText: working hours read as the Hours row does; a zone as itself; cleared as a dash (r7)", async () => {
  const { valueText } = await import("./profile-changes");
  assert.equal(valueText("hours", { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" }), "Mon–Fri 09:00–17:00");
  assert.equal(valueText("hours", null), "—");
  assert.equal(valueText("tz", "Europe/Istanbul"), "Europe/Istanbul");
  assert.equal(valueText("tz", ""), "—");
});
