import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_OUTCOMES, RELATION_TYPES, type ActorView, type EventSummary, type HistoryCoverage } from "../../shared/org-history";
import { absentLine, actorWord, authorityAdds, authorizationWord, AVAILABILITY_WORDS, edgeWords, entityRelationLines, HISTORY_FOOTER, noteChip, PURGE_CONFIRM, QUOTE_CHECK_NOTE, QUOTE_CHECK_WORDS, quoteCheckWords, byDay, conditionText, countLine, dispositionAdds, coverageLine, linkWords, outcomeChip, projectWords, reasonCaption, reasonWords, RELATION_WORDS, timeLines, whatAdds, whoLine, wordedBy } from "./org-history-words";

const unknown = { unknown: true as const };
const person = (label: string, id = "p_1"): ActorView => ({ kind: "person", id, label });
const operator: ActorView = { kind: "operator", label: "Operator" };
const actors = (over: Partial<EventSummary["actors"]>): EventSummary["actors"] => ({ initiatedBy: unknown, decidedBy: unknown, recordedBy: unknown, executedBy: unknown, authorization: unknown, ...over });

test("outcome words: a deliberate no stays apart from a refusal, a failure and an unknown result", () => {
  const w = Object.fromEntries(HISTORY_OUTCOMES.map((o) => [o, outcomeChip(o)]));
  assert.equal(w["do-not-do"]!.word, "Won't do");
  assert.deepEqual([w.refused!.tone, w.failed!.tone], ["error", "error"]);
  assert.deepEqual([w.deferred!.tone, w.unknown!.tone, w.held!.tone], ["warn", "warn", "warn"]);
  assert.notEqual(w.rejected!.tone, "error", "a rejection is a decision, not a failure");
  // Every outcome has its own word: none is two things.
  assert.equal(new Set(HISTORY_OUTCOMES.map((o) => outcomeChip(o).word)).size, HISTORY_OUTCOMES.length);
  assert.equal(outcomeChip("unsupported").word, "Unreadable");
});

test("who: an unknown is said as not recorded, never filled in with the operator", () => {
  const line = whoLine({ actors: actors({}), attended: undefined });
  assert.equal(line, "Decided by: not recorded · start not recorded");
  assert.doesNotMatch(line, /operator/i);
  // Run Now by the operator, then the overseer's unattended choice: the choice is the overseer's.
  assert.equal(whoLine({ actors: actors({ initiatedBy: operator, decidedBy: { kind: "project-overseer", id: "p_x", label: "Portal's overseer" } }), attended: false }), "Portal's overseer · started by Operator · unattended");
  assert.equal(whoLine({ actors: actors({ initiatedBy: operator, decidedBy: operator }), attended: true }), "Operator");
  assert.equal(whoLine({ actors: actors({ initiatedBy: person("Priya"), decidedBy: person("Priya", "p_2") }) }), "Priya · started by Priya", "two people with one name are still two");
});

test("an unknown actor says the why recorded for it; with none, Not recorded; a withheld one, Withheld", () => {
  assert.equal(actorWord({ unknown: true, why: "The gathering's turn." }), "Not recorded: the gathering's turn.");
  assert.equal(actorWord({ unknown: true, why: "The decision statechart's verdict; who reached it is not recorded." }), "Not recorded: the decision statechart's verdict; who reached it is not recorded.");
  assert.equal(actorWord({ unknown: true, why: "Not recorded." }), "Not recorded");
  assert.equal(actorWord({ unknown: true }), "Not recorded");
  assert.equal(actorWord({ unknown: true, why: "withheld" }), "Withheld");
  assert.equal(authorizationWord({ unknown: true, why: "An outside result." }), "Not recorded: an outside result.");
  // The kind already says attended; the by names who, never a raw kind.
  assert.equal(authorizationWord({ kind: "attended-turn", level: "L1", attended: true }), "A turn the operator attended");
  const names = (r: { kind: string; id?: string }) => (r.kind === "person" && r.id === "p_2" ? "Mahmoud" : undefined);
  assert.equal(authorizationWord({ kind: "person-decision", by: { kind: "person", id: "p_2" } }, names), "A person's decision · by Mahmoud");
  assert.equal(authorizationWord({ kind: "person-decision", by: { kind: "person", id: "p_9" } }, names), "A person's decision · by a person not named here");
  assert.equal(authorizationWord({ kind: "confirm-card", by: { kind: "operator" }, ref: "card_1" }), "A confirm card · by the operator · card_1");
  assert.equal(authorizationWord({ kind: "autonomy-level", level: "L2", attended: false }), "Autonomy level L2 · unattended");
  assert.equal(RELATION_WORDS.about, "is about");
});

test("times: an occurrence time when recorded, an import says both its times", () => {
  const at = new Date(2026, 3, 8, 9, 40).getTime();
  const now = new Date(2026, 3, 8, 12, 0).getTime();
  assert.deepEqual(timeLines({ occurredAt: at, recordedAt: at + 1000, origin: "live" }, now), ["Recorded 9:40 AM"]);
  assert.deepEqual(timeLines({ occurredAt: at, recordedAt: at + 3_600_000, origin: "live" }, now), ["Recorded 10:40 AM", "Happened 9:40 AM"]);
  // a note or a correction has no separate occurrence: when it was recorded is when it happened
  assert.deepEqual(timeLines({ recordedAt: at, origin: "live" }, now), ["Recorded 9:40 AM"]);
  assert.deepEqual(timeLines({ occurredAt: at - 86_400_000 * 30, recordedAt: at, origin: "imported" }, now), ["Imported 9:40 AM", "Source time Mar 9 9:40 AM"]);
});

test("the count and coverage lines are the server's numbers", () => {
  assert.equal(countLine(8, 42), "8 of 42 events");
  assert.equal(countLine(1, 1), "1 of 1 event");
  assert.equal(countLine(50, 1200), "50 of 1,200 events");
  const now = new Date(2026, 9, 8).getTime();
  const cov = (over: Partial<HistoryCoverage>): HistoryCoverage => ({ capturedSince: new Date(2026, 3, 8).getTime(), importedSince: null, gaps: [], savingSince: null, problems: [], ...over });
  assert.equal(coverageLine(cov({}), now), "Captured since Apr 8");
  assert.equal(coverageLine(cov({ importedSince: new Date(2026, 1, 1).getTime() }), now), "Captured since Apr 8 · Earlier history partial");
  assert.equal(coverageLine(cov({ capturedSince: null }), now), "Nothing captured yet");
});

test("citations read in the claim's words", () => {
  assert.equal(AVAILABILITY_WORDS["other-host"], "Source not on this host");
  assert.equal(AVAILABILITY_WORDS.changed, "Source changed since it was recorded");
  assert.equal(AVAILABILITY_WORDS.withheld, "Source withheld");
  assert.equal(AVAILABILITY_WORDS.missing, "Source missing");
  assert.equal(AVAILABILITY_WORDS.corrupt, "Source can't be read");
  // Every state has its own words: none reads as another.
  assert.equal(new Set(Object.values(AVAILABILITY_WORDS)).size, Object.keys(AVAILABILITY_WORDS).length);
});

test("links read from the linked event's side: \"{it} {words} this\" or \"This {words} it\", never garbled", () => {
  const target = { id: "e", headline: "x" } as EventSummary;
  // Triggered By: the other event triggered this one; Resulted In: this one triggered it.
  assert.equal(linkWords({ event: target, via: "effect", direction: "in" }), "Triggered this · effect");
  assert.equal(linkWords({ event: target, via: "request", direction: "out" }), "This triggered it · requested");
  assert.equal(linkWords({ event: target, type: "named-target", direction: "in" }), "Names this as its target");
  assert.equal(linkWords({ event: target, type: "named-target", direction: "out" }), "This names it as its target");
  assert.equal(linkWords({ event: target, type: "related", direction: "in" }), "Related to this");
  assert.equal(linkWords({ event: target, type: "related", direction: "out" }), "This is related to it");
  assert.equal(linkWords({ event: target, type: "depends-on", direction: "out" }), "This depends on it");
  assert.equal(linkWords({ event: target, type: "depends-on", direction: "in" }), "Depends on this");
  // A decision recorded in its gathering, from both sides.
  assert.equal(linkWords({ event: target, type: "recorded-in", direction: "out" }), "This was recorded in it");
  assert.equal(linkWords({ event: target, type: "recorded-in", direction: "in" }), "Recorded in this");
  assert.equal(linkWords({ event: target, type: "adopts", direction: "in" }), "Adopts this");
  assert.equal(linkWords({ event: target, type: "about", direction: "in" }), "About this");
  for (const t of RELATION_TYPES)
    for (const direction of ["in", "out"] as const) {
      const w = linkWords({ event: target, type: t, direction });
      assert.doesNotMatch(w, /trigger/i, `${t} ${direction}: a relation is never worded as a cause`);
      assert.doesNotMatch(w, / this$/.test(w) ? /^This / : /^$/, `${t} ${direction}: "${w}"`);
      assert.match(w, direction === "in" ? /\bthis\b/ : /^This .*\bit\b/, `${t} ${direction}: "${w}"`);
    }
  // Every relation has its own name (the refused-link line uses it).
  assert.equal(new Set(RELATION_TYPES.map((t) => RELATION_WORDS[t])).size, RELATION_TYPES.length);
  // A type this version has no words for still shows, by its own name.
  assert.equal(linkWords({ event: target, type: "newer-type" as never, direction: "in" }), "Newer-type this");
});

test("a chain edge's words: the card is the subject when it holds the edge, else the other end is named", () => {
  assert.equal(edgeWords({ via: "effect" }, "from", "this"), "triggered this · effect");
  assert.equal(edgeWords({ via: "spawn" }, "to", "this"), "this triggered it · spawned");
  assert.equal(edgeWords({ type: "adopts" }, "from", "this"), "adopts this");
  assert.equal(edgeWords({ type: "recorded-in" }, "from", "it"), "recorded in it");
  assert.equal(edgeWords({ type: "named-target" }, "to", "“Conflict settled”"), "“Conflict settled” names it as its target");
});

test("reasons: recorded, added later, purged, withheld and none each say which", () => {
  assert.deepEqual(reasonWords({ reason: "Ledger export not approved", reasonState: "recorded" }), { text: "Ledger export not approved", muted: false });
  assert.equal(reasonWords({ reason: "Found later", reasonState: "added-later" }).text, "Added later: Found later");
  assert.equal(reasonWords({ reasonState: "not-recorded" }).text, "Reason not recorded");
  assert.equal(reasonWords({ reasonState: "purged" }, new Date(2026, 3, 22).getTime(), new Date(2026, 5, 1).getTime()).text, "Reason purged Apr 22");
  assert.equal(reasonWords({ reasonState: "withheld" }).text, "Reason withheld");
});

test("rows group by local day in the order given; projects name the owner first, archived said", () => {
  const d = (day: number, h: number) => ({ recordedAt: new Date(2026, 3, day, h).getTime() });
  assert.deepEqual(byDay([d(9, 1), d(8, 23), d(8, 2)]).map((g) => g.rows.length), [1, 2]);
  assert.equal(projectWords({ project: { id: "a", name: "Investor portal" }, affected: [{ id: "b", name: "Finance ledger", archived: true }] }), "Investor portal + Finance ledger (archived)");
  assert.equal(projectWords({ project: null, affected: [] }), "Organization");
});

test("a decision's chip adds only what its outcome word doesn't say; a condition never reads \"Until: until\"", () => {
  assert.equal(dispositionAdds("defer", "deferred"), false, "Deferred needs no Deferral beside it");
  assert.equal(dispositionAdds("do-not-do", "do-not-do"), false);
  assert.equal(dispositionAdds("choose", "chosen"), false);
  assert.equal(dispositionAdds("defer", "recorded"), true, "a Recorded outcome says nothing of the disposition");
  assert.equal(conditionText("until ledger validation is approved"), "Until ledger validation is approved");
  assert.equal(conditionText("ledger validation approved"), "Until: ledger validation approved");
  assert.doesNotMatch(conditionText("Until Q2"), /until.*until/i);
});

test("a quote's check says what was compared, never that a person approved the record", () => {
  assert.equal(QUOTE_CHECK_WORDS.checked, "Quote found in source; sender is the person named");
  assert.equal(new Set(Object.values(QUOTE_CHECK_WORDS)).size, Object.keys(QUOTE_CHECK_WORDS).length, "each state its own words");
  for (const w of [...Object.values(QUOTE_CHECK_WORDS), QUOTE_CHECK_NOTE]) {
    assert.doesNotMatch(w, /\b(verified|confirmed|approved by|checked)\b/i, w);
  }
  assert.match(QUOTE_CHECK_NOTE, /doesn't show the person approved/);
  // An unchecked quote says why when the recorder said: its words may be in the message, but who said them isn't recorded.
  assert.equal(quoteCheckWords("unchecked", "The message's sender wasn't recorded."), "Not checked: The message's sender wasn't recorded.");
  assert.equal(quoteCheckWords("unchecked"), "Quote not compared with source");
  assert.equal(quoteCheckWords("checked", "ignored"), QUOTE_CHECK_WORDS.checked, "why only for unchecked");
});

test("the purge confirm says what goes, then what stays and what it can't reach; the footer says it once", () => {
  assert.equal(
    PURGE_CONFIRM,
    "Removes this reason and its search words from the history. The event, its links and who did it stay, and the original messages, decisions and spec keep their own text. Earlier workspace commits, the remote and backups may still hold it.",
  );
  assert.doesNotMatch(PURGE_CONFIRM, /from Sova/, "it doesn't remove the text from Sova as a whole");
  assert.equal(HISTORY_FOOTER, "History is kept in this organization's workspace repo on this device; only a push to its remote copies it elsewhere. A purge removes a stored reason here, not from earlier commits, the remote or backups.");
  assert.equal(HISTORY_FOOTER.split(". ").length, 2, "two sentences");
});

test("WHAT shows only when it says more than the headline; Worded by only for a recorder that isn't the decider", () => {
  assert.equal(whatAdds(undefined, "Gap filed"), false);
  assert.equal(whatAdds("Gap filed", "Gap filed"), false);
  assert.equal(whatAdds(" Gap filed ", "Gap filed"), false);
  assert.equal(whatAdds("Gap filed for receipts", "Gap filed"), true);
  const model: ActorView = { kind: "model", session: "s1", label: "A model" };
  const sova: ActorView = { kind: "sova", label: "Sova" };
  const overseer: ActorView = { kind: "project-overseer", id: "p", label: "Overseer · Expense Inbox" };
  assert.equal(wordedBy({ actors: actors({ decidedBy: person("Mahmoud"), recordedBy: model }) }), "A model", "a model wording a person's decision");
  assert.equal(wordedBy({ actors: actors({ decidedBy: overseer, recordedBy: overseer }) }), null, "the decider recorded it");
  // The operator's own decision is worded by the operator: never "Worded by Sova", even on a record from before that was fixed.
  assert.equal(wordedBy({ actors: actors({ decidedBy: operator, recordedBy: sova }) }), null);
  assert.equal(wordedBy({ actors: actors({ decidedBy: unknown, recordedBy: model }) }), "A model");
  assert.equal(wordedBy({ actors: actors({ decidedBy: person("Mahmoud"), recordedBy: unknown }) }), null);
  assert.equal(wordedBy({ actors: undefined }), null);
});

test("the reason's caption names its author once, Worded by only when someone else wrote it", () => {
  const model: ActorView = { kind: "model", session: "s1", label: "A model" };
  const label = (r: { kind: string; id?: string }) => (r.kind === "person" ? "Mahmoud" : r.kind === "operator" ? "Operator" : "Model");
  // The recorder is the author (the same model by its session): one name, the recorder's own label.
  assert.equal(reasonCaption({ author: { kind: "model", session: "s1" }, contemporaneous: true }, model, label), "A model · recorded at the time");
  assert.equal(reasonCaption({ author: { kind: "person", id: "p_1" }, contemporaneous: true }, model, label), "Mahmoud · Worded by A model · recorded at the time");
  assert.equal(reasonCaption({ author: { kind: "operator" }, contemporaneous: false }, operator, label), "Operator · Added later");
  assert.equal(reasonCaption({ author: { kind: "operator" }, contemporaneous: true }, { kind: "sova", label: "Sova" }, label), "Operator · recorded at the time");
  assert.equal(reasonCaption({ author: unknown, contemporaneous: true }, model, label), "Author not recorded · Worded by A model · recorded at the time");
});

test("Decision authority shows only when it isn't who decided; one muted line says what's absent", () => {
  assert.equal(authorityAdds({ kind: "person", id: "p_1" }, person("Mahmoud")), false);
  assert.equal(authorityAdds({ kind: "operator" }, operator), false);
  assert.equal(authorityAdds({ kind: "person", id: "p_1" }, { kind: "model", label: "A model" }), true);
  assert.equal(authorityAdds(unknown, person("Mahmoud")), true, "an unknown authority is said");
  assert.equal(absentLine(0, 0), "No evidence cited · no recorded consequence.");
  assert.equal(absentLine(0, 2), "No evidence cited.");
  assert.equal(absentLine(1, 0), "No recorded consequence.");
  assert.equal(absentLine(1, 1), null);
});

test("a relation to an entity from before capture shows its type and id, and that it isn't in this history", () => {
  const lines = entityRelationLines([
    { type: "recorded-in", target: { entity: { type: "gathering", id: "s_123" } } },
    { type: "supersedes", target: { event: "he_1" } },
    { type: "named-target", target: { entity: { type: "decision", id: "d_9" } } },
  ]);
  assert.deepEqual(lines, ["This was recorded in gathering s_123 · not in this history", "This names decision d_9 as its target · not in this history"]);
  assert.deepEqual(entityRelationLines(undefined), []);
});

test("a note or correction reads as its author's note, never as a decision", () => {
  const op: ActorView = { kind: "operator", label: "Operator" };
  const a = actors({ initiatedBy: op, decidedBy: op, recordedBy: op, authorization: { kind: "operator-act" } });
  assert.equal(noteChip({ kind: "annotation.added", actors: a }), "Operator note");
  assert.equal(noteChip({ kind: "correction.recorded", actors: a }), "Operator correction");
  assert.equal(noteChip({ kind: "annotation.added", actors: undefined }), "Note", "a boundary card without actors names no author");
  assert.equal(noteChip({ kind: "decision.recorded", actors: a }), null, "a decision keeps its decider and authority");
});
