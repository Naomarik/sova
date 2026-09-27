import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionRow } from "../../shared/decisions";
import { alsoCarriesLine, areaGroups, conflictSides, decisionsLine, emptySelection, keepPromotable, outsideTheirArea, promotable, refName, refreshSelection, selectAllReady, toggleSelection } from "./decisions-view";

const row = (id: string, areaKey: string, state: DecisionRow["state"], area = areaKey): DecisionRow => ({
  id,
  orgId: "org_1",
  projectId: "prj_1",
  area,
  areaKey,
  statement: `s ${id}`,
  quote: `q ${id}`,
  by: "p_1",
  name: "Tony",
  at: "2026-09-26T10:00:00Z",
  sessionId: "s1",
  entryId: "e1",
  markerId: id,
  authorOwnsArea: true,
  sessionPath: null,
  state,
});

test("only drafted decisions are promotable", () => {
  const all: DecisionRow["state"][] = ["pending", "drafted", "conflict", "promoted", "superseded"];
  assert.deepEqual(all.filter((s) => promotable({ state: s })), ["drafted"]);
});

test("areas keep the order of their newest decision; superseded rows only on request", () => {
  const rows = [row("1", "invoicing", "drafted", "Invoicing"), row("2", "bank", "pending"), row("3", "invoicing", "superseded"), row("4", "bank", "superseded")];
  const g = areaGroups(rows, { superseded: false });
  assert.deepEqual(g.map((x) => [x.areaKey, x.decisions.map((d) => d.id)]), [["invoicing", ["1"]], ["bank", ["2"]]]);
  assert.equal(g[0]!.area, "Invoicing");
  const all = areaGroups(rows, { superseded: true });
  assert.deepEqual(all.map((x) => x.decisions.map((d) => d.id)), [["1", "3"], ["2", "4"]]);
});

test("an area with only superseded decisions disappears when they're hidden", () => {
  assert.deepEqual(areaGroups([row("1", "a", "superseded")], { superseded: false }), []);
});

test("a refresh drops selected ids that are no longer promotable or no longer listed", () => {
  const kept = keepPromotable(new Set(["1", "2", "gone"]), [row("1", "a", "drafted"), row("2", "a", "promoted")]);
  assert.deepEqual([...kept], ["1"]);
});

test("conflict sides resolve by id; a missing side is null, never another row", () => {
  const info = { decisions: [row("1", "a", "conflict"), row("2", "a", "conflict")] };
  assert.equal(conflictSides(info, { a: "1", b: "2" }).b?.id, "2");
  assert.equal(conflictSides(info, { a: "1", b: "9" }).b, null);
});

test("the summary line counts live decisions, open conflicts and promotable ones", () => {
  const info = {
    decisions: [row("1", "a", "drafted"), row("2", "a", "superseded"), row("3", "b", "conflict")],
    conflicts: [
      { state: "open" },
      { state: "resolved" },
    ] as never,
  };
  assert.equal(decisionsLine(info), "2 decisions · 1 conflict open · 1 ready to promote");
  assert.equal(decisionsLine({ decisions: [], conflicts: [] }), "0 decisions · none ready to promote");
});

test("the operator is 'you'; an unknown ref shows as itself", () => {
  assert.equal(refName({ p_1: "Tony" }, "operator"), "you");
  assert.equal(refName({ p_1: "Tony" }, "p_1"), "Tony");
  assert.equal(refName({}, "p_9"), "p_9");
});

const own = (id: string, state: DecisionRow["state"], authorOwnsArea = true) => ({ ...row(id, "a", state), authorOwnsArea });

test("Select All Ready takes promotable decisions whose author decides the area, and says it was bulk", () => {
  const ds = [own("1", "drafted", true), own("2", "drafted", false), own("3", "pending", true), own("4", "drafted", true)];
  const sel = selectAllReady(ds);
  assert.deepEqual([...sel.ids], ["1", "4"], "outside-their-area (2) and not-ready (3) stay out");
  assert.equal(sel.bulk, true);
  assert.equal(outsideTheirArea(ds[1]!), true);
  assert.equal(outsideTheirArea(ds[0]!), false);
});

test("any tick or untick by hand makes the selection explicit, including adding an outside-area one", () => {
  const ds = [own("1", "drafted", true), own("2", "drafted", false)];
  const added = toggleSelection(selectAllReady(ds), "2", true);
  assert.deepEqual([...added.ids].sort(), ["1", "2"]);
  assert.equal(added.bulk, false);
  const removed = toggleSelection(selectAllReady(ds), "1", false);
  assert.equal(removed.bulk, false, "even narrowing a bulk pick is a hand pick");
  assert.equal(toggleSelection(emptySelection(), "1", true).bulk, false);
});

test("a refresh keeps how the selection was made and drops what stopped being promotable", () => {
  const sel = selectAllReady([own("1", "drafted", true), own("4", "drafted", true)]);
  const after = refreshSelection(sel, [own("1", "promoted", true), own("4", "drafted", true)]);
  assert.deepEqual([...after.ids], ["4"]);
  assert.equal(after.bulk, true);
});

test("Also carries: every statement folded in, through a fold of a fold, earlier or later, each once", () => {
  const a = { ...row("a", "lunch", "drafted"), folded: ["b"] };
  const b = { ...row("b", "lunch", "superseded"), folded: ["c", "a"] };
  const c = { ...row("c", "lunch", "superseded"), folded: ["b"] };
  const byId = new Map([a, b, c].map((d) => [d.id, d]));
  assert.equal(alsoCarriesLine(a, byId), "Also carries 2 more statements of the same decision, with their quotes.");
  assert.equal(alsoCarriesLine(b, byId), "Also carries 2 more statements of the same decision, with their quotes.", "a cycle back counts nothing twice, nor itself");
  assert.equal(alsoCarriesLine({ ...a, folded: ["c"] }, byId), "Also carries 2 more statements of the same decision, with their quotes.");
  assert.equal(alsoCarriesLine({ ...a, folded: ["gone"] }, byId), null);
  const one = { ...row("x", "lunch", "drafted"), folded: ["y"] };
  assert.equal(alsoCarriesLine(one, new Map([[one.id, one], ["y", row("y", "lunch", "superseded")]])), "Also carries 1 more statement of the same decision, with its quote.");
  assert.doesNotMatch(alsoCarriesLine(a, byId)!, /earlier/, "a confirmation can come later");
});
