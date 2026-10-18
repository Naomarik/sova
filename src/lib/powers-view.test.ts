import assert from "node:assert/strict";
import { test } from "node:test";
import { ALWAYS_PHRASES, POWER_INFO, POWERS, powersView, readStoredPowers, type PowerMap } from "../../shared/powers";
import { alwaysLine, assistantGroups, cellState, columnsFor, expandName, nextOn, onCount, powerGroups, powersButtonName, powersNote, powersPatch, stateChip, switchDone, switchName } from "./powers-view";

const off = (): PowerMap => Object.fromEntries(POWERS.map((p) => [p, false])) as PowerMap;
const models = { overseer: {}, assistant: {}, assistantSource: { reply: "org" as const, coding: "org" as const, gathering: "org" as const } };
const view = (placed: boolean) => powersView(readStoredPowers({ autonomy: "L1" }, () => "t"), null, placed, models);
const with_ = (...on: string[]): PowerMap => ({ ...off(), ...Object.fromEntries(on.map((p) => [p, true])) });

test("every power is in exactly one shown group, in the server's order; a standalone project shows no organization's act and no assistant column", () => {
  const placed = powerGroups(view(true));
  assert.deepEqual(placed.flatMap((g) => g.acts.map((a) => a.id)), [...POWERS], "each power once, nothing invented");
  assert.deepEqual(placed.map((g) => g.label), ["People", "Spec", "Code", "Running copies", "Release"]);
  const alone = powerGroups(view(false));
  assert.ok(!alone.some((g) => g.id === "people"), "People is all organization's: the group goes");
  for (const p of POWERS) assert.equal(alone.some((g) => g.acts.some((a) => a.id === p)), !POWER_INFO[p].placedOnly, p);
  assert.deepEqual(columnsFor(view(false)), ["overseer"]);
  assert.deepEqual(columnsFor(view(true)), ["overseer", "assistant"]);
});

test("a cell is On or Off only when every act it can set agrees; the assistant's cell skips acts it can't set, and is '—' with none", () => {
  const people = powerGroups(view(true)).find((g) => g.id === "people")!;
  assert.equal(cellState(people.acts, with_("gather", "whatsapp", "ownerUpdates", "roster"), "overseer"), "on");
  assert.equal(cellState(people.acts, with_("gather"), "overseer"), "mixed");
  assert.equal(cellState(people.acts, off(), "overseer"), "off");
  // Only `gather` is the assistant's in People: on it alone, the group reads On.
  assert.equal(cellState(people.acts, with_("gather"), "assistant"), "on");
  const whatsapp = people.acts.filter((a) => a.id === "whatsapp");
  assert.equal(cellState(whatsapp, with_("whatsapp"), "assistant"), "none");
});

test("a switch: Mixed and Off turn all on, On all off; the PATCH names only the acts its column can set", () => {
  assert.equal(nextOn("mixed"), true);
  assert.equal(nextOn("off"), true);
  assert.equal(nextOn("on"), false);
  const people = powerGroups(view(true)).find((g) => g.id === "people")!;
  assert.deepEqual(powersPatch(people.acts, "assistant", true), { powers: { assistant: { gather: true } } });
  assert.deepEqual(Object.keys(powersPatch(people.acts, "overseer", false).powers.overseer!), ["gather", "whatsapp", "ownerUpdates", "roster"]);
});

test("names: each switch names its row and its column, so no two share a name", () => {
  const groups = powerGroups(view(true));
  const names = groups.flatMap((g) => [g.label, ...g.acts.map((a) => a.label)]).flatMap((l) => columnsFor(view(true)).map((c) => switchName(l, c)));
  assert.equal(new Set(names).size, names.length);
  assert.equal(switchName("People", "overseer"), "People, on its own");
  assert.equal(switchDone("People", "assistant", true, true), "People, from a client: all on.");
  assert.equal(switchDone("Deploy", "overseer", false, false), "Deploy, on its own: off.");
  assert.equal(expandName({ label: "Code", acts: [{ id: "codingStart", label: "", assistant: true }] }, true), "Hide the 1 act in Code");
});

test("the head button counts each shown column over what it can set, and says a brake once, with one full stop", () => {
  const groups = powerGroups(view(true));
  const assistantActs = POWERS.filter((p) => POWER_INFO[p].assistant).length;
  assert.deepEqual(onCount(groups, with_("gather", "whatsapp"), "assistant"), { on: 1, of: assistantActs });
  const m = { overseer: with_("gather"), assistant: off() };
  assert.equal(powersButtonName(groups, m, ["overseer", "assistant"], null), `What may happen without you: on its own 1 of ${POWERS.length} on, from a client 0 of ${assistantActs} on. Change.`);
  assert.match(powersButtonName(groups, m, ["overseer"], { kind: "empty-roster", reason: "The roster has no active people yet." }), /on\. Paused: The roster has no active people yet\. Change\.$/);
});

test("always line: one sentence with a serial comma; the overseer's list says no level", () => {
  assert.equal(alwaysLine(["Answer questions", "keep notes.", "stop a copy"]), "Always allowed: answer questions, keep notes, and stop a copy.");
  assert.equal(alwaysLine(["a", "b"]), "Always allowed: a and b.");
  assert.equal(alwaysLine([]), "");
  assert.doesNotMatch(alwaysLine(ALWAYS_PHRASES), /L[0-3]|approv/i);
});

test("the head chip: Working wins, Paused carries the brake's reason, nothing otherwise; never a level", () => {
  assert.deepEqual(stateChip(true, { kind: "paused", reason: "x" }), { tone: "accent", text: "Working" });
  assert.deepEqual(stateChip(false, { kind: "paused", reason: "Attached here 2h ago." }), { tone: "warn", text: "Paused", title: "Attached here 2h ago." });
  assert.equal(stateChip(false, null), null);
});

test("the one-time note: shown only while unseen; the carry-over states the loosening (q2), never 'nothing changed'", () => {
  assert.equal(powersNote(null), null);
  assert.equal(powersNote({ kind: "carried-over", from: "L1", at: "", seen: true }), null);
  const n = powersNote({ kind: "carried-over", from: "L1", at: "", seen: false })!;
  assert.equal(n.title, "Levels are now switches.");
  assert.match(n.body, /level L1/);
  assert.match(n.body, /no longer approves its own waiting acts/);
  assert.doesNotMatch(n.body, /nothing changed|nothing changes/i);
  assert.match(powersNote({ kind: "rederived", from: "L3", at: "", seen: false })!.body, /older Sova/);
});

test("the assistant's own list (owner page card): only acts it can ever set, groups with none left out", () => {
  const g = assistantGroups(view(true));
  const acts = g.flatMap((x) => x.acts.map((a) => a.id));
  assert.deepEqual(acts, POWERS.filter((p) => POWER_INFO[p].assistant));
  assert.ok(!g.some((x) => x.id === "spec"), "Spec has no assistant act");
  for (const x of g) assert.notEqual(cellState(x.acts, off(), "assistant"), "none");
});
