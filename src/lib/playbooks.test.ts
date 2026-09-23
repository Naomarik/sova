import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlaybookInfo } from "../../shared/protocol";
import {
  groupPlaybooks,
  noPlaybookDrafts,
  playbookDraft,
  playbookDraftsEmpty,
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
  body: "# X\n",
  ...over,
});

const HEAD = "Playbook: Brandmaker — /repo/playbooks/brandmaker\nRead the files in that directory as the playbook directs.\n\n";
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

test("groups: Sova, Yours, This project, in that order, each by title, empty ones omitted", () => {
  const groups = groupPlaybooks({
    playbooks: [
      pb({ id: "p", title: "Proj", source: "project" }),
      pb({ id: "b", title: "beta", source: "sova" }),
      pb({ id: "a", title: "Alpha", source: "sova" }),
      pb({ id: "z", title: "Zed", source: "project" }),
    ],
  });
  assert.deepEqual(
    groups.map((g) => [g.label, g.playbooks.map((p) => p.id)]),
    [["Sova", ["a", "b"]], ["This project", ["p", "z"]]],
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
