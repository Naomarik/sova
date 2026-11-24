import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlaybookInfo } from "../../shared/protocol";
import {
  firstPlaybookIndex,
  FOLD_TOGGLE_KEY,
  foldStartsOpen,
  groupPlaybooks,
  noPlaybookDrafts,
  playbookDraft,
  playbookDraftsEmpty,
  playbookFocusOrder,
  playbookKey,
  playbookTurnText,
  projectNote,
  sentPlaybookDraft,
  setPlaybookDraft,
} from "./playbooks";

const pb = (over: Partial<PlaybookInfo>): PlaybookInfo => ({
  id: "x",
  title: "X",
  description: "",
  source: "sova",
  dir: "/abs/playbooks/x",
  entry: "PLAYBOOK.md",
  body: "# X\n",
  ...over,
});

const HEAD = "Playbook: Brandmaker — /repo/playbooks/brandmaker\nEvery relative path in this playbook is relative to that directory; read its files as the playbook directs.\n\n";
const brand = pb({ title: "Brandmaker", dir: "/repo/playbooks/brandmaker", body: "# Brandmaker\n\nDo the thing.\n" });

test("the turn is the pinned header, a blank line, then the body verbatim", () => {
  assert.equal(playbookTurnText(brand, ""), `${HEAD}# Brandmaker\n\nDo the thing.\n`);
});

test("the user's text follows after the separator, with a trailing newline", () => {
  assert.equal(playbookTurnText(brand, "Brand is Acme"), `${HEAD}# Brandmaker\n\nDo the thing.\n\n---\n\nBrand is Acme\n`);
});

test("blank or whitespace-only user text adds nothing — no separator, no filler", () => {
  for (const blank of ["", "   ", "\n\n\t"]) assert.equal(playbookTurnText(brand, blank), playbookTurnText(brand, ""), JSON.stringify(blank));
  assert.ok(!playbookTurnText(brand, " ").includes("\n---\n"));
});

test("the turn can never start with `/`, whatever the title, body or user text", () => {
  for (const title of ["/brand", "/skill:x", ""]) {
    const text = playbookTurnText(pb({ title, body: "/template arg\n" }), "/also");
    assert.ok(!text.startsWith("/"), text);
    assert.ok(text.startsWith("Playbook: "), text);
  }
});

test("the header names the ABSOLUTE dir, and it is the first line", () => {
  const firstLine = playbookTurnText(brand, "").split("\n")[0]!;
  assert.equal(firstLine, "Playbook: Brandmaker — /repo/playbooks/brandmaker");
  assert.ok(firstLine.endsWith(brand.dir));
});

test("markdown and prompt-template-looking syntax pass through verbatim", () => {
  const body = "---\nnot: frontmatter\n---\n/skill:foo $1 $@ ${2:-x} {{var}} <!-- c -->\n```sh\nrm -rf $ARGUMENTS\n```\n\\`esc\\`\n";
  const text = playbookTurnText(pb({ body }), "use $1 literally");
  assert.ok(text.includes(body), "body intact");
  assert.ok(text.endsWith("\n---\n\nuse $1 literally\n"));
});

test("the user's own text is kept as written inside, trimmed only at its ends", () => {
  assert.ok(playbookTurnText(brand, "  line 1\n\n  line 2  \n").endsWith("\n---\n\nline 1\n\n  line 2\n"));
});

test("groups: This project, Yours, Sova, in that order, each by title, empty ones omitted", () => {
  const groups = groupPlaybooks({
    playbooks: [
      pb({ id: "p", title: "Proj", source: "project" }),
      pb({ id: "b", title: "beta", source: "sova" }),
      pb({ id: "a", title: "Alpha", source: "sova" }),
      pb({ id: "z", title: "Zed", source: "project" }),
      pb({ id: "u", title: "Mine", source: "user" }),
    ],
  });
  assert.deepEqual(
    groups.map((g) => [g.label, g.playbooks.map((p) => p.id)]),
    [["This project", ["p", "z"]], ["Yours", ["u"]], ["Sova", ["a", "b"]]],
  );
  assert.deepEqual(groupPlaybooks({ playbooks: [] }), []);
  assert.deepEqual(groupPlaybooks({ playbooks: [pb({ source: "user" })] }).map((g) => g.label), ["Yours"]);
});

test("row keys stay distinct when a project playbook shares a shipped id", () => {
  assert.notEqual(playbookKey(pb({ id: "a", source: "sova" })), playbookKey(pb({ id: "a", source: "project" })));
});

test("projectNote speaks for remote and missing only, preferring the server's message", () => {
  assert.equal(projectNote({ state: "ok" }), null);
  assert.equal(projectNote({ state: "none" }), null);
  assert.equal(projectNote({ state: "remote", message: "lives on box" }), "lives on box");
  assert.equal(projectNote({ state: "missing", message: "/x doesn't exist" }), "/x doesn't exist");
  const remote = projectNote({ state: "remote" });
  const missing = projectNote({ state: "missing" });
  assert.ok(remote && missing && remote !== missing, "each state has its own fallback");
});

test("typed text belongs to the playbook it was written for", () => {
  const a = playbookKey(pb({ id: "a" }));
  const b = playbookKey(pb({ id: "b", source: "user" }));
  let d = setPlaybookDraft(noPlaybookDrafts, a, "note for A");
  assert.equal(playbookDraft(d, b), "", "A's text is not visible with B selected");
  d = setPlaybookDraft(d, b, "note for B");
  assert.equal(playbookDraft(d, a), "note for A", "A's text comes back when A is reselected");
  assert.equal(d.last, b);
  d = sentPlaybookDraft(d, b);
  assert.equal(playbookDraft(d, b), "", "sending clears its own playbook's entry");
  assert.equal(playbookDraft(d, a), "note for A", "and only its own");
  assert.equal(d.last, null);
  assert.ok(playbookDraftsEmpty(setPlaybookDraft(d, a, "  \n")), "whitespace-only keeps nothing");
});

/** The dialog's catalog for one case of the fold's cross product. `state` is what the server said of
    the project's folder; a project that isn't `ok` lists none of its playbooks. */
const catalogOf = (projectRows: number, userRows: number, state: "ok" | "none" | "remote" | "missing") => ({
  playbooks: [
    ...(state === "ok" ? Array.from({ length: projectRows }, (_, i) => pb({ id: `p${i}`, title: `P${i}`, source: "project" })) : []),
    ...Array.from({ length: userRows }, (_, i) => pb({ id: `u${i}`, title: `U${i}`, source: "user" })),
    pb({ id: "verbs", title: "Project verbs", source: "sova" }),
    pb({ id: "audit", title: "Context audit", source: "sova" }),
  ],
});

test("Sova's section opens by itself only when nothing is above it or the list comes back to one of its rows", () => {
  const sovaRow = playbookKey(pb({ id: "verbs", source: "sova" }));
  const goneSovaRow = playbookKey(pb({ id: "gone", source: "sova" }));
  for (const state of ["ok", "none", "remote", "missing"] as const)
    for (const projectRows of [0, 2])
      for (const userRows of [0, 1])
        for (const focus of [null, sovaRow, goneSovaRow, "project:p0", "user:u0"]) {
          const groups = groupPlaybooks(catalogOf(projectRows, userRows, state));
          const above = groups.some((g) => g.key !== "sova");
          const expected = !above || focus === sovaRow;
          const label = JSON.stringify({ state, projectRows, userRows, focus });
          assert.equal(foldStartsOpen(groups, focus), expected, label);
          assert.equal(above, (state === "ok" && projectRows > 0) || userRows > 0, label);
        }
});

test("with no Sova playbooks there is no section to open", () => {
  assert.equal(foldStartsOpen(groupPlaybooks({ playbooks: [] }), null), false);
  assert.equal(foldStartsOpen(groupPlaybooks({ playbooks: [pb({ source: "project" })] }), null), false);
  assert.deepEqual(playbookFocusOrder(groupPlaybooks({ playbooks: [pb({ id: "a", source: "user" })] }), false), ["user:a"]);
});

test("the focus order is the rows as drawn, Sova's heading row in its place, its rows only while open", () => {
  const groups = groupPlaybooks(catalogOf(2, 1, "ok"));
  const above = ["project:p0", "project:p1", "user:u0"];
  assert.deepEqual(playbookFocusOrder(groups, false), [...above, FOLD_TOGGLE_KEY]);
  assert.deepEqual(playbookFocusOrder(groups, true), [...above, FOLD_TOGGLE_KEY, "sova:audit", "sova:verbs"]);
  const alone = groupPlaybooks(catalogOf(0, 0, "missing"));
  assert.deepEqual(playbookFocusOrder(alone, true), [FOLD_TOGGLE_KEY, "sova:audit", "sova:verbs"]);
  assert.deepEqual(playbookFocusOrder(alone, false), [FOLD_TOGGLE_KEY]);
  assert.ok(!["project", "user", "sova"].some((s) => FOLD_TOGGLE_KEY.startsWith(`${s}:`)), "the heading's key is no row's key");
});

test("focus lands on the first playbook drawn, never the heading row unless it is all there is", () => {
  const groups = groupPlaybooks(catalogOf(2, 0, "ok"));
  assert.equal(firstPlaybookIndex(playbookFocusOrder(groups, false)), 0);
  const alone = groupPlaybooks(catalogOf(0, 0, "none"));
  const open = playbookFocusOrder(alone, foldStartsOpen(alone, null));
  assert.equal(open[firstPlaybookIndex(open)], "sova:audit", "the section opened by itself; focus skips its heading");
  assert.equal(firstPlaybookIndex([FOLD_TOGGLE_KEY]), 0, "folded by hand with nothing above: the heading");
  assert.equal(firstPlaybookIndex([]), -1);
});
