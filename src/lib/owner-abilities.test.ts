import assert from "node:assert/strict";
import { test } from "node:test";
import type { OwnerAbilities, OwnerProjectAbilities } from "../../shared/owner";
import { abilityLines, howLine, lineText, nameList, openCount, requestsLine } from "./owner-abilities";

const A = { id: "q_aaaaaaaa", name: "RakibaDesigns" };
const B = { id: "q_bbbbbbbb", name: "Rakiba Shop" };
const C = { id: "q_cccccccc", name: "Notes" };
const ab = (p: { id: string }, x: Partial<OwnerProjectAbilities> = {}): OwnerProjectAbilities => ({ project: p.id, fix: "team", version: "none", release: "team", ...x });
const abilities = (...projects: OwnerProjectAbilities[]): OwnerAbilities => ({ photos: false, projects });
const byId = (lines: ReturnType<typeof abilityLines>) => Object.fromEntries(lines.map((l) => [l.id, l]));

test("the three lines that never depend on a switch, in order", () => {
  const lines = abilityLines([A], abilities(ab(A)));
  assert.deepEqual(lines.slice(0, 3).map((l) => [l.name, l.how]), [
    ["Ask about your projects", "Answers right away"],
    ["Report a problem", "Goes to the team at once"],
    ["Ask for something new", "Written up with you, then sent to the team"],
  ]);
});

test("every answer of one project reads its plain sentence", () => {
  const read = (x: Partial<OwnerProjectAbilities>) => byId(abilityLines([A], abilities(ab(A, x))));
  assert.equal(read({ fix: "now" }).fix!.how, "Starts right away");
  assert.equal(read({ fix: "held" }).fix!.how, "Starts on its own in a few minutes");
  assert.equal(read({ fix: "team" }).fix!.how, "The team decides when to start it");
  assert.equal(read({ version: "now" }).try!.how, "Starts right away, with an Open button");
  assert.equal(read({ version: "team" }).try!.how, "The team starts it for you");
  assert.equal(read({ release: "now" }).release!.how, "Starts right away");
  assert.equal(read({ release: "held" }).release!.how, "Starts on its own in a few minutes");
  assert.equal(read({ release: "team" }).release!.how, "The team releases it");
  for (const l of abilityLines([A], abilities(ab(A, { fix: "held" })))) assert.equal(l.named, false, l.id);
});

test("Try the latest version only while some project lists a version", () => {
  assert.deepEqual(abilityLines([A, B], abilities(ab(A), ab(B))).map((l) => l.id), ["ask", "report", "new", "fix", "release"]);
  const lines = abilityLines([A, B], abilities(ab(A), ab(B, { version: "now" })));
  assert.deepEqual(lines.map((l) => l.id), ["ask", "report", "new", "fix", "try", "release"]);
  // Only projects that list one are covered: one plain line, its prefill names that project.
  assert.equal(byId(lines).try!.how, "Starts right away, with an Open button");
  assert.equal(byId(lines).try!.prefill, "Can I try the latest version of Rakiba Shop?");
});

test("projects that differ are named, right away, then on its own, then the team", () => {
  const lines = byId(abilityLines([A, B, C], abilities(ab(A, { fix: "held", release: "team" }), ab(B, { fix: "team", release: "now" }), ab(C, { fix: "held", release: "held" }))));
  assert.equal(lineText(lines.fix!), "Get a problem fixed: on its own for RakibaDesigns and Notes, the team starts it for Rakiba Shop.");
  assert.equal(lineText(lines.release!), "Release a new version: right away for Rakiba Shop, on its own for Notes, the team releases it for RakibaDesigns.");
  assert.equal(lines.fix!.named, true);
});

test("the brief's example reads exactly", () => {
  const fix = byId(abilityLines([A, B], abilities(ab(A, { fix: "held" }), ab(B, { fix: "team" })))).fix!;
  assert.equal(lineText(fix), "Get a problem fixed: on its own for RakibaDesigns, the team starts it for Rakiba Shop.");
});

test("projects that agree read one plain line, named nowhere", () => {
  const lines = abilityLines([A, B], abilities(ab(A, { fix: "held", release: "team" }), ab(B, { fix: "held", release: "team" })));
  for (const l of lines) {
    assert.equal(l.named, false, l.id);
    assert.doesNotMatch(l.how, /RakibaDesigns|Rakiba Shop/, l.id);
  }
});

test("a version is never held: held and now are one answer", () => {
  assert.deepEqual(howLine("version", [{ name: "A", outcome: "held" }, { name: "B", outcome: "now" }]), { how: "Starts right away, with an Open button", named: false });
  assert.equal(howLine("version", [{ name: "A", outcome: "held" }, { name: "B", outcome: "team" }]).how, "right away for A, the team starts it for B.");
});

test("what a tap starts in the message box", () => {
  const one = byId(abilityLines([A], abilities(ab(A, { version: "now" }))));
  assert.equal(one.ask!.prefill, "How is RakibaDesigns going?");
  assert.equal(one.report!.prefill, "Something isn't working: ");
  assert.equal(one.new!.prefill, "I'd like something new: ");
  assert.equal(one.fix!.prefill, "Please fix this: ");
  assert.equal(one.try!.prefill, "Can I try the latest version of RakibaDesigns?");
  assert.equal(one.release!.prefill, "Please release a new version of RakibaDesigns.");
  const two = byId(abilityLines([A, B], abilities(ab(A, { version: "team" }), ab(B, { version: "now" }))));
  assert.equal(two.ask!.prefill, "How are my projects going?");
  assert.equal(two.release!.prefill, "Please release a new version of ");
  // The first project in Home's order that lists one.
  assert.equal(two.try!.prefill, "Can I try the latest version of RakibaDesigns?");
});

test("an answer with no abilities (an older server) or none of the shown projects: the three fixed lines", () => {
  assert.deepEqual(abilityLines([A], undefined).map((l) => l.id), ["ask", "report", "new"]);
  assert.deepEqual(abilityLines([A], abilities(ab(C))).map((l) => l.id), ["ask", "report", "new"]);
});

test("project lists read A, A and B, A, B and C", () => {
  assert.equal(nameList(["A"]), "A");
  assert.equal(nameList(["A", "B"]), "A and B");
  assert.equal(nameList(["A", "B", "C"]), "A, B and C");
});

test("no line uses a word the owner page never says", () => {
  const banned = /\b(session|branch|model|AI|deploy|switch|power|overseer|brake|paused|limit|worktree|engine)\b/i;
  const outcomes = ["now", "held", "team"] as const;
  for (const fix of outcomes)
    for (const release of outcomes)
      for (const version of [...outcomes, "none"] as const) {
        const lines = abilityLines([A, B], abilities(ab(A, { fix, release, version }), ab(B)));
        for (const l of lines) {
          assert.doesNotMatch(lineText(l), banned, lineText(l));
          assert.doesNotMatch(l.prefill, banned, l.prefill);
        }
      }
});

test("Home's requests line and the tab's open count", () => {
  assert.equal(requestsLine([{ status: "with-team" }]), "Your requests: 1 with the team ›");
  assert.equal(requestsLine([{ status: "with-team" }, { status: "with-team" }, { status: "done" }]), "Your requests: 2 with the team ›");
  assert.equal(requestsLine([{ status: "started" }, { status: "done" }]), "Your requests: 2 ›");
  // A feature request whose chat is open reads Planning with you, never with the team (found driving the page);
  // once its plan is agreed it is with the team again.
  assert.equal(requestsLine([{ status: "with-team", plan: "planning" }]), "Your requests: 1 ›");
  assert.equal(requestsLine([{ status: "with-team", plan: "planning" }, { status: "with-team" }]), "Your requests: 1 with the team ›");
  assert.equal(requestsLine([{ status: "with-team", plan: "agreed" }]), "Your requests: 1 with the team ›");
  assert.equal(openCount([{ status: "with-team" }, { status: "started" }, { status: "done" }, { status: "declined" }]), 2);
  assert.equal(openCount(undefined), 0);
});

test("Plan something new with you takes the place of Ask for something new while some project opens a feature request chat", () => {
  // Switch Off everywhere (or an older server with no `feature`): Ask for something new, as today.
  assert.equal(byId(abilityLines([A], abilities(ab(A, { feature: "team" })))).new!.name, "Ask for something new");
  assert.equal(byId(abilityLines([A], abilities(ab(A)))).plan, undefined);
  // On: one plain line, in the same place, with its own prefill.
  const on = abilityLines([A], abilities(ab(A, { feature: "now" })));
  assert.equal(on[2]!.id, "plan");
  assert.equal(lineText(on[2]!), "Plan something new with you. Opens a chat with you right away.");
  assert.equal(on[2]!.prefill, "I'd like to plan something new: ");
  assert.equal(byId(on).new, undefined);
  // Projects that differ are named.
  const mixed = byId(abilityLines([A, B], abilities(ab(A, { feature: "now" }), ab(B, { feature: "team" })))).plan!;
  assert.equal(lineText(mixed), "Plan something new with you: right away for RakibaDesigns, the team plans it for Rakiba Shop.");
  // Never more than 6 lines.
  assert.ok(abilityLines([A], abilities(ab(A, { feature: "now", fix: "now", version: "now", release: "now" }))).length <= 6);
});
