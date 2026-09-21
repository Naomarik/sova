// Run: npx tsx --test src/lib/session-groups.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionGroup, SessionSummary } from "../../shared/protocol";
import { GROUP_DRAG_TYPE, dragHasRow, groupDragPath, groupNameOf, groupSections, quoted, setGroupDragData } from "./session-groups";

const group = (id: string, name: string): SessionGroup => ({ id, name, createdAt: "2026-09-20T00:00:00.000Z" });
const session = (id: string, groupId?: string): SessionSummary =>
  ({ id, path: `/tmp/${id}.jsonl`, cwd: "/tmp", title: id, groupId }) as SessionSummary;

const WORK = group("g1", "Work");
const HOME = group("g2", "Home");

test("groupSections keeps the groups' order and the rows' order inside each one", () => {
  const sessions = [session("a", "g2"), session("b", "g1"), session("c", "g2"), session("d")];
  const sections = groupSections(sessions, [WORK, HOME], false);
  assert.deepEqual(
    sections.map((s) => [s.group.name, s.sessions.map((x) => x.id)]),
    [
      ["Work", ["b"]],
      ["Home", ["a", "c"]],
    ],
  );
});

test("groupSections keeps a group with no sessions — it's a drop target — unless a search is on", () => {
  assert.deepEqual(
    groupSections([session("a", "g1")], [WORK, HOME], false).map((s) => s.group.name),
    ["Work", "Home"],
  );
  assert.deepEqual(
    groupSections([session("a", "g1")], [WORK, HOME], true).map((s) => s.group.name),
    ["Work"],
  );
  assert.deepEqual(groupSections([], [], false), []);
});

test("groupSections ignores an ungrouped session and one whose group is gone", () => {
  const sections = groupSections([session("a"), session("b", "deleted-group"), session("c", "g1")], [WORK], false);
  assert.deepEqual(sections.map((s) => s.sessions.map((x) => x.id)), [["c"]]);
});

test("groupNameOf resolves a name, and null for no group or an unknown one", () => {
  assert.equal(groupNameOf([WORK, HOME], "g2"), "Home");
  assert.equal(groupNameOf([WORK, HOME], undefined), null);
  assert.equal(groupNameOf([WORK, HOME], "gone"), null);
  assert.equal(quoted("Home"), "“Home”");
});

test("the drag payload round-trips the session path, and only our own drags report as rows", () => {
  const store = new Map<string, string>();
  const dt = {
    types: [GROUP_DRAG_TYPE],
    effectAllowed: "none",
    setData: (t: string, v: string) => void store.set(t, v),
    getData: (t: string) => store.get(t) ?? "",
  };
  const drag = { dataTransfer: dt } as unknown as DragEvent;
  setGroupDragData(drag, "/tmp/a.jsonl");
  assert.equal(store.get(GROUP_DRAG_TYPE), "/tmp/a.jsonl");
  assert.equal(store.get("text/plain"), "/tmp/a.jsonl");
  assert.equal(dt.effectAllowed, "move");
  assert.equal(groupDragPath(drag), "/tmp/a.jsonl");
  assert.equal(dragHasRow(drag), true);

  // A drag that carries files or plain text is not ours: no path, and no drop target lights up.
  const other = { dataTransfer: { types: ["Files"], getData: (t: string) => (t === GROUP_DRAG_TYPE ? "" : "hello") } } as unknown as DragEvent;
  assert.equal(groupDragPath(other), null);
  assert.equal(dragHasRow(other), false);
});
